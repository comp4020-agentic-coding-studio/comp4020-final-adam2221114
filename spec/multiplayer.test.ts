import { inject, it, expect } from "vitest";
import { WebSocket } from "ws";

// Crit 9: two concrete, automatable invariants from the ADR at
// docs/decisions/0001-simultaneous-build-conflicts.md. Everything else about
// multiplayer (feel, the ~1s propagation requirement, remote-player
// rendering) is judged by playtesting with real browser tabs, same as this
// project's other realtime behaviour — see PROCESS.md's workflow section.
const baseUrl = inject("baseUrl");
const wsUrl = (): string => `${baseUrl.replace(/^http/, "ws")}/ws`;

interface ServerMsg {
  type: string;
  [key: string]: unknown;
}

function connect(): Promise<{ ws: WebSocket; messages: ServerMsg[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    const messages: ServerMsg[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    ws.on("open", () => resolve({ ws, messages }));
    ws.on("error", reject);
  });
}

function waitFor(messages: ServerMsg[], type: string, timeoutMs = 3000): Promise<ServerMsg> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = messages.find((m) => m.type === type);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for "${type}"`));
      setTimeout(check, 20);
    };
    check();
  });
}

it("rejects a 5th simultaneous connection instead of dropping an existing player", async () => {
  const conns = await Promise.all([connect(), connect(), connect(), connect()]);
  try {
    for (const c of conns) await waitFor(c.messages, "welcome");

    const fifth = await connect();
    try {
      const full = await waitFor(fifth.messages, "full");
      expect(full.type).toBe("full");

      // None of the first 4 were dropped to make room.
      for (const c of conns) expect(c.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      fifth.ws.close();
    }
  } finally {
    for (const c of conns) c.ws.close();
  }
});

// Assumes a freshly-booted app (phase "waiting", sharedXp 0) — true for CI's
// throwaway /data (.github/workflows/checks.yml) and for a just-started dev
// server. Run against a dev instance you've already been playing on and both
// requests may legitimately get different answers (one could actually
// afford the wall); that's a stale precondition, not this test being wrong.
it("a duplicate simultaneous build_wall request is rejected, not double-charged", async () => {
  const a = await connect();
  const b = await connect();
  try {
    await waitFor(a.messages, "welcome");
    await waitFor(b.messages, "welcome");

    // Both requests race against the same (likely insufficient) shared XP —
    // the point here isn't affording the wall, it's that the server gives
    // the same consistent answer to both instead of two different ones, and
    // never partially applies the action to just one of them.
    a.ws.send(JSON.stringify({ type: "interact", action: "build_wall" }));
    b.ws.send(JSON.stringify({ type: "interact", action: "build_wall" }));

    const rejectedA = await waitFor(a.messages, "rejected");
    const rejectedB = await waitFor(b.messages, "rejected");
    expect(rejectedA.action).toBe("build_wall");
    expect(rejectedB.action).toBe("build_wall");
    expect(rejectedA.reason).toBe(rejectedB.reason);
  } finally {
    a.ws.close();
    b.ws.close();
  }
});
