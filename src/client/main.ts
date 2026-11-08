import {
  BASE_ATTACK_RANGE,
  BASE_INTERACT_RANGE,
  BASE_POS,
  MAX_TURRETS,
  MEDKIT_COST,
  MEDKIT_MAX,
  PISTOL_CONE_HALF_ANGLE,
  PISTOL_RANGE,
  REVIVE_RANGE,
  resurrectCostForDay,
  TURRET_BUILD_RADIUS,
  TURRET_INTERACT_RANGE,
  TURRET_LEVELS,
  TURRET_MAX_LEVEL,
  WALL_LEVELS,
  WALL_MAX_LEVEL,
} from "./defense-config.ts";
import { WALL_HALF_EXTENT } from "./obstacles.ts";
import type { ClientMessage, ControlMessage, GamePhase, InteractAction, PlayerSnapshot, ServerMessage, StateMessage, TurretAction, ZombieSnapshot, ZombieType } from "./protocol.ts";
import { InputController } from "./input.ts";
import { interpolateState } from "./interpolate.ts";
import { LocalPlayerPrediction } from "./prediction.ts";
import {
  collectDeathEffects,
  render,
  renderBullets,
  renderCrosshair,
  renderDamageNumbers,
  renderDamageVignette,
  renderDayIntro,
  renderBossEntranceEffects,
  WAVE_BADGES,
  renderDeathEffects,
  renderFlyingZombie,
  renderImpactEffects,
  renderTurretPlacementPreview,
  renderZombieProjectiles,
  BULLET_TRAVEL_MS,
  DAMAGE_NUMBER_MS,
  EXPLOSION_EFFECT_MS,
  PROJECTILE_TRAVEL_MS,
  baseMenuIcon,
  lastZombieDir,
  nextTurretBarrelIndex,
  turretMuzzlePositions,
  uiIcon,
  weaponMuzzleOffset,
  type Bullet,
  type DamageNumber,
  type DeathEffect,
  type ImpactEffect,
  type ZombieProjectile,
} from "./render.ts";
import { giantSheetFor, isReady, zombieWalkSheet, PLAYER_SHEETS, type SpritedZombieType, type UiIconName } from "./sprites.ts";
import { overlapsAnyBuilding } from "./obstacles.ts";
import { computeCamera, clampViewSize, screenToWorld, DEFAULT_VIEW_SIZE, type Camera } from "./camera.ts";

// Must match src/server/game-state.ts's MAP_SIZE (see protocol.ts's comment
// on why this is a duplicated constant, not a shared import).
const WORLD_SIZE = 1000;

// 2026-11-08 HUD-legibility pass: mirrors index.html's --hud-scale (same
// value, kept in sync by hand — a CSS custom property can't be read into a
// JS numeric literal without an extra getComputedStyle round trip for a
// constant that never changes at runtime). Everything CSS can size on its
// own (panel padding/gaps/font-size) uses the CSS variable directly; this
// constant exists only for the handful of sizes main.ts itself sets as raw
// numbers — uiIcon()'s px argument, the player-portrait canvas's pixel
// resolution, and the inline bar width/height literals below, none of which
// a stylesheet can reach.
const HUD_SCALE = 1.45;
// The canvas now resizes to fill the entire browser window (see
// resizeCanvas() below) instead of staying a fixed 800x800 — canvas.width/
// height are read fresh every frame from the live canvas element rather
// than this constant, which only sets the very first size before layout
// runs.
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
const hudTopLeft = document.querySelector<HTMLDivElement>("#hud-top-left");
if (!hudTopLeft) throw new Error("index.html is missing #hud-top-left");
const topBarPlayers = document.querySelector<HTMLDivElement>("#top-bar-players");
if (!topBarPlayers) throw new Error("index.html is missing #top-bar-players");
const topBarDay = document.querySelector<HTMLDivElement>("#top-bar-day");
if (!topBarDay) throw new Error("index.html is missing #top-bar-day");
const topBarWave = document.querySelector<HTMLDivElement>("#top-bar-wave");
if (!topBarWave) throw new Error("index.html is missing #top-bar-wave");
const hudStatusBox = document.querySelector<HTMLDivElement>("#hud-status-box");
if (!hudStatusBox) throw new Error("index.html is missing #hud-status-box");
const hudXpValue = document.querySelector<HTMLDivElement>("#hud-xp-value");
if (!hudXpValue) throw new Error("index.html is missing #hud-xp-value");
const conn = document.querySelector<HTMLDivElement>("#conn");
if (!conn) throw new Error("index.html is missing #conn");
const banner = document.querySelector<HTMLDivElement>("#phase-banner");
if (!banner) throw new Error("index.html is missing #phase-banner");
const menu = document.querySelector<HTMLDivElement>("#interact-menu");
if (!menu) throw new Error("index.html is missing #interact-menu");
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
const btnMenu = document.querySelector<HTMLButtonElement>("#btn-menu");
if (!btnMenu) throw new Error("index.html is missing #btn-menu");
const hudMenuDropdown = document.querySelector<HTMLDivElement>("#hud-menu-dropdown");
if (!hudMenuDropdown) throw new Error("index.html is missing #hud-menu-dropdown");
const btnResume = document.querySelector<HTMLButtonElement>("#btn-resume");
if (!btnResume) throw new Error("index.html is missing #btn-resume");
const btnRetry = document.querySelector<HTMLButtonElement>("#btn-retry");
if (!btnRetry) throw new Error("index.html is missing #btn-retry");
const btnRestart = document.querySelector<HTMLButtonElement>("#btn-restart");
if (!btnRestart) throw new Error("index.html is missing #btn-restart");
// Static icon content for the three top-right icon buttons (set once —
// these never change, unlike btn.hidden which updatePhaseUi toggles every
// state message).
btnStart.innerHTML = uiIcon("play", Math.round(18 * HUD_SCALE));
btnPause.innerHTML = uiIcon("pause", Math.round(18 * HUD_SCALE));
btnMenu.innerHTML = uiIcon("menu", Math.round(18 * HUD_SCALE));
// Hides/shows the whole wrap (title banner + panel together) — the panel
// itself (#character-select) is just the inner chrome-styled card and is
// never hidden on its own.
const characterSelect = document.querySelector<HTMLDivElement>("#character-select-wrap");
if (!characterSelect) throw new Error("index.html is missing #character-select-wrap");
const characterGrid = document.querySelector<HTMLDivElement>("#character-grid");
if (!characterGrid) throw new Error("index.html is missing #character-grid");
const characterCards = [...characterGrid.querySelectorAll<HTMLDivElement>(".character-card")];
if (characterCards.length !== PLAYER_SHEETS.length) throw new Error("index.html's #character-grid card count doesn't match PLAYER_SHEETS");
const characterNameInput = document.querySelector<HTMLInputElement>("#character-name-input");
if (!characterNameInput) throw new Error("index.html is missing #character-name-input");
const characterConfirmBtn = document.querySelector<HTMLButtonElement>("#character-confirm-btn");
if (!characterConfirmBtn) throw new Error("index.html is missing #character-confirm-btn");
const characterCancelBtn = document.querySelector<HTMLButtonElement>("#character-cancel-btn");
if (!characterCancelBtn) throw new Error("index.html is missing #character-cancel-btn");
const characterSelectBackdrop = document.querySelector<HTMLDivElement>("#character-select-backdrop");
if (!characterSelectBackdrop) throw new Error("index.html is missing #character-select-backdrop");
const btnChangeCharacter = document.querySelector<HTMLButtonElement>("#btn-change-character");
if (!btnChangeCharacter) throw new Error("index.html is missing #btn-change-character");

canvas.width = INITIAL_CANVAS_SIZE;
canvas.height = INITIAL_CANVAS_SIZE;
const ctxOrNull = canvas.getContext("2d");
if (!ctxOrNull) throw new Error("2d canvas context unavailable");
const ctx: CanvasRenderingContext2D = ctxOrNull;
ctx.imageSmoothingEnabled = false; // pixel-art sprites stay crisp when scaled up, not blurred

// Responsive canvas: fills the ENTIRE browser window edge-to-edge,
// independently sized per axis — not fit-to-the-shorter-axis-and-letterbox
// (the old behaviour), and not forced square. camera.ts's computeCamera
// derives the world window's width/height from this canvas's own aspect
// ratio, so a wide window shows more world side-to-side rather than a
// stretched image. Changing canvas.width/height clears its contents, which
// is fine — the very next animation frame redraws everything from
// currentState.
function resizeCanvas(): void {
  const width = Math.max(320, window.innerWidth);
  const height = Math.max(240, window.innerHeight);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
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

const bullets: Bullet[] = []; // both the player's own shots AND turret shots now — see render.ts's Bullet/renderBullets
const lastTurretShotsFired = new Map<string, number>();
const lastPlayerShotsFired = new Map<string, number>();
// Player id -> performance.now() their weapon last actually fired — drives
// render.ts's cosmetic recoil kick (drawPlayerWeapon's recoilFrac) for every
// player, set immediately for the local player (input.ts's onShoot, so it
// feels instant on click) and from PlayerSnapshot.shotsFired diffing below
// for every remote player (which has no local click event to hook).
const playerLastShotAt = new Map<string, number>();
// Turret id -> performance.now() it last actually fired — drives
// renderTurret's cosmetic weapon-recoil kick, same shotsFired-diffing
// pattern as playerLastShotAt for remote players (a turret has no local
// click event either).
const turretLastShotAt = new Map<string, number>();

// --- Zombie attack feedback: all driven by diffing consecutive snapshots
// against real server fields (ZombieSnapshot.attacksLanded/lastHitKind,
// PlayerSnapshot.hp) in the "state" handler below — never a client-side
// guess at whether or when a hit happened. See render.ts for the drawing. ---
const impactEffects: ImpactEffect[] = [];
const zombieProjectiles: ZombieProjectile[] = [];
const damageNumbers: DamageNumber[] = [];
const lastZombieAttacksLanded = new Map<string, number>();
const zombieLungeUntil = new Map<string, number>(); // zombie id -> lunge started at (performance.now())
// Zombie id -> performance.now() its hp was last seen dropping — same
// hp-diff pattern as the player damage-feedback block below, just applied to
// zombies too (previously only players got any hp-drop-driven visual
// feedback at all — see monsters.ts's hitFlashFrac for the giant/boss
// consumer).
const zombieHitFlashUntil = new Map<string, number>();
const playerFlashUntil = new Map<string, number>(); // player id -> flash started at (performance.now())
let selfFlashAt: number | undefined; // local-player screen vignette
// Player id -> the last status this client actually observed, what it
// changed FROM, and when — drives render.ts's downed-fall/get-up transition
// timing (player-pose.ts). Distinct from the raw PlayerSnapshot.status
// (which has no timing info of its own) the same way zombieLungeUntil/
// playerFlashUntil already turn a plain server field into "when did this
// last happen".
const playerStatusChangedAt = new Map<string, { status: PlayerSnapshot["status"]; prevStatus: PlayerSnapshot["status"] | undefined; at: number }>();

// Boss id -> the moment it was first seen in a state snapshot — drives a
// brief one-shot entrance flash (render.ts's renderBossEntrance) exactly
// once per boss, keyed by id (not type) so a second boss later in the run
// gets its own entrance rather than only the very first boss ever doing so.
const bossEntranceAt = new Map<string, number>();

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
  if (type === "giant") {
    // Giant has its own real directional LPC sheet (sprites.ts's
    // GIANT_SHEETS) distinct from the plain "normal" zombie sheet
    // zombieWalkSheet always returns — using that generic sheet here
    // previously showed a normal-zombie portrait on the giant's own "new
    // enemy" intro popup. Frame 0 of its idle-down cycle doubles as a
    // standing portrait pose, same "reuse what exists" choice this
    // function already makes for the other types.
    const sheet = giantSheetFor("idle", "down");
    if (isReady(sheet.image)) {
      const size = 90;
      ctx2.drawImage(sheet.image, 0, 0, sheet.frameWidth, sheet.frameHeight, cx - size / 2, cy - size / 2, size, size);
    }
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

// --- Character select: shown while the LOCAL player's own characterIndex
// is -1 (brand new identity, or never confirmed) — see updateCharacterSelectUi
// below, called from the "state" handler alongside updateTopBar.
const characterPortraitCtxs = characterCards.map((card) => {
  const portraitCanvas = card.querySelector<HTMLCanvasElement>(".character-portrait");
  if (!portraitCanvas) throw new Error("a .character-card is missing its .character-portrait canvas");
  const pctx = portraitCanvas.getContext("2d");
  if (!pctx) throw new Error("2d canvas context unavailable for a .character-portrait");
  return { canvas: portraitCanvas, ctx: pctx };
});

// Same technique drawIntroPortrait already established: frame 0 of the
// walk-down cycle doubles as a standing portrait pose (no dedicated idle
// sheet in the LPC set) — drawn once per card, re-drawn on every call since
// isReady() may flip from false to true after the sprite finishes loading.
const drawCharacterPortraits = (): void => {
  for (let i = 0; i < PLAYER_SHEETS.length; i++) {
    const { canvas: portraitCanvas, ctx: pctx } = characterPortraitCtxs[i];
    const sheet = PLAYER_SHEETS[i].down;
    pctx.clearRect(0, 0, portraitCanvas.width, portraitCanvas.height);
    if (!isReady(sheet.image)) continue;
    pctx.imageSmoothingEnabled = false;
    const size = 56;
    const cx = portraitCanvas.width / 2;
    const cy = portraitCanvas.height / 2;
    pctx.drawImage(sheet.image, 0, 0, sheet.frameWidth, sheet.frameHeight, cx - size / 2, cy - size / 2, size, size);
  }
};
drawCharacterPortraits();

// Local in-progress pick, not yet sent — the confirm button is what actually
// sends select_character. undefined until the player clicks a card.
let selectedCharacterIndex: number | undefined;

// True while the overlay is open because the player explicitly clicked
// "Change Character" from the hamburger menu (hud-menu-dropdown), as
// opposed to the mandatory first-pick case (self.characterIndex < 0). This
// is the one extra bit of client state this feature needs — the server side
// already supports re-sending select_character at any time (see
// game-loop.ts's own comment on selectCharacter: "Re-sending this for an
// already-confirmed player is how they'd change their pick"), so no server
// change was required, only a client-side way to voluntarily reopen a UI
// that was previously only ever shown once, automatically.
let changingCharacter = false;
// Captured when Change Character is clicked so updateCharacterSelectUi can
// tell "the pick actually changed" (close the overlay) apart from "still
// mid-edit, no state update related to this yet" (keep it open) — comparing
// against the live self snapshot alone wouldn't work since that snapshot is
// exactly what triggered opening it in the first place.
let preChangeSnapshot: { characterIndex: number; displayName: string } | undefined;

const sendSelectCharacter = (characterIndex: number, displayName: string): void => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "select_character", characterIndex, displayName }));
};

const refreshCharacterConfirmEnabled = (): void => {
  const name = characterNameInput.value.trim();
  const card = selectedCharacterIndex !== undefined ? characterCards[selectedCharacterIndex] : undefined;
  const taken = card?.classList.contains("taken") ?? true;
  characterConfirmBtn.disabled = selectedCharacterIndex === undefined || name.length === 0 || taken;
};

characterGrid.addEventListener("click", (e) => {
  const card = (e.target as HTMLElement).closest<HTMLDivElement>(".character-card");
  if (!card || card.classList.contains("taken")) return;
  const index = Number(card.dataset.index);
  selectedCharacterIndex = index;
  for (const c of characterCards) c.classList.toggle("selected", c === card);
  refreshCharacterConfirmEnabled();
});
characterNameInput.addEventListener("input", refreshCharacterConfirmEnabled);
characterConfirmBtn.addEventListener("click", () => {
  if (selectedCharacterIndex === undefined) return;
  const name = characterNameInput.value.trim();
  if (!name) return;
  sendSelectCharacter(selectedCharacterIndex, name);
});

// Reopens the overlay for an ALREADY-confirmed player (self.characterIndex
// >= 0) — pre-filled with their current pick/name so Confirm with no
// changes is a harmless no-op re-send, not a forced blank re-entry. Does
// nothing if self isn't known yet or hasn't picked a first character (the
// mandatory overlay is already showing in that case; btnChangeCharacter is
// also hidden then, see updateCharacterSelectUi, so this path shouldn't
// normally be reachable without it).
const openCharacterSelectForChange = (): void => {
  if (!currentState) return;
  const self = findSelf(currentState);
  if (!self || self.characterIndex < 0) return;
  preChangeSnapshot = { characterIndex: self.characterIndex, displayName: self.displayName };
  changingCharacter = true;
  selectedCharacterIndex = self.characterIndex;
  characterNameInput.value = self.displayName;
  updateCharacterSelectUi(currentState);
};

const cancelCharacterChange = (): void => {
  changingCharacter = false;
  preChangeSnapshot = undefined;
  selectedCharacterIndex = undefined;
  if (currentState) updateCharacterSelectUi(currentState);
};
characterCancelBtn.addEventListener("click", cancelCharacterChange);

// Called once per "state" message. Shows the overlay in two cases: (1) self
// hasn't confirmed a character yet (characterIndex -1, whether a brand new
// identity or simply never finished) — a late joiner should still get a
// chance to pick, not just a stuck "connected, nothing to do" screen; (2)
// changingCharacter is true (the player explicitly reopened it via "Change
// Character"). Case (1) hides automatically the instant characterIndex goes
// >= 0 (fresh pick OR a resumed reconnect — same check covers both); case
// (2) hides once the live self snapshot actually diverges from
// preChangeSnapshot, which is the one reliable sign the new pick was
// accepted by the server (a REJECTED pick, e.g. someone else grabbed that
// slot a moment earlier, leaves self unchanged, so the overlay correctly
// stays open with its existing "rejected" banner visible instead).
const updateCharacterSelectUi = (state: StateMessage): void => {
  const self = findSelf(state);
  if (changingCharacter && preChangeSnapshot && self && (self.characterIndex !== preChangeSnapshot.characterIndex || self.displayName !== preChangeSnapshot.displayName)) {
    changingCharacter = false;
    preChangeSnapshot = undefined;
  }
  btnChangeCharacter.hidden = !self || self.characterIndex < 0;
  const show = changingCharacter || !self || self.characterIndex < 0;
  if (!show) {
    characterSelect.hidden = true;
    characterSelectBackdrop.hidden = true;
    return;
  }
  characterSelect.hidden = false;
  characterSelectBackdrop.hidden = false;
  characterCancelBtn.hidden = !changingCharacter;
  drawCharacterPortraits();

  const takenByOthers = new Set(state.players.filter((p) => p.id !== myPlayerId && p.characterIndex >= 0).map((p) => p.characterIndex));
  for (const card of characterCards) {
    const index = Number(card.dataset.index);
    const taken = takenByOthers.has(index);
    card.classList.toggle("taken", taken);
    card.classList.toggle("selected", index === selectedCharacterIndex);
    const takenLabel = card.querySelector<HTMLDivElement>(".character-card-taken-label");
    if (takenLabel) takenLabel.hidden = !taken;
  }
  if (selectedCharacterIndex !== undefined && takenByOthers.has(selectedCharacterIndex)) {
    // Someone else just grabbed our in-progress (unsent) pick — clear it
    // rather than leave a now-taken card looking selected.
    selectedCharacterIndex = undefined;
  }
  refreshCharacterConfirmEnabled();
};

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

// Hamburger menu (2026-11-06 corner-panel redesign): Resume/Retry Current
// Day/Restart used to be their own always-visible text buttons; they're the
// same three controls, now tucked behind one icon button per the reference
// sketch's "only two icon buttons" top-right corner. Resume/Retry/Restart
// still each only ever show when their own game phase allows it (see
// updatePhaseUi below) — the dropdown just groups them, it doesn't change
// when any of them are valid to click.
let hudMenuOpen = false;
const closeHudMenu = (): void => {
  hudMenuOpen = false;
  hudMenuDropdown.hidden = true;
};
btnMenu.addEventListener("click", (e) => {
  e.stopPropagation();
  hudMenuOpen = !hudMenuOpen;
  hudMenuDropdown.hidden = !hudMenuOpen;
});
document.addEventListener("click", (e) => {
  if (hudMenuOpen && !hudMenuDropdown.contains(e.target as Node) && e.target !== btnMenu) closeHudMenu();
});
btnResume.addEventListener("click", () => {
  sendControl("resume");
  closeHudMenu();
});
btnRetry.addEventListener("click", () => {
  sendControl("retry_day");
  closeHudMenu();
});
btnRestart.addEventListener("click", () => {
  sendControl("restart");
  resetEnemyIntros();
  closeHudMenu();
});
btnChangeCharacter.addEventListener("click", () => {
  openCharacterSelectForChange();
  closeHudMenu();
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
let currentCamera: Camera = computeCamera(WORLD_SIZE / 2, WORLD_SIZE / 2, canvas.width, canvas.height);

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

// A VISUAL-ONLY mirror of game-state.ts's resolveShot, used purely to pick
// where the player's own bullet should visibly travel to (a hit zombie's
// position, so the bullet visibly lands on it; or PISTOL_RANGE along the
// aim line if nothing qualifies, so a miss clearly travels the weapon's
// real max range and stops, instead of flying forever). This NEVER decides
// damage or kills anything — the server's own "shoot" message handling
// already resolved the real hit before this client-side guess even runs;
// if the two ever disagree (lag, a zombie that moved a frame later than
// this client's last snapshot), the only consequence is the bullet's
// cosmetic endpoint being a touch off, never a gameplay difference.
function guessShotEndpoint(origin: { x: number; y: number }, aimAngle: number): { x: number; y: number } {
  const zombies = currentState?.zombies ?? [];
  let best: { x: number; y: number } | undefined;
  let bestDist = Infinity;
  for (const z of zombies) {
    const dx = z.x - origin.x;
    const dy = z.y - origin.y;
    const d = Math.hypot(dx, dy);
    if (d > PISTOL_RANGE) continue;
    let diff = Math.atan2(dy, dx) - aimAngle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) > PISTOL_CONE_HALF_ANGLE) continue;
    if (d < bestDist) {
      best = { x: z.x, y: z.y };
      bestDist = d;
    }
  }
  if (best) return best;
  return { x: origin.x + Math.cos(aimAngle) * PISTOL_RANGE, y: origin.y + Math.sin(aimAngle) * PISTOL_RANGE };
}

const input = new InputController({
  canvas,
  getCamera: () => currentCamera,
  send: (msg: ClientMessage) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  },
  getPlayerPos: () => prediction.getDisplayPos(performance.now()),
  onShoot: (origin, aimAngle) => {
    const endpoint = guessShotEndpoint(origin, aimAngle);
    // The bullet/muzzle-flash visually originates at the drawn weapon's own
    // muzzle tip (weaponMuzzleOffset — render.ts's same fractions the
    // weapon art itself uses), not the player's centre, so it lines up with
    // the held rifle instead of appearing to fire from the torso.
    const muzzle = weaponMuzzleOffset(aimAngle);
    const firedAt = performance.now();
    bullets.push({ fromX: origin.x + muzzle.x, fromY: origin.y + muzzle.y, toX: endpoint.x, toY: endpoint.y, firedAt });
    if (myPlayerId) playerLastShotAt.set(myPlayerId, firedAt);
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
    // Project the zombie's direction from the base onto the wall's SQUARE
    // boundary (Chebyshev projection) — the square analogue of the old
    // circular WALL_RING_RADIUS projection, now that the wall is a real
    // rectangle rather than a free-floating ring.
    const dx = z.x - BASE_POS.x;
    const dy = z.y - BASE_POS.y;
    const scale = WALL_HALF_EXTENT / (Math.max(Math.abs(dx), Math.abs(dy)) || 1);
    return { x: BASE_POS.x + dx * scale, y: BASE_POS.y + dy * scale };
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

// Maps each row's existing UiIconName (unchanged choice data — see
// computeBaseChoices/computeTurretChoices above, neither touched by this
// visual pass) onto the new, more-detailed base-menu icon set used only
// inside #interact-menu. Falls back to the original flat icon for anything
// with no equivalent in the reference image (e.g. "skull" for reviving a
// dead teammate, which the reference doesn't depict).
const rowIcon = (o: MenuChoice): string => {
  if (o.kind === "place_turret" || o.kind === "turret_action") return baseMenuIcon("turret");
  if (o.icon === "shield") return baseMenuIcon("wall");
  if (o.icon === "medkit") return baseMenuIcon("medkit");
  return uiIcon(o.icon, 22);
};

const renderMenu = (state: StateMessage | undefined): void => {
  if (placementMode) {
    menu.innerHTML = [
      `<div class="menu-heading">${baseMenuIcon("turret")} PLACING TURRET</div>`,
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
  const heading = menuContext.kind === "base" ? `${baseMenuIcon("fortress")} BASE` : `${baseMenuIcon("turret")} TURRET`;
  const rows = menuChoices.map((o) => {
    const affordable = state.sharedXp >= o.cost;
    return [
      `<div class="menu-row${affordable ? "" : " menu-row-disabled"}">`,
      `<span class="menu-key">[${o.key}]</span>`,
      `<span class="menu-row-icon">${rowIcon(o)}</span>`,
      `<span class="menu-label">${o.label}</span>`,
      `<span class="menu-cost${affordable ? "" : " menu-cost-insufficient"}">${baseMenuIcon("xp", 16)}${o.cost} XP</span>`,
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
  // Typing into the character-name field (reachable mid-game via "Change
  // Character") must not also trigger H/X/Esc/menu-number shortcuts — same
  // reasoning as InputController's own identical guard.
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
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

  collectDeathEffects(currentState?.zombies, msg.zombies, performance.now(), deathEffects, lastZombieDir);
  previousState = currentState;
  previousReceivedAt = currentReceivedAt;
  currentState = msg;
  currentReceivedAt = performance.now();
  const self = findSelf(currentState);
  if (self) prediction.reconcile(self, currentReceivedAt);

  // One real-endpoint bullet (same Bullet/renderBullets system the player's
  // own shots use) per turret that actually fired this tick, originating
  // from the turret's drawn weapon sprite's own muzzle tip (render.ts's
  // turretMuzzlePositions, rotated to the turret's actual aim angle) rather
  // than its centre — purely cosmetic; game-loop.ts's #updateTurrets already
  // resolved the real hit when shotsFired incremented. A level-3 turret has
  // two muzzles (its twin barrels) and alternates which one the shot
  // visually comes from via nextTurretBarrelIndex, even though both barrels
  // always hit server-side on every shot.
  for (const t of currentState.turrets) {
    const prevFired = lastTurretShotsFired.get(t.id) ?? 0;
    if (t.shotsFired > prevFired && t.target) {
      const angle = Math.atan2(t.target.y - t.y, t.target.x - t.x);
      const muzzles = turretMuzzlePositions(t, angle);
      const barrelIndex = muzzles.length > 1 ? nextTurretBarrelIndex(t.id) % muzzles.length : 0;
      const muzzle = muzzles[barrelIndex];
      const firedAt = performance.now();
      bullets.push({ fromX: muzzle.x, fromY: muzzle.y, toX: t.target.x, toY: t.target.y, firedAt, kind: "turret" });
      turretLastShotAt.set(t.id, firedAt);
    }
    lastTurretShotsFired.set(t.id, t.shotsFired);
  }

  // Weapon recoil for every REMOTE player's real fired shot (the local
  // player's own recoil is already set instantly by onShoot above, on
  // click, for zero-latency feel — this covers teammates, whose shots this
  // client only learns about via the next state broadcast).
  for (const p of currentState.players) {
    if (p.id === myPlayerId) continue;
    const prevFired = lastPlayerShotsFired.get(p.id) ?? 0;
    if (p.shotsFired > prevFired) playerLastShotAt.set(p.id, performance.now());
    lastPlayerShotsFired.set(p.id, p.shotsFired);
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

  // Zombie hit-reaction feedback: same hp-drop diff as players above, just
  // applied to zombies — previously no zombie type had ANY hp-drop-driven
  // visual feedback. Only giant/boss (monsters.ts's hitFlashFrac) currently
  // react to this; normal/flying ignore it harmlessly.
  for (const z of currentState.zombies) {
    const prevZ = previousState?.zombies.find((q) => q.id === z.id);
    if (prevZ && z.hp < prevZ.hp) zombieHitFlashUntil.set(z.id, now0);
  }

  // Downed/dead<->alive transitions: a pure status-string diff against the
  // previous snapshot (status itself carries no timing), recorded so
  // render.ts can play a fall-down transition right after alive->downed/dead
  // and a get-up transition right after downed/dead->alive, instead of
  // snapping straight into the held pose for the whole duration.
  for (const p of currentState.players) {
    const prevP = previousState?.players.find((q) => q.id === p.id);
    const prevStatus = prevP?.status;
    const tracked = playerStatusChangedAt.get(p.id);
    if (prevStatus === undefined) {
      // First time this id is seen at all (fresh connect/reconnect) — record
      // a baseline with no transition animation implied (there's nothing to
      // transition FROM).
      if (!tracked) playerStatusChangedAt.set(p.id, { status: p.status, prevStatus: undefined, at: now0 });
    } else if (prevStatus !== p.status || !tracked) {
      playerStatusChangedAt.set(p.id, { status: p.status, prevStatus, at: now0 });
    }
  }

  // A boss's entrance flash fires the first tick its id is ever seen —
  // covers both a freshly-spawned boss and (harmlessly) one already present
  // on the very first snapshot after connecting/reconnecting, same
  // "can't tell the difference and it's harmless either way" reasoning
  // checkForNewEnemies already uses for its own intro popups.
  for (const z of currentState.zombies) {
    if (z.type === "boss" && !bossEntranceAt.has(z.id)) bossEntranceAt.set(z.id, now0);
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
  updateTopBar(currentState);
  updatePhaseUi(currentState.phase);
  updateCharacterSelectUi(currentState);
  renderMenu(currentState);
});

// HP bars live in-world now (base/wall/player each have their own — see
// render.ts's renderBase/the wall's dashed perimeter/renderPlayer), so this
// panel is a labelled readout grid: icon+label on the left, value on the
// right, coloured by threshold so a critical number (low base/player HP) is
// visually distinct from a healthy one without having to read the digits.
const fractionClass = (current: number, max: number): string => {
  if (max <= 0) return "";
  const f = current / max;
  if (f > 0.5) return "hud-value-good";
  if (f > 0.2) return "hud-value-warn";
  return "hud-value-critical";
};

// A small reusable "barWithLabel" (track + proportional fill + the real
// number alongside, never the only source of the value — same rule the old
// vertical HUD followed) for the per-player cards below.
const miniBar = (barClass: string, current: number, max: number, text: string): string => {
  const fraction = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  const width = Math.round(50 * HUD_SCALE);
  const height = Math.round(7 * HUD_SCALE);
  return `<span class="bar ${barClass}" style="width:${width}px;height:${height}px"><span class="bar-fill" style="width:${(fraction * 100).toFixed(0)}%"></span></span><span class="player-card-value">${text}</span>`;
};

// Crit 10's gameplay-expansion requirement "their own HP/status... and any
// teammate's status" — this project's only per-player identity colour
// (matching the canvas's own per-player colour), reused both for the
// top-bar player cards and the in-world name-tag/HP-bar render.ts already
// draws above each player sprite.
const REMOTE_PLAYER_COLORS = ["#ff6666", "#66b2ff", "#66ff99", "#ffcc66"];
const LOCAL_PLAYER_COLOR = "#ffcc00";
const TEAM_SIZE = 4; // matches server-side MAX_PLAYERS (game-state.ts) — not client-importable, see its own comment

// Draws one player's portrait (frame 0 of their walk-down cycle, same
// "reuse what exists" choice drawCharacterPortraits/drawIntroPortrait
// already make — no dedicated idle sheet exists in the LPC set) into a
// freshly created small canvas, returned ready to insert into the DOM. The
// backing resolution is scaled by HUD_SCALE too (not just the CSS frame it
// sits in via width:100%/height:100%) so a bigger on-screen portrait is
// still drawn from a bigger source bitmap — stretching the old fixed 36x36
// canvas up via CSS alone would have read as soft/blurry despite
// image-rendering:pixelated, which only prevents smoothing, not low source
// resolution.
const drawPlayerPortraitCanvas = (characterIndex: number): HTMLCanvasElement => {
  const c = document.createElement("canvas");
  c.width = Math.round(36 * HUD_SCALE);
  c.height = Math.round(36 * HUD_SCALE);
  const pctx = c.getContext("2d");
  if (!pctx) return c;
  const sheet = PLAYER_SHEETS[characterIndex % PLAYER_SHEETS.length]?.down;
  if (sheet && isReady(sheet.image)) {
    pctx.imageSmoothingEnabled = false;
    const size = Math.round(34 * HUD_SCALE);
    pctx.drawImage(sheet.image, 0, 0, sheet.frameWidth, sheet.frameHeight, (c.width - size) / 2, (c.height - size) / 2, size, size);
  }
  return c;
};

// HUD corner panels (2026-11-06 redesign, replacing the 2026-11-05 single
// full-width bottom bar with four independent panels matching a reference
// sketch the user supplied):
//   - top-left: the LOCAL player's own portrait/name/HP + the real shared
//     XP as a plain number (the sketch showed a per-player Lv./XP-to-next-
//     threshold bar, but this game only has one shared team XP total with
//     no level/threshold concept — confirmed with the user, who chose
//     showing the real number over inventing a levelling system; no bar
//     fill either, since shared XP has no real maximum to size one against)
//   - top-centre: day counter + the real kill-progress ("N / total
//     ZOMBIES" — this project has no server-side concept of numbered
//     sub-waves within a day, just one continuous spawn queue, so this
//     shows actual progress rather than inventing a wave-count fiction)
//     plus today's enemy-type badges
//   - top-right: base/wall/turret status (wall added beyond what the sketch
//     showed, since CLAUDE.md's UI rules require it stay visible), a
//     second real-shared-XP readout + connection status (matching the
//     sketch's separate top-right XP box), and the play/pause/menu icon
//     buttons
//   - bottom-left: the full team roster (portrait/HP/status per player,
//     "+JOIN" placeholders for open slots) — unchanged in substance from
//     the single-bar version, just in its own panel now
const updateTopBar = (state: StateMessage): void => {
  const selfPlayer = state.players.find((p) => p.id === myPlayerId);

  // --- Top-left: local player card ---
  if (!selfPlayer || selfPlayer.characterIndex < 0) {
    hudTopLeft.innerHTML = `<div class="player-card-row">choosing character…</div>`;
  } else {
    const hasCharacter = selfPlayer.characterIndex >= 0;
    const frame = document.createElement("div");
    frame.className = "hud-self-portrait-frame";
    frame.style.borderColor = LOCAL_PLAYER_COLOR;
    if (hasCharacter) frame.appendChild(drawPlayerPortraitCanvas(selfPlayer.characterIndex));

    const stats = document.createElement("div");
    stats.className = "hud-self-stats";
    const name = document.createElement("div");
    name.className = "hud-self-name";
    name.style.color = LOCAL_PLAYER_COLOR;
    name.textContent = selfPlayer.displayName || "You";
    stats.appendChild(name);

    if (selfPlayer.status === "alive") {
      const hpRow = document.createElement("div");
      hpRow.className = "player-card-row";
      hpRow.innerHTML = `${uiIcon("heart", Math.round(12 * HUD_SCALE))} ${miniBar("bar-hp", selfPlayer.hp, selfPlayer.maxHp, `${selfPlayer.hp}/${selfPlayer.maxHp}`)}`;
      stats.appendChild(hpRow);
    } else if (selfPlayer.status === "downed") {
      const statusRow = document.createElement("div");
      statusRow.className = "player-card-row player-downed";
      statusRow.innerHTML = `${uiIcon("skull", Math.round(12 * HUD_SCALE))} DOWNED ${Math.ceil(selfPlayer.downedRemainingMs / 1000)}s`;
      stats.appendChild(statusRow);
    } else {
      const statusRow = document.createElement("div");
      statusRow.className = "player-card-row player-dead";
      statusRow.innerHTML = `${uiIcon("skull", Math.round(12 * HUD_SCALE))} DEAD`;
      stats.appendChild(statusRow);
    }
    const xpRow = document.createElement("div");
    xpRow.className = "player-card-row";
    xpRow.innerHTML = `${uiIcon("coin", Math.round(12 * HUD_SCALE))} <span class="player-card-value hud-value-good">${state.sharedXp} XP</span>`;
    stats.appendChild(xpRow);

    hudTopLeft.replaceChildren(frame, stats);
  }

  // --- Bottom-left: full team roster ---
  topBarPlayers.replaceChildren();
  for (const p of state.players) {
    const isSelf = p.id === myPlayerId;
    const hasCharacter = p.characterIndex >= 0;
    const color = isSelf ? LOCAL_PLAYER_COLOR : hasCharacter ? REMOTE_PLAYER_COLORS[p.characterIndex % REMOTE_PLAYER_COLORS.length] : "#888";
    const label = p.displayName || (isSelf ? "You" : `P${p.colorIndex + 1}`);

    const card = document.createElement("div");
    card.className = "player-card";

    const frame = document.createElement("div");
    frame.className = "player-portrait-frame";
    frame.style.borderColor = color;
    if (hasCharacter) frame.appendChild(drawPlayerPortraitCanvas(p.characterIndex));
    const portraitLabel = document.createElement("span");
    portraitLabel.className = "player-portrait-label";
    portraitLabel.style.color = color;
    portraitLabel.textContent = `P${p.colorIndex + 1}`;
    frame.appendChild(portraitLabel);
    card.appendChild(frame);

    const stats = document.createElement("div");
    stats.className = "player-card-stats";

    if (!hasCharacter) {
      const row = document.createElement("div");
      row.className = "player-card-row";
      row.textContent = "choosing character…";
      stats.appendChild(row);
    } else if (p.status === "alive") {
      const nameRow = document.createElement("div");
      nameRow.className = "player-card-row";
      nameRow.textContent = label;
      nameRow.style.fontWeight = "800";
      nameRow.style.color = color;
      stats.appendChild(nameRow);
      const hpRow = document.createElement("div");
      hpRow.className = "player-card-row";
      hpRow.innerHTML = `${uiIcon("heart", Math.round(12 * HUD_SCALE))} ${miniBar("bar-hp", p.hp, p.maxHp, `${p.hp}/${p.maxHp}`)}`;
      stats.appendChild(hpRow);
    } else if (p.status === "downed") {
      const nameRow = document.createElement("div");
      nameRow.className = "player-card-row";
      nameRow.textContent = label;
      nameRow.style.fontWeight = "800";
      nameRow.style.color = color;
      stats.appendChild(nameRow);
      const statusRow = document.createElement("div");
      statusRow.className = "player-card-row player-downed";
      const revive = state.reviveProgress.find((r) => r.targetId === p.id);
      statusRow.innerHTML = `${uiIcon("skull", Math.round(12 * HUD_SCALE))} DOWNED ${Math.ceil(p.downedRemainingMs / 1000)}s`;
      stats.appendChild(statusRow);
      if (revive) {
        const reviveFraction = Math.max(0, Math.min(1, 1 - revive.remainingMs / 3000));
        const reviveRow = document.createElement("div");
        reviveRow.className = "player-card-row";
        reviveRow.innerHTML = `<span class="bar bar-revive"><span class="bar-fill" style="width:${(reviveFraction * 100).toFixed(0)}%"></span></span> ${Math.ceil(revive.remainingMs / 1000)}s`;
        stats.appendChild(reviveRow);
      }
    } else {
      const nameRow = document.createElement("div");
      nameRow.className = "player-card-row";
      nameRow.textContent = label;
      nameRow.style.fontWeight = "800";
      nameRow.style.color = color;
      stats.appendChild(nameRow);
      const statusRow = document.createElement("div");
      statusRow.className = "player-card-row player-dead";
      statusRow.innerHTML = `${uiIcon("skull", Math.round(12 * HUD_SCALE))} DEAD`;
      stats.appendChild(statusRow);
    }

    // The local player's medkit count is specifically theirs (medkits are
    // per-player inventory, not shared) — shown only on their own card.
    if (isSelf && hasCharacter && p.status === "alive") {
      const medkitRow = document.createElement("div");
      medkitRow.className = "player-card-row";
      medkitRow.innerHTML = `${uiIcon("medkit", Math.round(12 * HUD_SCALE))} x${p.medkits}`;
      stats.appendChild(medkitRow);
    }

    card.appendChild(stats);
    topBarPlayers.appendChild(card);
  }
  // Empty "+JOIN" slot(s) for remaining team capacity, so the roster always
  // shows the team's real size, not just who's currently connected —
  // matching the reference sketch's bottom-left row.
  for (let i = state.players.length; i < TEAM_SIZE; i++) {
    const slot = document.createElement("div");
    slot.className = "player-slot-empty";
    slot.innerHTML = `+ JOIN`;
    topBarPlayers.appendChild(slot);
  }

  // --- Top-centre: day + real kill-progress + today's enemy-type badges ---
  topBarDay.innerHTML = `${uiIcon("calendar", Math.round(18 * HUD_SCALE))} DAY ${state.day}`;
  const waveFraction = state.totalZombiesForDay > 0 ? state.killedZombies / state.totalZombiesForDay : 0;
  const activeBadges = WAVE_BADGES.filter((b) => state.dayWaveComposition[b.key] > 0);
  const waveBarWidth = Math.round(90 * HUD_SCALE);
  topBarWave.innerHTML = [
    uiIcon("hazard", Math.round(16 * HUD_SCALE)),
    `<span class="top-bar-wave-label">${state.killedZombies} / ${state.totalZombiesForDay} ZOMBIES</span>`,
    `<span class="bar" style="width:${waveBarWidth}px"><span class="bar-fill" style="width:${(waveFraction * 100).toFixed(0)}%;background:var(--accent-green)"></span></span>`,
    ...activeBadges.map(
      (b) =>
        `<span class="top-bar-wave-badge" style="color:${b.color};border-color:${b.color}">${b.label} x${state.dayWaveComposition[b.key]}</span>`,
    ),
  ].join(" ");

  // --- Top-right: base/wall/turret status box + XP/connection box + icon
  // buttons (icon buttons are static HTML, see btnStart/btnPause/btnMenu's
  // one-time innerHTML set near their DOM queries — nothing to update here
  // every state message). Wall is included even though the reference
  // sketch's status box didn't show it, since CLAUDE.md's UI rules require
  // wall level/HP stay visible at all times. ---
  const wallText = state.wallLevel > 0 ? `Lv${state.wallLevel} ${state.wallHp}/${state.wallMaxHp}` : "none";
  const wallClass = state.wallLevel > 0 ? fractionClass(state.wallHp, state.wallMaxHp) : "hud-value-critical";
  hudStatusBox.innerHTML = [
    `<div class="player-card-row">${uiIcon("heart", Math.round(14 * HUD_SCALE))} ${miniBar("bar-hp", state.baseHp, state.baseMaxHp, `${state.baseHp}/${state.baseMaxHp}`)}</div>`,
    `<div class="player-card-row">${uiIcon("shield", Math.round(14 * HUD_SCALE))} <span class="player-card-value ${wallClass}">${wallText}</span></div>`,
    `<div class="player-card-row">Turrets <span class="player-card-value">${state.turrets.length}/${MAX_TURRETS}</span></div>`,
  ].join("");
  hudXpValue.innerHTML = `${uiIcon("coin", Math.round(16 * HUD_SCALE))} XP ${state.sharedXp}`;

  rejectionEl.textContent = rejectionNotice ?? "";
};

// A persistent fixed-position element (not re-created every state message)
// for the "rejected" notice — see .rejected in index.html for its
// positioning above the bottom-centre "[X] Base Menu"-style prompt
// (2026-11-06 corner-panel redesign).
const rejectionEl = document.createElement("div");
rejectionEl.className = "rejected";
document.body.appendChild(rejectionEl);

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
  // btn-menu (and Restart inside its dropdown) stay visible in every phase —
  // only Resume/Retry Current Day are phase-gated, same validity rules as
  // before this pass, just relocated into the dropdown.
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
      prediction.tick(input.getMoveState(), dtMs, currentState.wallLevel);
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
    currentCamera = computeCamera(followPos.x, followPos.y, canvas.width, canvas.height, zoomCurrent);

    render(ctx, currentCamera, displayState, input.getAimAngle(), myPlayerId, zombieLungeUntil, playerFlashUntil, zombieHitFlashUntil, playerLastShotAt, turretLastShotAt, playerStatusChangedAt);
    renderBossEntranceEffects(ctx, currentCamera, displayState.zombies, bossEntranceAt, timestamp);
    renderDeathEffects(ctx, currentCamera, deathEffects, timestamp);
    if (displayState.dayIntroRemainingMs > 0) {
      renderDayIntro(ctx, canvas.width, canvas.height, displayState.day, displayState.dayIntroRemainingMs);
    }

    // Both the player's own bullets AND turret shots now share this one
    // system: spawn a small impact effect the instant each one's travel
    // finishes (hit spark on a zombie, or a dust/ground puff at max range if
    // it missed) — a REAL visual arrival, not a guessed one, since
    // guessShotEndpoint (player) / the turret's own real t.target (turret)
    // already decided this bullet's destination when it was fired.
    for (let i = bullets.length - 1; i >= 0; i--) {
      const bullet = bullets[i];
      const age = timestamp - bullet.firedAt;
      if (age > BULLET_TRAVEL_MS) {
        impactEffects.push({ x: bullet.toX, y: bullet.toY, kind: "melee", startedAt: bullet.firedAt + BULLET_TRAVEL_MS });
        bullets.splice(i, 1);
      }
    }
    renderBullets(ctx, currentCamera, bullets, timestamp);

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

    renderDamageVignette(ctx, canvas.width, canvas.height, selfFlashAt, timestamp);

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
