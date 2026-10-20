import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { GameLoop } from "./game-loop.ts";
import type { ClientMessage } from "./protocol.ts";

// Crit 10: a player's id is no longer purely ephemeral-per-socket (Crit 9) —
// the client supplies a browser-persistent id (localStorage, generated once)
// as a `?playerId=` query param on the WS URL, so GameLoop can load/save
// durable identity (hp/status/medkits) across reconnects. A malformed or
// missing id falls back to a fresh server-generated one rather than trusting
// arbitrary client input as a database key.
//
// Up to MAX_PLAYERS (game-state.ts) may be connected at once, same cap as
// Crit 9, now keyed by identity rather than raw socket count; one identity
// may drive at most one open socket at a time (see duplicate_identity below).
const BROADCAST_INTERVAL_MS = 50; // 20Hz, matching the game loop's own tick rate

const PLAYER_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function extractPlayerId(requestUrl: string | undefined): string | undefined {
  if (!requestUrl) return undefined;
  try {
    const url = new URL(requestUrl, "http://internal");
    const id = url.searchParams.get("playerId");
    return id && PLAYER_ID_PATTERN.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function parseClientMessage(data: unknown): ClientMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(data));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) return undefined;

  if (parsed.type === "input") {
    const { move, aimAngle, reviving } = parsed as { move?: unknown; aimAngle?: unknown; reviving?: unknown };
    if (typeof move !== "object" || move === null || typeof aimAngle !== "number") return undefined;
    const m = move as Record<string, unknown>;
    return {
      type: "input",
      move: { up: m.up === true, down: m.down === true, left: m.left === true, right: m.right === true },
      aimAngle,
      reviving: reviving === true,
    };
  }

  if (parsed.type === "shoot") return { type: "shoot" };

  if (parsed.type === "start" || parsed.type === "pause" || parsed.type === "resume" || parsed.type === "restart" || parsed.type === "retry_day") {
    return { type: parsed.type };
  }

  if (parsed.type === "interact") {
    const { action } = parsed as { action?: unknown };
    if (action === "build_wall" || action === "upgrade_wall" || action === "revive_dead" || action === "buy_medkit") {
      return { type: "interact", action };
    }
    return undefined;
  }

  if (parsed.type === "place_turret") {
    const { x, y } = parsed as { x?: unknown; y?: unknown };
    if (typeof x !== "number" || typeof y !== "number") return undefined;
    return { type: "place_turret", x, y };
  }

  if (parsed.type === "turret_interact") {
    const { turretId, action } = parsed as { turretId?: unknown; action?: unknown };
    if (typeof turretId !== "string" || (action !== "upgrade" && action !== "repair")) return undefined;
    return { type: "turret_interact", turretId, action };
  }

  if (parsed.type === "use_medkit") return { type: "use_medkit" };

  if (parsed.type === "select_character") {
    const { characterIndex, displayName } = parsed as { characterIndex?: unknown; displayName?: unknown };
    if (typeof characterIndex !== "number" || typeof displayName !== "string") return undefined;
    return { type: "select_character", characterIndex, displayName };
  }

  return undefined;
}

export function attachWebSocketServer(httpServer: Server, gameLoop: GameLoop): void {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  const sockets = new Map<WebSocket, string>();

  wss.on("connection", (socket, request) => {
    const id = extractPlayerId(request.url) ?? randomUUID();

    if (gameLoop.isConnected(id)) {
      console.log(`ws: rejected connection — identity ${id} already has an open session`);
      socket.send(JSON.stringify({ type: "duplicate_identity" }));
      socket.close();
      return;
    }
    if (!gameLoop.addPlayer(id)) {
      console.log("ws: rejected connection — game is full");
      socket.send(JSON.stringify({ type: "full" }));
      socket.close();
      return;
    }
    sockets.set(socket, id);
    socket.send(JSON.stringify({ type: "welcome", playerId: id }));
    console.log(`ws: client connected as ${id} (${gameLoop.playerCount()} connected)`);

    const sendRejected = (action: string, result: { ok: true } | { ok: false; reason: string }): void => {
      if (!result.ok) socket.send(JSON.stringify({ type: "rejected", action, reason: result.reason }));
    };

    socket.on("message", (data) => {
      const msg = parseClientMessage(data);
      if (!msg) {
        console.warn("ws: dropped an unrecognised message");
        return;
      }
      switch (msg.type) {
        case "input":
          gameLoop.setInput(id, { ...msg.move, aimAngle: msg.aimAngle, reviving: msg.reviving });
          break;
        case "shoot":
          gameLoop.shoot(id);
          break;
        case "start":
        case "resume":
          gameLoop.play();
          break;
        case "pause":
          gameLoop.pause();
          break;
        case "restart":
          gameLoop.restart();
          break;
        case "retry_day":
          sendRejected("retry_day", gameLoop.retryDay());
          break;
        case "interact":
          sendRejected(msg.action, gameLoop.interact(id, msg.action));
          break;
        case "place_turret":
          sendRejected("place_turret", gameLoop.placeTurret(id, msg.x, msg.y));
          break;
        case "turret_interact":
          sendRejected(msg.action, gameLoop.turretInteract(id, msg.turretId, msg.action));
          break;
        case "use_medkit":
          sendRejected("use_medkit", gameLoop.useMedkit(id));
          break;
        case "select_character":
          sendRejected("select_character", gameLoop.selectCharacter(id, msg.characterIndex, msg.displayName));
          break;
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      gameLoop.removePlayer(id);
      // Only pause once the LAST player has left — a single remaining
      // connection keeps the round running for whoever's still there.
      // gameLoop.pause() is a no-op unless phase is currently "running".
      // There is no auto-resume: the next connection just sees "paused".
      if (gameLoop.playerCount() === 0) {
        gameLoop.pause();
        console.log("ws: last client disconnected — game paused if it was running");
      } else {
        console.log(`ws: client ${id} disconnected (${gameLoop.playerCount()} remain)`);
      }
    });
  });

  setInterval(() => {
    const snapshot = JSON.stringify(gameLoop.getSnapshot());
    for (const socket of sockets.keys()) {
      if (socket.readyState === WebSocket.OPEN) socket.send(snapshot);
    }
  }, BROADCAST_INTERVAL_MS);
}
