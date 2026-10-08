import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { GameLoop } from "./game-loop.ts";
import type { ClientMessage } from "./protocol.ts";

// Crit 9: up to MAX_PLAYERS simultaneous connections, each tracked by an
// ephemeral server-assigned id (no accounts, nothing durable — see
// game-state.ts's MAX_PLAYERS and the Crit 9 ADR on simultaneous actions).
// Every open socket gets the same broadcast; each client finds itself in the
// snapshot's players[] by the id its own "welcome" message carried.
//
// 20Hz, matching the game loop's own tick rate — this timer only ever reads
// gameLoop.getSnapshot() (no game logic lives here), so running it at the
// same cadence as the tick is the simplest choice, not a second copy of any
// simulation logic.
const BROADCAST_INTERVAL_MS = 50;

function parseClientMessage(data: unknown): ClientMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(data));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) return undefined;

  if (parsed.type === "input") {
    const { move, aimAngle } = parsed as { move?: unknown; aimAngle?: unknown };
    if (typeof move !== "object" || move === null || typeof aimAngle !== "number") return undefined;
    const m = move as Record<string, unknown>;
    return {
      type: "input",
      move: {
        up: m.up === true,
        down: m.down === true,
        left: m.left === true,
        right: m.right === true,
      },
      aimAngle,
    };
  }

  if (parsed.type === "shoot") {
    return { type: "shoot" };
  }

  if (parsed.type === "start" || parsed.type === "pause" || parsed.type === "resume" || parsed.type === "restart") {
    return { type: parsed.type };
  }

  if (parsed.type === "interact") {
    const { action } = parsed as { action?: unknown };
    if (action === "build_wall" || action === "upgrade_wall") {
      return { type: "interact", action };
    }
    return undefined;
  }

  if (parsed.type === "place_turret") {
    const { x, y } = parsed as { x?: unknown; y?: unknown };
    if (typeof x !== "number" || typeof y !== "number") return undefined;
    return { type: "place_turret", x, y };
  }

  return undefined;
}

export function attachWebSocketServer(httpServer: Server, gameLoop: GameLoop): void {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  const sockets = new Map<WebSocket, string>();

  wss.on("connection", (socket) => {
    const id = randomUUID();
    if (!gameLoop.addPlayer(id)) {
      console.log("ws: rejected connection — game is full");
      socket.send(JSON.stringify({ type: "full" }));
      socket.close();
      return;
    }
    sockets.set(socket, id);
    socket.send(JSON.stringify({ type: "welcome", playerId: id }));
    console.log(`ws: client connected as ${id} (${gameLoop.playerCount()} connected)`);

    socket.on("message", (data) => {
      const msg = parseClientMessage(data);
      if (!msg) {
        console.warn("ws: dropped an unrecognised message");
        return;
      }
      switch (msg.type) {
        case "input":
          gameLoop.setInput(id, { ...msg.move, aimAngle: msg.aimAngle });
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
        case "interact": {
          const result = gameLoop.interact(id, msg.action);
          if (!result.ok) {
            socket.send(JSON.stringify({ type: "rejected", action: msg.action, reason: result.reason }));
          }
          break;
        }
        case "place_turret": {
          const result = gameLoop.placeTurret(id, msg.x, msg.y);
          if (!result.ok) {
            socket.send(JSON.stringify({ type: "rejected", action: "place_turret", reason: result.reason }));
          }
          break;
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      gameLoop.removePlayer(id);
      // Only pause once the LAST player has left — i.e. the shared session
      // has genuinely gone empty, not just lost one of several players. A
      // single remaining connection keeps the round running for whoever's
      // still there. gameLoop.pause() is a no-op unless phase is currently
      // "running", so it's always safe to call whenever this check passes.
      // There is no auto-resume anywhere: the next connection just sees
      // "paused" and a player has to click Resume themselves.
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
