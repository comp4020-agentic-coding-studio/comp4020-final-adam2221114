import type { ClientMessage, ControlMessage, GamePhase, StateMessage } from "./protocol.ts";
import { InputController } from "./input.ts";
import { interpolateState } from "./interpolate.ts";
import { LocalPlayerPrediction } from "./prediction.ts";
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

// The last two snapshots the server sent, and when each arrived.
// interpolateState() uses these to smooth REMOTE entity motion (zombies, and
// any future remote players) for rendering. The local player does not use
// this path — see `prediction` below — nothing here feeds back into any
// outgoing message, and the server never sees any of it.
let previousState: StateMessage | undefined;
let previousReceivedAt = 0;
let currentState: StateMessage | undefined;
let currentReceivedAt = 0;

// Client-side prediction for the local player only: advances every
// animation frame from locally-held input, never waiting for a snapshot.
// reconcile() still corrects it to the server's authoritative position on
// every message — the server remains the only source of truth; this only
// changes how quickly the display reflects input and how a correction looks.
const prediction = new LocalPlayerPrediction();

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
  // The predicted position, not the last server snapshot — aiming and the
  // shot-effect origin should match where the character is actually drawn.
  getPlayerPos: () => prediction.getDisplayPos(performance.now()),
  onShoot: (origin, aimAngle) => {
    effects.push({ x: origin.x, y: origin.y, angle: aimAngle, firedAt: performance.now() });
  },
});

socket.addEventListener("message", (ev) => {
  previousState = currentState;
  previousReceivedAt = currentReceivedAt;
  currentState = JSON.parse(ev.data) as StateMessage;
  currentReceivedAt = performance.now();
  prediction.reconcile(currentState.player, currentReceivedAt);
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

// Render loop: requestAnimationFrame (~60fps), independent of the server's
// broadcast rate. Every frame advances local prediction (if the round is
// running), re-interpolates remote entities between the last two snapshots,
// and redraws. Nothing here is authoritative; it only ever reads/writes the
// client-local prediction and reads currentState/previousState.
let lastFrameTimestamp: number | undefined;
// The timestamp last fed to getDisplayPos() while not running — freezes the
// player exactly where it was, bit for bit, the instant the round stops
// being "running". Without this, a reconciliation's decaying correction
// offset (see prediction.ts) would keep settling toward its target for up to
// CORRECTION_DECAY_MS after a pause, a tiny but real violation of "paused
// freezes everything".
let frozenAt: number | undefined;

const frame = (timestamp: number): void => {
  const dtMs = lastFrameTimestamp === undefined ? 0 : timestamp - lastFrameTimestamp;
  lastFrameTimestamp = timestamp;

  if (currentState) {
    // Matches the server's own gate: waiting/paused/game_over/victory freeze
    // the player there too, so a pause doesn't let the character keep
    // wandering locally only to snap back on resume.
    const isRunning = currentState.phase === "running";
    if (isRunning) {
      prediction.tick(input.getMoveState(), dtMs);
      frozenAt = undefined;
    } else if (frozenAt === undefined) {
      frozenAt = timestamp; // capture the instant we stopped running
    }
    const predictionNow = isRunning ? timestamp : (frozenAt ?? timestamp); // frozenAt is always set by now in this branch; the fallback is just for TS

    const displayState = interpolateState(previousState, previousReceivedAt, currentState, currentReceivedAt, timestamp);
    const predictedPos = prediction.getDisplayPos(predictionNow);
    displayState.player = { ...displayState.player, x: predictedPos.x, y: predictedPos.y };

    render(ctx, CANVAS_SIZE, displayState, input.getAimAngle());

    for (let i = effects.length - 1; i >= 0; i--) {
      if (timestamp - effects[i].firedAt > TRACER_LIFETIME_MS) effects.splice(i, 1);
    }
    renderShotEffects(ctx, CANVAS_SIZE, effects, timestamp);

    const mouse = input.getMouseWorldPos();
    if (mouse) renderCrosshair(ctx, CANVAS_SIZE, mouse);
  }
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
