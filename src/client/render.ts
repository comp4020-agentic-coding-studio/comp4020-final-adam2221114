import { BASE_ATTACK_RANGE, BASE_INTERACT_RANGE, BASE_POS, TURRET_BUILD_RADIUS, TURRET_LEVELS, WORLD_SIZE } from "./defense-config.ts";
import { cameraScale, worldToScreen, type Camera } from "./camera.ts";
import {
  BASE_STRUCTURE_IMAGE,
  baseStructureAspect,
  BUILDING_BRICK_TILE,
  BUILDING_STONE_TILE,
  directionFromVector,
  FLYING_SHEET,
  FORTRESS_TILES,
  giantSheetFor,
  GRASS_LIGHT_TILE,
  GRASS_TILE,
  isReady,
  PLAYER_SHEETS,
  PROP_IMAGES,
  ROAD_LIGHT_TILE,
  ROAD_TILE,
  TERRAIN_TILE_SIZE,
  turretSprite,
  uiIconUrl,
  wallLevelTile,
  ZOMBIE_DEAD,
  zombieAttackSheet,
  zombieWalkSheet,
  type Direction,
  type SpritedZombieType,
  type UiIconName,
} from "./sprites.ts";
import { BOSS_ENTRANCE_MS, giantAnimState, renderBossDeath, renderBossEntrance, renderBossZombie, renderGiantDeath, renderGiantZombie, type MonsterPose } from "./monsters.ts";
import { FALL_TRANSITION_MS, renderProneRig, renderProneShadow, RISE_TRANSITION_MS, shouldFaceAimDirection, weaponDrawsBehindBody } from "./player-pose.ts";
import { DECORATIVE_PROPS, distanceToRoad, GROUND_MARKS, OUTER_ZONE_RADIUS, ROAD_HALF_WIDTH, type GroundMark, type Prop } from "./terrain.ts";
import { renderFortressDecor } from "./fortress-decor.ts";
import { BUILDINGS, TOWN_BUILDINGS, WALL_GATE_WIDTH, WALL_HALF_EXTENT, WALL_INTERIOR_HALF_EXTENT, wallRectsForPlayers, type Rect } from "./obstacles.ts";
import type { PlayerStatus, StateMessage, TurretSnapshot, ZombieSnapshot, ZombieType } from "./protocol.ts";

// The HP/ability status overlay traced around the wall (border colour, tick
// marks, pulse ring) — independent of the per-level MATERIAL art the wall
// itself is now built from (wallLevelTile/renderWallSegment below handles
// that). This table only decides the overlay's colour/thickness and which
// ability each level actually has (WALL_LEVELS in defense-config.ts says the
// real numbers).
const WALL_VISUALS: Record<number, { color: string; lineWidth: number; ability: "none" | "pulse" | "spike" }> = {
  1: { color: "#9aa0a6", lineWidth: 4, ability: "none" },
  2: { color: "#6fc2a6", lineWidth: 5, ability: "pulse" },
  3: { color: "#7fa6c9", lineWidth: 5, ability: "spike" },
  4: { color: "#c9a0ff", lineWidth: 6, ability: "spike" },
  5: { color: "#ffd166", lineWidth: 7, ability: "spike" },
};

// Per-type render treatment. Giant/boss now have their own hand-built
// procedural art (monsters.ts) instead of a scale/tint reskin of the normal-
// zombie sprite — see that file's own comment for why no licensed sprite
// replacement fits. `glow` stays as an ambient aura behind the monster
// (unchanged); `tint` no longer applies to giant/boss (nothing to tint).
const ZOMBIE_RENDER: Record<ZombieType, { scale: number; hover: boolean; glow?: string; tint?: string }> = {
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
// A brief hit-reaction flash plays exactly when a zombie's hp actually drops
// (main.ts diffs ZombieSnapshot.hp across consecutive snapshots — same
// "only ever confirms a real server event" convention as the lunge above).
// Only giant/boss (monsters.ts) currently consume this; normal/flying
// zombies are untouched by this pass.
const ZOMBIE_HIT_FLASH_DURATION_MS = 220;

const REMOTE_PLAYER_COLORS = ["#ff6666", "#66b2ff", "#66ff99", "#ffcc66"];
const LOCAL_PLAYER_COLOR = "#ffcc00";

// Tactical sleeve/glove colours for the held-weapon-and-arms overlay
// (drawPlayerWeapon) — neutral tactical gear across every character skin,
// so the arms read as plausible gear regardless of which of the 4 outfits
// (PLAYER_SHEETS) a player picked; only the head/body sprite and the small
// team-colour pip actually vary per player.
const WEAPON_ARM_SLEEVE_COLOR = "#454a3c";
const WEAPON_ARM_GLOVE_COLOR = "#211f1a";

function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// --- Ground layer: built ONCE into a fixed-resolution offscreen canvas
// covering the WHOLE world (not just the visible viewport) and reused every
// frame — the camera crops+scales a window of it with a single drawImage
// call instead of re-tiling ~1,700 sprite draws (plus ground-mark/base-pad
// decoration) per frame. Baked at a fixed world-space resolution rather than
// at canvas size: this means panning/zooming the camera, or resizing the
// canvas, never requires rebaking — only the tileset images finishing load
// does. ---
let terrainLayer: HTMLCanvasElement | undefined;
let terrainLayerReady = false;

// Base highlight smoothing (2026-11-02 base visual swap) — a single module-
// level 0..1 value eased toward its on/off target every frame (same
// `1 - Math.exp(-rate * dtMs / 1000)` eased-approach shape main.ts's own
// zoom easing already uses), so the glow fades in/out instead of popping.
// Module-level rather than per-call state because render() takes no
// explicit dt parameter; baseHighlightLastFrameAt lets the first call in a
// session skip a bogus huge dt instead of snapping to full intensity.
let baseHighlightIntensity = 0;
let baseHighlightLastFrameAt: number | undefined;
const BASE_HIGHLIGHT_EASE_PER_SEC = 6;
const GROUND_TILE_WORLD = 25; // world units per ground tile — coarser than the asset's native 32px, which keeps the per-frame blit count down without reading as obviously different art
// Pixels-per-world-unit the terrain bakes at. Higher than the old
// canvasSize/WORLD_SIZE (~0.8-1.2 depending on canvas size) specifically
// because the camera now shows a ~420-unit window at up to full-viewport
// canvas sizes — a coarser bake would visibly blur when the camera crops a
// small, magnified region of it.
const BAKE_PX_PER_UNIT = 3;
const BAKED_WORLD_SIZE = WORLD_SIZE * BAKE_PX_PER_UNIT;

function allTerrainImagesReady(): boolean {
  return isReady(GRASS_TILE) && isReady(GRASS_LIGHT_TILE) && isReady(ROAD_TILE) && isReady(ROAD_LIGHT_TILE);
}

// A real 2D hash (same family as this file's own pseudo() for ground marks)
// in [0, 1) — NOT a small-multiplier modulo trick. An earlier version used
// `(gx*928371 + gy*654323) % 97`, which reduces mod 97 to just (81, 58): the
// multiples of two such small numbers land in a visible diagonal lattice,
// not noise (confirmed by reproducing it standalone — an unmistakable
// regular grid, exactly the "bright green checkerboard" the user's
// screenshot showed). This hash has no such small period.
function hash2D(gx: number, gy: number): number {
  const v = Math.sin(gx * 12.9898 + gy * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

// Soft dither band at the grass/road edge, a few world units wide, instead
// of a hard isOnRoad() cutoff — at the boundary each tile independently
// rolls (hashed by its own position, so it's stable frame to frame) toward
// whichever surface is closer, so the transition reads as a worn, uneven
// edge rather than a ruler-straight line.
const ROAD_EDGE_DITHER_WIDTH = 30; // wider than one ground tile (25 units) so the dither band is visibly more than a single row

function groundTileFor(worldX: number, worldY: number, gx: number, gy: number): HTMLImageElement {
  const roadDist = distanceToRoad(worldX, worldY) - ROAD_HALF_WIDTH; // negative = inside the road
  const variantRoll = hash2D(gx * 1.7 + 0.5, gy * 1.7 + 0.5);
  let onRoad: boolean;
  if (roadDist <= -ROAD_EDGE_DITHER_WIDTH) {
    onRoad = true;
  } else if (roadDist >= ROAD_EDGE_DITHER_WIDTH) {
    onRoad = false;
  } else {
    // Linearly blend the PROBABILITY of being road across the dither band,
    // using a separate hash draw so it doesn't correlate with the variant
    // roll above (which would make the edge look patterned too).
    const t = 0.5 - roadDist / (2 * ROAD_EDGE_DITHER_WIDTH); // 1 at the inner edge, 0 at the outer edge
    onRoad = hash2D(gx * 3.1 + 7.7, gy * 3.1 + 7.7) < t;
  }
  if (onRoad) {
    return variantRoll < 0.15 ? ROAD_LIGHT_TILE : ROAD_TILE;
  }
  return variantRoll < 0.2 ? GRASS_LIGHT_TILE : GRASS_TILE;
}

// A soft, static drop shadow under every building footprint, baked into the
// ground layer (so it never needs re-sorting against moving entities — it's
// always beneath everything, same as a real cast shadow). Offset down-right,
// same light-direction convention as every other shadow this project draws
// (renderPlayer's own body shadow, etc).
function renderBuildingShadows(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.fillStyle = "rgba(10, 10, 8, 0.35)";
  for (const b of BUILDINGS) {
    const x = (b.x + 6) * BAKE_PX_PER_UNIT;
    const y = (b.y + 8) * BAKE_PX_PER_UNIT;
    const w = b.w * BAKE_PX_PER_UNIT;
    const h = b.h * BAKE_PX_PER_UNIT;
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, w / 2 + 4 * BAKE_PX_PER_UNIT, h / 2 + 4 * BAKE_PX_PER_UNIT, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function buildTerrainLayer(): HTMLCanvasElement {
  const layer = document.createElement("canvas");
  layer.width = BAKED_WORLD_SIZE;
  layer.height = BAKED_WORLD_SIZE;
  const lctx = layer.getContext("2d");
  if (!lctx) return layer;
  lctx.imageSmoothingEnabled = false;
  const drawTile = GROUND_TILE_WORLD * BAKE_PX_PER_UNIT;
  const cols = Math.ceil(WORLD_SIZE / GROUND_TILE_WORLD);
  const rows = Math.ceil(WORLD_SIZE / GROUND_TILE_WORLD);
  for (let gx = 0; gx < cols; gx++) {
    for (let gy = 0; gy < rows; gy++) {
      const worldX = (gx + 0.5) * GROUND_TILE_WORLD;
      const worldY = (gy + 0.5) * GROUND_TILE_WORLD;
      const tile = groundTileFor(worldX, worldY, gx, gy);
      lctx.drawImage(tile, 0, 0, TERRAIN_TILE_SIZE, TERRAIN_TILE_SIZE, gx * drawTile, gy * drawTile, drawTile + 1, drawTile + 1);
    }
  }
  renderBuildingShadows(lctx);
  renderGroundMarks(lctx);
  renderFortressCourtyardFloor(lctx);
  renderFortressDecor(lctx, BAKE_PX_PER_UNIT);
  return layer;
}

// Interior courtyard floor: fills the square the wall encloses once built
// (WALL_INTERIOR_HALF_EXTENT around BASE_POS) so the ground reads as
// "inside the walls" right up to them, rather than leaving bare grass
// visible between the walls and the base. Deliberately unconditional —
// baked once into the static terrain layer regardless of wallLevel, same
// as every other decorative ground tile, so the base always has a
// consistent "home" patch whether or not a wall currently stands. Tiles
// FORTRESS_TILES.floorPad once that art exists; until then, a flat-colour +
// border placeholder fill.
function renderFortressCourtyardFloor(ctx: CanvasRenderingContext2D): void {
  const half = WALL_INTERIOR_HALF_EXTENT * BAKE_PX_PER_UNIT;
  const cx = BASE_POS.x * BAKE_PX_PER_UNIT;
  const cy = BASE_POS.y * BAKE_PX_PER_UNIT;
  const x = cx - half;
  const y = cy - half;
  const size = half * 2;

  ctx.save();
  const tile = FORTRESS_TILES.floorPad;
  if (isReady(tile)) {
    ctx.imageSmoothingEnabled = false;
    const ts = TERRAIN_TILE_SIZE * BAKE_PX_PER_UNIT;
    for (let ty = 0; ty < size; ty += ts) {
      for (let tx = 0; tx < size; tx += ts) {
        const dw = Math.min(ts, size - tx);
        const dh = Math.min(ts, size - ty);
        ctx.drawImage(tile, 0, 0, TERRAIN_TILE_SIZE, TERRAIN_TILE_SIZE, x + tx, y + ty, dw, dh);
      }
    }
  } else {
    ctx.fillStyle = "#312d26";
    ctx.fillRect(x, y, size, size);
    ctx.strokeStyle = "rgba(230, 225, 210, 0.1)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, size, size);
  }
  ctx.restore();
}

// Tiny deterministic hash for jittering ground-mark shapes from their own
// seed — not a full PRNG object, just enough variation that marks of the
// same kind don't all look identical.
function pseudo(seed: number, i: number): number {
  const v = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

function renderGroundMark(ctx: CanvasRenderingContext2D, mark: GroundMark): void {
  const x = mark.x * BAKE_PX_PER_UNIT;
  const y = mark.y * BAKE_PX_PER_UNIT;
  const s = mark.scale * BAKE_PX_PER_UNIT;

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

function renderGroundMarks(ctx: CanvasRenderingContext2D): void {
  for (const mark of GROUND_MARKS) renderGroundMark(ctx, mark);
}

function getTerrainLayer(): HTMLCanvasElement | undefined {
  const ready = allTerrainImagesReady();
  if (!ready) return undefined;
  if (!terrainLayer || !terrainLayerReady) {
    terrainLayer = buildTerrainLayer();
    terrainLayerReady = ready;
  }
  return terrainLayer;
}

// Native pixel sizes for each curated LPC prop crop (sprites/lpc/NOTES.md) —
// used to preserve aspect ratio when drawing at a chosen world-unit width.
// "wreck" is excluded — it's hand-drawn Canvas art (drawVehicleWreck below),
// not a sprite crop, so it has no native pixel size to preserve.
type SpritedPropType = Exclude<Prop["type"], "wreck">;
const PROP_NATIVE_SIZE: Record<SpritedPropType, { w: number; h: number }> = {
  tree: { w: 96, h: 112 },
  bush: { w: 96, h: 112 },
  barrel: { w: 32, h: 64 },
  chest: { w: 32, h: 32 },
};
// World-unit width each prop type is drawn at (height follows its own aspect
// ratio) — chosen so a tree reads as a real landmark and a chest/barrel
// reads as a small, human-scale object, same relative sizing the old
// CraftPix crate/barrel/tree crops had.
const PROP_DRAW_WIDTH: Record<SpritedPropType, number> = {
  tree: 46,
  bush: 40,
  barrel: 16,
  chest: 20,
};

// A burnt-out car wreck — hand-drawn Canvas art (no vehicle sprite exists in
// any licensed pack vendored in this repo, and this sandbox has no outbound
// network access to source one; see terrain.ts's own comment on PropType).
// Drawn top-down: a scorched chassis, a caved-in roof gap, two dark wheel
// hubs, and a thin smoke wisp — reads as "abandoned, burnt" rather than a
// parked car. `rotation` (terrain.ts) points it along its own road segment.
function drawVehicleWreck(ctx: CanvasRenderingContext2D, scale: number): void {
  const len = 30 * scale;
  const width = 14 * scale;
  ctx.save();
  // Contact shadow first, same down-right convention every other shadow in
  // this project uses.
  ctx.fillStyle = "rgba(10, 10, 8, 0.35)";
  ctx.beginPath();
  ctx.ellipse(2, 3, len / 2 + 2, width / 2 + 1, 0, 0, Math.PI * 2);
  ctx.fill();

  // Chassis — a scorched, uneven dark-rust body, not a clean rectangle.
  ctx.fillStyle = "#3a332e";
  ctx.beginPath();
  ctx.moveTo(-len / 2, -width / 2 + 2);
  ctx.lineTo(-len / 2 + 4, -width / 2);
  ctx.lineTo(len / 2 - 6, -width / 2 + 1);
  ctx.lineTo(len / 2, 0);
  ctx.lineTo(len / 2 - 6, width / 2 - 1);
  ctx.lineTo(-len / 2 + 4, width / 2);
  ctx.lineTo(-len / 2, width / 2 - 2);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#1c1814";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Rust/burn patches — a couple of warmer-toned blotches over the chassil.
  ctx.fillStyle = "rgba(120, 60, 30, 0.45)";
  ctx.beginPath();
  ctx.ellipse(-len * 0.1, -width * 0.1, len * 0.22, width * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();

  // Caved-in roof gap — a darker void where the cabin roof used to be,
  // the clearest "this burned out" silhouette cue at this scale.
  ctx.fillStyle = "#15120f";
  ctx.beginPath();
  ctx.ellipse(len * 0.05, 0, len * 0.22, width * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();

  // Wheel hubs, dark and flat (no suspension detail needed at this scale).
  ctx.fillStyle = "#0e0c0a";
  for (const wx of [-len * 0.3, len * 0.28]) {
    ctx.beginPath();
    ctx.ellipse(wx, -width / 2, width * 0.14, width * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(wx, width / 2, width * 0.14, width * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // A thin, static smoke wisp drifting up from the cabin — cheap (no
  // particle system, just two translucent soft blobs) but enough to read as
  // "still smouldering" rather than long-dead wreckage.
  ctx.fillStyle = "rgba(120, 120, 118, 0.22)";
  ctx.beginPath();
  ctx.ellipse(len * 0.05, -width * 0.9, width * 0.35, width * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(140, 140, 138, 0.14)";
  ctx.beginPath();
  ctx.ellipse(len * 0.12, -width * 1.6, width * 0.5, width * 0.7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Only props within (roughly) the visible viewport are drawn — the full
// prop list can include points far outside whatever window the camera
// currently shows, and with the camera now zoomed in (viewSize ~420 of the
// 1000-unit world) most of them are off-screen at any given moment.
const PROP_CULL_MARGIN = 80; // world units of slack beyond the viewport edge, so a prop doesn't pop in/out right at the edge

function renderProps(ctx: CanvasRenderingContext2D, camera: Camera): void {
  const scale = cameraScale(camera);
  const left = camera.originX - PROP_CULL_MARGIN;
  const top = camera.originY - PROP_CULL_MARGIN;
  const right = camera.originX + camera.viewWidth + PROP_CULL_MARGIN;
  const bottom = camera.originY + camera.viewHeight + PROP_CULL_MARGIN;
  for (const prop of DECORATIVE_PROPS) {
    if (prop.x < left || prop.x > right || prop.y < top || prop.y > bottom) continue;
    const screen = worldToScreen(camera, prop.x, prop.y);

    if (prop.type === "wreck") {
      ctx.save();
      ctx.translate(screen.x, screen.y);
      ctx.rotate(prop.rotation);
      drawVehicleWreck(ctx, scale);
      ctx.restore();
      continue;
    }

    const img = PROP_IMAGES[prop.type];
    if (!isReady(img)) continue;
    const native = PROP_NATIVE_SIZE[prop.type];
    const dw = PROP_DRAW_WIDTH[prop.type] * scale;
    const dh = dw * (native.h / native.w);
    // Anchor at the sprite's own "base" (bottom-centre) rather than its
    // centre — a tree/bush/barrel/chest should visually stand ON its world
    // position, not float centred over it.
    ctx.drawImage(img, screen.x - dw / 2, screen.y - dh, dw, dh);
  }
}

// --- Buildings: solid, server-authoritative obstacles (obstacles.ts) drawn
// as a tiled wall-material rectangle plus a darker "roof band" top strip (a
// flat colour band, not the pack's diagonal roof tiles — those don't tile
// cleanly at arbitrary footprint sizes, and a flat band reads fine at this
// top-down scale) and a light trim border for edge definition. Drawn as a
// SORTED entity (see render()'s drawables list) so a zombie/player passing
// in front of or behind one is occluded correctly, not always-on-top or
// always-behind. ---
// Deterministic per-building "damage profile" (round 3 of the visual
// overhaul, request #3: "destroyed structures, environmental storytelling" —
// every town building previously used the exact same two-tone tile/roof
// treatment, so a dozen of them in view read as one copy-pasted rectangle).
// Hashed from the building's own fixed position (TOWN_BUILDINGS never
// changes at runtime), so the same building always rolls the same damage —
// not a per-frame random flicker. Purely decorative, drawn over the existing
// tile fill; the rectangle's actual collision footprint (obstacles.ts) is
// completely unaffected.
function buildingDamageSeed(b: Rect): number {
  return hashStr(`${b.x},${b.y},${b.w},${b.h}`);
}

function renderBuilding(ctx: CanvasRenderingContext2D, camera: Camera, b: Rect): void {
  const scale = cameraScale(camera);
  const screen = worldToScreen(camera, b.x, b.y);
  const x = screen.x;
  const y = screen.y;
  const w = b.w * scale;
  const h = b.h * scale;
  const tile = isReady(BUILDING_STONE_TILE) ? BUILDING_STONE_TILE : undefined;
  const brick = isReady(BUILDING_BRICK_TILE) ? BUILDING_BRICK_TILE : undefined;
  const seed = buildingDamageSeed(b);
  const collapsedCorner = seed % 5 === 0; // ~1 in 5 buildings has visibly caved in
  const scorched = seed % 3 === 1;
  const boarded = seed % 2 === 0;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (tile) {
    const ts = TERRAIN_TILE_SIZE * scale;
    for (let ty = 0; ty < h; ty += ts) {
      for (let tx = 0; tx < w; tx += ts) {
        const dw = Math.min(ts, w - tx);
        const dh = Math.min(ts, h - ty);
        ctx.drawImage(tile, 0, 0, TERRAIN_TILE_SIZE, TERRAIN_TILE_SIZE, x + tx, y + ty, dw, dh);
      }
    }
  } else {
    ctx.fillStyle = "#4a4a56";
    ctx.fillRect(x, y, w, h);
  }

  // Roof band: the top ~30% of the footprint, in the brick material, so the
  // building reads as having a distinct roof plane from its stone walls —
  // simple flat colour-blocking rather than attempting diagonal roof tiles.
  const roofH = h * 0.3;
  if (brick) {
    const ts = TERRAIN_TILE_SIZE * scale;
    for (let tx = 0; tx < w; tx += ts) {
      const dw = Math.min(ts, w - tx);
      ctx.drawImage(brick, 0, 0, TERRAIN_TILE_SIZE, TERRAIN_TILE_SIZE, x + tx, y, dw, Math.min(ts, roofH));
    }
  } else {
    ctx.fillStyle = "#6b3a34";
    ctx.fillRect(x, y, w, roofH);
  }

  // A soot/scorch wash on roughly a third of buildings — reads as fire
  // damage from whatever happened before the player arrived.
  if (scorched) {
    const scorchGrad = ctx.createLinearGradient(x, y + h, x, y + h * 0.3);
    scorchGrad.addColorStop(0, "rgba(15, 12, 10, 0.5)");
    scorchGrad.addColorStop(1, "rgba(15, 12, 10, 0)");
    ctx.fillStyle = scorchGrad;
    ctx.fillRect(x, y + h * 0.3, w, h * 0.7);
  }

  // Boarded-up windows: a couple of plank rectangles with cross-bracing —
  // the single clearest "abandoned, not just decorative" cue available
  // without a dedicated sprite (no boarded-window crop exists in any
  // licensed pack checked while planning this change).
  if (boarded && w > 24 && h > 24) {
    const plankW = Math.min(14, w * 0.3);
    const plankH = Math.min(10, h * 0.22);
    const px = x + w * 0.5 - plankW / 2;
    const py = y + h * 0.55;
    ctx.fillStyle = "#5c4a36";
    ctx.fillRect(px, py, plankW, plankH);
    ctx.strokeStyle = "rgba(20, 15, 10, 0.7)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + plankW, py + plankH);
    ctx.moveTo(px + plankW, py);
    ctx.lineTo(px, py + plankH);
    ctx.stroke();
  }

  // A collapsed corner: part of the footprint drawn as a rubble pile instead
  // of standing wall — the clearest "destroyed structure" read, since it
  // changes the building's own silhouette rather than only its surface.
  if (collapsedCorner && w > 20 && h > 20) {
    const cw = w * 0.4;
    const ch = h * 0.4;
    const cx = x + w - cw * 0.6;
    const cy = y + h - ch * 0.6;
    ctx.fillStyle = "#6b6358";
    ctx.beginPath();
    ctx.moveTo(cx, cy + ch);
    ctx.lineTo(cx + cw * 0.3, cy + ch * 0.3);
    ctx.lineTo(cx + cw * 0.7, cy + ch * 0.55);
    ctx.lineTo(cx + cw, cy + ch * 0.1);
    ctx.lineTo(cx + cw, cy + ch);
    ctx.closePath();
    ctx.fill();
    // Scattered rubble chunks at the base of the collapse.
    for (let i = 0; i < 4; i++) {
      const rx = cx + (i / 4) * cw + (pseudo(seed, i) - 0.5) * 6;
      const ry = cy + ch + pseudo(seed, i + 5) * 5;
      ctx.fillStyle = i % 2 === 0 ? "#8a8276" : "#5c564c";
      ctx.beginPath();
      ctx.arc(rx, ry, 3 + pseudo(seed, i + 10) * 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.strokeStyle = "rgba(20, 18, 22, 0.6)";
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  ctx.restore();
}

// --- Wall placeholder blockout: deliberately NOT an attempt at finished
// art. The user explicitly rejected composing "fake" finished visuals out of
// Canvas primitives (sandbags/fencing/etc drawn with shapes) — this instead
// reads unmistakably as a construction blockout (flat magenta/cyan debug
// fill, diagonal hazard hatch, a text label), kept only as a fallback for if
// one of the five per-level wall textures (sprites/lpc/fortress/
// wall-level-*.png, see sprites/lpc/NOTES.md's "Wall levels" entry) is ever
// missing. isReady() flips between the two automatically, same pattern
// renderBuilding already uses for BUILDING_STONE_TILE/BUILDING_BRICK_TILE —
// no logic needs to change if an art file ever moves/goes missing. ---
const FORTRESS_PLACEHOLDER_FILL = "rgba(180, 40, 160, 0.35)";
const FORTRESS_PLACEHOLDER_HATCH = "rgba(255, 255, 0, 0.55)";

function drawPlaceholderBlockout(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, label: string): void {
  ctx.save();
  ctx.fillStyle = FORTRESS_PLACEHOLDER_FILL;
  ctx.fillRect(x, y, w, h);

  // Diagonal hazard hatch — an unambiguous "under construction" visual
  // convention, not a texture attempt.
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = FORTRESS_PLACEHOLDER_HATCH;
  ctx.lineWidth = Math.max(2, Math.min(w, h) * 0.08);
  const step = Math.max(8, Math.min(w, h) * 0.3);
  for (let d = -h; d < w + h; d += step) {
    ctx.beginPath();
    ctx.moveTo(x + d, y);
    ctx.lineTo(x + d + h, y + h);
    ctx.stroke();
  }
  ctx.restore();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  if (w >= 18 && h >= 10) {
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${Math.max(8, Math.min(12, h * 0.35))}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + w / 2, y + h / 2);
  }
  ctx.restore();
}

// Wall segment: tiled with the CURRENT wallLevel's own material texture
// (wallLevelTile — five genuinely distinct materials, not a colour/
// thickness reskin of one tile; see sprites/lpc/NOTES.md's "Wall levels"
// entry), else an explicit "WALL" blockout — see the comment above. Each
// 32x32 cell alternates between that level's two hand-varied crops (A/B),
// picked by the cell's own world position (not the segment's, so the
// pattern stays continuous across adjacent wall rects) — same deterministic-
// per-position-hash approach buildingDamageSeed already uses for town
// buildings, so a long wall run reads as built from distinct sections rather
// than one tile stamped repeatedly. Only ever called for rects
// wallRectsForPlayers actually returned, i.e. only while wallLevel > 0, so
// nothing draws before the wall is built or after it's destroyed. No corner
// towers — cut entirely from this design.
function renderWallSegment(ctx: CanvasRenderingContext2D, camera: Camera, b: Rect, wallLevel: number): void {
  const scale = cameraScale(camera);
  const screen = worldToScreen(camera, b.x, b.y);
  const w = b.w * scale;
  const h = b.h * scale;
  const tileA = wallLevelTile(wallLevel, "a");
  const tileB = wallLevelTile(wallLevel, "b");
  if (isReady(tileA) && isReady(tileB)) {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    const ts = TERRAIN_TILE_SIZE * scale;
    for (let ty = 0, wy = b.y; ty < h; ty += ts, wy += TERRAIN_TILE_SIZE) {
      for (let tx = 0, wx = b.x; tx < w; tx += ts, wx += TERRAIN_TILE_SIZE) {
        const dw = Math.min(ts, w - tx);
        const dh = Math.min(ts, h - ty);
        const cellSeed = hashStr(`${Math.round(wx / TERRAIN_TILE_SIZE)},${Math.round(wy / TERRAIN_TILE_SIZE)}`);
        const tile = cellSeed % 2 === 0 ? tileA : tileB;
        ctx.drawImage(tile, 0, 0, TERRAIN_TILE_SIZE, TERRAIN_TILE_SIZE, screen.x + tx, screen.y + ty, dw, dh);
      }
    }
    ctx.restore();
  } else {
    drawPlaceholderBlockout(ctx, screen.x, screen.y, w, h, "WALL");
  }
}

// --- Facing: a shared per-entity (zombie or player) direction memory, keyed
// by id — module-level since render() is called fresh every frame with no
// history of its own. Computed from real movement (position delta since
// last frame), not from aim/attack state, so an idle entity keeps its last
// real facing instead of snapping to some default. Entries for
// zombies/players no longer present are harmless (just unused keys); the
// population is small enough that this never needs pruning.
interface FacingState {
  dir: Direction;
  lastX: number;
  lastY: number;
  // Whether this entity actually moved on the call that just computed `dir`
  // — captured from the position delta BEFORE lastX/lastY get overwritten
  // below, so a caller reading it afterward (renderPlayer's walk/idle frame
  // gate) sees the real per-frame movement instead of comparing the current
  // position against itself (every earlier call here already synced
  // lastX/lastY to the current position first, which made that delta read
  // ~0 on nearly every frame and pinned the walk animation on frame 0 even
  // while the character was visibly sliding across the map — this was Bug
  // 2's root cause, not a missing walk-frame asset).
  moving: boolean;
}
const zombieFacing = new Map<string, FacingState>();
const playerFacing = new Map<string, FacingState>();

function updateFacing(map: Map<string, FacingState>, id: string, x: number, y: number, fallbackDir: Direction = "down"): FacingState {
  let face = map.get(id);
  if (!face) {
    face = { dir: fallbackDir, lastX: x, lastY: y, moving: false };
    map.set(id, face);
    return face;
  }
  const dx = x - face.lastX;
  const dy = y - face.lastY;
  const moved = Math.abs(dx) > 0.3 || Math.abs(dy) > 0.3;
  face.moving = moved;
  if (moved) {
    face.dir = directionFromVector(dx, dy, face.dir);
    face.lastX = x;
    face.lastY = y;
  }
  return face;
}

function renderZombie(ctx: CanvasRenderingContext2D, camera: Camera, z: ZombieSnapshot, lungeStartedAt: number | undefined, hitFlashStartedAt: number | undefined): void {
  const scale = cameraScale(camera);
  const screen = worldToScreen(camera, z.x, z.y);
  const cfg = ZOMBIE_RENDER[z.type];
  const face = updateFacing(zombieFacing, z.id, z.x, z.y);

  const phase = hashStr(z.id);
  const now = performance.now();
  const hoverOffset = cfg.hover ? Math.sin(now / 260 + phase) * 5 : 0;
  const drawSize = 32 * cfg.scale * scale * 0.9;
  const lungeFrac = lungeStartedAt === undefined ? 0 : Math.max(0, 1 - (now - lungeStartedAt) / LUNGE_DURATION_MS);
  const hitFlashFrac = hitFlashStartedAt === undefined ? 0 : Math.max(0, 1 - (now - hitFlashStartedAt) / ZOMBIE_HIT_FLASH_DURATION_MS);
  // The lunge nudges the whole body a few pixels toward its facing direction
  // and scales it up slightly — readable at any zombie size, no per-type art.
  const facingSign = face.dir === "left" ? -1 : face.dir === "right" ? 1 : 0;
  const lungeOffset = lungeFrac * 6 * (facingSign || 1);

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
    ctx.scale(face.dir === "left" ? -1 : 1, 1);
    renderFlyingZombie(ctx, drawSize, z.attacking, lungeFrac, phase, now);
    ctx.restore();
  } else if (z.type === "boss") {
    // Hand-built procedural monster (monsters.ts) — see that file's own
    // comment for why no licensed sprite replaces the old scale/tint reskin.
    const pose: MonsterPose = { id: z.id, dir: face.dir, walking: face.moving, attacking: z.attacking, lungeFrac, hitFlashFrac, now, phase };
    ctx.save();
    ctx.translate(screen.x + lungeOffset, screen.y);
    renderBossZombie(ctx, drawSize, pose);
    ctx.restore();
  } else if (z.type === "giant") {
    // Real directional LPC art (2026-11-04 rebuild — see sprites.ts's
    // GIANT_SHEETS comment for provenance: genuine licensed LPC body+head
    // art, recoloured to this project's giant-zombie palette, every
    // direction a real multi-frame walk/attack sequence). Falls back to the
    // original procedural monster if a sheet image hasn't finished loading
    // yet, so the giant is never blank mid-load.
    const pose: MonsterPose = { id: z.id, dir: face.dir, walking: face.moving, attacking: z.attacking, lungeFrac, hitFlashFrac, now, phase };
    const { anim, frameFrac } = giantAnimState(pose);
    const sheet = giantSheetFor(anim, face.dir);
    if (isReady(sheet.image)) {
      const frameIdx = Math.min(sheet.frameCount - 1, Math.floor(frameFrac * sheet.frameCount));
      ctx.save();
      ctx.translate(screen.x + lungeOffset, screen.y);
      ctx.scale(face.dir === "left" ? -1 : 1, 1);
      ctx.imageSmoothingEnabled = true;
      const h = drawSize * 1.35;
      const w = h; // every giant frame is a square 64x64 LPC tile now
      ctx.drawImage(sheet.image, frameIdx * sheet.frameWidth, 0, sheet.frameWidth, sheet.frameHeight, -w / 2, -h / 2, w, h);
      if (hitFlashFrac > 0) {
        // No dedicated hurt art exists for any direction (see sprites.ts) —
        // every direction gets the same white flash-tint reaction, the same
        // source-atop technique renderPlayer's flash already uses — only
        // tints the sprite's own drawn pixels, not a rectangle.
        ctx.globalCompositeOperation = "source-atop";
        ctx.fillStyle = `rgba(255, 255, 255, ${hitFlashFrac * 0.6})`;
        ctx.fillRect(-w / 2, -h / 2, w, h);
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.restore();
    } else {
      ctx.save();
      ctx.translate(screen.x + lungeOffset, screen.y);
      renderGiantZombie(ctx, drawSize, pose);
      ctx.restore();
    }
  } else {
    const spritedType = z.type as SpritedZombieType;
    const sheet = z.attacking ? zombieAttackSheet(spritedType, face.dir) : zombieWalkSheet(spritedType, face.dir);
    if (isReady(sheet.image)) {
      const frameIdx = Math.floor(now / 130 + phase) % sheet.frameCount;
      const lungeScale = 1 + lungeFrac * 0.12;
      ctx.save();
      ctx.translate(screen.x + lungeOffset, screen.y + hoverOffset * scale);
      ctx.scale(lungeScale, lungeScale);
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

// Flying zombie: a real sprite now (LPC's bat monster, sprites.ts's
// FLYING_SHEET) — this reverses the earlier documented choice ("no CC0/
// CC-BY-SA flying-creature sprite sheet exists"), which was true when
// written but is now stale since one does (see sprites.ts's own comment).
// Signature kept IDENTICAL to the function this replaces so every existing
// call site (renderZombie above, renderDeathEffects below, main.ts's
// "new enemy" intro portrait) needed no changes — only the body did.
export function renderFlyingZombie(ctx: CanvasRenderingContext2D, drawSize: number, attacking: boolean, lungeFrac: number, phase: number, now: number): void {
  const bodyScale = 1 + lungeFrac * 0.12;
  if (isReady(FLYING_SHEET.image)) {
    const frameIdx = Math.floor(now / 90 + phase) % FLYING_SHEET.frameCount; // fast wingbeat, matching the old procedural flap rate
    ctx.save();
    ctx.scale(bodyScale, bodyScale);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(FLYING_SHEET.image, frameIdx * FLYING_SHEET.frameWidth, 0, FLYING_SHEET.frameWidth, FLYING_SHEET.frameHeight, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
    ctx.restore();
  } else {
    // Sprite not loaded yet — a small placeholder so it's never invisible.
    ctx.fillStyle = "#223842";
    ctx.beginPath();
    ctx.ellipse(0, 0, drawSize * 0.22 * bodyScale, drawSize * 0.27 * bodyScale, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // A small glow brightens mid-lunge — the "about to bite" beat players can
  // read as the attack actually connecting, now an overlay on the sprite
  // rather than the sprite's own (now-removed) drawn eyes.
  if (attacking) {
    const eyeGlow = 0.5 + 0.5 * lungeFrac;
    ctx.save();
    ctx.globalAlpha = 0.5 + 0.3 * eyeGlow;
    const grad = ctx.createRadialGradient(0, -drawSize * 0.05, 0, 0, -drawSize * 0.05, drawSize * 0.18);
    grad.addColorStop(0, `rgba(${150 + 105 * eyeGlow}, 245, 255, 0.9)`);
    grad.addColorStop(1, "rgba(150, 245, 255, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, -drawSize * 0.05, drawSize * 0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
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
  dir: Direction; // last known facing at death — only giant's topple uses this
}
const DEATH_EFFECT_MS = 500;
// A giant's collapse runs a little longer than every other type's death fade
// so its direction-aware topple has room to read, and is kept exactly equal
// to EXPLOSION_EFFECT_MS (render.ts's renderImpactEffects) so the body
// finishing its fall and the shockwave ring fading out happen together —
// the brief's own "make the explosion match the death animation" request.
export const GIANT_DEATH_EFFECT_MS = 650;
export function collectDeathEffects(
  previous: readonly ZombieSnapshot[] | undefined,
  current: readonly ZombieSnapshot[],
  now: number,
  into: DeathEffect[],
  // Looks up a zombie's last known facing by id — backed by render.ts's own
  // zombieFacing map (via lastZombieFacing below) so the topple direction
  // matches whatever direction it was actually last seen moving/attacking
  // in, without duplicating that state here.
  dirForId: (id: string) => Direction = () => "down",
): void {
  if (!previous) return;
  const currentIds = new Set(current.map((z) => z.id));
  for (const z of previous) {
    if (!currentIds.has(z.id)) into.push({ type: z.type, x: z.x, y: z.y, diedAt: now, dir: dirForId(z.id) });
  }
}
// Exposes the SAME facing memory renderZombie already keeps (zombieFacing,
// §updateFacing above) so main.ts can resolve a just-died zombie's last
// facing for collectDeathEffects without render.ts needing to export the
// map itself or main.ts needing a second, separately-tracked copy.
export function lastZombieDir(id: string): Direction {
  return zombieFacing.get(id)?.dir ?? "down";
}
export function renderDeathEffects(ctx: CanvasRenderingContext2D, camera: Camera, effects: DeathEffect[], now: number): void {
  const scale = cameraScale(camera);
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    const duration = e.type === "giant" ? GIANT_DEATH_EFFECT_MS : DEATH_EFFECT_MS;
    const age = now - e.diedAt;
    if (age > duration) {
      effects.splice(i, 1);
      continue;
    }
    const alpha = 1 - age / duration;
    const drawSize = 32 * ZOMBIE_RENDER[e.type].scale * scale * 0.9;
    const screen = worldToScreen(camera, e.x, e.y);
    const x = screen.x;
    const y = screen.y;

    if (e.type === "flying") {
      // No dedicated death frame for the bat sprite — a quick wings-folding
      // collapse instead, same silhouette, no new art needed.
      const collapse = 1 - alpha;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(x, y + collapse * drawSize * 0.3);
      ctx.scale(1 - collapse * 0.4, 1 - collapse * 0.4);
      renderFlyingZombie(ctx, drawSize, false, 0, hashStr(`${x},${y}`), now);
      ctx.restore();
      continue;
    }

    if (e.type === "boss") {
      // Procedural collapse matching the procedural monster itself
      // (monsters.ts) — no sprite "dead" frame exists for boss.
      ctx.save();
      ctx.translate(x, y);
      renderBossDeath(ctx, drawSize, age / duration);
      ctx.restore();
      continue;
    }

    if (e.type === "giant") {
      // No death-sheet art exists for the giant in any direction (see
      // sprites.ts's GIANT_SHEETS comment — the source has no matching
      // head-pose set for a collapse animation), so every direction uses
      // the original procedural direction-aware topple.
      ctx.save();
      ctx.translate(x, y);
      renderGiantDeath(ctx, drawSize, age / duration, e.dir);
      ctx.restore();
      continue;
    }

    if (!isReady(ZOMBIE_DEAD.image)) continue;
    const frameIdx = age > duration / 2 ? ZOMBIE_DEAD.frameCount - 1 : Math.min(ZOMBIE_DEAD.frameCount - 2, Math.floor((age / duration) * (ZOMBIE_DEAD.frameCount - 1)));
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(ZOMBIE_DEAD.image, frameIdx * ZOMBIE_DEAD.frameWidth, 0, ZOMBIE_DEAD.frameWidth, ZOMBIE_DEAD.frameHeight, x - drawSize / 2, y - drawSize / 2, drawSize, drawSize);
    ctx.restore();
  }
}

// One dramatic entrance flash per boss id, drawn at its live position for as
// long as it's still fresh — main.ts owns the id -> first-seen-at map
// (bossEntranceAt), this only draws it. A boss that dies mid-flash simply
// stops being in `zombies` and its entry is left harmless/unused in the map
// (same "small enough it never needs pruning" reasoning zombieFacing/
// playerFacing already rely on).
export function renderBossEntranceEffects(ctx: CanvasRenderingContext2D, camera: Camera, zombies: readonly ZombieSnapshot[], entranceAt: ReadonlyMap<string, number>, now: number): void {
  for (const z of zombies) {
    if (z.type !== "boss") continue;
    const startedAt = entranceAt.get(z.id);
    if (startedAt === undefined) continue;
    const age = now - startedAt;
    if (age < 0 || age > BOSS_ENTRANCE_MS) continue;
    const screen = worldToScreen(camera, z.x, z.y);
    renderBossEntrance(ctx, screen.x, screen.y, age / BOSS_ENTRANCE_MS);
  }
}

// A drawable entity that needs to sort against buildings for correct front/
// back occlusion (CLAUDE.md's new Map/obstacles section, and the reference
// image's own call-out on this) — buildings are static, but zombies and
// players move freely around and behind them, so all three are sorted into
// one list by world-Y (a building's sort key is its BOTTOM edge — the point
// below which anything should be drawn in FRONT of it) and drawn in that
// order every frame. Turrets never need this: TURRET_BUILD_RADIUS keeps
// them well clear of every building (obstacles.ts's own comment), so they
// stay in the simple unsorted pass below.
// A player's status (alive/downed/dead) has no timing of its own on the
// wire — this pairs the last OBSERVED status with when this client saw it
// change (and what it changed FROM), so renderPlayer/player-pose.ts can play
// a fall-down/get-up transition right after a REAL transition instead of
// snapping into the held pose. `prevStatus` is undefined for the very first
// observation of a given player id (a fresh connect/reconnect) — never
// treated as a transition, since there's nothing to transition FROM.
export interface StatusChange {
  status: PlayerStatus;
  prevStatus: PlayerStatus | undefined;
  at: number;
}

type Drawable =
  | { kind: "building"; sortY: number; rect: Rect }
  | { kind: "wall-segment"; sortY: number; rect: Rect; wallLevel: number }
  | { kind: "zombie"; sortY: number; z: ZombieSnapshot; lungeStartedAt: number | undefined; hitFlashStartedAt: number | undefined }
  | {
      kind: "player";
      sortY: number;
      p: StateMessage["players"][number];
      isSelf: boolean;
      aimAngle: number;
      flashStartedAt: number | undefined;
      lastShotAt: number | undefined;
      statusChangedAt: StatusChange | undefined;
    };

// Plain shapes for the player (kept modular and swappable — see
// PROCESS.md's visual-redesign entry on why: the CraftPix pack had no
// player-character sprite at all) and sprite art for everything else.
// Renders exactly what the server sent; never infers or predicts anything.
export function render(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  state: StateMessage,
  aimAngle: number,
  myPlayerId: string | undefined,
  // Both keyed by id, both driven by main.ts diffing consecutive snapshots
  // against real server events (ZombieSnapshot.attacksLanded, PlayerSnapshot
  // .hp) — never a client-side guess at whether/when a hit happened.
  zombieLunge: ReadonlyMap<string, number> = new Map(),
  playerFlash: ReadonlyMap<string, number> = new Map(),
  // Zombie id -> performance.now() its hp was last seen dropping (main.ts
  // diffing ZombieSnapshot.hp, same pattern as playerFlash above) — drives
  // monsters.ts's hit-reaction flash for giant/boss.
  zombieHitFlash: ReadonlyMap<string, number> = new Map(),
  // Local player id -> performance.now() the weapon last actually fired —
  // purely cosmetic recoil timing (drawPlayerWeapon's recoilFrac), driven by
  // main.ts's own onShoot callback (the local player) or shotsFired-style
  // diffing (see main.ts) for a remote player firing; never a hit decision.
  playerLastShotAt: ReadonlyMap<string, number> = new Map(),
  // Turret id -> performance.now() it last actually fired (TurretSnapshot.
  // shotsFired diffing, same pattern as playerLastShotAt) — purely cosmetic
  // recoil timing for renderTurret's weapon-sprite kick.
  turretLastShotAt: ReadonlyMap<string, number> = new Map(),
  // Player id -> the last status this client observed for them + when it
  // changed (main.ts's playerStatusChangedAt) — drives player-pose.ts's
  // fall-down/get-up transition timing. A pure status-string diff; no new
  // protocol field.
  playerStatusChanged: ReadonlyMap<string, StatusChange> = new Map(),
): void {
  const canvasWidth = camera.canvasWidth;
  const canvasHeight = camera.canvasHeight;
  const scale = cameraScale(camera);
  const toScreen = (x: number, y: number) => worldToScreen(camera, x, y);

  const terrain = getTerrainLayer();
  if (terrain) {
    // The terrain layer is baked once at a fixed world-space resolution
    // (BAKE_PX_PER_UNIT) covering the whole map — the camera crops+scales
    // just its visible window with one drawImage call, so panning/zooming
    // never needs rebaking.
    const sx = camera.originX * BAKE_PX_PER_UNIT;
    const sy = camera.originY * BAKE_PX_PER_UNIT;
    const sWidth = camera.viewWidth * BAKE_PX_PER_UNIT;
    const sHeight = camera.viewHeight * BAKE_PX_PER_UNIT;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(terrain, sx, sy, sWidth, sHeight, 0, 0, canvasWidth, canvasHeight);
  } else {
    ctx.fillStyle = "#2a2622";
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  }
  renderProps(ctx, camera);

  const base = toScreen(BASE_POS.x, BASE_POS.y);
  // Wall status is drawn mapped onto the square WALL_HALF_EXTENT footprint
  // the wall's own collision rects physically occupy once built
  // (obstacles.ts's wallRectsForPlayers) — this is a visual mapping only;
  // wallHp/wallLevel/ability resolution are untouched. The south side's
  // gate gap (WALL_GATE_WIDTH, the same gap players actually walk through)
  // is traced into every stroke below via traceWallPerimeter instead of one
  // unbroken strokeRect, so the drawn wall always matches real collision.
  const fortressHalf = scale * WALL_HALF_EXTENT;
  const fortX = base.x - fortressHalf;
  const fortY = base.y - fortressHalf;
  const fortSize = fortressHalf * 2;
  const gateHalf = (scale * WALL_GATE_WIDTH) / 2;

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

  // Nothing square draws at all before the wall is ever built — the dashed
  // "no protection" hint only makes sense once there's a real wall (however
  // damaged) to warn about; pre-build, the always-visible base-interact
  // range above already shows where the base is.
  if (state.wallLevel > 0 && state.wallHp <= 0) {
    // Wall was destroyed — a dim, clearly "broken" dashed outline traced
    // over the square footprint it occupied (full closed square: once
    // destroyed there's no real gate-shaped geometry left to match, it's
    // purely a "build again here" hint).
    ctx.save();
    ctx.setLineDash([2, 6]);
    ctx.strokeStyle = "rgba(224, 92, 92, 0.35)";
    ctx.lineWidth = 2;
    ctx.strokeRect(fortX, fortY, fortSize, fortSize);
    ctx.setLineDash([]);
    ctx.restore();
  }

  if (state.wallHp > 0 && state.wallLevel > 0) {
    const visual = WALL_VISUALS[state.wallLevel] ?? WALL_VISUALS[1];

    // The wall's real perimeter as ONE open path, starting/ending at the
    // south gate's two edges and running the long way around (SW corner ->
    // NW -> NE -> SE corner) — exactly the shape wallRectsForPlayers
    // physically occupies, so every stroke below (border, HP dash, etc.)
    // leaves the gate visibly open rather than drawing over it.
    const traceWallPerimeter = (): void => {
      ctx.beginPath();
      ctx.moveTo(base.x - gateHalf, fortY + fortSize);
      ctx.lineTo(fortX, fortY + fortSize);
      ctx.lineTo(fortX, fortY);
      ctx.lineTo(fortX + fortSize, fortY);
      ctx.lineTo(fortX + fortSize, fortY + fortSize);
      ctx.lineTo(base.x + gateHalf, fortY + fortSize);
    };

    // A solid border tinted by the level's colour, traced over the wall's
    // real (gated) perimeter, with a thicker inner wash for a bit of
    // material depth — no fence-panel sprite exists for this (the LPC set
    // has no tileable barricade texture at this scale), so this is
    // deliberately simple Canvas geometry (CLAUDE.md: "prefer simple Canvas
    // geometry over inventing assets that don't exist").
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = visual.color;
    ctx.lineWidth = visual.lineWidth;
    traceWallPerimeter();
    ctx.stroke();
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = visual.lineWidth * 2;
    traceWallPerimeter();
    ctx.stroke();
    ctx.restore();

    if (visual.ability === "spike") {
      // Tick marks along each REAL wall segment (south split into its two
      // gated halves, so no tick ever floats in the open gate gap).
      const spikeLength = 7;
      const perSide = 4;
      ctx.strokeStyle = visual.color;
      ctx.lineWidth = 2;
      const sides: Array<{ x0: number; y0: number; x1: number; y1: number; nx: number; ny: number }> = [
        { x0: fortX, y0: fortY, x1: fortX + fortSize, y1: fortY, nx: 0, ny: -1 }, // north
        { x0: fortX + fortSize, y0: fortY, x1: fortX + fortSize, y1: fortY + fortSize, nx: 1, ny: 0 }, // east
        { x0: fortX + fortSize, y0: fortY + fortSize, x1: base.x + gateHalf, y1: fortY + fortSize, nx: 0, ny: 1 }, // south-east
        { x0: base.x - gateHalf, y0: fortY + fortSize, x1: fortX, y1: fortY + fortSize, nx: 0, ny: 1 }, // south-west
        { x0: fortX, y0: fortY + fortSize, x1: fortX, y1: fortY, nx: -1, ny: 0 }, // west
      ];
      for (const side of sides) {
        for (let i = 1; i <= perSide; i++) {
          const t = i / (perSide + 1);
          const px = side.x0 + (side.x1 - side.x0) * t;
          const py = side.y0 + (side.y1 - side.y0) * t;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px + side.nx * spikeLength, py + side.ny * spikeLength);
          ctx.stroke();
        }
      }
    } else if (visual.ability === "pulse") {
      // Pulse's actual AOE radius (WALL_PULSE_RADIUS) stays a circle in the
      // server's own damage resolution (game-loop.ts) — this is purely the
      // player-facing indicator, drawn as a dashed rectangle just outside
      // the wall footprint so it reads as "this base's ability" rather than
      // a separate circular shape floating over it. Kept a plain closed
      // rect (not gate-traced) since it's a margin OUTSIDE the wall, not
      // the wall itself.
      const pulseMargin = 12 * scale;
      ctx.strokeStyle = "rgba(111, 194, 166, 0.3)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.strokeRect(fortX - pulseMargin, fortY - pulseMargin, fortSize + pulseMargin * 2, fortSize + pulseMargin * 2);
      ctx.setLineDash([]);
    }

    // Wall HP traced as a partial border over the wall's own real (gated)
    // perimeter (via a dash pattern sized to its actual stroked length) —
    // "how much wall is left" readable at a glance, without checking the
    // HUD, and turning visibly red as it nears breaking instead of only the
    // HUD number changing colour.
    const hpFraction = Math.max(0, Math.min(1, state.wallHp / state.wallMaxHp));
    const perimeter = fortSize * 4 - gateHalf * 2;
    ctx.save();
    ctx.lineWidth = 4;
    ctx.strokeStyle = hpFraction > 0.5 ? "rgba(140, 230, 160, 0.9)" : hpFraction > 0.2 ? "rgba(255, 205, 90, 0.9)" : "rgba(255, 90, 90, 0.95)";
    ctx.setLineDash([perimeter * hpFraction, perimeter]);
    traceWallPerimeter();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Level badge so the number is unambiguous even with the fence texture.
    ctx.fillStyle = "#111";
    ctx.beginPath();
    ctx.arc(base.x, fortY - 9, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = visual.color;
    ctx.textAlign = "center";
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.fillText(`${state.wallLevel}`, base.x, fortY - 5);
    ctx.textAlign = "left";
  }

  // Base highlight: active once ANY player (all clients see the same
  // server-authoritative positions, so this reads identically for everyone
  // in multiplayer, not just the local player) is standing inside the
  // base's own drawn footprint — an axis-aligned square test against
  // BASE_FOOTPRINT, NOT the wider circular BASE_INTERACT_RANGE the "[X] Base
  // Menu" prompt above already uses for a different purpose (menu
  // availability). Eased toward its target each frame (see
  // BASE_HIGHLIGHT_EASE_PER_SEC) instead of snapping, so crossing the
  // footprint edge reads as a fade rather than an instant on/off toggle.
  const anyPlayerInBaseFootprint = state.players.some((p) => Math.abs(p.x - BASE_POS.x) <= BASE_FOOTPRINT / 2 && Math.abs(p.y - BASE_POS.y) <= BASE_FOOTPRINT / 2);
  const highlightNow = performance.now();
  const highlightDtMs = baseHighlightLastFrameAt === undefined ? 0 : Math.max(0, highlightNow - baseHighlightLastFrameAt);
  baseHighlightLastFrameAt = highlightNow;
  const highlightEaseT = 1 - Math.exp(-(BASE_HIGHLIGHT_EASE_PER_SEC * highlightDtMs) / 1000);
  baseHighlightIntensity += ((anyPlayerInBaseFootprint ? 1 : 0) - baseHighlightIntensity) * highlightEaseT;

  renderBase(ctx, base, scale, state.baseHp, state.baseMaxHp, baseHighlightIntensity);

  for (const turret of state.turrets) {
    renderTurret(ctx, camera, turret, turretLastShotAt.get(turret.id), performance.now());
  }

  // Buildings, zombies, and players all sort together by world-Y so a
  // building correctly occludes (or is occluded by) whatever's passing in
  // front of or behind it — see the Drawable type's own comment. Sort keys
  // stay in WORLD units (not screen pixels) — the relative order is
  // identical either way, and it keeps this independent of the camera scale.
  const drawables: Drawable[] = [];
  for (const b of TOWN_BUILDINGS) {
    drawables.push({ kind: "building", sortY: b.y + b.h, rect: b });
  }
  // Wall segments only exist to draw once wallLevel > 0 — wallRectsForPlayers
  // returns [] otherwise, so nothing solid-textured appears before the wall
  // is actually built (the dashed HP/level overlay above is the only
  // pre-build/post-destruction hint). No corner towers — cut entirely.
  for (const b of wallRectsForPlayers(state.wallLevel)) {
    drawables.push({ kind: "wall-segment", sortY: b.y + b.h, rect: b, wallLevel: state.wallLevel });
  }
  for (const z of state.zombies) {
    drawables.push({ kind: "zombie", sortY: z.y, z, lungeStartedAt: zombieLunge.get(z.id), hitFlashStartedAt: zombieHitFlash.get(z.id) });
  }
  for (const p of state.players) {
    drawables.push({
      kind: "player",
      sortY: p.y,
      p,
      isSelf: p.id === myPlayerId,
      aimAngle,
      flashStartedAt: playerFlash.get(p.id),
      lastShotAt: playerLastShotAt.get(p.id),
      statusChangedAt: playerStatusChanged.get(p.id),
    });
  }
  drawables.sort((a, b) => a.sortY - b.sortY);
  for (const d of drawables) {
    if (d.kind === "building") renderBuilding(ctx, camera, d.rect);
    else if (d.kind === "wall-segment") renderWallSegment(ctx, camera, d.rect, d.wallLevel);
    else if (d.kind === "zombie") renderZombie(ctx, camera, d.z, d.lungeStartedAt, d.hitFlashStartedAt);
    else renderPlayer(ctx, camera, d.p, d.isSelf, d.aimAngle, d.flashStartedAt, d.lastShotAt, d.statusChangedAt);
  }

  for (const prog of state.reviveProgress) {
    const target = state.players.find((p) => p.id === prog.targetId);
    if (!target) continue;
    renderReviveProgress(ctx, toScreen(target.x, target.y), prog.remainingMs);
  }
}

// Base footprint, in world units — round 3 of the visual overhaul enlarges
// this from 44 to 64 specifically because the user rejected the previous
// size as "a tiny structure in the middle" of the fortress interior. BASE_POS
// has no physical collision footprint on either client or server (it isn't
// in obstacles.ts's BUILDINGS list, and nothing server-side resolves
// movement against a base radius), so this is a purely visual change with
// zero effect on collision, interaction range, or any other gameplay number
// — BASE_INTERACT_RANGE/BASE_ATTACK_RANGE (defense-config.ts) are untouched.
const BASE_FOOTPRINT = 64;

function renderBase(ctx: CanvasRenderingContext2D, base: { x: number; y: number }, scale: number, hp: number, maxHp: number, highlight: number): void {
  const size = BASE_FOOTPRINT * scale;
  ctx.save();

  // A dark ground-contact shadow first, same down-right light convention
  // every other shadow in this project uses — at this larger footprint a
  // flat structure with no shadow read as "floating", not "built". Kept
  // even though the sourced artwork (sprites/base/) has its own baked-in
  // shadow pixels baked INTO its alpha — the source image's own shadow was
  // removed along with its background during the cutout (see
  // sprites/base/NOTES.md), so this hand-drawn one is still the only
  // ground-contact shadow the base actually gets.
  //
  // Positioned/sized to actually sit under the sci-fi art's own footprint
  // (its entry ramp and right-side pedestal, the lowest points of its
  // silhouette) rather than the generic "big ellipse near the bottom" this
  // started as — the original placement left a visible gap of bare ground
  // between the structure's feet and the shadow, which read as the whole
  // base floating. Verified in-browser against the current art's actual
  // silhouette (see sprites/base/NOTES.md); if the art changes again, re-
  // check this against the new silhouette's lowest points.
  ctx.fillStyle = "rgba(10, 10, 8, 0.45)";
  ctx.beginPath();
  ctx.ellipse(base.x + size * 0.04, base.y + size * 0.35, size * 0.48, size * 0.12, 0, 0, Math.PI * 2);
  ctx.fill();

  // Soft highlight glow, drawn BEHIND the structure artwork (same stacking
  // as the shadow above it) so it reads as ground-level light spilling out
  // from under/around the base rather than a ring painted over the art.
  // Intensity is the eased 0..1 value render() computes from "is any player
  // standing inside BASE_FOOTPRINT" — 0 draws nothing at all, so the base is
  // never highlighted by default, only actually fading in once a player is
  // inside the real footprint (not the wider BASE_INTERACT_RANGE circle).
  if (highlight > 0.001) {
    ctx.save();
    ctx.globalAlpha = highlight;
    const glowRadius = size * 0.78;
    const glow = ctx.createRadialGradient(base.x, base.y, size * 0.1, base.x, base.y, glowRadius);
    glow.addColorStop(0, "rgba(110, 210, 255, 0.55)");
    glow.addColorStop(0.7, "rgba(90, 180, 255, 0.22)");
    glow.addColorStop(1, "rgba(90, 180, 255, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(base.x, base.y, glowRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (isReady(BASE_STRUCTURE_IMAGE)) {
    // Scale-to-fit (preserving the art's real aspect ratio) inside a
    // size x size box, exactly like renderBuilding/renderWallSegment treat
    // their own tiles — never stretched to force a square, which the
    // original image is not quite. imageSmoothingEnabled stays ON (unlike
    // the pixel-art LPC tiles elsewhere in this file, which deliberately
    // turn it off) because this is painted/anti-aliased artwork, not a
    // repeating pixel tile — nearest-neighbour would look wrong here.
    const aspect = baseStructureAspect();
    const drawW = aspect >= 1 ? size : size * aspect;
    const drawH = aspect >= 1 ? size / aspect : size;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(BASE_STRUCTURE_IMAGE, base.x - drawW / 2, base.y - drawH / 2, drawW, drawH);
  } else {
    // Image not loaded yet — a flat rectangular placeholder (matches the
    // shape renderBase draws once the art is ready) so the base never
    // flashes as a circle before art loads.
    ctx.fillStyle = "#4477cc";
    ctx.fillRect(base.x - size / 2, base.y - size / 2, size, size);
  }
  ctx.restore();

  // In-world HP bar — same shape/position convention renderTurret already
  // uses above its own plate, now the base's own (the one entity that had
  // no in-world HP representation at all before this; the HUD's "Base
  // HP/HP" DOM bar was removed in favour of this).
  const barWidth = Math.max(24, size * 0.6);
  const barHeight = 4;
  const barX = base.x - barWidth / 2;
  const barY = base.y - size / 2 - 14;
  const fraction = Math.max(0, Math.min(1, hp / maxHp));
  ctx.fillStyle = "#552222";
  ctx.fillRect(barX, barY, barWidth, barHeight);
  ctx.fillStyle = fraction > 0.3 ? "#5fd35f" : "#e05c5c";
  ctx.fillRect(barX, barY, barWidth * fraction, barHeight);
}

// Last known aim angle per turret id, so an idle turret (no current target)
// keeps pointing the way it last fired instead of snapping back to a
// default facing every time it loses its target.
const turretFacing = new Map<string, number>();

// Level 3's two gameplay-identical barrels (TURRET_LEVELS[3].multiTargetCount
// hits both targets in the same tick server-side — see game-loop.ts's
// #updateTurrets) alternate which drawn barrel's muzzle flash/recoil plays
// per shot, purely cosmetic: a shotsFired parity toggle per turret id, reset
// whenever a turret id is first seen so it always starts on the left barrel.
const turretAltBarrel = new Map<string, boolean>();

// Per-level sprite geometry, hand-measured from each split base/weapon PNG
// (see sprites/turrets/NOTES.md for how these were produced):
// - `weaponPivot`: the rotation centre, in the WEAPON image's own pixel
//   space, that render.ts rotates around — must exactly match the pivot the
//   split script used, or the weapon would visibly orbit instead of
//   spinning in place.
// - `muzzles`: one (or two, for level 3's twin barrels) muzzle-tip offset
//   from that same pivot, in the weapon image's own UNROTATED pixel space —
//   rotated by the turret's current aim angle at render/fire time so
//   projectiles/flashes originate from the actual drawn barrel tip.
// - `drawScale`: world units per sprite pixel — chosen per level so the
//   silhouette grows noticeably level-to-level (matching the old
//   `bodyRadius = 8 + level` progression's intent) while staying readable
//   and not obscuring players/zombies at normal zoom. Re-measured in the
//   2026-11 scale-down pass: the original flat 0.34 for every level made a
//   level-1 turret alone render ~53 world units wide and level 5 ~105 wide —
//   wider than BASE_FOOTPRINT (64), so the turret visually dominated/
//   outsized the base building itself (user report: "bigger than the base").
//   These values keep every level's rendered width (base.width * drawScale)
//   well under 64, growing only modestly level-to-level.
// - `shadow`: a ground-contact ellipse, measured directly from each base
//   PNG's own opaque-pixel bounding box (hand-measured the same way
//   weaponPivot/muzzles were) — `offsetY` is the sprite's lowest opaque
//   pixel's distance below weaponPivot (in the SAME unrotated sprite-pixel
//   space drawScale applies to), `halfWidth` is half the base art's opaque
//   bounding-box width. Without this, renderTurret drew no ground shadow at
//   all (unlike renderBase/renderPlayer, which both do), so the sprite had
//   no visual cue anchoring it to the floor and read as embedded/sunk into
//   the ground (user report: "lower half of the turret is buried").
// - `collar`: fixes a real sprite-transparency bug (user report: "grass is
//   visibly covering parts of the turret"), NOT a draw-order issue — the
//   terrain is always blitted before any turret (render()'s draw order is
//   terrain -> props -> base building -> turrets), so ground tiles can never
//   literally paint over a turret within a frame. The actual cause: the
//   levels 1-3 base PNGs have a non-circular (C-shaped) transparent gap
//   around weaponPivot, sized for the rotating weapon's hub to plug — but
//   the hub's own silhouette isn't radially symmetric, so at many aim
//   angles it doesn't fully cover that gap, and whatever is drawn underneath
//   (most visibly grass, since its saturated green contrasts hardest with
//   the sprite's grey metal) shows straight through the hole. Levels 4-5
//   have no such hole (their pivot sits in solid opaque pixels already), so
//   they're omitted here. `radius` is the measured worst-case (max over all
//   angles) transparent-hole radius around weaponPivot, in the same
//   unrotated sprite-pixel space weaponPivot/drawScale share; `color` is
//   sampled directly from that base PNG's own metal ring just outside the
//   hole, so the collar reads as part of the existing art rather than a new
//   shape. Drawn as a filled circle AFTER the base and BEFORE the weapon, so
//   it only ever plugs the base's own gap and is itself fully covered by the
//   weapon layer wherever that layer is actually opaque.
interface TurretSpriteGeometry {
  weaponPivot: { x: number; y: number };
  muzzles: { x: number; y: number }[];
  drawScale: number;
  shadow: { offsetY: number; halfWidth: number };
  collar?: { radius: number; color: string };
}
const TURRET_SPRITE_GEOMETRY: Record<number, TurretSpriteGeometry> = {
  1: {
    weaponPivot: { x: 60, y: 153 },
    muzzles: [{ x: 2.5, y: -144 }],
    drawScale: 0.15,
    shadow: { offsetY: 83, halfWidth: 78.5 },
    collar: { radius: 68, color: "rgb(55, 60, 75)" },
  },
  2: {
    weaponPivot: { x: 73, y: 168 },
    muzzles: [{ x: 3, y: -159 }],
    drawScale: 0.158,
    shadow: { offsetY: 93, halfWidth: 88 },
    collar: { radius: 97, color: "rgb(75, 98, 113)" },
  },
  3: {
    weaponPivot: { x: 99, y: 204 },
    muzzles: [
      { x: -24, y: -195 },
      { x: 27.5, y: -195 },
    ],
    drawScale: 0.153,
    shadow: { offsetY: 88, halfWidth: 104.5 },
    collar: { radius: 98, color: "rgb(85, 91, 107)" },
  },
  4: { weaponPivot: { x: 83, y: 180 }, muzzles: [{ x: -17, y: -171 }], drawScale: 0.139, shadow: { offsetY: 137, halfWidth: 133 } },
  5: { weaponPivot: { x: 70, y: 270 }, muzzles: [{ x: 5, y: -262 }], drawScale: 0.135, shadow: { offsetY: 134, halfWidth: 155 } },
};

// How long a just-fired turret's weapon stays kicked back along its own
// aim axis — same short-snap convention as the player's own
// WEAPON_RECOIL_MS, not a sustained sway.
const TURRET_RECOIL_MS = 120;

// The world-space point(s) a turret's shot visually originates from (the
// drawn weapon sprite's own muzzle tip, rotated to the turret's current aim
// angle) — purely cosmetic; the server's real hit resolution
// (game-loop.ts's #updateTurrets) already happened by the time this plays.
// Returns one point per barrel for a level-3 turret (its two muzzles), one
// point for every other level.
export function turretMuzzlePositions(turret: TurretSnapshot, angle: number): { x: number; y: number }[] {
  const geo = TURRET_SPRITE_GEOMETRY[turret.level] ?? TURRET_SPRITE_GEOMETRY[1];
  // The weapon sprites' own art faces "up" (local -y) at rest, not "right"
  // (local +x) the way the plain rotation math below assumes — so the draw
  // (and this muzzle math, which must match it exactly) rotates by
  // `angle + 90°` rather than `angle` directly, to turn that native "up"
  // orientation into the turret's actual aim angle.
  const drawAngle = angle + Math.PI / 2;
  const cos = Math.cos(drawAngle);
  const sin = Math.sin(drawAngle);
  return geo.muzzles.map((m) => ({
    x: turret.x + (m.x * cos - m.y * sin) * geo.drawScale,
    y: turret.y + (m.x * sin + m.y * cos) * geo.drawScale,
  }));
}

// Which of a level-3 turret's two muzzles the NEXT shot should visually use
// — main.ts calls this once per turret that actually fired this tick
// (shotsFired increased), so the two barrels visibly alternate even though
// both always hit server-side on every shot.
export function nextTurretBarrelIndex(turretId: string): number {
  const alt = !(turretAltBarrel.get(turretId) ?? false);
  turretAltBarrel.set(turretId, alt);
  return alt ? 1 : 0;
}

// Base layer first (fixed plate/ring/armor — never rotates), then the
// weapon layer (barrel + hub dial) translated to the shared pivot and
// rotated to the turret's current aim angle — the split this task's own
// brief called the most critical part of the rework: an idle or traversing
// turret must only visibly spin its gun, never its whole mounted body (see
// sprites/turrets/NOTES.md). `lastShotAt` drives a brief recoil kick along
// the weapon's own aim axis, the same WEAPON_RECOIL_MS-style easing the
// player's own weapon already uses.
function renderTurret(ctx: CanvasRenderingContext2D, camera: Camera, turret: TurretSnapshot, lastShotAt: number | undefined, now: number): void {
  if (turret.hp <= 0) return;
  const scale = cameraScale(camera);
  const screen = worldToScreen(camera, turret.x, turret.y);
  const range = TURRET_LEVELS[turret.level]?.range ?? TURRET_LEVELS[1].range;
  const geo = TURRET_SPRITE_GEOMETRY[turret.level] ?? TURRET_SPRITE_GEOMETRY[1];
  const sprite = turretSprite(turret.level);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, scale * range, 0, Math.PI * 2);
  ctx.stroke();

  let angle = turretFacing.get(turret.id) ?? -Math.PI / 2;
  if (turret.target) {
    const targetScreen = worldToScreen(camera, turret.target.x, turret.target.y);
    angle = Math.atan2(targetScreen.y - screen.y, targetScreen.x - screen.x);
    turretFacing.set(turret.id, angle);
  }

  const drawScale = geo.drawScale * scale;

  // Ground-contact shadow, drawn BEFORE the sprite (same stacking renderBase
  // uses for its own shadow) — anchored to the base art's own measured
  // lowest-opaque-pixel row (geo.shadow.offsetY, in the same unrotated
  // sprite-pixel space weaponPivot/drawScale already share), not a guessed
  // offset, so it sits directly under the sprite's actual drawn footprint
  // regardless of how much transparent margin that PNG has above it.
  const shadowY = screen.y + (geo.shadow.offsetY - geo.weaponPivot.y) * drawScale;
  ctx.fillStyle = "rgba(10, 10, 8, 0.4)";
  ctx.beginPath();
  ctx.ellipse(screen.x, shadowY, geo.shadow.halfWidth * drawScale * 0.9, geo.shadow.halfWidth * drawScale * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();

  if (isReady(sprite.base)) {
    // The base image's own pivot-space origin is its top-left pixel; its
    // world anchor is the SAME shared pivot the weapon rotates around (not
    // the image's centre), so the two layers never drift apart as the
    // weapon spins.
    ctx.drawImage(
      sprite.base,
      screen.x - geo.weaponPivot.x * drawScale,
      screen.y - geo.weaponPivot.y * drawScale,
      sprite.base.width * drawScale,
      sprite.base.height * drawScale,
    );
  } else {
    // Image not loaded yet — a small flat placeholder square (matches the
    // base's own pre-art-load convention) so a turret never flashes empty.
    const plateSize = 14 + turret.level * 2;
    ctx.fillStyle = "#4a4e55";
    ctx.fillRect(screen.x - plateSize / 2, screen.y - plateSize / 2, plateSize, plateSize);
  }

  // Plugs the base sprite's own non-circular transparent gap around the
  // pivot (see TURRET_SPRITE_GEOMETRY's `collar` doc comment) — drawn after
  // the base, before the weapon, so it only fills the base's own hole and is
  // itself hidden under the weapon layer wherever that layer is opaque.
  if (geo.collar) {
    ctx.fillStyle = geo.collar.color;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, geo.collar.radius * drawScale, 0, Math.PI * 2);
    ctx.fill();
  }

  // Recoil: kicks the whole weapon sprite back along its current aim axis,
  // eased out (recoilFrac^2) the same way drawPlayerWeapon's kick is —
  // snaps out fast, settles smoothly, never a sustained sway.
  const recoilFrac = lastShotAt === undefined ? 0 : Math.max(0, 1 - (now - lastShotAt) / TURRET_RECOIL_MS);
  const kick = recoilFrac * recoilFrac * 4 * scale;

  if (isReady(sprite.weapon)) {
    ctx.save();
    ctx.translate(screen.x, screen.y);
    // The weapon art faces "up" (local -y) at rest, not "right" (local +x)
    // the way a bare `ctx.rotate(angle)` would assume (that convention
    // matches the OLD procedurally-drawn barrel, which was built pointing
    // +x) — rotating by `angle + 90°` instead turns that native "up" into
    // the turret's actual aim angle. turretMuzzlePositions (above) applies
    // this exact same correction so the drawn barrel tip and the point
    // bullets/flashes originate from can never drift apart.
    ctx.rotate(angle + Math.PI / 2);
    // Recoil kicks straight back along the sprite's own forward axis, which
    // after the rotation above is local -y (not local -x) — so the kick
    // translates +y (backward), not -x.
    ctx.translate(0, kick);
    ctx.drawImage(sprite.weapon, -geo.weaponPivot.x * drawScale, -geo.weaponPivot.y * drawScale, sprite.weapon.width * drawScale, sprite.weapon.height * drawScale);
    ctx.restore();
  }

  ctx.fillStyle = "#0b0d10";
  ctx.font = "bold 10px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`${turret.level}`, screen.x, screen.y - sprite.base.height * drawScale * 0.5 - 14);
  ctx.textAlign = "left";

  const barWidth = 22;
  const barHeight = 3;
  const barX = screen.x - barWidth / 2;
  const barY = screen.y - sprite.base.height * drawScale * 0.5 - 8;
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
// World-unit width a player sprite is drawn at — comparable in on-screen
// footprint to a normal zombie's own draw size (32 * 1.1 * 0.9 ≈ 31.7), so
// neither reads as oddly large/small next to the other.
const PLAYER_DRAW_SIZE = 34;

// Weapon proportions, as fractions of PLAYER_DRAW_SIZE/drawSize — shared
// between drawPlayerWeapon's actual drawing and weaponMuzzleOffset's
// world-space muzzle math below, so the two can never silently drift apart
// (the muzzle flash/bullet origin must land exactly where the drawn barrel
// tip is).
const WEAPON_LEN_FRAC = 0.82;
const WEAPON_MUZZLE_FRAC = 0.84; // how far along the weapon's own length the muzzle tip sits
const WEAPON_PIVOT_Y_FRAC = 0.08; // vertical offset of the hold pivot below the sprite's own centre (hip/hand height)
// How long a just-fired recoil kick lasts — short enough to read as a snap,
// not a sustained sway.
const WEAPON_RECOIL_MS = 110;

// The world-space point a shot visually originates from — the drawn
// weapon's own muzzle tip, not the player's centre — so the muzzle flash/
// bullet (main.ts's onShoot) lines up with the barrel exactly as drawn by
// drawPlayerWeapon below, instead of appearing to fire from the torso.
// Purely cosmetic: resolveShot's real origin (game-state.ts, server-side)
// is and remains the player's actual position, untouched by this.
export function weaponMuzzleOffset(angle: number): { x: number; y: number } {
  const muzzleX = PLAYER_DRAW_SIZE * WEAPON_LEN_FRAC * WEAPON_MUZZLE_FRAC;
  const pivotY = PLAYER_DRAW_SIZE * WEAPON_PIVOT_Y_FRAC;
  return { x: Math.cos(angle) * muzzleX, y: pivotY + Math.sin(angle) * muzzleX };
}

// A remote player's sprite facing (Direction: up/down/left/right) converted
// to a representative angle for its cosmetic weapon model — only used for
// non-local players, who have no broadcast continuous aim angle (see
// drawPlayerWeapon's call site).
function directionToAngle(dir: Direction): number {
  switch (dir) {
    case "up":
      return -Math.PI / 2;
    case "down":
      return Math.PI / 2;
    case "left":
      return Math.PI;
    case "right":
      return 0;
  }
}

// A recognisable survivor carbine — stock, receiver, pistol grip, magazine,
// handguard, barrel and muzzle brake, all drawn as one silhouette — PLUS a
// pair of procedural arms bridging the player's body to the weapon's own
// grip/foregrip points, so it reads as held rather than floating in front
// of the character (visual overhaul request #1/#2: "a much more
// recognisable... firearm", "proper arm and weapon integration... hands
// align with the gun, arms visually support the weapon"). The whole group
// (arms + weapon) is one rigid unit rotated together to `angle`, so the
// hands never visually separate from the gun at any aim direction, and a
// recent shot kicks the whole unit back along its own axis for a brief
// recoil (`recoilFrac`: 1 right at the muzzle flash, easing to 0 — see
// WEAPON_RECOIL_MS). Proportioned off WEAPON_LEN_FRAC/WEAPON_MUZZLE_FRAC —
// the SAME fractions weaponMuzzleOffset() uses for the bullet/muzzle-flash
// origin above — so the visible barrel tip and the point shots actually
// originate from can never drift apart. Purely a held prop: no hitbox, no
// collision, no effect on PISTOL_RANGE/PISTOL_CONE_HALF_ANGLE, which stay
// entirely server-side (game-state.ts).
function drawPlayerWeapon(ctx: CanvasRenderingContext2D, screenX: number, screenY: number, drawSize: number, angle: number, recoilFrac: number): void {
  const len = drawSize * WEAPON_LEN_FRAC;
  const bodyW = drawSize * 0.1;

  // Key stations along the weapon's own long axis (local +x, pre-rotation),
  // as fractions of `len` — named so the arm hand-points below can target
  // the exact same coordinates the weapon art itself uses (grip/foregrip),
  // guaranteeing the hands land ON the gun rather than near it.
  const stockBackX = -len * 0.34;
  const gripX = -len * 0.08; // trigger hand
  const receiverFrontX = len * 0.22;
  const foregripX = len * 0.42; // support hand
  const barrelBaseX = len * 0.58;
  const muzzleBaseX = len * WEAPON_MUZZLE_FRAC;

  ctx.save();
  ctx.translate(screenX, screenY + drawSize * WEAPON_PIVOT_Y_FRAC); // roughly hip/hand height, just below the sprite's own centre
  ctx.rotate(angle);
  // Recoil: the whole weapon+arms unit kicks straight back along its own
  // axis and tips up very slightly — eased with recoilFrac^2 so it snaps
  // out fast and settles back smoothly rather than linearly.
  const kick = recoilFrac * recoilFrac;
  ctx.translate(-kick * drawSize * 0.1, 0);
  ctx.rotate(-kick * 0.14);

  // --- Weapon body, back to front -------------------------------------
  // Stock: angled back from the receiver into the shoulder.
  ctx.fillStyle = "#4a3a28";
  ctx.beginPath();
  ctx.moveTo(stockBackX, -bodyW * 0.3);
  ctx.lineTo(gripX, -bodyW * 0.42);
  ctx.lineTo(gripX, bodyW * 0.22);
  ctx.lineTo(stockBackX + bodyW * 0.3, bodyW * 0.5);
  ctx.closePath();
  ctx.fill();

  // Pistol grip: hangs down just behind the trigger, below the receiver.
  ctx.fillStyle = "#2b2b2e";
  ctx.beginPath();
  ctx.moveTo(gripX - bodyW * 0.1, bodyW * 0.3);
  ctx.lineTo(gripX + bodyW * 0.32, bodyW * 0.3);
  ctx.lineTo(gripX + bodyW * 0.22, bodyW * 1.15);
  ctx.lineTo(gripX - bodyW * 0.2, bodyW * 1.1);
  ctx.closePath();
  ctx.fill();

  // Receiver/body: the main rectangular mass the rest hangs off.
  ctx.fillStyle = "#34343a";
  ctx.fillRect(gripX, -bodyW * 0.55, receiverFrontX - gripX, bodyW * 1.1);
  ctx.strokeStyle = "#1c1c1f";
  ctx.lineWidth = Math.max(1, bodyW * 0.12);
  ctx.strokeRect(gripX, -bodyW * 0.55, receiverFrontX - gripX, bodyW * 1.1);

  // A raised top rail — the single detail that most reads as "modern
  // rifle" rather than a plain block at this draw size.
  ctx.fillStyle = "#26262a";
  ctx.fillRect(gripX + bodyW * 0.2, -bodyW * 0.75, receiverFrontX - gripX - bodyW * 0.3, bodyW * 0.3);

  // Curved magazine, forward of the grip, swept slightly back — the single
  // most recognisable "this is a rifle, not a pistol" silhouette cue at
  // this draw size.
  ctx.fillStyle = "#1f1f22";
  ctx.beginPath();
  ctx.moveTo(gripX + bodyW * 0.5, bodyW * 0.5);
  ctx.lineTo(gripX + bodyW * 1.05, bodyW * 0.5);
  ctx.quadraticCurveTo(gripX + bodyW * 1.2, bodyW * 1.3, gripX + bodyW * 0.95, bodyW * 1.75);
  ctx.lineTo(gripX + bodyW * 0.55, bodyW * 1.6);
  ctx.closePath();
  ctx.fill();

  // Handguard: where the support hand actually grips, textured with a
  // couple of thin vent lines so it doesn't read as plain barrel shroud.
  ctx.fillStyle = "#3a3a3f";
  ctx.fillRect(receiverFrontX, -bodyW * 0.38, barrelBaseX - receiverFrontX, bodyW * 0.76);
  ctx.strokeStyle = "#232326";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const x = receiverFrontX + ((barrelBaseX - receiverFrontX) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(x, -bodyW * 0.3);
    ctx.lineTo(x, bodyW * 0.3);
    ctx.stroke();
  }

  // Barrel, tapering slightly toward the muzzle.
  ctx.fillStyle = "#222225";
  ctx.beginPath();
  ctx.moveTo(barrelBaseX, -bodyW * 0.22);
  ctx.lineTo(muzzleBaseX, -bodyW * 0.14);
  ctx.lineTo(muzzleBaseX, bodyW * 0.14);
  ctx.lineTo(barrelBaseX, bodyW * 0.22);
  ctx.closePath();
  ctx.fill();

  // Muzzle brake — the actual tip, lighter so the business end reads
  // distinctly and lines up with weaponMuzzleOffset()'s own math.
  ctx.fillStyle = "#4a4a4f";
  ctx.fillRect(muzzleBaseX, -bodyW * 0.18, len * 0.03, bodyW * 0.36);

  // --- Arms: two short tube segments (shoulder -> elbow -> hand), drawn
  // as rounded strokes so a convincing bend reads without full limb
  // polygons. Hands land exactly on gripX (trigger hand) and foregripX
  // (support hand) — the same coordinates the weapon body above uses — so
  // the grip always visually connects, matching request #2's "hands align
  // with the gun". Drawn AFTER the weapon body so both hands sit on top of
  // it, as a real grip would. ---
  const armW = Math.max(2, bodyW * 0.85);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Trigger-hand arm: shoulder near the body's own centre, elbow tucked
  // down and back (the "shouldering the stock" bend), hand on the grip.
  ctx.strokeStyle = WEAPON_ARM_SLEEVE_COLOR;
  ctx.lineWidth = armW;
  ctx.beginPath();
  ctx.moveTo(stockBackX * 0.15, -bodyW * 0.9);
  ctx.lineTo(gripX - bodyW * 0.3, bodyW * 0.9);
  ctx.lineTo(gripX + bodyW * 0.06, bodyW * 0.55);
  ctx.stroke();

  // Support-hand arm: shoulder near the body's centre, elbow bent down,
  // hand out on the foregrip/handguard.
  ctx.beginPath();
  ctx.moveTo(gripX * 0.2, -bodyW * 0.95);
  ctx.lineTo(receiverFrontX + bodyW * 0.3, -bodyW * 1.0);
  ctx.lineTo(foregripX, -bodyW * 0.05);
  ctx.stroke();

  // Gloved hands on top of both grip points.
  ctx.fillStyle = WEAPON_ARM_GLOVE_COLOR;
  ctx.beginPath();
  ctx.arc(gripX + bodyW * 0.06, bodyW * 0.55, armW * 0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(foregripX, -bodyW * 0.05, armW * 0.55, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// Resolves how "prone" (0 standing .. 1 fully fallen) a player should
// render THIS frame, purely from the current status plus the last observed
// status-change (render.ts's StatusChange — see main.ts's playerStatusChanged
// diffing). `change.prevStatus === undefined` means "first-ever observation"
// (a fresh connect/reconnect) and never plays a transition — only a REAL
// alive<->downed/dead flip does. A downed->dead flip (already lying down)
// intentionally does NOT replay the fall — it stays fully prone, only the
// `dead` flag (caller) changes how it's drawn (stiller, dimmer).
function resolveProneAmount(status: PlayerStatus, change: StatusChange | undefined, now: number): number {
  if (status === "alive") {
    if (change && change.status === "alive" && change.prevStatus !== undefined && change.prevStatus !== "alive") {
      const t = Math.min(1, (now - change.at) / RISE_TRANSITION_MS);
      return 1 - t;
    }
    return 0;
  }
  if (change && change.status === status && change.prevStatus === "alive") {
    return Math.min(1, (now - change.at) / FALL_TRANSITION_MS);
  }
  // downed->dead (already lying down) or a first-ever observation while
  // already downed/dead (reconnect mid-round) — stay fully prone, no replay.
  return 1;
}

function renderPlayer(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  p: StateMessage["players"][number],
  isSelf: boolean,
  aimAngle: number,
  flashStartedAt: number | undefined,
  lastShotAt: number | undefined,
  statusChangedAt: StatusChange | undefined,
): void {
  const scale = cameraScale(camera);
  const screen = worldToScreen(camera, p.x, p.y);
  // characterIndex is the player's own CHOSEN outfit (select-character
  // overlay) — distinct from colorIndex, which only ever decides spawn
  // offset. -1 means "hasn't chosen yet"; render as the same flat-colour
  // placeholder every other not-yet-ready sprite in this project already
  // falls back to, keyed off a neutral grey rather than indexing into
  // REMOTE_PLAYER_COLORS/PLAYER_SHEETS with a negative index.
  const hasCharacter = p.characterIndex >= 0;
  const color = isSelf ? LOCAL_PLAYER_COLOR : hasCharacter ? REMOTE_PLAYER_COLORS[p.characterIndex % REMOTE_PLAYER_COLORS.length] : "#888";
  const now = performance.now();
  const phase = hashStr(p.id);
  const flashFrac = flashStartedAt === undefined ? 0 : Math.max(0, 1 - (now - flashStartedAt) / PLAYER_FLASH_MS);

  // Always tracked from real WORLD position (p.x/p.y) — this is also what
  // the "moving" check below compares against, so facing and animation stay
  // consistent. A remote player has no broadcast aim angle (protocol.ts's
  // PlayerSnapshot never sends one), so its facing always comes from
  // movement delta, same as a zombie's.
  const face = updateFacing(playerFacing, p.id, p.x, p.y);
  if (shouldFaceAimDirection(isSelf, face.moving)) {
    // Only the LOCAL player, and only while stationary (player-pose.ts):
    // aiming still turns a standing character to face the mouse, but
    // WALKING now always shows the real walk direction (face.dir from
    // updateFacing above, already movement-derived) regardless of where the
    // mouse points — this is what makes strafing/backpedaling-while-aiming
    // look like a human walking instead of a body twisted toward the cursor.
    face.dir = directionFromVector(Math.cos(aimAngle), Math.sin(aimAngle), face.dir);
  }

  const sheet = hasCharacter ? PLAYER_SHEETS[p.characterIndex % PLAYER_SHEETS.length][face.dir] : undefined;
  const drawSize = PLAYER_DRAW_SIZE * scale;

  // How prone (0 standing .. 1 fully fallen) to render this frame — a
  // continuous value driving a crossfade between the standing sprite and
  // the new prone rig (player-pose.ts), replacing the old instant snap into
  // a vertical squash. `dead` (not just `downed`) governs the prone rig's
  // own stillness/dimness once settled.
  const proneAmount = resolveProneAmount(p.status, statusChangedAt, now);
  const standingAlpha = 1 - proneAmount;
  const dead = p.status === "dead";

  // Ground shadow — the prone shadow (player-pose.ts) naturally shrinks to
  // nothing as proneAmount approaches 0, so both can simply coexist during
  // the crossfade without an extra branch.
  ctx.save();
  ctx.globalAlpha = 0.3 * standingAlpha;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(screen.x + 2, screen.y + drawSize * 0.32, drawSize * 0.26, drawSize * 0.12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.translate(screen.x, screen.y);
  renderProneShadow(ctx, drawSize, proneAmount);
  ctx.restore();

  // The local player's real continuous aim angle (input.ts tracks the mouse
  // every frame); a remote player's is never broadcast (protocol.ts's
  // PlayerSnapshot has no aimAngle field), so its weapon instead follows the
  // same movement-derived facing direction its sprite already uses,
  // converted to an angle — an approximation for a REMOTE player only, never
  // anything authoritative. Only drawn once more than half risen (still
  // alive, not mid-fall) so the gun doesn't appear to float on a mostly-
  // fallen body during the crossfade.
  const showWeapon = p.status === "alive" && proneAmount < 0.5;
  const weaponAngle = isSelf ? aimAngle : directionToAngle(face.dir);
  const recoilFrac = lastShotAt === undefined ? 0 : Math.max(0, 1 - (now - lastShotAt) / WEAPON_RECOIL_MS);
  // Angle-conditional draw order (player-pose.ts): aiming into the upper
  // screen half draws the weapon+arms BEFORE the body so the body occludes
  // it (brief's own "aiming upward, gun may appear partially behind the
  // character"); aiming down/level keeps the previous on-top order.
  const weaponBehind = showWeapon && weaponDrawsBehindBody(weaponAngle);
  if (weaponBehind) drawPlayerWeapon(ctx, screen.x, screen.y, drawSize, weaponAngle, recoilFrac);

  ctx.save();
  ctx.translate(screen.x, screen.y);
  ctx.globalAlpha = standingAlpha * (p.invulnerable ? 0.55 + 0.35 * Math.sin(now / 80) : 1);

  if (sheet && isReady(sheet.image)) {
    // Idle when not actually moving this frame (face.moving, captured by
    // updateFacing from the real position delta above) — frame 0 of the
    // walk cycle doubles as a standing pose, same "no dedicated idle sheet,
    // reuse what exists" choice this project already made for zombies.
    const frameIdx = face.moving ? Math.floor(now / 130 + phase) % sheet.frameCount : 0;
    ctx.imageSmoothingEnabled = false;

    // A soft team-colour ground glow BEHIND the sprite (round 3 of the
    // visual overhaul, request "make the player easier to recognise without
    // changing gameplay collision sizes or interaction ranges" — this draws
    // UNDER the existing sprite at the existing drawSize, so hitbox/footprint
    // perception is untouched; it only adds a readability cue against a
    // busier, more decorated environment).
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, drawSize * 0.62);
    glow.addColorStop(0, `${color}55`);
    glow.addColorStop(1, `${color}00`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, drawSize * 0.62, 0, Math.PI * 2);
    ctx.fill();

    ctx.drawImage(sheet.image, frameIdx * sheet.frameWidth, 0, sheet.frameWidth, sheet.frameHeight, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
    if (flashFrac > 0) {
      // Red tint applied only to the sprite's own drawn pixels (source-
      // atop), same technique renderZombie uses for the giant/boss tint —
      // briefly flashes the character red without a second sprite.
      ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = `rgba(255, 48, 48, ${flashFrac * 0.75})`;
      ctx.fillRect(-drawSize / 2, -drawSize / 2, drawSize, drawSize);
      ctx.globalCompositeOperation = "source-over";
    }
  } else {
    // Sprite not loaded yet — a flat-colour placeholder so the player is
    // never simply invisible.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(0, 0, drawSize * 0.3, drawSize * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // A small team-colour pip above the head reinforces "which colour is this
  // player" at a glance even though distinct character art (not a palette
  // swap) is what mainly tells players apart now.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, -drawSize / 2 - 2, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.restore();
  ctx.globalAlpha = 1;

  if (!weaponBehind && showWeapon) {
    // A proper held weapon, replacing the old bare aim-line stroke (visual
    // overhaul request: "the player should use a proper gun-like weapon...
    // weapon orientation follows aiming direction", and separately "the
    // current yellow beam is not acceptable" — that beam was
    // renderShotEffects' old fixed-length tracer line, removed entirely; see
    // renderBullets below for what replaced it). No licensed firearm sprite
    // exists in this project's vendored asset packs (LPC/Kenney — checked;
    // neither includes a weapon sheet), so this is hand-drawn procedural
    // Canvas art, same precedent as turrets/monsters.ts/fortress-decor.ts.
    drawPlayerWeapon(ctx, screen.x, screen.y, drawSize, weaponAngle, recoilFrac);
  }

  if (proneAmount > 0.01) {
    // The downed/dying/reviving prone rig (player-pose.ts) — always the
    // same canonical lying-down orientation regardless of the player's
    // facing before they went down (the brief's own explicit requirement),
    // crossfaded against the standing sprite above via proneAmount/
    // standingAlpha. A dropped weapon is drawn as part of the rig itself,
    // underneath the body, so nothing floats above a downed character.
    ctx.save();
    ctx.translate(screen.x, screen.y);
    ctx.globalAlpha = proneAmount * (dead ? 0.4 : 0.85);
    renderProneRig(ctx, drawSize, color, { proneAmount, dead, now, phase });
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  if (p.status !== "dead") {
    const barWidth = 26;
    const barHeight = 3;
    const barX = screen.x - barWidth / 2;
    const barY = screen.y - drawSize / 2 - 10;
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
    ctx.fillText(`DOWNED ${Math.ceil(p.downedRemainingMs / 1000)}s`, screen.x, screen.y - drawSize / 2 - 14);
    ctx.textAlign = "left";
  } else if (p.status === "dead") {
    ctx.textAlign = "center";
    ctx.fillStyle = "#888";
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.fillText("DEAD", screen.x, screen.y - drawSize / 2 - 10);
    ctx.textAlign = "left";
  } else if (p.healing) {
    ctx.textAlign = "center";
    ctx.fillStyle = "#6fe08a";
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.fillText("HEALING…", screen.x, screen.y - drawSize / 2 - 14);
    ctx.textAlign = "left";
  }

  // The player's own chosen display name, above the status text so the two
  // never collide — unconditional on status (still shown downed/dead), same
  // text-rendering convention this function already uses. Skipped entirely
  // for a not-yet-confirmed player (no name to show).
  if (hasCharacter && p.displayName) {
    ctx.textAlign = "center";
    ctx.fillStyle = color;
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.shadowColor = "rgba(0, 0, 0, 0.7)";
    ctx.shadowBlur = 3;
    ctx.fillText(p.displayName, screen.x, screen.y - drawSize / 2 - 20);
    ctx.shadowBlur = 0;
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
// Exported so main.ts's top HUD bar (2026-11-05 redesign) can draw the same
// badges as DOM elements instead of this Canvas-drawn version — see
// updateTopBar in main.ts.
export const WAVE_BADGES: Array<{ key: "flying" | "giant" | "boss"; color: string; label: string }> = [
  { key: "flying", color: "#7ef0ff", label: "FLYING" },
  { key: "giant", color: "#ffb04d", label: "GIANT" },
  { key: "boss", color: "#ff5c5c", label: "BOSS" },
];

export function renderDayIntro(ctx: CanvasRenderingContext2D, canvasWidth: number, canvasHeight: number, day: number, remainingMs: number): void {
  const centerX = canvasWidth / 2;
  const centerY = canvasHeight / 2;
  const t = Math.max(0, Math.min(1, remainingMs / 5000));

  ctx.fillStyle = `rgba(0, 0, 0, ${0.35 + 0.25 * t})`;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

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

export function renderCrosshair(ctx: CanvasRenderingContext2D, camera: Camera, mouseWorldPos: { x: number; y: number }): void {
  const screen = worldToScreen(camera, mouseWorldPos.x, mouseWorldPos.y);
  const x = screen.x;
  const y = screen.y;
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

// A real projectile that travels from the muzzle to an EXPLICIT endpoint
// over a short, fast duration, instead of a fixed-length line drawn the
// instant the trigger is pulled — used for BOTH the player's own shot and a
// turret's shot now (turrets used to get a separate fixed-length tracer
// line/ShotEffect; that was replaced with this same real-endpoint system so
// a turret's cyan bolt visibly travels from its own drawn barrel tip to its
// actual target, matching this task's "projectiles originating from the
// barrel tip" / "cyan-blue energy effects" ask). For the player, `toX/toY`
// is computed by main.ts: either the zombie a CLIENT-SIDE mirror of the
// server's own resolveShot logic predicts will be hit (so the bullet
// visually arrives at that zombie), or a point PISTOL_RANGE away along the
// aim angle if nothing was in range/cone (so a miss clearly travels to the
// weapon's real max range and stops there, rather than an infinite line).
// For a turret, `toX/toY` is simply its own real `target` field. Either way
// this mirror is for the VISUAL endpoint only — the server's authoritative
// hit resolution already ran by the time this plays.
export interface Bullet {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  firedAt: number;
  // "turret" gets this project's cyan-blue energy-bolt palette (matching
  // the turret sprites' own glowing accents) instead of the player
  // pistol's warm yellow-white, so the two read as genuinely different
  // weapons at a glance. Defaults to "player" so every pre-existing caller
  // (main.ts's onShoot) keeps its exact old look without updating every
  // call site.
  kind?: "player" | "turret";
}

export const BULLET_TRAVEL_MS = 90; // fast, but slow enough over PISTOL_RANGE to read as a visible travelling object, not an instant snap
const BULLET_TRAIL_FRAC = 0.22; // fraction of the travelled distance the trail extends back from the bullet's current position

const BULLET_PALETTE = {
  player: { trailFrom: "rgba(255, 230, 150, 0)", trailTo: "rgba(255, 244, 200, 0.9)", core: "#fff8dd" },
  turret: { trailFrom: "rgba(130, 230, 255, 0)", trailTo: "rgba(170, 245, 255, 0.95)", core: "#dffaff" },
} as const;

export function renderBullets(ctx: CanvasRenderingContext2D, camera: Camera, bullets: readonly Bullet[], now: number): void {
  for (const b of bullets) {
    const age = now - b.firedAt;
    if (age < 0 || age > BULLET_TRAVEL_MS) continue;
    const t = age / BULLET_TRAVEL_MS;
    const angle = Math.atan2(b.toY - b.fromY, b.toX - b.fromX);
    const from = worldToScreen(camera, b.fromX, b.fromY);
    const to = worldToScreen(camera, b.toX, b.toY);
    const palette = BULLET_PALETTE[b.kind ?? "player"];

    if (age < 16) renderMuzzleFlash(ctx, from.x, from.y, angle, 1, b.kind);

    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    const tailT = Math.max(0, t - BULLET_TRAIL_FRAC);
    const tailX = from.x + (to.x - from.x) * tailT;
    const tailY = from.y + (to.y - from.y) * tailT;

    // A short bright trail behind the bullet body — reads as "fast-moving
    // projectile" without the old tracer's full-screen length.
    const grad = ctx.createLinearGradient(tailX, tailY, x, y);
    grad.addColorStop(0, palette.trailFrom);
    grad.addColorStop(1, palette.trailTo);
    ctx.strokeStyle = grad;
    ctx.lineWidth = b.kind === "turret" ? 2.6 : 2;
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(x, y);
    ctx.stroke();

    // The bullet body itself — a small bright core, the actual "visible
    // projectile" the request asked for (not just a line).
    ctx.fillStyle = palette.core;
    ctx.beginPath();
    ctx.arc(x, y, b.kind === "turret" ? 2.8 : 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

// A brief 4-point star-burst at the muzzle, oriented along the shot's own
// angle — reads as a distinct "weapon just fired" flash rather than a plain
// fading dot, for both the player's own shots and a turret's (renderBullets
// above calls this for every Bullet, player or turret, tinted by `kind`).
function renderMuzzleFlash(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, alpha: number, kind: "player" | "turret" = "player"): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.globalAlpha = alpha;
  const core = 3 + 5 * alpha;
  const spike = core * 2.6;
  const spikeColor = kind === "turret" ? "rgba(190, 245, 255, 0.95)" : "rgba(255, 245, 200, 0.95)";
  const coreColor = kind === "turret" ? "rgba(90, 210, 255, 0.85)" : "rgba(255, 210, 110, 0.85)";
  ctx.fillStyle = spikeColor;
  ctx.beginPath();
  ctx.moveTo(spike, 0);
  ctx.lineTo(core * 0.3, core * 0.35);
  ctx.lineTo(0, 0);
  ctx.lineTo(core * 0.3, -core * 0.35);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = coreColor;
  ctx.beginPath();
  ctx.moveTo(0, -core);
  ctx.lineTo(core * 0.25, 0);
  ctx.lineTo(0, core);
  ctx.lineTo(-core * 0.25, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
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
// Deliberately equal to GIANT_DEATH_EFFECT_MS (collectDeathEffects above) so
// a giant's own collapse and its death-explosion shockwave ring finish at
// the same moment — also the longer of the two impact durations, so main.ts
// uses this as the impact-array cleanup threshold.
export const EXPLOSION_EFFECT_MS = GIANT_DEATH_EFFECT_MS;

export function renderImpactEffects(ctx: CanvasRenderingContext2D, camera: Camera, effects: readonly ImpactEffect[], now: number): void {
  for (const e of effects) {
    const age = now - e.startedAt;
    const duration = e.kind === "explosion" ? EXPLOSION_EFFECT_MS : IMPACT_EFFECT_MS;
    if (age < 0 || age > duration) continue;
    const t = age / duration;
    const screen = worldToScreen(camera, e.x, e.y);
    const x = screen.x;
    const y = screen.y;

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

export function renderZombieProjectiles(ctx: CanvasRenderingContext2D, camera: Camera, projectiles: readonly ZombieProjectile[], now: number): void {
  for (const p of projectiles) {
    const age = now - p.firedAt;
    if (age < 0 || age > PROJECTILE_TRAVEL_MS) continue;
    const t = age / PROJECTILE_TRAVEL_MS;
    const from = worldToScreen(camera, p.fromX, p.fromY);
    const to = worldToScreen(camera, p.toX, p.toY);
    const x1 = from.x;
    const y1 = from.y;
    const x2 = to.x;
    const y2 = to.y;
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

export function renderDamageNumbers(ctx: CanvasRenderingContext2D, camera: Camera, numbers: readonly DamageNumber[], now: number): void {
  ctx.textAlign = "center";
  ctx.font = "bold 14px system-ui, sans-serif";
  for (const n of numbers) {
    const age = now - n.spawnedAt;
    if (age < 0 || age > DAMAGE_NUMBER_MS) continue;
    const t = age / DAMAGE_NUMBER_MS;
    const screen = worldToScreen(camera, n.x, n.y);
    const x = screen.x;
    const y = screen.y - 22 - t * 22;
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

export function renderDamageVignette(ctx: CanvasRenderingContext2D, canvasWidth: number, canvasHeight: number, flashedAt: number | undefined, now: number): void {
  if (flashedAt === undefined) return;
  const age = now - flashedAt;
  if (age < 0 || age > VIGNETTE_MS) return;
  const alpha = 0.35 * (1 - age / VIGNETTE_MS);
  const centerX = canvasWidth / 2;
  const centerY = canvasHeight / 2;
  // Outer radius reaches the canvas's farthest corner (half the diagonal) —
  // a radial gradient paints its LAST colour stop solid everywhere beyond
  // its outer radius, so sizing this off the shorter axis (as it used to)
  // left two solid-red bars down the long sides on a wide window once the
  // canvas stopped being forced square. Reaching the corner guarantees every
  // on-screen pixel falls inside the gradient's own fade, on any aspect
  // ratio. Inner radius keeps the same ratio to outer the old square-canvas
  // numbers (0.35/0.72) had, just rebased onto the corner distance.
  const cornerDist = Math.hypot(canvasWidth, canvasHeight) / 2;
  const outerRadius = cornerDist;
  const innerRadius = outerRadius * (0.35 / 0.72);
  const grad = ctx.createRadialGradient(centerX, centerY, innerRadius, centerX, centerY, outerRadius);
  grad.addColorStop(0, "rgba(255, 0, 0, 0)");
  grad.addColorStop(1, `rgba(200, 0, 0, ${alpha})`);
  ctx.save();
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  ctx.restore();
}

export function renderTurretPlacementPreview(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  mouseWorldPos: { x: number; y: number },
  valid: boolean,
): void {
  const scale = cameraScale(camera);
  const base = worldToScreen(camera, BASE_POS.x, BASE_POS.y);

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

  const p = worldToScreen(camera, mouseWorldPos.x, mouseWorldPos.y);
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
