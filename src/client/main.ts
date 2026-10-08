import {
  BASE_ATTACK_RANGE,
  BASE_INTERACT_RANGE,
  BASE_POS,
  MAX_TURRETS,
  MEDKIT_COST,
  MEDKIT_MAX,
  resurrectCostForDay,
  TURRET_BUILD_RADIUS,
  TURRET_INTERACT_RANGE,
  TURRET_LEVELS,
  TURRET_MAX_LEVEL,
  WALL_LEVELS,
  WALL_MAX_LEVEL,
} from "./defense-config.ts";
import type { ClientMessage, ControlMessage, GamePhase, InteractAction, ServerMessage, StateMessage, TurretAction } from "./protocol.ts";
import { InputController } from "./input.ts";
import { interpolateState } from "./interpolate.ts";
import { LocalPlayerPrediction } from "./prediction.ts";
import {
  collectDeathEffects,
  render,
  renderCrosshair,
  renderDayIntro,
  renderDayProgress,
  renderDeathEffects,
  renderShotEffects,
  renderTurretPlacementPreview,
  TRACER_LIFETIME_MS,
  UI_REGIONS,
  uiIconStyle,
  type DeathEffect,
  type ShotEffect,
} from "./render.ts";

// Must match src/server/game-state.ts's MAP_SIZE (see protocol.ts's comment
// on why this is a duplicated constant, not a shared import).
const WORLD_SIZE = 1000;
const CANVAS_SIZE = 800;

// Crit 10: a browser-persistent identity, generated once and kept in
// localStorage, so a reconnect (tab refresh, network drop) resumes the same
// player — HP, status, medkits — instead of joining as someone new. No
// accounts: this is just a random id the server treats as an opaque key.
const PLAYER_ID_KEY = "comp4020-last-stand-player-id";
function getOrCreatePlayerId(): string {
  try {
    const existing = localStorage.getItem(PLAYER_ID_KEY);
    if (existing) return existing;
  } catch {
    // localStorage unavailable (private browsing, etc.) — fall through to a
    // fresh id for this tab; the server still works, reconnect just won't
    // resume the same identity.
  }
  const id = crypto.randomUUID();
  try {
    localStorage.setItem(PLAYER_ID_KEY, id);
  } catch {
    // ignore — see above
  }
  return id;
}

const canvas = document.querySelector<HTMLCanvasElement>("#game");
if (!canvas) throw new Error("index.html is missing #game");
const hud = document.querySelector<HTMLDivElement>("#hud");
if (!hud) throw new Error("index.html is missing #hud");
const conn = document.querySelector<HTMLDivElement>("#conn");
if (!conn) throw new Error("index.html is missing #conn");
const banner = document.querySelector<HTMLDivElement>("#phase-banner");
if (!banner) throw new Error("index.html is missing #phase-banner");
const menu = document.querySelector<HTMLDivElement>("#interact-menu");
if (!menu) throw new Error("index.html is missing #interact-menu");
const btnStart = document.querySelector<HTMLButtonElement>("#btn-start");
if (!btnStart) throw new Error("index.html is missing #btn-start");
const btnPause = document.querySelector<HTMLButtonElement>("#btn-pause");
if (!btnPause) throw new Error("index.html is missing #btn-pause");
const btnResume = document.querySelector<HTMLButtonElement>("#btn-resume");
if (!btnResume) throw new Error("index.html is missing #btn-resume");
const btnRetry = document.querySelector<HTMLButtonElement>("#btn-retry");
if (!btnRetry) throw new Error("index.html is missing #btn-retry");
const btnRestart = document.querySelector<HTMLButtonElement>("#btn-restart");
if (!btnRestart) throw new Error("index.html is missing #btn-restart");

canvas.width = CANVAS_SIZE;
canvas.height = CANVAS_SIZE;
const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("2d canvas context unavailable");
ctx.imageSmoothingEnabled = false; // pixel-art sprites stay crisp when scaled up, not blurred

let previousState: StateMessage | undefined;
let previousReceivedAt = 0;
let currentState: StateMessage | undefined;
let currentReceivedAt = 0;

// Zombie-death visual effects — purely cosmetic (render.ts's own comment),
// detected by diffing consecutive raw snapshots' zombie lists.
const deathEffects: DeathEffect[] = [];

// The server confirms (and may override, if our stored id was malformed)
// our identity in the "welcome" message — that confirmed value, not the one
// we sent, is what we use to find ourselves in players[].
let myPlayerId: string | undefined;

const findSelf = (state: StateMessage): StateMessage["players"][number] | undefined =>
  state.players.find((p) => p.id === myPlayerId);

let rejectionNotice: string | undefined;
let rejectionTimer: ReturnType<typeof setTimeout> | undefined;

const prediction = new LocalPlayerPrediction();

const effects: ShotEffect[] = [];
const lastTurretShotsFired = new Map<string, number>();

const setConnStatus = (status: "connecting" | "connected" | "disconnected", detail?: string): void => {
  conn.textContent = detail ?? (status === "connected" ? "connected" : status === "connecting" ? "connecting…" : "disconnected");
  conn.className = status;
};

setConnStatus("connecting");
const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
const playerId = getOrCreatePlayerId();
const socket = new WebSocket(`${wsProtocol}//${location.host}/ws?playerId=${encodeURIComponent(playerId)}`);

socket.addEventListener("open", () => setConnStatus("connected"));
socket.addEventListener("close", () => setConnStatus("disconnected"));
socket.addEventListener("error", () => setConnStatus("disconnected"));

const sendControl = (type: ControlMessage["type"]): void => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type }));
};
btnStart.addEventListener("click", () => sendControl("start"));
btnPause.addEventListener("click", () => sendControl("pause"));
btnResume.addEventListener("click", () => sendControl("resume"));
btnRetry.addEventListener("click", () => sendControl("retry_day"));
btnRestart.addEventListener("click", () => sendControl("restart"));

const sendInteract = (action: InteractAction): void => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "interact", action }));
};
const sendPlaceTurret = (x: number, y: number): void => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "place_turret", x, y }));
};
const sendTurretInteract = (turretId: string, action: TurretAction): void => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "turret_interact", turretId, action }));
};
const sendUseMedkit = (): void => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "use_medkit" }));
};

const input = new InputController({
  canvas,
  worldSize: WORLD_SIZE,
  send: (msg: ClientMessage) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  },
  getPlayerPos: () => prediction.getDisplayPos(performance.now()),
  onShoot: (origin, aimAngle) => {
    effects.push({ x: origin.x, y: origin.y, angle: aimAngle, firedAt: performance.now() });
  },
});

// --- X-menu: base vs. a specific turret -------------------------------------
//
// Crit 10 splits the single "base menu" into two contexts: near the base
// itself (build/upgrade wall, build a turret, revive a dead teammate, buy a
// medkit) vs. near an already-built turret (upgrade/repair THAT turret
// only). A turret in range takes priority over the base when both overlap —
// see nearestTurretInRange()'s own comment. Every actual action still
// round-trips to the server, which re-checks range/cost/state against its
// own authoritative data; this is all preview-only.
type MenuChoice =
  | { key: string; label: string; kind: "interact"; action: InteractAction }
  | { key: string; label: string; kind: "place_turret" }
  | { key: string; label: string; kind: "turret_action"; turretId: string; action: TurretAction };

type MenuContext = { kind: "base" } | { kind: "turret"; turretId: string };

let menuOpen = false;
let menuContext: MenuContext | undefined;
let menuChoices: MenuChoice[] = [];
let placementMode = false;

const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

const playerInBaseRange = (): boolean =>
  distance(prediction.getDisplayPos(performance.now()), BASE_POS) <= BASE_INTERACT_RANGE;

// The nearest turret within TURRET_INTERACT_RANGE, or undefined. Turrets can
// be placed as close as BASE_ATTACK_RANGE from the base, well inside
// BASE_INTERACT_RANGE — when both overlap, the more specific context (a
// particular turret) wins over the general one (the base), per the brief's
// explicit "the base menu must not allow turret upgrades/repairs."
const nearestTurretInRange = (state: StateMessage | undefined): string | undefined => {
  if (!state) return undefined;
  const pos = prediction.getDisplayPos(performance.now());
  let best: { id: string; d: number } | undefined;
  for (const t of state.turrets) {
    if (t.hp <= 0) continue;
    const d = distance(pos, { x: t.x, y: t.y });
    if (d <= TURRET_INTERACT_RANGE && (!best || d < best.d)) best = { id: t.id, d };
  }
  return best?.id;
};

const isValidTurretSpot = (pos: { x: number; y: number }): boolean => {
  const d = distance(pos, BASE_POS);
  return d >= BASE_ATTACK_RANGE && d <= TURRET_BUILD_RADIUS;
};

// A manual distributive-Omit equivalent — plain `Omit<MenuChoice, "key">`
// collapses a union down to its common keys only, which would lose the
// `action`/`turretId` fields that only exist on some branches.
type UnkeyedChoice =
  | { label: string; kind: "interact"; action: InteractAction }
  | { label: string; kind: "place_turret" }
  | { label: string; kind: "turret_action"; turretId: string; action: TurretAction };

const computeBaseChoices = (state: StateMessage, self: StateMessage["players"][number] | undefined): UnkeyedChoice[] => {
  const choices: UnkeyedChoice[] = [];
  if (state.wallLevel === 0) {
    choices.push({ label: `Build Wall — ${WALL_LEVELS[1].cost} XP`, kind: "interact", action: "build_wall" });
  } else if (state.wallLevel < WALL_MAX_LEVEL) {
    const next = WALL_LEVELS[state.wallLevel + 1];
    if (next) choices.push({ label: `Upgrade Wall — ${next.cost} XP`, kind: "interact", action: "upgrade_wall" });
  }
  if (state.turrets.length < MAX_TURRETS) {
    choices.push({ label: `Build Turret — ${TURRET_LEVELS[1].cost} XP`, kind: "place_turret" });
  }
  if (state.players.some((p) => p.status === "dead")) {
    choices.push({ label: `Revive Dead Teammate — ${resurrectCostForDay(state.day)} XP`, kind: "interact", action: "revive_dead" });
  }
  if (self && self.medkits < MEDKIT_MAX) {
    choices.push({ label: `Buy Medkit — ${MEDKIT_COST} XP (${self.medkits}/${MEDKIT_MAX} carried)`, kind: "interact", action: "buy_medkit" });
  }
  return choices;
};

const computeTurretChoices = (state: StateMessage, turretId: string): UnkeyedChoice[] => {
  const turret = state.turrets.find((t) => t.id === turretId);
  if (!turret) return [];
  const choices: UnkeyedChoice[] = [];
  if (turret.level < TURRET_MAX_LEVEL) {
    const next = TURRET_LEVELS[turret.level + 1];
    choices.push({ label: `Upgrade This Turret (Lv${turret.level}→${turret.level + 1}) — ${next.cost} XP`, kind: "turret_action", turretId, action: "upgrade" });
  }
  if (turret.hp < turret.maxHp) {
    const cost = TURRET_LEVELS[turret.level].repairCost;
    choices.push({ label: `Repair This Turret (${turret.hp}/${turret.maxHp} HP) — ${cost} XP`, kind: "turret_action", turretId, action: "repair" });
  }
  return choices;
};

const computeMenuChoices = (state: StateMessage, context: MenuContext): MenuChoice[] => {
  const self = findSelf(state);
  const unkeyed = context.kind === "base" ? computeBaseChoices(state, self) : computeTurretChoices(state, context.turretId);
  return unkeyed.map((choice, i) => ({ key: String(i + 1), ...choice }) as MenuChoice);
};

const renderMenu = (state: StateMessage | undefined): void => {
  if (placementMode) {
    menu.textContent = ["PLACING TURRET", "", "Click a valid spot (dashed ring around the base)", "[X / Esc] Cancel"].join("\n");
    menu.hidden = false;
    return;
  }
  if (!menuOpen || !state || !menuContext) {
    menu.hidden = true;
    return;
  }
  menuChoices = computeMenuChoices(state, menuContext);
  const heading = menuContext.kind === "base" ? "BASE" : "TURRET";
  const lines = [heading, "", ...menuChoices.map((o) => `[${o.key}] ${o.label}`), "[X / Esc] Close"];
  menu.textContent = lines.join("\n");
  menu.hidden = false;
};

const closeMenu = (): void => {
  menuOpen = false;
  menuContext = undefined;
  menu.hidden = true;
};

const cancelPlacement = (): void => {
  placementMode = false;
  menu.hidden = true;
};

window.addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();

  if (key === "h") {
    sendUseMedkit();
    return;
  }

  if (key === "x" || key === "escape") {
    if (placementMode) {
      cancelPlacement();
    } else if (key === "escape") {
      if (menuOpen) closeMenu();
    } else if (menuOpen) {
      closeMenu();
    } else {
      const turretId = nearestTurretInRange(currentState);
      if (turretId) {
        menuOpen = true;
        menuContext = { kind: "turret", turretId };
        renderMenu(currentState);
      } else if (playerInBaseRange()) {
        menuOpen = true;
        menuContext = { kind: "base" };
        renderMenu(currentState);
      }
    }
    return;
  }
  if (menuOpen) {
    const chosen = menuChoices.find((o) => o.key === key);
    if (!chosen) return;
    if (chosen.kind === "place_turret") {
      closeMenu();
      placementMode = true;
      renderMenu(currentState);
    } else if (chosen.kind === "interact") {
      sendInteract(chosen.action);
    } else {
      sendTurretInteract(chosen.turretId, chosen.action);
    }
  }
});

canvas.addEventListener(
  "click",
  (e) => {
    if (!placementMode) return;
    e.stopImmediatePropagation();
    const mouse = input.getMouseWorldPos();
    if (!mouse || !isValidTurretSpot(mouse)) return;
    sendPlaceTurret(mouse.x, mouse.y);
    placementMode = false;
    menu.hidden = true;
  },
  { capture: true },
);

socket.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data) as ServerMessage;

  if (msg.type === "welcome") {
    myPlayerId = msg.playerId;
    try {
      localStorage.setItem(PLAYER_ID_KEY, msg.playerId);
    } catch {
      // ignore — see getOrCreatePlayerId()
    }
    return;
  }
  if (msg.type === "full") {
    setConnStatus("disconnected", "game is full (max 4 players)");
    return;
  }
  if (msg.type === "duplicate_identity") {
    setConnStatus("disconnected", "already connected elsewhere");
    return;
  }
  if (msg.type === "rejected") {
    rejectionNotice = `${msg.action.replace(/_/g, " ")}: ${msg.reason}`;
    clearTimeout(rejectionTimer);
    rejectionTimer = setTimeout(() => {
      rejectionNotice = undefined;
    }, 2500);
    return;
  }

  collectDeathEffects(currentState?.zombies, msg.zombies, performance.now(), deathEffects);
  previousState = currentState;
  previousReceivedAt = currentReceivedAt;
  currentState = msg;
  currentReceivedAt = performance.now();
  const self = findSelf(currentState);
  if (self) prediction.reconcile(self, currentReceivedAt);

  // One tracer per turret that actually fired this tick, same effect/tracer
  // pool the player's own shots use.
  for (const t of currentState.turrets) {
    const prevFired = lastTurretShotsFired.get(t.id) ?? 0;
    if (t.shotsFired > prevFired && t.target) {
      const angle = Math.atan2(t.target.y - t.y, t.target.x - t.x);
      effects.push({ x: t.x, y: t.y, angle, firedAt: performance.now() });
    }
    lastTurretShotsFired.set(t.id, t.shotsFired);
  }

  updateHud(currentState);
  updatePhaseUi(currentState.phase);
  renderMenu(currentState);
});

const icon = (region: { sx: number; sy: number; sw: number; sh: number }, size = 16): string =>
  `<span style="${uiIconStyle(region, size)}"></span>`;

const updateHud = (state: StateMessage): void => {
  const wallLine = state.wallLevel > 0 ? `${icon(UI_REGIONS.shield)} Wall Lv${state.wallLevel} HP ${state.wallHp} / ${state.wallMaxHp}` : `${icon(UI_REGIONS.shield)} Wall: none`;
  const turretLine = `Turrets: ${state.turrets.length} / ${MAX_TURRETS}`;
  const self = findSelf(state);

  const statusLine = self
    ? self.status === "alive"
      ? `${icon(UI_REGIONS.heart)} ${self.hp} / ${self.maxHp}${self.healing ? " (healing…)" : ""}${self.invulnerable ? " (invulnerable)" : ""}`
      : self.status === "downed"
        ? `${icon(UI_REGIONS.skull)} DOWNED — ${Math.ceil(self.downedRemainingMs / 1000)}s left (hold E near a teammate to revive, or wait)`
        : `${icon(UI_REGIONS.skull)} DEAD — a teammate can resurrect you at the base`
    : "—";

  const aliveCount = state.players.filter((p) => p.status === "alive").length;
  const downedCount = state.players.filter((p) => p.status === "downed").length;
  const deadCount = state.players.filter((p) => p.status === "dead").length;
  const teamLine = `Team: ${aliveCount} alive, ${downedCount} downed, ${deadCount}${deadCount > 0 ? ` ${icon(UI_REGIONS.skull)}` : ""} dead`;

  hud.innerHTML = [
    `${icon(UI_REGIONS.house)} Day ${state.day}`,
    `${icon(UI_REGIONS.heart)} Base HP ${state.baseHp} / ${state.baseMaxHp}`,
    wallLine,
    turretLine,
    `${icon(UI_REGIONS.star)} Shared XP: ${state.sharedXp}`,
    `You: ${statusLine}`,
    self ? `${icon(UI_REGIONS.medkit)} Medkits: ${self.medkits} / ${MEDKIT_MAX} (H to use)` : "",
    teamLine,
    ...(rejectionNotice ? [`<span class="rejected">${rejectionNotice}</span>`] : []),
  ]
    .filter(Boolean)
    .join("<br>");
};

const PHASE_LABELS: Record<GamePhase, string> = {
  waiting: "READY",
  running: "",
  paused: "PAUSED",
  game_over: `${icon(UI_REGIONS.skull, 32)} GAME OVER`,
  victory: `${icon(UI_REGIONS.star, 32)} VICTORY`,
};

const updatePhaseUi = (phase: GamePhase): void => {
  banner.innerHTML = PHASE_LABELS[phase];
  btnStart.hidden = phase !== "waiting";
  btnPause.hidden = phase !== "running";
  btnResume.hidden = phase !== "paused";
  btnRetry.hidden = phase !== "game_over";
  if (phase !== "running") {
    if (menuOpen) closeMenu();
    if (placementMode) cancelPlacement();
  }
};

let lastFrameTimestamp: number | undefined;
let frozenAt: number | undefined;

const frame = (timestamp: number): void => {
  const dtMs = lastFrameTimestamp === undefined ? 0 : timestamp - lastFrameTimestamp;
  lastFrameTimestamp = timestamp;

  if (currentState) {
    const self = findSelf(currentState);
    // Prediction/local movement only makes sense for an alive player — a
    // downed/dead one can't move, and the server never advances their
    // position either (GameLoop's own tick skips non-alive players).
    const isRunning = currentState.phase === "running" && self?.status === "alive";
    if (isRunning) {
      prediction.tick(input.getMoveState(), dtMs);
      frozenAt = undefined;
    } else if (frozenAt === undefined) {
      frozenAt = timestamp;
    }
    const predictionNow = isRunning ? timestamp : (frozenAt ?? timestamp);

    const displayState = interpolateState(previousState, previousReceivedAt, currentState, currentReceivedAt, timestamp);
    const predictedPos = prediction.getDisplayPos(predictionNow);
    displayState.players = displayState.players.map((p) =>
      p.id === myPlayerId && p.status === "alive" ? { ...p, x: predictedPos.x, y: predictedPos.y } : p,
    );

    render(ctx, CANVAS_SIZE, displayState, input.getAimAngle(), myPlayerId);
    renderDeathEffects(ctx, CANVAS_SIZE / WORLD_SIZE, deathEffects, timestamp);
    renderDayProgress(ctx, CANVAS_SIZE, displayState.day, displayState.killedZombies, displayState.totalZombiesForDay);
    if (displayState.dayIntroRemainingMs > 0) {
      renderDayIntro(ctx, CANVAS_SIZE, displayState.day, displayState.dayIntroRemainingMs);
    }

    for (let i = effects.length - 1; i >= 0; i--) {
      if (timestamp - effects[i].firedAt > TRACER_LIFETIME_MS) effects.splice(i, 1);
    }
    renderShotEffects(ctx, CANVAS_SIZE, effects, timestamp);

    const mouse = input.getMouseWorldPos();
    if (mouse) renderCrosshair(ctx, CANVAS_SIZE, mouse);
    if (placementMode && mouse) renderTurretPlacementPreview(ctx, CANVAS_SIZE, mouse, isValidTurretSpot(mouse));

    // The menu (and placement mode) auto-close if the player walks out of
    // range of whatever they opened it near.
    if (menuOpen && menuContext?.kind === "base" && !playerInBaseRange()) closeMenu();
    if (menuOpen && menuContext?.kind === "turret") {
      const turretId = menuContext.turretId;
      const stillNear = currentState.turrets.some(
        (t) => t.id === turretId && t.hp > 0 && distance(prediction.getDisplayPos(performance.now()), { x: t.x, y: t.y }) <= TURRET_INTERACT_RANGE,
      );
      if (!stillNear) closeMenu();
    }
    if (placementMode && !playerInBaseRange()) cancelPlacement();
  }
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
