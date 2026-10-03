import type { ClientMessage, ControlMessage, GamePhase, StateMessage } from "./protocol.ts";
import { InputController } from "./input.ts";
import { interpolateState } from "./interpolate.ts";
import { render, renderCrosshair, renderShotEffects, TRACER_LIFETIME_MS, type ShotEffect } from "./render.ts";

// Must match src/server/game-state.ts's MAP_SIZE (see protocol.ts's comment
// on why this is a duplicated constant, not a shared import).
const WORLD_SIZE = 1000;
const CANVAS_SIZE = 800;

// Arrow functions throughout, not `function` declarations: TS only carries
// the non-null narrowing from guards like these into closures created after
// them, not into hoisted function declarations (bit us in Step 5).
const canvas = document.querySelector<HTMLCanvasElement>("#game");
if (!canvas) throw new Error("index.html is missing #game");
const hud = document.querySelector<HTMLDivElement>("#hud");
if (!hud) throw new Error("index.html is missing #hud");
const conn = document.querySelector<HTMLDivElement>("#conn");
if (!conn) throw new Error("index.html is missing #conn");
const banner = document.querySelector<HTMLDivElement>("#phase-banner");
if (!banner) throw new Error("index.html is missing #phase-banner");
const btnStart = document.querySelector<HTMLButtonElement>("#btn-start");
if (!btnStart) throw new Error("index.html is missing #btn-start");
const btnPause = document.querySelector<HTMLButtonElement>("#btn-pause");
if (!btnPause) throw new Error("index.html is missing #btn-pause");
const btnResume = document.querySelector<HTMLButtonElement>("#btn-resume");
if (!btnResume) throw new Error("index.html is missing #btn-resume");
const btnRestart = document.querySelector<HTMLButtonElement>("#btn-restart");
if (!btnRestart) throw new Error("index.html is missing #btn-restart");

canvas.width = CANVAS_SIZE;
canvas.height = CANVAS_SIZE;
const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("2d canvas context unavailable");

// The only client state that matters for gameplay: the last two snapshots
// the server sent, and when each arrived. interpolateState() uses these to
// smooth player/zombie motion for rendering; nothing here feeds back into
// any outgoing message, and the server never sees any of it.
let previousState: StateMessage | undefined;
let previousReceivedAt = 0;
let currentState: StateMessage | undefined;
let currentReceivedAt = 0;

// Fired shots, client-side only — see input.ts's onShoot and render.ts's
// comment on ShotEffect. Pruned once their tracer has fully faded.
const effects: ShotEffect[] = [];

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

const sendControl = (type: ControlMessage["type"]): void => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type }));
};
btnStart.addEventListener("click", () => sendControl("start"));
btnPause.addEventListener("click", () => sendControl("pause"));
btnResume.addEventListener("click", () => sendControl("resume"));
btnRestart.addEventListener("click", () => sendControl("restart"));

const input = new InputController({
  canvas,
  worldSize: WORLD_SIZE,
  send: (msg: ClientMessage) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  },
  getPlayerPos: () => currentState?.player ?? { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 },
  onShoot: (origin, aimAngle) => {
    effects.push({ x: origin.x, y: origin.y, angle: aimAngle, firedAt: performance.now() });
  },
});

socket.addEventListener("message", (ev) => {
  previousState = currentState;
  previousReceivedAt = currentReceivedAt;
  currentState = JSON.parse(ev.data) as StateMessage;
  currentReceivedAt = performance.now();
  // Text/numbers update immediately on new data — only positions (handled in
  // the animation loop below) benefit from smoothing between snapshots.
  updateHud(currentState);
  updatePhaseUi(currentState.phase);
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

const PHASE_LABELS: Record<GamePhase, string> = {
  waiting: "READY",
  running: "",
  paused: "PAUSED",
  game_over: "GAME OVER",
  victory: "VICTORY",
};

const updatePhaseUi = (phase: GamePhase): void => {
  banner.textContent = PHASE_LABELS[phase];
  btnStart.hidden = phase !== "waiting";
  btnPause.hidden = phase !== "running";
  btnResume.hidden = phase !== "paused";
  // Restart stays visible in every phase — it's the one control that always
  // works, regardless of how the round ended or whether it's even started.
};

// Render loop: requestAnimationFrame, independent of the ~5Hz broadcast rate.
// Every frame re-interpolates between the last two snapshots and redraws —
// this is what makes movement look smooth instead of stepping once per
// snapshot. Nothing here is authoritative; it only ever reads currentState/
// previousState, never writes them.
const frame = (): void => {
  if (currentState) {
    const now = performance.now();
    const displayState = interpolateState(previousState, previousReceivedAt, currentState, currentReceivedAt, now);
    render(ctx, CANVAS_SIZE, displayState, input.getAimAngle());

    for (let i = effects.length - 1; i >= 0; i--) {
      if (now - effects[i].firedAt > TRACER_LIFETIME_MS) effects.splice(i, 1);
    }
    renderShotEffects(ctx, CANVAS_SIZE, effects, now);

    const mouse = input.getMouseWorldPos();
    if (mouse) renderCrosshair(ctx, CANVAS_SIZE, mouse);
  }
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
