import {
  BASE_ATTACK_RANGE,
  BASE_INTERACT_RANGE,
  BASE_POS,
  MAX_TURRETS,
  MEDKIT_COST,
  MEDKIT_MAX,
  REVIVE_RANGE,
  resurrectCostForDay,
  TURRET_BUILD_RADIUS,
  TURRET_INTERACT_RANGE,
  TURRET_LEVELS,
  TURRET_MAX_LEVEL,
  WALL_LEVELS,
  WALL_MAX_LEVEL,
  WALL_RING_RADIUS,
} from "./defense-config.ts";
import type { ClientMessage, ControlMessage, GamePhase, InteractAction, PlayerSnapshot, ServerMessage, StateMessage, TurretAction, ZombieSnapshot, ZombieType } from "./protocol.ts";
import { InputController } from "./input.ts";
import { interpolateState } from "./interpolate.ts";
import { LocalPlayerPrediction } from "./prediction.ts";
import {
  collectDeathEffects,
  render,
  renderCrosshair,
  renderDamageNumbers,
  renderDamageVignette,
  renderDayIntro,
  renderDayProgress,
  renderDeathEffects,
  renderFlyingZombie,
  renderImpactEffects,
  renderShotEffects,
  renderTurretPlacementPreview,
  renderZombieProjectiles,
  DAMAGE_NUMBER_MS,
  EXPLOSION_EFFECT_MS,
  PROJECTILE_TRAVEL_MS,
  TRACER_LIFETIME_MS,
  uiIcon,
  type DamageNumber,
  type DeathEffect,
  type ImpactEffect,
  type ShotEffect,
  type ZombieProjectile,
} from "./render.ts";
import { isReady, zombieWalkSheet, type SpritedZombieType, type UiIconName } from "./sprites.ts";
import { overlapsAnyBuilding } from "./obstacles.ts";
import { computeCamera, clampViewSize, screenToWorld, DEFAULT_VIEW_SIZE, type Camera } from "./camera.ts";

// Must match src/server/game-state.ts's MAP_SIZE (see protocol.ts's comment
// on why this is a duplicated constant, not a shared import).
const WORLD_SIZE = 1000;
// The canvas now resizes to fill the available viewport (see
// resizeCanvas() below) instead of staying a fixed 800x800 — canvasSize is
// read fresh every frame from the live canvas element rather than this
// constant, which only sets the very first size before layout runs.
const INITIAL_CANVAS_SIZE = 800;

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

const canvasEl = document.querySelector<HTMLCanvasElement>("#game");
if (!canvasEl) throw new Error("index.html is missing #game");
const canvas: HTMLCanvasElement = canvasEl;
const hud = document.querySelector<HTMLDivElement>("#hud");
if (!hud) throw new Error("index.html is missing #hud");
const conn = document.querySelector<HTMLDivElement>("#conn");
if (!conn) throw new Error("index.html is missing #conn");
const banner = document.querySelector<HTMLDivElement>("#phase-banner");
if (!banner) throw new Error("index.html is missing #phase-banner");
const menu = document.querySelector<HTMLDivElement>("#interact-menu");
if (!menu) throw new Error("index.html is missing #interact-menu");
const teamPanel = document.querySelector<HTMLDivElement>("#team-panel");
if (!teamPanel) throw new Error("index.html is missing #team-panel");
const prompt = document.querySelector<HTMLDivElement>("#prompt");
if (!prompt) throw new Error("index.html is missing #prompt");
const enemyIntro = document.querySelector<HTMLDivElement>("#enemy-intro");
if (!enemyIntro) throw new Error("index.html is missing #enemy-intro");
const introPortrait = document.querySelector<HTMLCanvasElement>("#intro-portrait");
if (!introPortrait) throw new Error("index.html is missing #intro-portrait");
const introPortraitCtx = introPortrait.getContext("2d");
if (!introPortraitCtx) throw new Error("2d canvas context unavailable for #intro-portrait");
const introName = document.querySelector<HTMLDivElement>("#intro-name");
if (!introName) throw new Error("index.html is missing #intro-name");
const introBullets = document.querySelector<HTMLUListElement>("#intro-bullets");
if (!introBullets) throw new Error("index.html is missing #intro-bullets");
const introDismissBtn = document.querySelector<HTMLButtonElement>("#intro-dismiss");
if (!introDismissBtn) throw new Error("index.html is missing #intro-dismiss");
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

canvas.width = INITIAL_CANVAS_SIZE;
canvas.height = INITIAL_CANVAS_SIZE;
const ctxOrNull = canvas.getContext("2d");
if (!ctxOrNull) throw new Error("2d canvas context unavailable");
const ctx: CanvasRenderingContext2D = ctxOrNull;
ctx.imageSmoothingEnabled = false; // pixel-art sprites stay crisp when scaled up, not blurred

// Responsive canvas: fills the available viewport instead of a fixed
// 800x800 square, so the game area actually uses the browser window rather
// than sitting in a small fixed box surrounded by unused space. Still
// always square (world is square, camera.ts assumes a square viewport).
// Changing canvas.width/height clears its contents, which is fine — the
// very next animation frame redraws everything from currentState.
const CANVAS_MARGIN = 24;
function resizeCanvas(): void {
  const size = Math.max(320, Math.min(window.innerWidth, window.innerHeight) - CANVAS_MARGIN);
  if (canvas.width !== size || canvas.height !== size) {
    canvas.width = size;
    canvas.height = size;
    ctx.imageSmoothingEnabled = false; // resizing resets context state, including this
  }
}
resizeCanvas();
window.addEventListener("resize", resizeCanvas);

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

// --- Zombie attack feedback: all driven by diffing consecutive snapshots
// against real server fields (ZombieSnapshot.attacksLanded/lastHitKind,
// PlayerSnapshot.hp) in the "state" handler below — never a client-side
// guess at whether or when a hit happened. See render.ts for the drawing. ---
const impactEffects: ImpactEffect[] = [];
const zombieProjectiles: ZombieProjectile[] = [];
const damageNumbers: DamageNumber[] = [];
const lastZombieAttacksLanded = new Map<string, number>();
const zombieLungeUntil = new Map<string, number>(); // zombie id -> lunge started at (performance.now())
const playerFlashUntil = new Map<string, number>(); // player id -> flash started at (performance.now())
let selfFlashAt: number | undefined; // local-player screen vignette

// --- "New enemy" intro popups ------------------------------------------------
//
// Shown the first time a zombie type appears in a run (not every wave it's
// in). Driven by StateMessage.dayWaveComposition — the day's fixed, known-
// in-advance composition — rather than waiting for an actual instance of
// that type to spawn, so the warning arrives before the player is already
// fighting one. Text content is exactly what the brief specified; `bullets`
// only exist for the two types asked for (giant, flying) — anything else in
// ZombieType simply has no entry and is never queued.
const ENEMY_INTRO: Partial<Record<ZombieType, { name: string; bullets: string[] }>> = {
  flying: { name: "Flying Zombie", bullets: ["Ranged attacker", "Ignores walls", "Stay moving and keep distance"] },
  giant: { name: "Giant Zombie", bullets: ["High HP", "Heavy melee threat", "Explodes on death"] },
};
const ALL_ZOMBIE_TYPES: readonly ZombieType[] = ["normal", "flying", "giant", "boss"];
const INTRO_AUTO_DISMISS_MS = 9000;

const seenEnemyTypes = new Set<ZombieType>();
let introLastCheckedDay: number | undefined;
const introQueue: ZombieType[] = [];
let currentIntro: ZombieType | undefined;
let introShownAt: number | undefined;

// Called once per "state" message. On the very first snapshot after
// connecting, just records what the CURRENT day already contains as
// "already known" (so reconnecting mid-run on, say, Day 5 doesn't suddenly
// show three intros at once for types that appeared days ago) — only a
// day boundary crossed AFTER that point can queue a new intro.
const checkForNewEnemies = (state: StateMessage): void => {
  if (introLastCheckedDay === undefined) {
    introLastCheckedDay = state.day;
    for (const t of ALL_ZOMBIE_TYPES) if (state.dayWaveComposition[t] > 0) seenEnemyTypes.add(t);
    return;
  }
  if (state.day === introLastCheckedDay) return; // same day (e.g. a tick, or a retry) — nothing new to check
  introLastCheckedDay = state.day;
  for (const t of ALL_ZOMBIE_TYPES) {
    if (state.dayWaveComposition[t] > 0 && !seenEnemyTypes.has(t)) {
      seenEnemyTypes.add(t);
      if (ENEMY_INTRO[t]) introQueue.push(t);
    }
  }
  advanceIntroQueue();
};

const drawIntroPortrait = (type: ZombieType): void => {
  const ctx2 = introPortraitCtx;
  ctx2.clearRect(0, 0, introPortrait.width, introPortrait.height);
  ctx2.imageSmoothingEnabled = false;
  const cx = introPortrait.width / 2;
  const cy = introPortrait.height / 2;
  if (type === "flying") {
    ctx2.save();
    ctx2.translate(cx, cy);
    renderFlyingZombie(ctx2, 84, true, 0, 0, performance.now());
    ctx2.restore();
    return;
  }
  // No dedicated "idle" sheet in the LPC set (see sprites.ts) — frame 0 of
  // the walk-down cycle doubles as a standing portrait pose, same "reuse
  // what exists" choice render.ts's renderPlayer makes for players.
  const sheet = zombieWalkSheet(type as SpritedZombieType, "down");
  if (isReady(sheet.image)) {
    const size = 90;
    ctx2.drawImage(sheet.image, 0, 0, sheet.frameWidth, sheet.frameHeight, cx - size / 2, cy - size / 2, size, size);
  }
};

const advanceIntroQueue = (): void => {
  if (currentIntro !== undefined) return;
  const next = introQueue.shift();
  if (!next) return;
  const info = ENEMY_INTRO[next];
  if (!info) return;
  currentIntro = next;
  introShownAt = performance.now();
  introName.textContent = info.name;
  introBullets.innerHTML = info.bullets.map((b) => `<li>${b}</li>`).join("");
  drawIntroPortrait(next);
  enemyIntro.hidden = false;
};

const dismissIntro = (): void => {
  if (currentIntro === undefined) return;
  currentIntro = undefined;
  introShownAt = undefined;
  enemyIntro.hidden = true;
  advanceIntroQueue();
};

// A full restart means a genuinely new run — the next time flying/giant show
// up (Day 3/4) should introduce them again, same as a real first encounter.
const resetEnemyIntros = (): void => {
  seenEnemyTypes.clear();
  introQueue.length = 0;
  introLastCheckedDay = undefined;
  dismissIntro();
};

introDismissBtn.addEventListener("click", dismissIntro);

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
btnRestart.addEventListener("click", () => {
  sendControl("restart");
  resetEnemyIntros();
});

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

// Recomputed once per animation frame (the frame() loop below) from the
// local player's current predicted/displayed position — input.ts's mouse
// tracking and every render call this frame reads the SAME camera instance,
// so aim/placement never desyncs from what's actually drawn even as the
// player moves and the view pans to follow.
let currentCamera: Camera = computeCamera(WORLD_SIZE / 2, WORLD_SIZE / 2, canvas.width);

// --- Mouse-wheel zoom: client-only, purely a camera.viewSize change — never
// touches any server-authoritative number (speed, ranges, build distances).
// Two numbers rather than one: `zoomTarget` jumps immediately to wherever
// the wheel points it (clamped), `zoomCurrent` eases toward that target a
// little every frame (frame()'s own call below) so a fast scroll reads as a
// smooth zoom instead of snapping. Module-level state, so each browser
// tab/session has its own independent zoom level — there is nothing here
// that could make one player's scroll affect another player's view. ---
let zoomTarget = DEFAULT_VIEW_SIZE;
let zoomCurrent = DEFAULT_VIEW_SIZE;
const ZOOM_STEP_FACTOR = 1.15; // each wheel "tick" scales the view ~15%
const ZOOM_EASE_PER_SEC = 10; // higher = snappier easing toward zoomTarget

canvas.addEventListener(
  "wheel",
  (e) => {
    // Without this, the wheel both zooms the camera AND scrolls the page
    // behind/around the canvas (the canvas is a normal in-flow element, not
    // a fixed fullscreen one) — preventDefault stops the page scroll while
    // leaving the camera zoom as the wheel's only visible effect.
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1 / ZOOM_STEP_FACTOR : ZOOM_STEP_FACTOR; // deltaY<0 = scroll up = zoom in = smaller viewSize
    zoomTarget = clampViewSize(zoomTarget * factor);
  },
  { passive: false },
);

const input = new InputController({
  canvas,
  getCamera: () => currentCamera,
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
  | { key: string; label: string; cost: number; icon: UiIconName; kind: "interact"; action: InteractAction }
  | { key: string; label: string; cost: number; icon: UiIconName; kind: "place_turret" }
  | { key: string; label: string; cost: number; icon: UiIconName; kind: "turret_action"; turretId: string; action: TurretAction };

type MenuContext = { kind: "base" } | { kind: "turret"; turretId: string };

let menuOpen = false;
let menuContext: MenuContext | undefined;
let menuChoices: MenuChoice[] = [];
let placementMode = false;

const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

// Where a zombie's just-landed hit should visually appear, read straight off
// the server's own lastHitKind/lastHitTargetId (protocol.ts) — never guessed
// from which target merely looks nearest on this client.
const zombieHitTargetPos = (z: ZombieSnapshot, state: StateMessage): { x: number; y: number } | undefined => {
  if (z.lastHitKind === "player") {
    const target = state.players.find((p) => p.id === z.lastHitTargetId);
    return target ? { x: target.x, y: target.y } : undefined;
  }
  if (z.lastHitKind === "turret") {
    const target = state.turrets.find((t) => t.id === z.lastHitTargetId);
    return target ? { x: target.x, y: target.y } : undefined;
  }
  if (z.lastHitKind === "wall") {
    const d = distance(z, BASE_POS) || 1;
    return { x: BASE_POS.x + ((z.x - BASE_POS.x) / d) * WALL_RING_RADIUS, y: BASE_POS.y + ((z.y - BASE_POS.y) / d) * WALL_RING_RADIUS };
  }
  if (z.lastHitKind === "base") return BASE_POS;
  return undefined;
};

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
  if (d < BASE_ATTACK_RANGE || d > TURRET_BUILD_RADIUS) return false;
  return !overlapsAnyBuilding(pos);
};

// Display-only proximity check, same purpose as nearestTurretInRange/
// playerInBaseRange above — mirrors the server's own REVIVE_RANGE purely to
// decide whether to show a "[Hold E] Revive" prompt. The server independently
// re-validates range/status on every input; nothing here can revive anyone.
const nearestDownedTeammate = (state: StateMessage | undefined): PlayerSnapshot | undefined => {
  if (!state) return undefined;
  const pos = prediction.getDisplayPos(performance.now());
  let best: { player: PlayerSnapshot; d: number } | undefined;
  for (const p of state.players) {
    if (p.id === myPlayerId || p.status !== "downed") continue;
    const d = distance(pos, p);
    if (d <= REVIVE_RANGE && (!best || d < best.d)) best = { player: p, d };
  }
  return best?.player;
};

// A manual distributive-Omit equivalent — plain `Omit<MenuChoice, "key">`
// collapses a union down to its common keys only, which would lose the
// `action`/`turretId` fields that only exist on some branches.
type UnkeyedChoice =
  | { label: string; cost: number; icon: UiIconName; kind: "interact"; action: InteractAction }
  | { label: string; cost: number; icon: UiIconName; kind: "place_turret" }
  | { label: string; cost: number; icon: UiIconName; kind: "turret_action"; turretId: string; action: TurretAction };

const computeBaseChoices = (state: StateMessage, self: StateMessage["players"][number] | undefined): UnkeyedChoice[] => {
  const choices: UnkeyedChoice[] = [];
  if (state.wallLevel === 0) {
    choices.push({ label: "Build Wall", cost: WALL_LEVELS[1].cost, icon: "shield", kind: "interact", action: "build_wall" });
  } else if (state.wallLevel < WALL_MAX_LEVEL) {
    const next = WALL_LEVELS[state.wallLevel + 1];
    if (next) choices.push({ label: `Upgrade Wall (Lv${state.wallLevel}→${state.wallLevel + 1})`, cost: next.cost, icon: "shield", kind: "interact", action: "upgrade_wall" });
  }
  if (state.turrets.length < MAX_TURRETS) {
    choices.push({ label: "Build Turret", cost: TURRET_LEVELS[1].cost, icon: "coin", kind: "place_turret" });
  }
  if (state.players.some((p) => p.status === "dead")) {
    choices.push({ label: "Revive Dead Teammate", cost: resurrectCostForDay(state.day), icon: "skull", kind: "interact", action: "revive_dead" });
  }
  if (self && self.medkits < MEDKIT_MAX) {
    choices.push({ label: `Buy Medkit (${self.medkits}/${MEDKIT_MAX} carried)`, cost: MEDKIT_COST, icon: "medkit", kind: "interact", action: "buy_medkit" });
  }
  return choices;
};

const computeTurretChoices = (state: StateMessage, turretId: string): UnkeyedChoice[] => {
  const turret = state.turrets.find((t) => t.id === turretId);
  if (!turret) return [];
  const choices: UnkeyedChoice[] = [];
  if (turret.level < TURRET_MAX_LEVEL) {
    const next = TURRET_LEVELS[turret.level + 1];
    choices.push({ label: `Upgrade This Turret (Lv${turret.level}→${turret.level + 1})`, cost: next.cost, icon: "coin", kind: "turret_action", turretId, action: "upgrade" });
  }
  if (turret.hp < turret.maxHp) {
    const cost = TURRET_LEVELS[turret.level].repairCost;
    choices.push({ label: `Repair This Turret (${turret.hp}/${turret.maxHp} HP)`, cost, icon: "coin", kind: "turret_action", turretId, action: "repair" });
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
    menu.innerHTML = [
      `<div class="menu-heading">${uiIcon("shield")} PLACING TURRET</div>`,
      `<div class="menu-hint">Click a valid spot (dashed ring around the base)</div>`,
      `<div class="menu-hint">[X / Esc] Cancel</div>`,
    ].join("");
    menu.hidden = false;
    return;
  }
  if (!menuOpen || !state || !menuContext) {
    menu.hidden = true;
    return;
  }
  menuChoices = computeMenuChoices(state, menuContext);
  const heading = menuContext.kind === "base" ? "BASE" : "TURRET";
  const rows = menuChoices.map((o) => {
    const affordable = state.sharedXp >= o.cost;
    return [
      `<div class="menu-row${affordable ? "" : " menu-row-disabled"}">`,
      `<span class="menu-key">[${o.key}]</span>`,
      `${uiIcon(o.icon)}`,
      `<span class="menu-label">${o.label}</span>`,
      `<span class="menu-cost${affordable ? "" : " menu-cost-insufficient"}">${uiIcon("coin", 14)}${o.cost} XP</span>`,
      `</div>`,
    ].join("");
  });
  menu.innerHTML = [`<div class="menu-heading">${heading}</div>`, ...rows, `<div class="menu-hint">[X / Esc] Close</div>`].join("");
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

// A passive "here's what you can do" hint — every action it names already
// exists (X-menu, hold E, H); this only surfaces them contextually instead of
// requiring the player to remember keybinds. Hidden whenever the menu/
// placement overlay is already showing its own instructions.
const updatePrompt = (state: StateMessage | undefined): void => {
  if (!state || state.phase !== "running" || menuOpen || placementMode) {
    prompt.hidden = true;
    return;
  }
  const self = findSelf(state);
  const hints: string[] = [];
  const turretId = nearestTurretInRange(state);
  if (turretId) hints.push("[X] Turret Menu");
  else if (playerInBaseRange()) hints.push("[X] Base Menu");
  if (self?.status === "alive" && nearestDownedTeammate(state)) hints.push("[Hold E] Revive");
  if (self?.status === "alive" && self.medkits > 0 && self.hp < self.maxHp) hints.push("[H] Use Medkit");

  if (hints.length === 0) {
    prompt.hidden = true;
    return;
  }
  prompt.innerHTML = hints.map((h) => `<span class="prompt-hint">${h}</span>`).join("");
  prompt.hidden = false;
};

window.addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();

  if (currentIntro !== undefined && (key === "enter" || key === " " || key === "escape")) {
    dismissIntro();
    return;
  }

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

  // Player damage feedback: driven purely by the real hp drop between two
  // authoritative snapshots (works for every damage source — zombie melee,
  // a flying zombie's "ranged" hit, a giant's death explosion — since
  // #damagePlayer is the one place anything server-side can lower hp; see
  // PROCESS.md). Never a guessed/predicted hit.
  const now0 = performance.now();
  for (const p of currentState.players) {
    const prevP = previousState?.players.find((q) => q.id === p.id);
    if (prevP && p.hp < prevP.hp) {
      const amount = prevP.hp - p.hp;
      damageNumbers.push({ x: p.x, y: p.y, amount, spawnedAt: now0 });
      playerFlashUntil.set(p.id, now0);
      if (p.id === myPlayerId) selfFlashAt = now0;
    }
  }

  // Zombie attack effects: driven by ZombieSnapshot.attacksLanded actually
  // increasing (a real landed hit this tick — see protocol.ts), never by
  // `attacking`/cooldown timing alone. lastHitKind/lastHitTargetId say
  // exactly what was hit, so the effect lands exactly where the server's
  // own combat resolution says it did.
  for (const z of currentState.zombies) {
    const prevLanded = lastZombieAttacksLanded.get(z.id) ?? 0;
    if (z.attacksLanded > prevLanded) {
      const targetPos = zombieHitTargetPos(z, currentState);
      if (targetPos) {
        if (z.type === "flying") {
          zombieProjectiles.push({ fromX: z.x, fromY: z.y, toX: targetPos.x, toY: targetPos.y, firedAt: now0 });
          impactEffects.push({ x: targetPos.x, y: targetPos.y, kind: "melee", startedAt: now0 + PROJECTILE_TRAVEL_MS });
        } else {
          impactEffects.push({ x: targetPos.x, y: targetPos.y, kind: "melee", startedAt: now0 });
          zombieLungeUntil.set(z.id, now0);
        }
      }
    }
    lastZombieAttacksLanded.set(z.id, z.attacksLanded);
  }

  // A giant that just vanished died — collectDeathEffects already covers the
  // generic fade; a death explosion additionally gets its own shockwave,
  // since "giant exploded on an ally across the base" is exactly the kind of
  // damage source a player can otherwise completely fail to notice.
  if (previousState) {
    const currentZombieIds = new Set(currentState.zombies.map((z) => z.id));
    for (const z of previousState.zombies) {
      if (z.type === "giant" && !currentZombieIds.has(z.id)) {
        impactEffects.push({ x: z.x, y: z.y, kind: "explosion", startedAt: now0 });
      }
    }
  }

  checkForNewEnemies(currentState);
  updateHud(currentState);
  updateTeamPanel(currentState);
  updatePhaseUi(currentState.phase);
  renderMenu(currentState);
});

// A small HP/XP-style meter bar: a fixed-colour track with a proportional
// fill, used by both the HUD (base/player HP, wall HP) and the team panel
// (per-player HP) instead of numbers alone — numbers are always shown
// alongside it too (CLAUDE.md: "do not hide important game state behind
// decorative UI").
const bar = (value: number, max: number, variant: "hp" | "xp" | "wall"): string => {
  const fraction = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return `<span class="bar bar-${variant}"><span class="bar-fill" style="width:${(fraction * 100).toFixed(0)}%"></span></span>`;
};

const updateHud = (state: StateMessage): void => {
  const self = findSelf(state);

  const wallLine =
    state.wallLevel > 0
      ? `${uiIcon("shield")} Wall Lv${state.wallLevel} ${bar(state.wallHp, state.wallMaxHp, "wall")} ${state.wallHp}/${state.wallMaxHp}`
      : `${uiIcon("shield")} Wall: none`;
  const turretLine = `Turrets: ${state.turrets.length} / ${MAX_TURRETS}`;

  const statusLine = self
    ? self.status === "alive"
      ? `${uiIcon("heart")} ${bar(self.hp, self.maxHp, "hp")} ${self.hp}/${self.maxHp}${self.healing ? " (healing…)" : ""}${self.invulnerable ? " (invulnerable)" : ""}`
      : self.status === "downed"
        ? `${uiIcon("skull")} DOWNED — ${Math.ceil(self.downedRemainingMs / 1000)}s left (hold E near a teammate to revive, or wait)`
        : `${uiIcon("skull")} DEAD — a teammate can resurrect you at the base`
    : "—";

  hud.innerHTML = [
    `${uiIcon("house")} Day ${state.day}`,
    `${uiIcon("heart")} Base ${bar(state.baseHp, state.baseMaxHp, "hp")} ${state.baseHp}/${state.baseMaxHp}`,
    wallLine,
    turretLine,
    `${uiIcon("coin")} Shared XP: ${state.sharedXp}`,
    `You: ${statusLine}`,
    self ? `${uiIcon("medkit")} Medkits: ${self.medkits} / ${MEDKIT_MAX} (H to use)` : "",
    ...(rejectionNotice ? [`<span class="rejected">${rejectionNotice}</span>`] : []),
  ]
    .filter(Boolean)
    .join("<br>");
};

// Crit 10's gameplay-expansion requirement "their own HP/status... and any
// teammate's status" — previously only a team-wide alive/downed/dead count
// (updateHud's old teamLine); this shows each of up to 4 players by name-
// colour (matching the canvas's own per-player colour), HP bar, explicit
// downed/dead status, and — while someone's actively reviving them — a
// revival progress bar with its remaining time, straight from
// state.reviveProgress (already authoritative, already sent every tick).
const REMOTE_PLAYER_COLORS = ["#ff6666", "#66b2ff", "#66ff99", "#ffcc66"];
const LOCAL_PLAYER_COLOR = "#ffcc00";

const updateTeamPanel = (state: StateMessage): void => {
  const rows = state.players.map((p) => {
    const isSelf = p.id === myPlayerId;
    const color = isSelf ? LOCAL_PLAYER_COLOR : REMOTE_PLAYER_COLORS[p.colorIndex % REMOTE_PLAYER_COLORS.length];
    const swatch = `<span class="player-swatch" style="background:${color}"></span>`;
    const label = isSelf ? "You" : `P${p.colorIndex + 1}`;

    let statusHtml: string;
    if (p.status === "alive") {
      statusHtml = `${bar(p.hp, p.maxHp, "hp")} ${p.hp}/${p.maxHp}`;
    } else if (p.status === "downed") {
      const revive = state.reviveProgress.find((r) => r.targetId === p.id);
      statusHtml = `<span class="player-downed">${uiIcon("skull", 14)} DOWNED ${Math.ceil(p.downedRemainingMs / 1000)}s</span>`;
      if (revive) {
        const reviveFraction = Math.max(0, Math.min(1, 1 - revive.remainingMs / 3000));
        statusHtml += ` <span class="bar bar-revive"><span class="bar-fill" style="width:${(reviveFraction * 100).toFixed(0)}%"></span></span> reviving ${Math.ceil(revive.remainingMs / 1000)}s`;
      }
    } else {
      statusHtml = `<span class="player-dead">${uiIcon("skull", 14)} DEAD</span>`;
    }
    return `<div class="player-row">${swatch}<span class="player-label">${label}</span>${statusHtml}</div>`;
  });
  teamPanel.innerHTML = [`<div class="menu-heading">TEAM (${state.players.length}/4)</div>`, ...rows].join("");
};

const PHASE_LABELS: Record<GamePhase, { title: string; icon?: UiIconName; subtitle?: string }> = {
  waiting: { title: "LAST STAND", subtitle: "Press Start to begin Day 1" },
  running: { title: "" },
  paused: { title: "PAUSED", subtitle: "Press Resume to continue" },
  game_over: { title: "GAME OVER", icon: "skull" },
  victory: { title: "VICTORY", icon: "trophy", subtitle: "All 28 days survived" },
};

const CONTROLS_LEGEND = [
  ["WASD", "Move"],
  ["Mouse", "Aim / Shoot"],
  ["X", "Base / turret menu"],
  ["Hold E", "Revive downed teammate"],
  ["H", "Use medkit"],
];

const controlsLegendHtml = (): string =>
  `<div class="controls-legend">${CONTROLS_LEGEND.map(([key, desc]) => `<div><span class="legend-key">${key}</span>${desc}</div>`).join("")}</div>`;

const updatePhaseUi = (phase: GamePhase): void => {
  const info = PHASE_LABELS[phase];
  if (!info.title) {
    banner.innerHTML = "";
  } else {
    const titleLine = `${info.icon ? uiIcon(info.icon, 32) : ""} ${info.title}`;
    const subtitle = phase === "game_over" && currentState ? `Reached Day ${currentState.day}` : info.subtitle;
    const legend = phase === "waiting" || phase === "paused" ? controlsLegendHtml() : "";
    const panelClass = phase === "game_over" ? " danger" : phase === "victory" ? " success" : "";
    banner.innerHTML = `<div class="phase-panel${panelClass}"><div class="phase-title">${titleLine}</div>${subtitle ? `<div class="phase-subtitle">${subtitle}</div>` : ""}${legend}</div>`;
  }
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

  if (currentIntro !== undefined && introShownAt !== undefined && timestamp - introShownAt > INTRO_AUTO_DISMISS_MS) {
    dismissIntro();
  }

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

    // The camera follows the LOCAL player's own displayed position (falling
    // back to the map centre before a self row exists yet, e.g. the very
    // first frame) — recomputed fresh every frame from the live canvas size,
    // so a window resize takes effect immediately without a separate resize
    // handler needing to touch the camera itself.
    const selfDisplay = displayState.players.find((p) => p.id === myPlayerId);
    const followPos = selfDisplay ?? predictedPos;

    // Ease zoomCurrent toward zoomTarget (set instantly by the wheel
    // handler above) a little more each frame — exponential decay toward
    // the target, framerate-independent via dtMs, so a zoom reads as a
    // smooth glide rather than snapping straight to the new level.
    if (dtMs > 0) {
      const t = 1 - Math.exp(-(ZOOM_EASE_PER_SEC * dtMs) / 1000);
      zoomCurrent += (zoomTarget - zoomCurrent) * t;
    }
    currentCamera = computeCamera(followPos.x, followPos.y, canvas.width, zoomCurrent);

    render(ctx, currentCamera, displayState, input.getAimAngle(), myPlayerId, zombieLungeUntil, playerFlashUntil);
    renderDeathEffects(ctx, currentCamera, deathEffects, timestamp);
    renderDayProgress(ctx, canvas.width, displayState.day, displayState.killedZombies, displayState.totalZombiesForDay, displayState.dayWaveComposition);
    if (displayState.dayIntroRemainingMs > 0) {
      renderDayIntro(ctx, canvas.width, displayState.day, displayState.dayIntroRemainingMs);
    }

    for (let i = effects.length - 1; i >= 0; i--) {
      if (timestamp - effects[i].firedAt > TRACER_LIFETIME_MS) effects.splice(i, 1);
    }
    renderShotEffects(ctx, currentCamera, effects, timestamp);

    for (let i = zombieProjectiles.length - 1; i >= 0; i--) {
      if (timestamp - zombieProjectiles[i].firedAt > PROJECTILE_TRAVEL_MS) zombieProjectiles.splice(i, 1);
    }
    renderZombieProjectiles(ctx, currentCamera, zombieProjectiles, timestamp);

    for (let i = impactEffects.length - 1; i >= 0; i--) {
      if (timestamp - impactEffects[i].startedAt > EXPLOSION_EFFECT_MS) impactEffects.splice(i, 1);
    }
    renderImpactEffects(ctx, currentCamera, impactEffects, timestamp);

    for (let i = damageNumbers.length - 1; i >= 0; i--) {
      if (timestamp - damageNumbers[i].spawnedAt > DAMAGE_NUMBER_MS) damageNumbers.splice(i, 1);
    }
    renderDamageNumbers(ctx, currentCamera, damageNumbers, timestamp);

    renderDamageVignette(ctx, canvas.width, selfFlashAt, timestamp);

    const mouse = input.getMouseWorldPos();
    if (mouse) renderCrosshair(ctx, currentCamera, mouse);
    if (placementMode && mouse) renderTurretPlacementPreview(ctx, currentCamera, mouse, isValidTurretSpot(mouse));

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
    updatePrompt(currentState);
  }
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
