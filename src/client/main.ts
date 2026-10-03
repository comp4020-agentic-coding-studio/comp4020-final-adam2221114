import type { ClientMessage, StateMessage } from "./protocol.ts";
import { InputController } from "./input.ts";
import { render } from "./render.ts";

// Must match src/server/game-state.ts's MAP_SIZE (see protocol.ts's comment
// on why this is a duplicated constant, not a shared import).
const WORLD_SIZE = 1000;
const CANVAS_SIZE = 800;

const canvas = document.querySelector<HTMLCanvasElement>("#game");
if (!canvas) throw new Error("index.html is missing #game");
const hud = document.querySelector<HTMLDivElement>("#hud");
if (!hud) throw new Error("index.html is missing #hud");
const conn = document.querySelector<HTMLDivElement>("#conn");
if (!conn) throw new Error("index.html is missing #conn");

canvas.width = CANVAS_SIZE;
canvas.height = CANVAS_SIZE;
const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("2d canvas context unavailable");

// This is the only place client state lives: the last snapshot the server
// sent. Nothing here computes a position, an HP value or an XP total —
// render() and the HUD below just display whatever this holds.
let latest: StateMessage | undefined;

// Arrow functions, not `function` declarations: TS only carries the
// non-null narrowing from the guards above into closures created after them,
// not into hoisted function declarations.
const setConnStatus = (status: "connecting" | "connected" | "disconnected"): void => {
  conn.textContent = status === "connected" ? "connected" : status === "connecting" ? "connecting…" : "disconnected";
  conn.className = status;
};

setConnStatus("connecting");
const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(`${wsProtocol}//${location.host}/ws`);

socket.addEventListener("open", () => setConnStatus("connected"));
socket.addEventListener("close", () => setConnStatus("disconnected"));
socket.addEventListener("error", () => setConnStatus("disconnected"));

const input = new InputController({
  canvas,
  worldSize: WORLD_SIZE,
  send: (msg: ClientMessage) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  },
  getPlayerPos: () => latest?.player ?? { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 },
});

socket.addEventListener("message", (ev) => {
  latest = JSON.parse(ev.data) as StateMessage;
  render(ctx, CANVAS_SIZE, latest, input.getAimAngle());
  updateHud(latest);
});

const updateHud = (state: StateMessage): void => {
  hud.innerHTML = [
    `Day ${state.day}`,
    `Base HP ${state.baseHp} / ${state.baseMaxHp}`,
    `Base Level ${state.baseLevel}`,
    `Shared XP ${state.sharedXp}`,
    `Player HP ${state.player.hp}`,
  ].join("<br>");
};
