import { BASE_ATTACK_RANGE, BASE_POS, TURRET_BUILD_RADIUS, TURRET_LEVELS, WALL_PULSE_RADIUS, WALL_RING_RADIUS, WORLD_SIZE } from "./defense-config.ts";
import { isReady, TILE_SIZE, TILESET, TILESET_REGIONS, UI_REGIONS, UI_SHEET, ZOMBIE_SHEETS } from "./sprites.ts";
import { DECORATIVE_PROPS, type Prop } from "./terrain.ts";
import type { StateMessage, TurretSnapshot, ZombieSnapshot, ZombieType } from "./protocol.ts";

// Just enough visual distinction per wall level — colour/thickness, plus
// which ability each level actually has (WALL_LEVELS in defense-config.ts
// says the real numbers; this table only decides how to draw it).
const WALL_VISUALS: Record<number, { color: string; lineWidth: number; ability: "none" | "pulse" | "spike" }> = {
  1: { color: "#9aa0a6", lineWidth: 4, ability: "none" },
  2: { color: "#6fc2a6", lineWidth: 5, ability: "pulse" },
  3: { color: "#7fa6c9", lineWidth: 5, ability: "spike" },
  4: { color: "#c9a0ff", lineWidth: 6, ability: "spike" },
  5: { color: "#ffd166", lineWidth: 7, ability: "spike" },
};

// Per-type render treatment. The CraftPix pack has no sprite shaped like a
// "flying"/"giant"/"boss" monster — all four Enemies_N sets are palette-swap
// reskins of the same civilian-zombie character (see sprites.ts's own
// comment) — so role is told apart by scale/motion/glow here, not by
// distinct art. Documented, not hidden.
const ZOMBIE_RENDER: Record<ZombieType, { scale: number; hover: boolean; glow?: string }> = {
  normal: { scale: 1.1, hover: false },
  flying: { scale: 1.0, hover: true, glow: "rgba(90, 220, 230, 0.35)" },
  giant: { scale: 1.9, hover: false, glow: "rgba(140, 90, 40, 0.25)" },
  boss: { scale: 2.6, hover: false, glow: "rgba(220, 40, 40, 0.4)" },
};

const REMOTE_PLAYER_COLORS = ["#ff6666", "#66b2ff", "#66ff99", "#ffcc66"];
const LOCAL_PLAYER_COLOR = "#ffcc00";

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// --- Ground layer: built once into an offscreen canvas and reused every
// frame (cheap single blit) instead of re-tiling ~1,700 sprite draws per
// frame. Rebuilt only if the canvas size changes or the tileset image
// finishes loading after the first attempt. ---
let terrainLayer: HTMLCanvasElement | undefined;
let terrainLayerFor = { size: 0, ready: false };
const GROUND_TILE_WORLD = 25; // world units per ground tile — coarser than the asset's native 16px, which keeps the per-frame blit count down without reading as obviously different art

function buildTerrainLayer(canvasSize: number): HTMLCanvasElement {
  const layer = document.createElement("canvas");
  layer.width = canvasSize;
  layer.height = canvasSize;
  const lctx = layer.getContext("2d");
  if (!lctx) return layer;
  lctx.imageSmoothingEnabled = false;
  const scale = canvasSize / WORLD_SIZE;
  const drawTile = GROUND_TILE_WORLD * scale;
  const cols = Math.ceil(WORLD_SIZE / GROUND_TILE_WORLD);
  const rows = Math.ceil(WORLD_SIZE / GROUND_TILE_WORLD);
  const variants = TILESET_REGIONS.pavement;
  for (let gx = 0; gx < cols; gx++) {
    for (let gy = 0; gy < rows; gy++) {
      // Deterministic pseudo-random pick so the ground reads as varied
      // concrete, not an obviously repeating 3-tile stamp.
      const mix = (gx * 928371 + gy * 654323) % 97;
      const useAlt = mix % 11 === 0;
      const region = useAlt ? TILESET_REGIONS.pavementAlt : variants[mix % variants.length];
      lctx.drawImage(TILESET, region.sx, region.sy, TILE_SIZE, TILE_SIZE, gx * drawTile, gy * drawTile, drawTile + 1, drawTile + 1);
    }
  }
  return layer;
}

function getTerrainLayer(canvasSize: number): HTMLCanvasElement | undefined {
  const ready = isReady(TILESET);
  if (!ready) return undefined;
  if (!terrainLayer || terrainLayerFor.size !== canvasSize || !terrainLayerFor.ready) {
    terrainLayer = buildTerrainLayer(canvasSize);
    terrainLayerFor = { size: canvasSize, ready };
  }
  return terrainLayer;
}

const PROP_REGIONS: Record<Prop["type"], { sx: number; sy: number; sw: number; sh: number }> = {
  tree: TILESET_REGIONS.tree,
  bush: TILESET_REGIONS.bush,
  bench: TILESET_REGIONS.bench,
  dumpster: TILESET_REGIONS.dumpster,
  crate: TILESET_REGIONS.crate,
  barrel: TILESET_REGIONS.barrel,
};

function renderProps(ctx: CanvasRenderingContext2D, scale: number): void {
  if (!isReady(TILESET)) return;
  for (const prop of DECORATIVE_PROPS) {
    const r = PROP_REGIONS[prop.type];
    const dw = r.sw * scale;
    const dh = r.sh * scale;
    const x = prop.x * scale;
    const y = prop.y * scale;
    ctx.drawImage(TILESET, r.sx, r.sy, r.sw, r.sh, x - dw / 2, y - dh / 2, dw, dh);
  }
}

// Per-zombie animation phase + facing memory, keyed by id — module-level
// since render() is called fresh every frame with no history of its own.
// Entries for zombies no longer present are harmless (just unused keys);
// the zombie population is small enough that this never needs pruning.
const zombieFacing = new Map<string, { facing: 1 | -1; lastX: number }>();

function renderZombie(ctx: CanvasRenderingContext2D, scale: number, z: ZombieSnapshot): void {
  const screen = { x: z.x * scale, y: z.y * scale };
  const cfg = ZOMBIE_RENDER[z.type];
  const sheets = ZOMBIE_SHEETS[z.type];
  const sheet = z.attacking ? sheets.attack : sheets.walk;

  let face = zombieFacing.get(z.id);
  if (!face) {
    face = { facing: 1, lastX: z.x };
    zombieFacing.set(z.id, face);
  } else if (Math.abs(z.x - face.lastX) > 0.5) {
    face.facing = z.x > face.lastX ? 1 : -1;
    face.lastX = z.x;
  }

  const phase = hashStr(z.id);
  const now = performance.now();
  const hoverOffset = cfg.hover ? Math.sin(now / 260 + phase) * 5 : 0;
  const drawSize = 32 * cfg.scale * scale * 0.9;

  if (cfg.glow) {
    ctx.save();
    ctx.globalAlpha = 0.8;
    const grad = ctx.createRadialGradient(screen.x, screen.y + hoverOffset * scale, 2, screen.x, screen.y + hoverOffset * scale, drawSize * 0.75);
    grad.addColorStop(0, cfg.glow);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y + hoverOffset * scale, drawSize * 0.75, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (cfg.hover) {
    // A flying zombie's own ground shadow, drawn at its true (non-hover)
    // position, so the hover motion actually reads as height off the ground.
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(screen.x, screen.y + drawSize * 0.35, drawSize * 0.28, drawSize * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (isReady(sheet.image)) {
    const frameIdx = Math.floor(now / 130 + phase) % sheet.frameCount;
    ctx.save();
    ctx.translate(screen.x, screen.y + hoverOffset * scale);
    ctx.scale(face.facing, 1);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sheet.image, frameIdx * sheet.frameWidth, 0, sheet.frameWidth, sheet.frameHeight, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
    ctx.restore();
  } else {
    // Sprite not loaded yet (or failed) — a flat-colour placeholder so the
    // zombie is never simply invisible.
    ctx.fillStyle = "#4caf50";
    ctx.beginPath();
    ctx.arc(screen.x, screen.y + hoverOffset * scale, drawSize / 3, 0, Math.PI * 2);
    ctx.fill();
  }

  const barWidth = Math.max(18, drawSize * 0.6);
  const barHeight = 3;
  const barX = screen.x - barWidth / 2;
  const barY = screen.y - drawSize / 2 - 8 + hoverOffset * scale;
  const fraction = Math.max(0, Math.min(1, z.hp / z.maxHp));
  ctx.fillStyle = "#552222";
  ctx.fillRect(barX, barY, barWidth, barHeight);
  ctx.fillStyle = fraction > 0.3 ? "#5fd35f" : "#e05c5c";
  ctx.fillRect(barX, barY, barWidth * fraction, barHeight);
}

// A zombie that was present last frame and is gone this frame either died
// or was despawned — spawn a brief death-sprite effect at its last known
// spot. Purely cosmetic (render.ts owns this entirely; nothing here
// influences any gameplay state), and a graceful no-op if the sprite never
// loaded (no placeholder death animation invented).
export interface DeathEffect {
  type: ZombieType;
  x: number;
  y: number;
  diedAt: number;
}
const DEATH_EFFECT_MS = 500;
export function collectDeathEffects(previous: readonly ZombieSnapshot[] | undefined, current: readonly ZombieSnapshot[], now: number, into: DeathEffect[]): void {
  if (!previous) return;
  const currentIds = new Set(current.map((z) => z.id));
  for (const z of previous) {
    if (!currentIds.has(z.id)) into.push({ type: z.type, x: z.x, y: z.y, diedAt: now });
  }
}
export function renderDeathEffects(ctx: CanvasRenderingContext2D, scale: number, effects: DeathEffect[], now: number): void {
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    const age = now - e.diedAt;
    if (age > DEATH_EFFECT_MS) {
      effects.splice(i, 1);
      continue;
    }
    const sheet = ZOMBIE_SHEETS[e.type].dead;
    if (!isReady(sheet.image)) continue;
    const frameIdx = age > DEATH_EFFECT_MS / 2 ? 1 : 0;
    const alpha = 1 - age / DEATH_EFFECT_MS;
    const drawSize = 32 * ZOMBIE_RENDER[e.type].scale * scale * 0.9;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sheet.image, frameIdx * sheet.frameWidth, 0, sheet.frameWidth, sheet.frameHeight, e.x * scale - drawSize / 2, e.y * scale - drawSize / 2, drawSize, drawSize);
    ctx.restore();
  }
}

// Plain shapes for the player (kept modular and swappable — see
// PROCESS.md's visual-redesign entry on why: the CraftPix pack has no
// player-character sprite at all) and sprite art for everything else.
// Renders exactly what the server sent; never infers or predicts anything.
export function render(
  ctx: CanvasRenderingContext2D,
  canvasSize: number,
  state: StateMessage,
  aimAngle: number,
  myPlayerId: string | undefined,
): void {
  const scale = canvasSize / WORLD_SIZE;
  const toScreen = (x: number, y: number) => ({ x: x * scale, y: y * scale });

  const terrain = getTerrainLayer(canvasSize);
  if (terrain) {
    ctx.drawImage(terrain, 0, 0);
  } else {
    ctx.fillStyle = "#2a2622";
    ctx.fillRect(0, 0, canvasSize, canvasSize);
  }
  renderProps(ctx, scale);

  const base = toScreen(BASE_POS.x, BASE_POS.y);
  const ringRadius = scale * WALL_RING_RADIUS;

  if (state.wallHp > 0 && state.wallLevel > 0) {
    const visual = WALL_VISUALS[state.wallLevel] ?? WALL_VISUALS[1];

    // Fence-panel segments tiled around the ring for texture, tinted by a
    // colour wash matching the level (drawn after, see below) so the level
    // still reads clearly at a glance even though the sprite art itself
    // doesn't change per level.
    if (isReady(TILESET)) {
      const segmentCount = Math.max(8, Math.round((2 * Math.PI * ringRadius) / (TILESET_REGIONS.fencePanel.sw * scale * 0.9)));
      const segSize = (2 * Math.PI * ringRadius) / segmentCount;
      for (let i = 0; i < segmentCount; i++) {
        const angle = (i / segmentCount) * Math.PI * 2;
        const px = base.x + Math.cos(angle) * ringRadius;
        const py = base.y + Math.sin(angle) * ringRadius;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(angle + Math.PI / 2);
        ctx.imageSmoothingEnabled = false;
        const r = TILESET_REGIONS.fencePanel;
        ctx.drawImage(TILESET, r.sx, r.sy, r.sw, r.sh, -segSize / 2, -segSize / 2, segSize, segSize);
        ctx.restore();
      }
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = visual.color;
      ctx.lineWidth = visual.lineWidth;
      ctx.beginPath();
      ctx.arc(base.x, base.y, ringRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.strokeStyle = visual.color;
      ctx.lineWidth = visual.lineWidth;
      ctx.beginPath();
      ctx.arc(base.x, base.y, ringRadius, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (visual.ability === "spike") {
      const spikeCount = 14;
      const spikeLength = 7;
      ctx.strokeStyle = visual.color;
      ctx.lineWidth = 2;
      for (let i = 0; i < spikeCount; i++) {
        const angle = (i / spikeCount) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(base.x + Math.cos(angle) * ringRadius, base.y + Math.sin(angle) * ringRadius);
        ctx.lineTo(base.x + Math.cos(angle) * (ringRadius + spikeLength), base.y + Math.sin(angle) * (ringRadius + spikeLength));
        ctx.stroke();
      }
    } else if (visual.ability === "pulse") {
      ctx.strokeStyle = "rgba(111, 194, 166, 0.3)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.arc(base.x, base.y, scale * WALL_PULSE_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Level badge so the number is unambiguous even with the fence texture.
    ctx.fillStyle = "#111";
    ctx.beginPath();
    ctx.arc(base.x, base.y - ringRadius, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = visual.color;
    ctx.textAlign = "center";
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.fillText(`${state.wallLevel}`, base.x, base.y - ringRadius + 4);
    ctx.textAlign = "left";
  }

  renderBase(ctx, base, scale);

  for (const turret of state.turrets) {
    renderTurret(ctx, scale, turret);
  }

  for (const z of state.zombies) {
    renderZombie(ctx, scale, z);
  }

  for (const p of state.players) {
    renderPlayer(ctx, toScreen, p, p.id === myPlayerId, aimAngle);
  }

  for (const prog of state.reviveProgress) {
    const target = state.players.find((p) => p.id === prog.targetId);
    if (!target) continue;
    renderReviveProgress(ctx, toScreen(target.x, target.y), prog.remainingMs);
  }
}

function renderBase(ctx: CanvasRenderingContext2D, base: { x: number; y: number }, scale: number): void {
  if (isReady(TILESET)) {
    const r = TILESET_REGIONS.vaultDoor;
    const dw = r.sw * scale * 1.6;
    const dh = r.sh * scale * 1.6;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(TILESET, r.sx, r.sy, r.sw, r.sh, base.x - dw / 2, base.y - dh / 2, dw, dh);
    ctx.restore();
  } else {
    ctx.fillStyle = "#4477cc";
    ctx.beginPath();
    ctx.arc(base.x, base.y, 18, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderTurret(ctx: CanvasRenderingContext2D, scale: number, turret: TurretSnapshot): void {
  if (turret.hp <= 0) return;
  const screen = { x: turret.x * scale, y: turret.y * scale };
  const range = TURRET_LEVELS[turret.level]?.range ?? TURRET_LEVELS[1].range;

  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, scale * range, 0, Math.PI * 2);
  ctx.stroke();

  // A crate/barrel from the tileset as a grounded mount under the drawn
  // turret body — no turret sprite exists in the pack, so the turret itself
  // stays a drawn shape (CLAUDE.md: prefer simple Canvas geometry over
  // inventing assets that don't exist), just visually anchored to the scene.
  if (isReady(TILESET)) {
    const mount = turret.level >= 3 ? TILESET_REGIONS.barrel : TILESET_REGIONS.crate;
    const mw = mount.sw * scale * 1.4;
    const mh = mount.sh * scale * 1.4;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(TILESET, mount.sx, mount.sy, mount.sw, mount.sh, screen.x - mw / 2, screen.y - mh / 2 + 4, mw, mh);
    ctx.restore();
  }

  const bodyRadius = 8 + turret.level;
  ctx.fillStyle = "#cc6633";
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, bodyRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1c1c1c";
  ctx.font = "bold 10px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`${turret.level}`, screen.x, screen.y + 3);
  ctx.textAlign = "left";

  if (turret.target) {
    const angle = Math.atan2(turret.target.y * scale - screen.y, turret.target.x * scale - screen.x);
    ctx.strokeStyle = "#cc6633";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(screen.x, screen.y);
    ctx.lineTo(screen.x + Math.cos(angle) * 14, screen.y + Math.sin(angle) * 14);
    ctx.stroke();
  }

  const barWidth = 22;
  const barHeight = 3;
  const barX = screen.x - barWidth / 2;
  const barY = screen.y - bodyRadius - 8;
  const fraction = Math.max(0, Math.min(1, turret.hp / turret.maxHp));
  ctx.fillStyle = "#552222";
  ctx.fillRect(barX, barY, barWidth, barHeight);
  ctx.fillStyle = fraction > 0.3 ? "#5fd35f" : "#e05c5c";
  ctx.fillRect(barX, barY, barWidth * fraction, barHeight);
}

function renderPlayer(
  ctx: CanvasRenderingContext2D,
  toScreen: (x: number, y: number) => { x: number; y: number },
  p: StateMessage["players"][number],
  isSelf: boolean,
  aimAngle: number,
): void {
  const screen = toScreen(p.x, p.y);
  const angle = isSelf ? aimAngle : 0;
  const color = isSelf ? LOCAL_PLAYER_COLOR : REMOTE_PLAYER_COLORS[p.colorIndex % REMOTE_PLAYER_COLORS.length];

  ctx.save();
  ctx.translate(screen.x, screen.y);
  if (p.status === "alive") {
    ctx.rotate(angle);
    ctx.globalAlpha = p.invulnerable ? 0.55 + 0.35 * Math.sin(performance.now() / 80) : 1;
    // Body + a darker outline for contrast against the now-textured ground.
    ctx.fillStyle = "#00000055";
    ctx.beginPath();
    ctx.ellipse(1, 1, 11, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(0, 0, 11, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(6, 0, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#333";
    ctx.fillRect(8, -2, 15, 4);
    // A small team-colour pip on the head reinforces "which colour is this
    // player" at a glance even for a remote player facing away from aim.
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(6, -2, 1.5, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.globalAlpha = p.status === "dead" ? 0.3 : 0.6;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(0, 0, 13, 6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.globalAlpha = 1;

  if (isSelf && p.status === "alive") {
    const aimLength = 30;
    ctx.strokeStyle = LOCAL_PLAYER_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(screen.x, screen.y);
    ctx.lineTo(screen.x + Math.cos(aimAngle) * aimLength, screen.y + Math.sin(aimAngle) * aimLength);
    ctx.stroke();
  }

  if (p.status !== "dead") {
    const barWidth = 26;
    const barHeight = 3;
    const barX = screen.x - barWidth / 2;
    const barY = screen.y - 20;
    const fraction = Math.max(0, Math.min(1, p.hp / p.maxHp));
    ctx.fillStyle = "#333";
    ctx.fillRect(barX, barY, barWidth, barHeight);
    ctx.fillStyle = p.status === "downed" ? "#e0a05c" : fraction > 0.3 ? "#5fd35f" : "#e05c5c";
    ctx.fillRect(barX, barY, barWidth * fraction, barHeight);
  }

  if (p.status === "downed") {
    ctx.textAlign = "center";
    ctx.fillStyle = "#e0a05c";
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.fillText(`DOWNED ${Math.ceil(p.downedRemainingMs / 1000)}s`, screen.x, screen.y - 24);
    ctx.textAlign = "left";
  } else if (p.status === "dead") {
    ctx.textAlign = "center";
    ctx.fillStyle = "#888";
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.fillText("DEAD", screen.x, screen.y - 20);
    ctx.textAlign = "left";
  } else if (p.healing) {
    ctx.textAlign = "center";
    ctx.fillStyle = "#6fe08a";
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.fillText("HEALING…", screen.x, screen.y - 24);
    ctx.textAlign = "left";
  }
}

function renderReviveProgress(ctx: CanvasRenderingContext2D, screen: { x: number; y: number }, remainingMs: number): void {
  const total = 3000;
  const fraction = Math.max(0, Math.min(1, 1 - remainingMs / total));
  const barWidth = 34;
  const barHeight = 5;
  const barX = screen.x - barWidth / 2;
  const barY = screen.y - 34;
  ctx.fillStyle = "#222";
  ctx.fillRect(barX, barY, barWidth, barHeight);
  ctx.fillStyle = "#6fe08a";
  ctx.fillRect(barX, barY, barWidth * fraction, barHeight);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1;
  ctx.strokeRect(barX, barY, barWidth, barHeight);
}

export function renderDayProgress(
  ctx: CanvasRenderingContext2D,
  canvasSize: number,
  day: number,
  killed: number,
  total: number,
): void {
  const centerX = canvasSize / 2;

  ctx.textAlign = "center";
  ctx.fillStyle = "#fff";
  ctx.font = "bold 28px system-ui, sans-serif";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 6;
  ctx.fillText(`DAY ${day}`, centerX, 34);
  ctx.shadowBlur = 0;

  const barWidth = 220;
  const barHeight = 14;
  const barX = centerX - barWidth / 2;
  const barY = 44;
  const fraction = total > 0 ? killed / total : 0;

  ctx.strokeStyle = "#888";
  ctx.lineWidth = 2;
  ctx.strokeRect(barX, barY, barWidth, barHeight);
  ctx.fillStyle = "#4caf50";
  ctx.fillRect(barX, barY, barWidth * fraction, barHeight);

  ctx.fillStyle = "#fff";
  ctx.font = "14px system-ui, sans-serif";
  ctx.fillText(`${killed} / ${total} ZOMBIES`, centerX, barY + barHeight + 18);

  ctx.textAlign = "left";
}

export function renderDayIntro(ctx: CanvasRenderingContext2D, canvasSize: number, day: number, remainingMs: number): void {
  const centerX = canvasSize / 2;
  const centerY = canvasSize / 2;
  const t = Math.max(0, Math.min(1, remainingMs / 5000));

  ctx.fillStyle = `rgba(0, 0, 0, ${0.35 + 0.25 * t})`;
  ctx.fillRect(0, 0, canvasSize, canvasSize);

  const scale = 1 + 0.15 * Math.sin(performance.now() / 180);
  ctx.save();
  ctx.translate(centerX, centerY - 40);
  ctx.scale(scale, scale);
  ctx.textAlign = "center";
  ctx.fillStyle = "#fff";
  ctx.font = "bold 56px system-ui, sans-serif";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 12;
  ctx.fillText(`DAY ${day}`, 0, 0);
  ctx.restore();

  const count = Math.max(1, Math.ceil(remainingMs / 1000));
  ctx.fillStyle = "#ffcc00";
  ctx.font = "bold 72px system-ui, sans-serif";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 12;
  ctx.fillText(`${count}`, centerX, centerY + 60);
  ctx.shadowBlur = 0;
  ctx.textAlign = "left";
}

export function renderCrosshair(ctx: CanvasRenderingContext2D, canvasSize: number, mouseWorldPos: { x: number; y: number }): void {
  const scale = canvasSize / WORLD_SIZE;
  const x = mouseWorldPos.x * scale;
  const y = mouseWorldPos.y * scale;
  const inner = 4;
  const outer = 11;
  ctx.strokeStyle = "#ff5555";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - outer, y);
  ctx.lineTo(x - inner, y);
  ctx.moveTo(x + inner, y);
  ctx.lineTo(x + outer, y);
  ctx.moveTo(x, y - outer);
  ctx.lineTo(x, y - inner);
  ctx.moveTo(x, y + inner);
  ctx.lineTo(x, y + outer);
  ctx.stroke();
}

export interface ShotEffect {
  x: number;
  y: number;
  angle: number;
  firedAt: number;
}

export const TRACER_LIFETIME_MS = 130;
const TRACER_LENGTH = 220;

export function renderShotEffects(
  ctx: CanvasRenderingContext2D,
  canvasSize: number,
  effects: readonly ShotEffect[],
  now: number,
): void {
  const scale = canvasSize / WORLD_SIZE;
  for (const e of effects) {
    const age = now - e.firedAt;
    if (age < 0 || age > TRACER_LIFETIME_MS) continue;
    const alpha = 1 - age / TRACER_LIFETIME_MS;

    const x1 = e.x * scale;
    const y1 = e.y * scale;
    const x2 = (e.x + Math.cos(e.angle) * TRACER_LENGTH) * scale;
    const y2 = (e.y + Math.sin(e.angle) * TRACER_LENGTH) * scale;

    ctx.strokeStyle = `rgba(255, 240, 150, ${alpha})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.fillStyle = `rgba(255, 220, 120, ${alpha})`;
    ctx.beginPath();
    ctx.arc(x1, y1, 2 + 6 * alpha, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function renderTurretPlacementPreview(
  ctx: CanvasRenderingContext2D,
  canvasSize: number,
  mouseWorldPos: { x: number; y: number },
  valid: boolean,
): void {
  const scale = canvasSize / WORLD_SIZE;
  const base = { x: BASE_POS.x * scale, y: BASE_POS.y * scale };

  ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.arc(base.x, base.y, scale * TURRET_BUILD_RADIUS, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(base.x, base.y, scale * BASE_ATTACK_RANGE, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  const p = { x: mouseWorldPos.x * scale, y: mouseWorldPos.y * scale };
  ctx.fillStyle = valid ? "rgba(100, 220, 120, 0.8)" : "rgba(220, 80, 80, 0.8)";
  ctx.beginPath();
  ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = valid ? "#64dc78" : "#dc5050";
  ctx.lineWidth = 2;
  ctx.stroke();
}

// --- UI icon helper, for main.ts's HTML-rendered HUD/menus (not canvas) ---
export function uiIconStyle(region: { sx: number; sy: number; sw: number; sh: number }, size = 16): string {
  return [
    `display:inline-block`,
    `width:${size}px`,
    `height:${size}px`,
    `vertical-align:-3px`,
    `background-image:url(/sprites/ui.png)`,
    `background-position:-${region.sx}px -${region.sy}px`,
    `background-repeat:no-repeat`,
    `image-rendering:pixelated`,
  ].join(";");
}
export { UI_REGIONS };
