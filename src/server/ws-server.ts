import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { GameLoop } from "./game-loop.ts";
import type { ClientMessage } from "./protocol.ts";

// Step 3 added the broadcast; Step 4 adds the other direction (input/shoot).
// Still one logical connection at a time — no player id, no room, no
// broadcast-to-many, no reconnection handling, all deliberately crit 9's job.
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
    if (action === "build_wall" || action === "upgrade_wall" || action === "build_turret") {
      return { type: "interact", action };
    }
    return undefined;
  }

  return undefined;
}

export function attachWebSocketServer(httpServer: Server, gameLoop: GameLoop): void {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  let current: WebSocket | null = null;

  wss.on("connection", (socket) => {
    if (current && current.readyState === WebSocket.OPEN) {
      console.log("ws: new connection replacing the existing one");
      current.close();
    }
    current = socket;
    console.log("ws: client connected");

    socket.on("message", (data) => {
      const msg = parseClientMessage(data);
      if (!msg) {
        console.warn("ws: dropped an unrecognised message");
        return;
      }
      switch (msg.type) {
        case "input":
          gameLoop.setInput({ ...msg.move, aimAngle: msg.aimAngle });
          break;
        case "shoot":
          gameLoop.shoot();
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
        case "interact":
          gameLoop.interact(msg.action);
          break;
      }
    });

    socket.on("close", () => {
      if (current === socket) current = null;
      console.log("ws: client disconnected (game loop keeps running)");
    });
  });

  setInterval(() => {
    if (current?.readyState === WebSocket.OPEN) {
      current.send(JSON.stringify(gameLoop.getSnapshot()));
    }
  }, BROADCAST_INTERVAL_MS);
}
