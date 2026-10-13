import { BASE_ATTACK_RANGE, BASE_INTERACT_RANGE, BASE_POS, TURRET_BUILD_RADIUS, TURRET_LEVELS, WALL_PULSE_RADIUS, WALL_RING_RADIUS, WORLD_SIZE } from "./defense-config.ts";
import { isReady, TILE_SIZE, TILESET, TILESET_REGIONS, uiIconUrl, type UiIconName, ZOMBIE_SHEETS } from "./sprites.ts";
import { DECORATIVE_PROPS, GROUND_MARKS, OUTER_ZONE_RADIUS, type GroundMark, type Prop } from "./terrain.ts";
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
// "giant"/"boss" monster — both reuse palette-swap reskins of the same
// civilian-zombie character (see sprites.ts's own comment) — so those two
// are told apart by scale/tint here, not by distinct art. Flying used to be
// a third reskin of the same body; it's now drawn procedurally (see
// renderFlyingZombie below) specifically so it reads as a different KIND of
// threat, not just a recoloured ground zombie — the exact confusion this
// was built to fix.
const ZOMBIE_RENDER: Record<ZombieType, { scale: number; hover: boolean; glow?: string }> = {
  normal: { scale: 1.1, hover: false },
  flying: { scale: 1.0, hover: true, glow: "rgba(90, 220, 230, 0.35)" },
  giant: { scale: 1.9, hover: false, glow: "rgba(140, 90, 40, 0.25)" },
  boss: { scale: 2.6, hover: false, glow: "rgba(220, 40, 40, 0.4)" },
};

// A brief forward-lunge pulse plays exactly when a zombie's attack actually
// lands (main.ts drives this from ZombieSnapshot.attacksLanded, never from
// `attacking`/timing alone — see protocol.ts) so the moment damage is dealt
// reads as a distinct beat, not just a held "attacking" pose.
const LUNGE_DURATION_MS = 180;

const REMOTE_PLAYER_COLORS = ["#ff6666", "#66b2ff", "#66ff99", "#ffcc66"];
const LOCAL_PLAYER_COLOR = "#ffcc00";

function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// --- Ground layer: built once into an offscreen canvas and reused every
// frame (cheap single blit) instead of re-tiling ~1,700 sprite draws (plus
// the ground-mark/base-pad decoration below) per frame. Rebuilt only if the
// canvas size changes or the tileset image finishes loading after the first
// attempt. ---
let terrainLayer: HTMLCanvasElement | undefined;
let terrainLayerFor = { size: 0, ready: false };
const GROUND_TILE_WORLD = 25; // world units per ground tile — coarser than the asset's native 16px, which keeps the per-frame blit count down without reading as obviously different art

// The battlefield reads as three zones radiating out from the base (see
// terrain.ts's own comment): a kept-clean base zone, a mid "combat zone"
// with a believable minority of stained/cracked ground, and a harsher outer
// "danger zone" where the ground itself looks more fought-over — ground
// texture alone, before any props or marks are drawn on top of it.
const BASE_PAD_RADIUS = 92;

function tileRegionFor(worldX: number, worldY: number, mix: number): { sx: number; sy: number } {
  const distFromBase = Math.hypot(worldX - BASE_POS.x, worldY - BASE_POS.y);
  const variants = TILESET_REGIONS.pavement;
  const cracked = TILESET_REGIONS.pavementCracked;

  if (distFromBase < BASE_PAD_RADIUS) {
    // Base zone: the defended core is kept clean — no stained/cracked tiles
    // here, so the painted pad drawn on top of it reads as deliberately
    // maintained rather than just more worn ground.
    return variants[mix % variants.length];
  }
  if (distFromBase < OUTER_ZONE_RADIUS) {
    // Mid combat zone: mostly standard paving with a believable minority of
    // stained/cracked tiles — this is the main fighting area, not a ruin.
    if (mix % 13 === 0) return cracked[mix % cracked.length];
    if (mix % 11 === 0) return TILESET_REGIONS.pavementAlt;
    return variants[mix % variants.length];
  }
  // Outer danger zone: more damaged ground, including the heavily-cracked
  // dark variant, so the direction zombies approach from visually reads as
  // the more hostile edge of the map.
  if (mix % 5 === 0) return TILESET_REGIONS.pavementDamaged;
  if (mix % 4 === 0) return cracked[mix % cracked.length];
  if (mix % 11 === 0) return TILESET_REGIONS.pavementAlt;
  return variants[mix % variants.length];
}

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
  for (let gx = 0; gx < cols; gx++) {
    for (let gy = 0; gy < rows; gy++) {
      // Deterministic pseudo-random pick so the ground reads as varied
      // concrete, not an obviously repeating 3-tile stamp.
      const mix = (gx * 928371 + gy * 654323) % 97;
      const worldX = (gx + 0.5) * GROUND_TILE_WORLD;
      const worldY = (gy + 0.5) * GROUND_TILE_WORLD;
      const region = tileRegionFor(worldX, worldY, mix);
      lctx.drawImage(TILESET, region.sx, region.sy, TILE_SIZE, TILE_SIZE, gx * drawTile, gy * drawTile, drawTile + 1, drawTile + 1);
    }
  }
  renderGroundMarks(lctx, scale);
  renderBasePad(lctx, scale);
  return layer;
}

// Tiny deterministic hash for jittering ground-mark shapes from their own
// seed — not a full PRNG object, just enough variation that marks of the
// same kind don't all look identical.
function pseudo(seed: number, i: number): number {
  const v = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

function renderGroundMark(ctx: CanvasRenderingContext2D, scale: number, mark: GroundMark): void {
  const x = mark.x * scale;
  const y = mark.y * scale;
  const s = mark.scale * scale;

  if (mark.kind === "patch") {
    ctx.fillStyle = "rgba(20, 18, 14, 0.22)";
    for (let i = 0; i < 4; i++) {
      const a = pseudo(mark.seed, i) * Math.PI * 2;
      const rr = s * (0.35 + pseudo(mark.seed, i + 10) * 0.45);
      const ox = Math.cos(a) * s * 0.3;
      const oy = Math.sin(a) * s * 0.3;
      ctx.beginPath();
      ctx.ellipse(x + ox, y + oy, rr, rr * 0.65, a, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (mark.kind === "crack") {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(mark.rotation);
    ctx.strokeStyle = "rgba(8, 8, 6, 0.4)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-s / 2, 0);
    const segments = 5;
    for (let i = 1; i <= segments; i++) {
      const nx = -s / 2 + (s * i) / segments;
      const ny = (pseudo(mark.seed, i) - 0.5) * s * 0.35;
      ctx.lineTo(nx, ny);
      // A short branch off some segments reads as a real fracture, not a
      // single clean line.
      if (i % 2 === 0) {
        ctx.moveTo(nx, ny);
        ctx.lineTo(nx + (pseudo(mark.seed, i + 20) - 0.5) * s * 0.3, ny + s * 0.2);
        ctx.moveTo(nx, ny);
      }
    }
    ctx.stroke();
    ctx.restore();
  } else if (mark.kind === "scorch") {
    const grad = ctx.createRadialGradient(x, y, 0, x, y, s);
    grad.addColorStop(0, "rgba(12, 9, 7, 0.55)");
    grad.addColorStop(0.65, "rgba(25, 18, 12, 0.28)");
    grad.addColorStop(1, "rgba(25, 18, 12, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, s, 0, Math.PI * 2);
    ctx.fill();
  } else if (mark.kind === "blood") {
    ctx.fillStyle = "rgba(92, 24, 22, 0.32)";
    for (let i = 0; i < 5; i++) {
      const a = pseudo(mark.seed, i) * Math.PI * 2;
      const d = pseudo(mark.seed, i + 5) * s;
      const r2 = s * 0.18 * (0.5 + pseudo(mark.seed, i + 15));
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, r2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function renderGroundMarks(ctx: CanvasRenderingContext2D, scale: number): void {
  for (const mark of GROUND_MARKS) renderGroundMark(ctx, scale, mark);
}

// The defended core: a visually distinct fortified pad under the base and
// its wall ring (WALL_RING_RADIUS is 60, comfortably inside this), so "this
// is the one place that matters" reads from the ground itself, not just the
// structures sitting on it.
function renderBasePad(ctx: CanvasRenderingContext2D, scale: number): void {
  const cx = BASE_POS.x * scale;
  const cy = BASE_POS.y * scale;
  const r = BASE_PAD_RADIUS * scale;

  ctx.save();
  ctx.fillStyle = "#312d26";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // A few darker streaks for texture, not a flat colour fill.
  ctx.fillStyle = "rgba(0, 0, 0, 0.12)";
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const rr = r * (0.3 + (i % 3) * 0.2);
    ctx.beginPath();
    ctx.ellipse(cx + Math.cos(a) * rr * 0.5, cy + Math.sin(a) * rr * 0.5, r * 0.22, r * 0.1, a, 0, Math.PI * 2);
    ctx.fill();
  }

  // Structured floor marking: an inset ring plus a hazard-stripe border —
  // reads as a deliberately fortified pad, not just a patch of plain ground.
  ctx.strokeStyle = "rgba(230, 225, 210, 0.16)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.72, 0, Math.PI * 2);
  ctx.stroke();

  const stripeCount = 28;
  for (let i = 0; i < stripeCount; i++) {
    if (i % 2 !== 0) continue;
    const a0 = (i / stripeCount) * Math.PI * 2;
    const a1 = ((i + 1) / stripeCount) * Math.PI * 2;
    ctx.fillStyle = "#c9a227";
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a1);
    ctx.arc(cx, cy, r - 4, a1, a0, true);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
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
  // The same (already-damaged-looking) chain-link panel the wall ring uses
  // — scattered outside it, a few per "barricade remnant" cluster, it reads
  // as leftover defences the battle has moved past rather than more ring.
  fencePanel: TILESET_REGIONS.fencePanel,
};

function renderProps(ctx: CanvasRenderingContext2D, scale: number): void {
  if (!isReady(TILESET)) return;
  for (const prop of DECORATIVE_PROPS) {
    const r = PROP_REGIONS[prop.type];
    const dw = r.sw * scale;
    const dh = r.sh * scale;
    const x = prop.x * scale;
    const y = prop.y * scale;
    if (prop.type === "fencePanel") {
      // A fallen/scattered barricade segment can face any direction — other
      // prop art (trees, benches, crates) has a clear "up" and would look
      // broken rotated arbitrarily, so only this type uses prop.rotation.
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(prop.rotation);
      ctx.drawImage(TILESET, r.sx, r.sy, r.sw, r.sh, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
    } else {
      ctx.drawImage(TILESET, r.sx, r.sy, r.sw, r.sh, x - dw / 2, y - dh / 2, dw, dh);
    }
  }
}

// Per-zombie animation phase + facing memory, keyed by id — module-level
// since render() is called fresh every frame with no history of its own.
// Entries for zombies no longer present are harmless (just unused keys);
// the zombie population is small enough that this never needs pruning.
const zombieFacing = new Map<string, { facing: 1 | -1; lastX: number }>();

// Flying zombies used to reuse a palette-swapped copy of the same civilian-
// zombie sprite every other type uses, which is exactly why players couldn't
// tell a flying attacker from a ground one at a glance. No CC0 animated
// flying-creature sprite sheet matching this project's frame conventions
// exists (checked Kenney, OpenGameArt, itch.io — see PROCESS.md's
// zombie-visual-identity entry), so this is drawn procedurally instead, the
// same call this project already made for the player character and turrets
// ("no sprite in the pack is shaped like this, so draw it rather than force
// a mismatched one in" — CLAUDE.md's own UI rule, "prefer simple Canvas
// geometry"). A bat-like silhouette: wings instead of arms/legs, glowing
// eyes, no ground shadow confusion with a humanoid body.
// Exported so main.ts's "new enemy" intro popup can draw the same bat
// silhouette as its portrait — one definition of "what a flying zombie
// looks like," not a second copy that could drift from the in-world one.
export function renderFlyingZombie(ctx: CanvasRenderingContext2D, drawSize: number, attacking: boolean, lungeFrac: number, phase: number, now: number): void {
  const flap = Math.sin(now / 90 + phase) * 0.5 + 0.5; // fast wingbeat, 0..1
  const wingLift = -flap * drawSize * 0.32;
  const wingSpread = drawSize * (0.95 + lungeFrac * 0.15);

  ctx.fillStyle = "#16262b";
  for (const side of [-1, 1] as const) {
    ctx.beginPath();
    ctx.moveTo(side * drawSize * 0.12, 0);
    ctx.quadraticCurveTo(side * wingSpread * 0.55, wingLift, side * wingSpread * 0.5, drawSize * 0.3);
    ctx.quadraticCurveTo(side * wingSpread * 0.28, drawSize * 0.08, side * drawSize * 0.08, drawSize * 0.12);
    ctx.closePath();
    ctx.fill();
  }

  // Body
  const bodyScale = 1 + lungeFrac * 0.12;
  ctx.fillStyle = "#223842";
  ctx.beginPath();
  ctx.ellipse(0, 0, drawSize * 0.22 * bodyScale, drawSize * 0.27 * bodyScale, 0, 0, Math.PI * 2);
  ctx.fill();

  // Glowing eyes — brighter and wider apart mid-lunge, the "about to bite"
  // beat players can read as the attack actually connecting.
  const eyeGlow = attacking ? 0.5 + 0.5 * lungeFrac : 0;
  ctx.fillStyle = `rgba(${150 + 105 * eyeGlow}, 245, 255, ${0.75 + 0.25 * eyeGlow})`;
  const eyeSpread = drawSize * (0.08 + lungeFrac * 0.03);
  const eyeSize = drawSize * (0.045 + eyeGlow * 0.02);
  ctx.beginPath();
  ctx.arc(-eyeSpread, -drawSize * 0.05, eyeSize, 0, Math.PI * 2);
  ctx.arc(eyeSpread, -drawSize * 0.05, eyeSize, 0, Math.PI * 2);
  ctx.fill();
}

function renderZombie(ctx: CanvasRenderingContext2D, scale: number, z: ZombieSnapshot, lungeStartedAt: number | undefined): void {
  const screen = { x: z.x * scale, y: z.y * scale };
  const cfg = ZOMBIE_RENDER[z.type];

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
  const lungeFrac = lungeStartedAt === undefined ? 0 : Math.max(0, 1 - (now - lungeStartedAt) / LUNGE_DURATION_MS);
  // The lunge nudges the whole body a few pixels toward its facing direction
  // and scales it up slightly — readable at any zombie size, no per-type art.
  const lungeOffset = lungeFrac * 6 * face.facing;

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

  if (z.type === "flying") {
    ctx.save();
    ctx.translate(screen.x + lungeOffset, screen.y + hoverOffset * scale);
    ctx.scale(face.facing, 1);
    renderFlyingZombie(ctx, drawSize, z.attacking, lungeFrac, phase, now);
    ctx.restore();
  } else {
    const sheets = ZOMBIE_SHEETS[z.type];
    const sheet = z.attacking ? sheets.attack : sheets.walk;
    if (isReady(sheet.image)) {
      const frameIdx = Math.floor(now / 130 + phase) % sheet.frameCount;
      const lungeScale = 1 + lungeFrac * 0.12;
      ctx.save();
      ctx.translate(screen.x + lungeOffset, screen.y + hoverOffset * scale);
      ctx.scale(face.facing * lungeScale, lungeScale);
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

  // A small warning chevron above anything other than a normal zombie —
  // on a busy battlefield with a dozen normal zombies, the one flying/giant/
  // boss threat shouldn't depend on the player spotting a size/colour
  // difference on its own.
  if (z.type !== "normal") {
    const warnColor = z.type === "flying" ? "#7ef0ff" : z.type === "giant" ? "#ffb04d" : "#ff5c5c";
    const wx = screen.x;
    const wy = barY - 7 + Math.sin(now / 180 + phase) * 1.5;
    ctx.fillStyle = warnColor;
    ctx.beginPath();
    ctx.moveTo(wx, wy - 4);
    ctx.lineTo(wx - 4, wy + 3);
    ctx.lineTo(wx + 4, wy + 3);
    ctx.closePath();
    ctx.fill();
  }
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
    const alpha = 1 - age / DEATH_EFFECT_MS;
    const drawSize = 32 * ZOMBIE_RENDER[e.type].scale * scale * 0.9;
    const x = e.x * scale;
    const y = e.y * scale;

    if (e.type === "flying") {
      // No "dead" sprite exists for a procedurally-drawn zombie — a quick
      // wings-folding collapse instead, same silhouette, no new art needed.
      const collapse = 1 - alpha;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(x, y + collapse * drawSize * 0.3);
      ctx.scale(1 - collapse * 0.4, 1 - collapse * 0.4);
      renderFlyingZombie(ctx, drawSize, false, 0, hashStr(`${x},${y}`), now);
      ctx.restore();
      continue;
    }

    const sheet = ZOMBIE_SHEETS[e.type].dead;
    if (!isReady(sheet.image)) continue;
    const frameIdx = age > DEATH_EFFECT_MS / 2 ? 1 : 0;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sheet.image, frameIdx * sheet.frameWidth, 0, sheet.frameWidth, sheet.frameHeight, x - drawSize / 2, y - drawSize / 2, drawSize, drawSize);
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
  // Both keyed by id, both driven by main.ts diffing consecutive snapshots
  // against real server events (ZombieSnapshot.attacksLanded, PlayerSnapshot
  // .hp) — never a client-side guess at whether/when a hit happened.
  zombieLunge: ReadonlyMap<string, number> = new Map(),
  playerFlash: ReadonlyMap<string, number> = new Map(),
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

  // A soft, always-on glow anchors the base's position even when it's
  // visually busy nearby (props, zombies, a crowded wall ring) — readability
  // only, never a hitbox or range indicator.
  ctx.save();
  const baseGlow = ctx.createRadialGradient(base.x, base.y, 2, base.x, base.y, ringRadius * 0.9);
  baseGlow.addColorStop(0, "rgba(255, 220, 140, 0.18)");
  baseGlow.addColorStop(1, "rgba(255, 220, 140, 0)");
  ctx.fillStyle = baseGlow;
  ctx.beginPath();
  ctx.arc(base.x, base.y, ringRadius * 0.9, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Base interact range: always visible (not just while placing a turret),
  // highlighted once the local player is actually inside it — the same
  // range the "[X] Base Menu" prompt already uses, now with a visual match
  // instead of relying on the prompt text alone.
  const self = myPlayerId ? state.players.find((p) => p.id === myPlayerId) : undefined;
  const selfInBaseRange = self ? distanceBetween(self, BASE_POS) <= BASE_INTERACT_RANGE : false;
  ctx.save();
  ctx.setLineDash([3, 5]);
  ctx.strokeStyle = selfInBaseRange ? "rgba(255, 210, 90, 0.65)" : "rgba(255, 255, 255, 0.12)";
  ctx.lineWidth = selfInBaseRange ? 2 : 1;
  ctx.beginPath();
  ctx.arc(base.x, base.y, scale * BASE_INTERACT_RANGE, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  if (state.wallHp <= 0 || state.wallLevel === 0) {
    // No protection at all — a dim, clearly "broken" dashed ring (not the
    // solid/textured look an intact wall gets) so "I have no wall" reads at
    // a glance instead of only by its absence.
    ctx.save();
    ctx.setLineDash([2, 6]);
    ctx.strokeStyle = "rgba(224, 92, 92, 0.35)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(base.x, base.y, ringRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

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

    // Wall HP as a radial arc traced over the ring itself — "how much wall
    // is left" readable at a glance, without checking the HUD, and turning
    // visibly red/thin as it nears breaking instead of only the HUD number
    // changing colour.
    const hpFraction = Math.max(0, Math.min(1, state.wallHp / state.wallMaxHp));
    ctx.save();
    ctx.lineWidth = 4;
    ctx.strokeStyle = hpFraction > 0.5 ? "rgba(140, 230, 160, 0.9)" : hpFraction > 0.2 ? "rgba(255, 205, 90, 0.9)" : "rgba(255, 90, 90, 0.95)";
    ctx.beginPath();
    ctx.arc(base.x, base.y, ringRadius, -Math.PI / 2, -Math.PI / 2 + hpFraction * Math.PI * 2);
    ctx.stroke();
    ctx.restore();

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
    renderZombie(ctx, scale, z, zombieLunge.get(z.id));
  }

  for (const p of state.players) {
    renderPlayer(ctx, toScreen, p, p.id === myPlayerId, aimAngle, playerFlash.get(p.id));
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

// How long a player's damage-flash overlay lasts — driven by main.ts
// diffing PlayerSnapshot.hp between consecutive snapshots (a real, already-
// applied server hp loss, not a client-side guess), for exactly the "which
// zombie is attacking me" clarity this was built for.
const PLAYER_FLASH_MS = 220;

function renderPlayer(
  ctx: CanvasRenderingContext2D,
  toScreen: (x: number, y: number) => { x: number; y: number },
  p: StateMessage["players"][number],
  isSelf: boolean,
  aimAngle: number,
  flashStartedAt: number | undefined,
): void {
  const screen = toScreen(p.x, p.y);
  const angle = isSelf ? aimAngle : 0;
  const color = isSelf ? LOCAL_PLAYER_COLOR : REMOTE_PLAYER_COLORS[p.colorIndex % REMOTE_PLAYER_COLORS.length];
  const now = performance.now();
  const flashFrac = flashStartedAt === undefined ? 0 : Math.max(0, 1 - (now - flashStartedAt) / PLAYER_FLASH_MS);

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
    if (flashFrac > 0) {
      // Red overlay silhouette, same shapes, on top — briefly flashes the
      // whole body red without needing a second sprite/recoloured asset.
      ctx.globalAlpha = flashFrac * 0.75;
      ctx.fillStyle = "#ff3030";
      ctx.beginPath();
      ctx.ellipse(0, 0, 11, 8, 0, 0, Math.PI * 2);
      ctx.arc(6, 0, 5, 0, Math.PI * 2);
      ctx.fill();
    }
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

// Which types this day's wave actually contains, beyond the always-present
// normal zombies — small coloured badges matching each type's own in-world
// warning-chevron colour, so "today has flying zombies" is legible before
// any have even spawned yet (dayWaveComposition is the day's fixed total,
// not how many are currently alive).
const WAVE_BADGES: Array<{ key: "flying" | "giant" | "boss"; color: string; label: string }> = [
  { key: "flying", color: "#7ef0ff", label: "FLYING" },
  { key: "giant", color: "#ffb04d", label: "GIANT" },
  { key: "boss", color: "#ff5c5c", label: "BOSS" },
];

export function renderDayProgress(
  ctx: CanvasRenderingContext2D,
  canvasSize: number,
  day: number,
  killed: number,
  total: number,
  composition?: { flying: number; giant: number; boss: number },
): void {
  const centerX = canvasSize / 2;
  const activeBadges = composition ? WAVE_BADGES.filter((b) => composition[b.key] > 0) : [];
  const panelHeight = 78 + (activeBadges.length > 0 ? 20 : 0);

  // A translucent dark panel behind the whole strip — readable against any
  // terrain tile or zombie crossing underneath it, not just whichever colour
  // happens to be there this frame.
  ctx.save();
  ctx.fillStyle = "rgba(10, 10, 8, 0.55)";
  ctx.fillRect(centerX - 130, 4, 260, panelHeight);
  ctx.restore();

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

  if (activeBadges.length > 0) {
    const badgeY = barY + barHeight + 34;
    ctx.font = "bold 11px system-ui, sans-serif";
    const gap = 14;
    const widths = activeBadges.map((b) => ctx.measureText(`${b.label} x${composition![b.key]}`).width + 16);
    const totalWidth = widths.reduce((a, w) => a + w, 0) + gap * (activeBadges.length - 1);
    let x = centerX - totalWidth / 2;
    activeBadges.forEach((b, i) => {
      const w = widths[i];
      ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
      ctx.fillRect(x, badgeY - 13, w, 18);
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, badgeY - 13, w, 18);
      ctx.fillStyle = b.color;
      ctx.fillText(`${b.label} x${composition![b.key]}`, x + w / 2, badgeY);
      x += w + gap;
    });
  }

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

// --- Zombie attack feedback: impact bursts, a flying zombie's projectile,
// floating damage numbers, and a local screen-edge flash. All driven by
// main.ts diffing real server state (ZombieSnapshot.attacksLanded/
// lastHitKind, PlayerSnapshot.hp across consecutive snapshots) — nothing
// here decides whether or how much damage happened, only how to show it. ---

export interface ImpactEffect {
  x: number;
  y: number;
  kind: "melee" | "explosion";
  startedAt: number;
}
const IMPACT_EFFECT_MS = 240;
export const EXPLOSION_EFFECT_MS = 500; // the longer of the two — main.ts uses this as the impact-array cleanup threshold

export function renderImpactEffects(ctx: CanvasRenderingContext2D, canvasSize: number, effects: readonly ImpactEffect[], now: number): void {
  const scale = canvasSize / WORLD_SIZE;
  for (const e of effects) {
    const age = now - e.startedAt;
    const duration = e.kind === "explosion" ? EXPLOSION_EFFECT_MS : IMPACT_EFFECT_MS;
    if (age < 0 || age > duration) continue;
    const t = age / duration;
    const x = e.x * scale;
    const y = e.y * scale;

    if (e.kind === "explosion") {
      // A giant's death explosion — distinct from an ordinary hit: a wider,
      // slower, orange shockwave ring instead of a quick white claw-flash.
      const radius = 10 + t * 55;
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = "#ff9933";
      ctx.lineWidth = 4 * (1 - t) + 1;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(255, 180, 80, ${0.35 * (1 - t)})`;
      ctx.beginPath();
      ctx.arc(x, y, radius * 0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      continue;
    }

    // Ordinary melee/turret/wall/base hit — a brief burst of short claw-like
    // strokes radiating from the impact point.
    const alpha = 1 - t;
    const len = 5 + t * 6;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = "#fff3c4";
    ctx.lineWidth = 2;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + hashStr(`${e.x}${e.y}${i}`) % 100 * 0.01;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * 3, y + Math.sin(a) * 3);
      ctx.lineTo(x + Math.cos(a) * (3 + len), y + Math.sin(a) * (3 + len));
      ctx.stroke();
    }
    ctx.restore();
  }
}

// A flying zombie's ranged attack: damage is already applied server-side the
// same tick (see protocol.ts) — this is a purely cosmetic travel reveal
// between the two real endpoints, visually distinct (a cyan bolt, matching
// the flying zombie's own glow colour) from player/turret tracers (yellow).
export interface ZombieProjectile {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  firedAt: number;
}
export const PROJECTILE_TRAVEL_MS = 300;

export function renderZombieProjectiles(ctx: CanvasRenderingContext2D, canvasSize: number, projectiles: readonly ZombieProjectile[], now: number): void {
  const scale = canvasSize / WORLD_SIZE;
  for (const p of projectiles) {
    const age = now - p.firedAt;
    if (age < 0 || age > PROJECTILE_TRAVEL_MS) continue;
    const t = age / PROJECTILE_TRAVEL_MS;
    const x1 = p.fromX * scale;
    const y1 = p.fromY * scale;
    const x2 = p.toX * scale;
    const y2 = p.toY * scale;
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t;

    // Short trailing tail back toward the origin.
    ctx.save();
    ctx.strokeStyle = "rgba(110, 230, 245, 0.55)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x1 + (x2 - x1) * Math.max(0, t - 0.18), y1 + (y2 - y1) * Math.max(0, t - 0.18));
    ctx.stroke();

    ctx.fillStyle = "#7ef0ff";
    ctx.shadowColor = "#30c8e0";
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

export interface DamageNumber {
  x: number;
  y: number;
  amount: number;
  spawnedAt: number;
}
export const DAMAGE_NUMBER_MS = 850;

export function renderDamageNumbers(ctx: CanvasRenderingContext2D, canvasSize: number, numbers: readonly DamageNumber[], now: number): void {
  const scale = canvasSize / WORLD_SIZE;
  ctx.textAlign = "center";
  ctx.font = "bold 14px system-ui, sans-serif";
  for (const n of numbers) {
    const age = now - n.spawnedAt;
    if (age < 0 || age > DAMAGE_NUMBER_MS) continue;
    const t = age / DAMAGE_NUMBER_MS;
    const x = n.x * scale;
    const y = n.y * scale - 22 - t * 22;
    ctx.globalAlpha = 1 - t;
    ctx.fillStyle = "#ff5c5c";
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowBlur = 3;
    ctx.fillText(`-${n.amount}`, x, y);
  }
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
}

// Subtle red screen-edge vignette for the LOCAL player only, on top of
// everything else — a glanceable "you just got hit" cue that never blocks
// the centre of the view.
const VIGNETTE_MS = 320;

export function renderDamageVignette(ctx: CanvasRenderingContext2D, canvasSize: number, flashedAt: number | undefined, now: number): void {
  if (flashedAt === undefined) return;
  const age = now - flashedAt;
  if (age < 0 || age > VIGNETTE_MS) return;
  const alpha = 0.35 * (1 - age / VIGNETTE_MS);
  const grad = ctx.createRadialGradient(canvasSize / 2, canvasSize / 2, canvasSize * 0.35, canvasSize / 2, canvasSize / 2, canvasSize * 0.72);
  grad.addColorStop(0, "rgba(255, 0, 0, 0)");
  grad.addColorStop(1, `rgba(200, 0, 0, ${alpha})`);
  ctx.save();
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvasSize, canvasSize);
  ctx.restore();
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
export function uiIcon(name: UiIconName, size = 16): string {
  return `<img class="ui-icon" src="${uiIconUrl(name)}" width="${size}" height="${size}" alt="" />`;
}
