// Phase 3-9 (feature/3d-migration): the full 3D client entry point —
// replaces Phase 2's placeholder-box prototype with real 3D models
// (character.ts/zombie.ts/structures.ts/environment.ts), combat VFX
// (vfx.ts), and the SAME proven HUD/menu/character-select logic main.ts
// already has for the 2D client, reusing every pure/logic module unchanged
// (protocol.ts, prediction.ts, interpolate.ts, input.ts, defense-config.ts,
// obstacles.ts, terrain.ts) — only the rendering calls differ. Still served
// at the SEPARATE /3d route (src/server/index.ts's own comment); "/" and
// main.ts remain the proven, unmodified 2D baseline per CLAUDE.md's 3D
// migration rules.
import * as THREE from "three";
import { createScene3D } from "./scene.ts";
import { createPlayerModel, type PlayerModel } from "./character.ts";
import { createZombieModel, type ZombieModel } from "./zombie.ts";
import { createTownBuildings, createBaseStructure, createWallStructure, createTurretModel, type TurretModel } from "./structures.ts";
import { createEnvironmentProps } from "./environment.ts";
import { VfxLayer } from "./vfx.ts";
import { InputController } from "../input.ts";
import { remapIsometricMove } from "./isometric-input.ts";
import { LocalPlayerPrediction } from "../prediction.ts";
import { interpolateState } from "../interpolate.ts";
import { clampViewSize, DEFAULT_VIEW_SIZE } from "../camera.ts";
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
} from "../defense-config.ts";
import { overlapsAnyBuilding } from "../obstacles.ts";
import { uiIcon } from "../render.ts";
import type {
  ClientMessage,
  ControlMessage,
  GamePhase,
  InteractAction,
  PlayerSnapshot,
  ServerMessage,
  StateMessage,
  TurretAction,
  ZombieSnapshot,
  ZombieType,
} from "../protocol.ts";

// --- Identity (identical to main.ts) ----------------------------------------
const PLAYER_ID_KEY = "comp4020-last-stand-player-id";
function getOrCreatePlayerId(): string {
  try {
    const existing = localStorage.getItem(PLAYER_ID_KEY);
    if (existing) return existing;
  } catch {
    // ignore
  }
  const id = crypto.randomUUID();
  try {
    localStorage.setItem(PLAYER_ID_KEY, id);
  } catch {
    // ignore
  }
  return id;
}

// --- DOM wiring (same ids as the 2D client's index.html — see this
// directory's own index.html, deliberately copied verbatim) ----------------
function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`index.html is missing #${id}`);
  return found as T;
}
const canvas = el<HTMLCanvasElement>("three-canvas");
const hud = el<HTMLDivElement>("hud");
const conn = el<HTMLDivElement>("conn");
const banner = el<HTMLDivElement>("phase-banner");
const menu = el<HTMLDivElement>("interact-menu");
const teamPanel = el<HTMLDivElement>("team-panel");
const prompt = el<HTMLDivElement>("prompt");
const btnStart = el<HTMLButtonElement>("btn-start");
const btnPause = el<HTMLButtonElement>("btn-pause");
const btnResume = el<HTMLButtonElement>("btn-resume");
const btnRetry = el<HTMLButtonElement>("btn-retry");
const btnRestart = el<HTMLButtonElement>("btn-restart");
const characterSelect = el<HTMLDivElement>("character-select");
const characterGrid = el<HTMLDivElement>("character-grid");
const characterCards = [...characterGrid.querySelectorAll<HTMLDivElement>(".character-card")];
const characterNameInput = el<HTMLInputElement>("character-name-input");
const characterConfirmBtn = el<HTMLButtonElement>("character-confirm-btn");
// The 2D client's "new enemy" intro popup draws a procedural Canvas2D
// portrait — out of scope to replicate pixel-for-pixel in a 3D client whose
// renderer has no Canvas2D context; the intro panel itself (name/bullets/
// dismiss) is kept, with the portrait canvas left blank rather than
// crashing on a missing drawing routine.
const enemyIntro = el<HTMLDivElement>("enemy-intro");
const introName = el<HTMLDivElement>("intro-name");
const introBullets = el<HTMLUListElement>("intro-bullets");
const introDismissBtn = el<HTMLButtonElement>("intro-dismiss");
const crosshair = el<HTMLDivElement>("crosshair");

function resize(): void {
  const width = Math.max(320, window.innerWidth);
  const height = Math.max(240, window.innerHeight);
  scene3d.resize(width, height);
}
const scene3d = createScene3D(canvas);
resize();
window.addEventListener("resize", resize);

// --- Static world geometry: built once, never rebuilt (town buildings never
// change; environment props are deterministic/fixed) -------------------------
scene3d.scene.add(createTownBuildings());
const baseStructure = createBaseStructure();
scene3d.scene.add(baseStructure.group);
const wallStructure = createWallStructure();
scene3d.scene.add(wallStructure.group);
createEnvironmentProps().then((group) => scene3d.scene.add(group));

const vfx = new VfxLayer();
scene3d.scene.add(vfx.group);


// --- Zoom (identical easing to main.ts) -------------------------------------
let zoomTarget = DEFAULT_VIEW_SIZE;
let zoomCurrent = DEFAULT_VIEW_SIZE;
const ZOOM_STEP_FACTOR = 1.15;
const ZOOM_EASE_PER_SEC = 10;
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1 / ZOOM_STEP_FACTOR : ZOOM_STEP_FACTOR;
    zoomTarget = clampViewSize(zoomTarget * factor);
  },
  { passive: false },
);

// --- Networking / state --------------------------------------------------
let previousState: StateMessage | undefined;
let previousReceivedAt = 0;
let currentState: StateMessage | undefined;
let currentReceivedAt = 0;
let myPlayerId: string | undefined;
const findSelf = (state: StateMessage): PlayerSnapshot | undefined => state.players.find((p) => p.id === myPlayerId);

let rejectionNotice: string | undefined;
let rejectionTimer: ReturnType<typeof setTimeout> | undefined;

const prediction = new LocalPlayerPrediction();

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
const sendSelectCharacter = (characterIndex: number, displayName: string): void => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "select_character", characterIndex, displayName }));
};

// --- Character select (logic identical to main.ts; portraits are plain
// colour swatches here rather than a drawn LPC sprite frame, since the 3D
// client's player model isn't cheap to render into a tiny static portrait
// every frame — a swatch still distinguishes the 4 slots, which is the
// actual requirement). ---
const CHARACTER_SWATCH_COLORS = ["#ffcc00", "#ff6666", "#66b2ff", "#66ff99"];
for (let i = 0; i < characterCards.length; i++) {
  const portrait = characterCards[i].querySelector<HTMLCanvasElement>(".character-portrait");
  if (portrait) {
    const pctx = portrait.getContext("2d");
    if (pctx) {
      pctx.fillStyle = CHARACTER_SWATCH_COLORS[i % CHARACTER_SWATCH_COLORS.length];
      pctx.fillRect(0, 0, portrait.width, portrait.height);
    }
  }
}
let selectedCharacterIndex: number | undefined;
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
const updateCharacterSelectUi = (state: StateMessage): void => {
  const self = findSelf(state);
  if (self && self.characterIndex >= 0) {
    characterSelect.hidden = true;
    return;
  }
  characterSelect.hidden = false;
  const takenByOthers = new Set(state.players.filter((p) => p.id !== myPlayerId && p.characterIndex >= 0).map((p) => p.characterIndex));
  for (const card of characterCards) {
    const index = Number(card.dataset.index);
    const taken = takenByOthers.has(index);
    card.classList.toggle("taken", taken);
    card.classList.toggle("selected", index === selectedCharacterIndex);
    const takenLabel = card.querySelector<HTMLDivElement>(".character-card-taken-label");
    if (takenLabel) takenLabel.hidden = !taken;
  }
  if (selectedCharacterIndex !== undefined && takenByOthers.has(selectedCharacterIndex)) selectedCharacterIndex = undefined;
  refreshCharacterConfirmEnabled();
};

// --- "New enemy" intro popups (identical trigger logic to main.ts; no
// portrait render) ---
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

const checkForNewEnemies = (state: StateMessage): void => {
  if (introLastCheckedDay === undefined) {
    introLastCheckedDay = state.day;
    for (const t of ALL_ZOMBIE_TYPES) if (state.dayWaveComposition[t] > 0) seenEnemyTypes.add(t);
    return;
  }
  if (state.day === introLastCheckedDay) return;
  introLastCheckedDay = state.day;
  for (const t of ALL_ZOMBIE_TYPES) {
    if (state.dayWaveComposition[t] > 0 && !seenEnemyTypes.has(t)) {
      seenEnemyTypes.add(t);
      if (ENEMY_INTRO[t]) introQueue.push(t);
    }
  }
  advanceIntroQueue();
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
  enemyIntro.hidden = false;
};
const dismissIntro = (): void => {
  if (currentIntro === undefined) return;
  currentIntro = undefined;
  introShownAt = undefined;
  enemyIntro.hidden = true;
  advanceIntroQueue();
};
const resetEnemyIntros = (): void => {
  seenEnemyTypes.clear();
  introQueue.length = 0;
  introLastCheckedDay = undefined;
  dismissIntro();
};
introDismissBtn.addEventListener("click", dismissIntro);

// --- Shot-endpoint guess (identical to main.ts's guessShotEndpoint — a
// VISUAL-ONLY mirror, never decides damage) ---
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

const lastPlayerShotAt = new Map<string, number>();
const lastPlayerHitAt = new Map<string, number>();

const input = new InputController({
  canvas,
  screenToWorld: (x, y) => scene3d.screenToWorld(x, y),
  send: (msg: ClientMessage) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  },
  getPlayerPos: () => prediction.getDisplayPos(performance.now()),
  moveKeyRemap: remapIsometricMove,
  onShoot: (origin, aimAngle) => {
    const endpoint = guessShotEndpoint(origin, aimAngle);
    const firedAt = performance.now();
    vfx.addBullet({ from: new THREE.Vector3(origin.x, 36, origin.y), to: new THREE.Vector3(endpoint.x, 36, endpoint.y), firedAt });
    if (myPlayerId) lastPlayerShotAt.set(myPlayerId, firedAt);
  },
});

// --- X-menu (base vs turret) — identical logic to main.ts ------------------
type MenuChoice =
  | { key: string; label: string; cost: number; icon: Parameters<typeof uiIcon>[0]; kind: "interact"; action: InteractAction }
  | { key: string; label: string; cost: number; icon: Parameters<typeof uiIcon>[0]; kind: "place_turret" }
  | { key: string; label: string; cost: number; icon: Parameters<typeof uiIcon>[0]; kind: "turret_action"; turretId: string; action: TurretAction };
type MenuContext = { kind: "base" } | { kind: "turret"; turretId: string };
let menuOpen = false;
let menuContext: MenuContext | undefined;
let menuChoices: MenuChoice[] = [];
let placementMode = false;

const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
const playerInBaseRange = (): boolean => distance(prediction.getDisplayPos(performance.now()), BASE_POS) <= BASE_INTERACT_RANGE;
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

type UnkeyedChoice =
  | { label: string; cost: number; icon: Parameters<typeof uiIcon>[0]; kind: "interact"; action: InteractAction }
  | { label: string; cost: number; icon: Parameters<typeof uiIcon>[0]; kind: "place_turret" }
  | { label: string; cost: number; icon: Parameters<typeof uiIcon>[0]; kind: "turret_action"; turretId: string; action: TurretAction };
const computeBaseChoices = (state: StateMessage, self: PlayerSnapshot | undefined): UnkeyedChoice[] => {
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

// --- HUD (identical structure/logic to main.ts's updateHud/updateTeamPanel) ---
const fractionClass = (current: number, max: number): string => {
  if (max <= 0) return "";
  const f = current / max;
  if (f > 0.5) return "hud-value-good";
  if (f > 0.2) return "hud-value-warn";
  return "hud-value-critical";
};
const hudRow = (label: string, value: string, valueClass = ""): string =>
  `<div class="hud-row-label">${label}</div><div class="hud-row-value ${valueClass}">${value}</div>`;
const updateHud = (state: StateMessage): void => {
  const self = findSelf(state);
  const wallRow =
    state.wallLevel > 0
      ? hudRow(`${uiIcon("shield")} Wall`, `Lv${state.wallLevel} · ${state.wallHp}/${state.wallMaxHp}`, fractionClass(state.wallHp, state.wallMaxHp))
      : hudRow(`${uiIcon("shield")} Wall`, "none", "hud-value-critical");
  const statusRow = !self
    ? hudRow("You", "—")
    : self.status === "alive"
      ? hudRow(`${uiIcon("heart")} HP`, `${self.hp}/${self.maxHp}${self.healing ? " ⟳" : ""}${self.invulnerable ? " ✦" : ""}`, fractionClass(self.hp, self.maxHp))
      : self.status === "downed"
        ? hudRow(`${uiIcon("skull")} Status`, `DOWNED ${Math.ceil(self.downedRemainingMs / 1000)}s`, "hud-value-critical")
        : hudRow(`${uiIcon("skull")} Status`, "DEAD", "hud-value-critical");
  hud.innerHTML = [
    `<div id="hud-heading">${uiIcon("house", 18)} DAY ${state.day}</div>`,
    `<div id="hud-rows">`,
    hudRow(`${uiIcon("heart")} Base`, `${state.baseHp}/${state.baseMaxHp}`, fractionClass(state.baseHp, state.baseMaxHp)),
    wallRow,
    hudRow("Turrets", `${state.turrets.length} / ${MAX_TURRETS}`),
    hudRow(`${uiIcon("coin")} Shared XP`, `${state.sharedXp}`, "hud-value-good"),
    statusRow,
    self ? hudRow(`${uiIcon("medkit")} Medkits`, `${self.medkits} / ${MEDKIT_MAX} (H)`) : "",
    `</div>`,
    self?.status === "downed" ? `<div class="hud-note">Hold E near a teammate to revive, or wait it out.</div>` : "",
    self?.status === "dead" ? `<div class="hud-note">A teammate can resurrect you at the base.</div>` : "",
    rejectionNotice ? `<div class="rejected">${rejectionNotice}</div>` : "",
  ]
    .filter(Boolean)
    .join("");
};
const REMOTE_PLAYER_COLORS = ["#ff6666", "#66b2ff", "#66ff99", "#ffcc66"];
const LOCAL_PLAYER_COLOR = "#ffcc00";
const updateTeamPanel = (state: StateMessage): void => {
  teamPanel.replaceChildren();
  const heading = document.createElement("div");
  heading.className = "menu-heading";
  heading.textContent = `TEAM (${state.players.length}/4)`;
  teamPanel.appendChild(heading);
  for (const p of state.players) {
    const isSelf = p.id === myPlayerId;
    const hasCharacter = p.characterIndex >= 0;
    const color = isSelf ? LOCAL_PLAYER_COLOR : hasCharacter ? REMOTE_PLAYER_COLORS[p.characterIndex % REMOTE_PLAYER_COLORS.length] : "#888";
    const label = p.displayName || (isSelf ? "You" : `P${p.colorIndex + 1}`);
    let statusHtml: string;
    if (p.status === "alive") {
      statusHtml = hasCharacter ? "" : "(choosing character…)";
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
    const row = document.createElement("div");
    row.className = "player-row";
    const swatch = document.createElement("span");
    swatch.className = "player-swatch";
    swatch.style.background = color;
    const labelSpan = document.createElement("span");
    labelSpan.className = "player-label";
    labelSpan.textContent = label;
    const statusSpan = document.createElement("span");
    statusSpan.innerHTML = statusHtml;
    row.append(swatch, labelSpan, statusSpan);
    teamPanel.appendChild(row);
  }
};
const PHASE_LABELS: Record<GamePhase, { title: string; icon?: Parameters<typeof uiIcon>[0]; subtitle?: string }> = {
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

// --- Entity model pools (player/zombie/turret meshes, created lazily as
// each id first appears, disposed when it disappears from a snapshot —
// same "cache, don't reallocate per frame" discipline Phase 2's syncMeshes
// already established). ---
const playerModels = new Map<string, PlayerModel>();
const pendingPlayerModels = new Set<string>();
const zombieModels = new Map<string, ZombieModel>();
const pendingZombieModels = new Set<string>();
const turretModels = new Map<string, TurretModel>();

const playerFacing = new Map<string, { angle: number; lastX: number; lastY: number }>();
const zombieFacing = new Map<string, { angle: number; lastX: number; lastY: number }>();
const zombieLungeUntil = new Map<string, number>();
const lastZombieAttacksLanded = new Map<string, number>();
const lastPlayerShotsFired = new Map<string, number>();
const lastTurretShotsFired = new Map<string, number>();

function updateFacing(map: Map<string, { angle: number; lastX: number; lastY: number }>, id: string, x: number, y: number): { angle: number; moved: boolean } {
  let f = map.get(id);
  if (!f) {
    f = { angle: 0, lastX: x, lastY: y };
    map.set(id, f);
    return { angle: f.angle, moved: false };
  }
  const dx = x - f.lastX;
  const dy = y - f.lastY;
  const moved = Math.hypot(dx, dy) > 0.3;
  if (moved) {
    f.angle = Math.atan2(dy, dx);
    f.lastX = x;
    f.lastY = y;
  }
  return { angle: f.angle, moved };
}

// Where a zombie's just-landed hit should visually appear — same
// lastHitKind/lastHitTargetId-driven lookup main.ts's own zombieHitTargetPos
// uses, simplified here since the 3D wall/base hit case doesn't need the
// Chebyshev-projection-onto-the-square-wall math main.ts's 2D version has
// (BASE_POS alone reads fine as "hit the fortress" at this camera distance).
const zombieHitTargetPos = (z: ZombieSnapshot, state: StateMessage): { x: number; y: number } | undefined => {
  if (z.lastHitKind === "player") {
    const target = state.players.find((p) => p.id === z.lastHitTargetId);
    return target ? { x: target.x, y: target.y } : undefined;
  }
  if (z.lastHitKind === "turret") {
    const target = state.turrets.find((t) => t.id === z.lastHitTargetId);
    return target ? { x: target.x, y: target.y } : undefined;
  }
  if (z.lastHitKind === "wall" || z.lastHitKind === "base") return BASE_POS;
  return undefined;
};

socket.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data) as ServerMessage;
  if (msg.type === "welcome") {
    myPlayerId = msg.playerId;
    try {
      localStorage.setItem(PLAYER_ID_KEY, msg.playerId);
    } catch {
      // ignore
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

  previousState = currentState;
  previousReceivedAt = currentReceivedAt;
  currentState = msg;
  currentReceivedAt = performance.now();
  const self = findSelf(currentState);
  if (self) prediction.reconcile(self, currentReceivedAt);

  wallStructure.setLevel(currentState.wallLevel);

  // Turret tracer VFX — same shotsFired-diff discipline as main.ts.
  for (const t of currentState.turrets) {
    const prevFired = lastTurretShotsFired.get(t.id) ?? 0;
    if (t.shotsFired > prevFired && t.target) {
      vfx.addBullet({ from: new THREE.Vector3(t.x, 20, t.y), to: new THREE.Vector3(t.target.x, 20, t.target.y), firedAt: performance.now() });
    }
    lastTurretShotsFired.set(t.id, t.shotsFired);
  }

  // Remote players' weapon recoil/Attack overlay.
  for (const p of currentState.players) {
    if (p.id === myPlayerId) continue;
    const prevFired = lastPlayerShotsFired.get(p.id) ?? 0;
    if (p.shotsFired > prevFired) lastPlayerShotAt.set(p.id, performance.now());
    lastPlayerShotsFired.set(p.id, p.shotsFired);
  }

  // Player damage feedback — real hp drop between authoritative snapshots.
  const now0 = performance.now();
  for (const p of currentState.players) {
    const prevP = previousState?.players.find((q) => q.id === p.id);
    if (prevP && p.hp < prevP.hp) {
      const amount = prevP.hp - p.hp;
      vfx.addDamageNumber({ pos: new THREE.Vector3(p.x, 0, p.y), amount, spawnedAt: now0 });
      lastPlayerHitAt.set(p.id, now0);
    }
  }

  // Zombie attack effects — driven by attacksLanded actually increasing.
  for (const z of currentState.zombies) {
    const prevLanded = lastZombieAttacksLanded.get(z.id) ?? 0;
    if (z.attacksLanded > prevLanded) {
      const targetPos = zombieHitTargetPos(z, currentState);
      if (targetPos) {
        if (z.type === "flying") {
          vfx.addProjectile({ from: new THREE.Vector3(z.x, 60, z.y), to: new THREE.Vector3(targetPos.x, 20, targetPos.y), firedAt: now0 });
          vfx.addImpact({ pos: new THREE.Vector3(targetPos.x, 0, targetPos.y), kind: "melee", startedAt: now0 + 300 });
        } else {
          vfx.addImpact({ pos: new THREE.Vector3(targetPos.x, 0, targetPos.y), kind: "melee", startedAt: now0 });
          zombieLungeUntil.set(z.id, now0);
        }
      }
    }
    lastZombieAttacksLanded.set(z.id, z.attacksLanded);
  }

  // Giant death explosion VFX.
  if (previousState) {
    const currentZombieIds = new Set(currentState.zombies.map((z) => z.id));
    for (const z of previousState.zombies) {
      if (z.type === "giant" && !currentZombieIds.has(z.id)) {
        vfx.addImpact({ pos: new THREE.Vector3(z.x, 0, z.y), kind: "explosion", startedAt: now0 });
      }
    }
  }

  checkForNewEnemies(currentState);
  updateHud(currentState);
  updateTeamPanel(currentState);
  updatePhaseUi(currentState.phase);
  updateCharacterSelectUi(currentState);
  renderMenu(currentState);
});

// --- Main frame loop ---------------------------------------------------
let lastFrameTimestamp: number | undefined;
let frozenAt: number | undefined;

function syncEntities(state: StateMessage): void {
  // Players
  const seenPlayers = new Set<string>();
  for (const p of state.players) {
    seenPlayers.add(p.id);
    if (!playerModels.has(p.id) && !pendingPlayerModels.has(p.id)) {
      pendingPlayerModels.add(p.id);
      createPlayerModel(p.colorIndex).then((model) => {
        pendingPlayerModels.delete(p.id);
        if (!currentState || !currentState.players.some((pp) => pp.id === p.id)) {
          model.dispose();
          return;
        }
        playerModels.set(p.id, model);
        scene3d.scene.add(model.root);
      });
    }
  }
  for (const [id, model] of playerModels) {
    if (!seenPlayers.has(id)) {
      scene3d.scene.remove(model.root);
      model.dispose();
      playerModels.delete(id);
    }
  }

  // Zombies
  const seenZombies = new Set<string>();
  for (const z of state.zombies) {
    seenZombies.add(z.id);
    if (!zombieModels.has(z.id) && !pendingZombieModels.has(z.id)) {
      pendingZombieModels.add(z.id);
      createZombieModel(z.type).then((model) => {
        pendingZombieModels.delete(z.id);
        if (!currentState || !currentState.zombies.some((zz) => zz.id === z.id)) {
          model.dispose();
          return;
        }
        zombieModels.set(z.id, model);
        scene3d.scene.add(model.root);
      });
    }
  }
  for (const [id, model] of zombieModels) {
    if (!seenZombies.has(id)) {
      scene3d.scene.remove(model.root);
      model.dispose();
      zombieModels.delete(id);
    }
  }

  // Turrets
  const seenTurrets = new Set<string>();
  for (const t of state.turrets) {
    seenTurrets.add(t.id);
    let model = turretModels.get(t.id);
    if (!model) {
      model = createTurretModel();
      turretModels.set(t.id, model);
      scene3d.scene.add(model.group);
    }
    model.update(t);
  }
  for (const [id, model] of turretModels) {
    if (!seenTurrets.has(id)) {
      scene3d.scene.remove(model.group);
      turretModels.delete(id);
    }
  }
}

function frame(timestamp: number): void {
  const dtMs = lastFrameTimestamp === undefined ? 0 : timestamp - lastFrameTimestamp;
  lastFrameTimestamp = timestamp;

  if (currentIntro !== undefined && introShownAt !== undefined && timestamp - introShownAt > INTRO_AUTO_DISMISS_MS) {
    dismissIntro();
  }

  if (currentState) {
    const self = findSelf(currentState);
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
    displayState.players = displayState.players.map((p) => (p.id === myPlayerId && p.status === "alive" ? { ...p, x: predictedPos.x, y: predictedPos.y } : p));

    syncEntities(displayState);

    // Drive every live player model.
    for (const p of displayState.players) {
      const model = playerModels.get(p.id);
      if (!model) continue;
      let facingAngle: number;
      let speed: number;
      if (p.id === myPlayerId) {
        facingAngle = input.getAimAngle();
        const moveState = input.getMoveState();
        speed = moveState.up || moveState.down || moveState.left || moveState.right ? 150 : 0;
      } else {
        const f = updateFacing(playerFacing, p.id, p.x, p.y);
        facingAngle = f.angle;
        speed = f.moved ? 150 : 0;
      }
      model.update(dtMs, p, facingAngle, speed, lastPlayerShotAt.get(p.id), lastPlayerHitAt.get(p.id), timestamp);
      model.mixer.update(dtMs / 1000);
    }

    // Drive every live zombie model.
    for (const z of displayState.zombies) {
      const model = zombieModels.get(z.id);
      if (!model) continue;
      const f = updateFacing(zombieFacing, z.id, z.x, z.y);
      model.update(z, f.angle, zombieLungeUntil.get(z.id), timestamp);
      model.mixer.update(dtMs / 1000);
    }

    baseStructure.update(timestamp);
    vfx.update(timestamp);

    // Crosshair overlay — mirrors render.ts's renderCrosshair (hidden until
    // the first mousemove gives a real world position), positioned in CSS
    // pixels via scene3d.worldToScreen, the inverse of the same raycast
    // input.ts's screenToWorld already uses for this same mouse position.
    const mouseWorld = input.getMouseWorldPos();
    if (mouseWorld) {
      const screenPos = scene3d.worldToScreen(mouseWorld.x, mouseWorld.y);
      crosshair.style.left = `${screenPos.x}px`;
      crosshair.style.top = `${screenPos.y}px`;
      crosshair.hidden = false;
    }

    const followPos = predictedPos;
    if (dtMs > 0) {
      const t = 1 - Math.exp(-(ZOOM_EASE_PER_SEC * dtMs) / 1000);
      zoomCurrent += (zoomTarget - zoomCurrent) * t;
    }
    scene3d.updateCamera(followPos.x, followPos.y, zoomCurrent);

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

  scene3d.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
