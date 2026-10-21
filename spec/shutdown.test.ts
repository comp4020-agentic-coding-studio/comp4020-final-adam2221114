import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { loadState } from "../src/server/persistence.ts";
import Database from "better-sqlite3";

// Regression test for the Fly-restart shutdown bug documented in
// PendingRepair.md: src/server/index.ts's shutdown() used to call
// server.close(() => process.exit(0)) without ever closing the WebSocket
// server/its open sockets first. Node's http.Server#close() callback does
// not fire until every connection — including an upgraded WebSocket
// connection, which is detached from Node's normal HTTP connection
// tracking — has ended, so a single open browser tab could keep the process
// alive for 10+ seconds past SIGTERM (measured locally). Fly's default
// kill_timeout is 5 seconds before it escalates to a harder stop, so the
// graceful shutdown path could be cut off mid-exit on a real restart.
//
// This spawns a REAL server subprocess (not the shared app spec/global-
// setup.ts points the rest of spec/ at) because the property under test —
// how long the process itself takes to exit after a signal, and whether it
// already flushed state before doing so — can only be observed from
// outside that specific process's lifecycle, never against an
// already-running shared instance.
const SERVER_ENTRY = path.join(import.meta.dirname, "..", "src", "server", "index.ts");
const TSX_BIN = path.join(import.meta.dirname, "..", "node_modules", ".bin", "tsx");
const REPO_ROOT = path.join(import.meta.dirname, "..");

const tmpDirs: string[] = [];
const children: ChildProcessByStdio<null, Readable, Readable>[] = [];

afterEach(() => {
  // Belt and braces: if an assertion threw before a child was reaped, make
  // sure nothing lingers past this test (SIGKILL, not SIGTERM — we don't
  // want a slow child masking a failure as a hang in the NEXT test).
  for (const child of children.splice(0)) {
    if (child.pid && !child.killed) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "comp4020-shutdown-test-"));
  tmpDirs.push(dir);
  return dir;
}

// Spawns a real server subprocess on its own port/data dir, detached into
// its own process group (so SIGTERM can be sent to the group, matching how
// Fly signals the container's PID 1) and resolves once it has logged that
// it's listening.
function spawnServer(port: number, dataDir: string): Promise<ChildProcessByStdio<null, Readable, Readable>> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [SERVER_ENTRY], {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("server subprocess did not log 'listening on' within 15s"));
      }
    }, 15000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (!settled && chunk.toString().includes("listening on")) {
        settled = true;
        clearTimeout(timeout);
        resolve(child);
      }
    });
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}

function connectWs(port: number, playerId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?playerId=${encodeURIComponent(playerId)}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

// Sends SIGTERM to the whole process group (matching Fly's real signalling
// of a container's PID 1) and resolves with how long the process actually
// took to exit. Rejects if it doesn't exit within the given budget.
function sigtermAndMeasureExit(child: ChildProcessByStdio<null, Readable, Readable>, budgetMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timeout = setTimeout(() => {
      reject(new Error(`process did not exit within ${budgetMs}ms of SIGTERM`));
    }, budgetMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve(Date.now() - t0);
    });
    if (!child.pid) throw new Error("child has no pid");
    process.kill(-child.pid, "SIGTERM");
  });
}

it(
  "exits promptly on SIGTERM even with an open WebSocket connection, and has already flushed progress before doing so",
  async () => {
    const port = 8200 + Math.floor(Math.random() * 500);
    const dataDir = freshDataDir();
    const server = await spawnServer(port, dataDir);

    const ws = await connectWs(port, "spec-shutdown-regress-player1");
    // Give the server a moment to actually register the connection
    // (addPlayer/sockets.set) before signalling shutdown.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Fly's default kill_timeout is 5000ms before it escalates to a harder
    // stop; this asserts well inside that budget (2500ms) specifically so a
    // regression back to the old "waits for the WS close handshake"
    // behaviour (previously measured locally at 10+ seconds) fails this
    // test rather than silently passing because the budget was loose.
    const exitMs = await sigtermAndMeasureExit(server, 2500);
    expect(exitMs, "server took too long to exit with an open WS connection — Fly's default kill_timeout is 5000ms").toBeLessThan(2500);

    ws.close();

    // Progress must have been flushed (gameLoop.stop()/progress.flush()/
    // db.close() all run before wsServer.closeAllConnections() in
    // shutdown()) — opening the SAME database file fresh (simulating the
    // next process boot) must see the phase the server started in
    // ("waiting", STARTUP_PHASE's identity mapping for a clean shutdown),
    // not a half-written or stale row.
    const db = new Database(path.join(dataDir, "game.db"), { readonly: true });
    const saved = loadState(db);
    db.close();
    expect(saved.phase).toBe("waiting");
    expect(saved.day).toBe(1);
  },
  20000,
);

it(
  "exits promptly on SIGTERM with a player mid-round (running phase, non-zero sharedXp possible) and preserves that exact state",
  async () => {
    const port = 8200 + Math.floor(Math.random() * 500);
    const dataDir = freshDataDir();
    const server = await spawnServer(port, dataDir);

    const ws = await connectWs(port, "spec-shutdown-regress-player2");
    const messages: Array<{ type: string; [key: string]: unknown }> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));

    await new Promise((resolve) => setTimeout(resolve, 200));
    ws.send(JSON.stringify({ type: "select_character", characterIndex: 0, displayName: "ShutdownTest" }));
    ws.send(JSON.stringify({ type: "start" }));

    // Wait for the server's own broadcast to confirm "running" before
    // measuring shutdown — this is the exact scenario PendingRepair.md's
    // original report was about (a connected player, round in progress).
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = (): void => {
        const state = messages.filter((m) => m.type === "state").at(-1);
        if (state?.phase === "running") return resolve();
        if (Date.now() - start > 5000) return reject(new Error("round never reached 'running'"));
        setTimeout(check, 50);
      };
      check();
    });

    const lastState = messages.filter((m) => m.type === "state").at(-1) as { baseHp: number; day: number } | undefined;
    expect(lastState, "no state broadcast observed before shutdown").toBeDefined();

    const exitMs = await sigtermAndMeasureExit(server, 2500);
    expect(exitMs, "server took too long to exit with an open WS connection mid-round").toBeLessThan(2500);

    ws.close();

    const db = new Database(path.join(dataDir, "game.db"), { readonly: true });
    const saved = loadState(db);
    db.close();
    // STARTUP_PHASE maps "running" -> "paused" on the NEXT boot's safety
    // check, but what shutdown() itself flushes is the phase as it was the
    // instant gameLoop.stop() ran — "running", since that's what play()
    // last wrote via progress.update({phase: "running"}). The real
    // assertion that matters here is baseHp: it must match what the client
    // last observed, proving nothing mutated it after shutdown began and
    // nothing was lost before the flush completed.
    expect(saved.phase).toBe("running");
    expect(saved.baseHp).toBe(lastState!.baseHp);
    expect(saved.day).toBe(lastState!.day);
  },
  20000,
);
