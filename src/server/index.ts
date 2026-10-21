import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderReadme } from "./render-readme.ts";
import { openDatabase } from "./persistence.ts";
import { PersistedState } from "./persisted-state.ts";
import { GameLoop } from "./game-loop.ts";
import { attachWebSocketServer } from "./ws-server.ts";

// STEP 0: just enough of a server to replace the placeholder container and
// keep the two fixed invariants (spec/invariants.test.ts) green.
// STEP 1: persistence is wired into the process lifecycle here (loaded at
// startup, flushed on shutdown).
// STEP 2: the game loop runs server-side, in memory — zombies approach and
// hit the base, day advances.
// STEP 3: a /ws endpoint broadcasts the authoritative state at a stable rate.
// STEP 4: the client can send input/shoot; the server resolves them.
// STEP 5: the real canvas client replaces the Step 0 shell page, served from
// dist/client (built from src/client by tsconfig.client.json).

const port = Number(process.env.PORT ?? 8080);
const cwd = process.cwd();

const clientIndex = readFileSync(path.join(cwd, "src", "client", "index.html"), "utf8");
const distClientDir = path.join(cwd, "dist", "client");
const spritesDir = path.join(cwd, "src", "client", "sprites");

// Reads fresh each request (like renderReadme()) rather than caching, so a
// rebuild (`pnpm run build`) is visible without restarting the server. Only
// ever serves *.js under dist/client — nothing else is exposed this way.
function serveClientScript(url: string, res: import("node:http").ServerResponse): boolean {
  if (!url.endsWith(".js")) return false;
  const resolved = path.resolve(path.join(distClientDir, url));
  if (!resolved.startsWith(distClientDir + path.sep)) return false; // no path traversal
  try {
    const js = readFileSync(resolved, "utf8");
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    res.end(js);
    return true;
  } catch {
    return false;
  }
}

// Sprite/tileset PNGs under /sprites/ — served straight from source (same
// "read fresh from src/client" approach as index.html above, not a dist/
// build artifact), scoped to *.png under spritesDir only. The curated
// originals live in src/client/sprites/; the full CraftPix pack stays in
// assets/ untouched (see PROCESS.md's visual-redesign entry for sourcing).
function serveSprite(url: string, res: import("node:http").ServerResponse): boolean {
  if (!url.startsWith("/sprites/") || !url.endsWith(".png")) return false;
  const resolved = path.resolve(path.join(cwd, "src", "client", url));
  if (!resolved.startsWith(spritesDir + path.sep)) return false; // no path traversal
  try {
    const png = readFileSync(resolved);
    res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=3600" });
    res.end(png);
    return true;
  } catch {
    return false;
  }
}

const db = openDatabase();
const progress = new PersistedState(db);
console.log("loaded progress:", progress.get());

const gameLoop = new GameLoop(progress, db);
gameLoop.start();

const server = createServer((req, res) => {
  const url = req.url ?? "/";

  if (url === "/readme/" || url === "/readme") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderReadme(cwd));
    return;
  }

  if (url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(clientIndex);
    return;
  }

  if (serveClientScript(url, res)) return;
  if (serveSprite(url, res)) return;

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

const wsServer = attachWebSocketServer(server, gameLoop);

server.listen(port, "0.0.0.0", () => {
  console.log(`listening on :${port}`);
});

// Fly stops machines by sending SIGTERM; a redeploy's rolling update does the
// same to the outgoing machine. Flush whatever hasn't hit the periodic save
// yet before the process actually exits.
//
// wsServer.closeAllConnections() MUST run before server.close(): an
// upgraded WebSocket connection is detached from Node's normal HTTP
// connection bookkeeping, so server.close()'s callback never fires while
// one is still open (confirmed locally: 10+ seconds with a single open
// connection, via a graceful close handshake that waits on the client).
// Fly's default kill_timeout is 5 seconds before it escalates to a harder
// stop, so without this the process can still be mid-shutdown — past the
// point gameLoop.stop()/progress.flush()/db.close() already ran, but before
// process.exit(0) ever gets called — when Fly's own forced stop cuts it
// off. See PendingRepair.md for the investigation this fixes and
// spec/shutdown.test.ts for the regression test.
//
// Guarded so a second SIGTERM/SIGINT while already shutting down (Fly can
// send more than one) can't flush/close an already-closed db a second time.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: flushing progress and exiting`);
  gameLoop.stop();
  progress.flush();
  progress.stop();
  db.close();
  wsServer.closeAllConnections();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
