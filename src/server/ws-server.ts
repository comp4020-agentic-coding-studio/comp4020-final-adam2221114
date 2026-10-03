import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { GameLoop } from "./game-loop.ts";

// Step 3: one logical connection at a time. No player id, no room, no
// broadcast-to-many, no reconnection handling — crit 9's job, not this
// step's. This module only ever reads GameLoop's snapshot and pushes it out;
// there's no client input to apply yet (that's Step 4), so it never touches
// game state.
const BROADCAST_INTERVAL_MS = 200;

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
