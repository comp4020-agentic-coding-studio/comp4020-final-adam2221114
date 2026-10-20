import { BASE_ATTACK_RANGE, BASE_INTERACT_RANGE, BASE_POS, TURRET_BUILD_RADIUS, TURRET_LEVELS, WORLD_SIZE } from "./defense-config.ts";
import { cameraScale, worldToScreen, type Camera } from "./camera.ts";
import {
  BUILDING_BRICK_TILE,
  BUILDING_STONE_TILE,
  directionFromVector,
  FLYING_SHEET,
  FORTRESS_TILES,
  GRASS_LIGHT_TILE,
  GRASS_TILE,
  isReady,
  PLAYER_SHEETS,
  PROP_IMAGES,
  ROAD_LIGHT_TILE,
  ROAD_TILE,
  TERRAIN_TILE_SIZE,
  uiIconUrl,
  ZOMBIE_DEAD,
  zombieAttackSheet,
  zombieWalkSheet,
  type Direction,
  type SpritedZombieType,
  type UiIconName,
} from "./sprites.ts";
import { DECORATIVE_PROPS, distanceToRoad, GROUND_MARKS, OUTER_ZONE_RADIUS, ROAD_HALF_WIDTH, type GroundMark, type Prop } from "./terrain.ts";
import { BUILDINGS, FORTRESS_HALF_EXTENT, FORTRESS_INTERIOR_HALF_EXTENT, FORTRESS_TOWERS, FORTRESS_WALLS, TOWN_BUILDINGS, type Rect } from "./obstacles.ts";
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

// Per-type render treatment. The LPC zombie pack (like the CraftPix one it
// replaces) has no sprite shaped like a "giant"/"boss" monster — both reuse
// scale/tint reskins of the same civilian-zombie character (see sprites.ts's
// own comment) — so those two are told apart by scale/tint here, not by
// distinct art. Flying now uses a real sprite (sprites.ts's FLYING_SHEET)
// instead of the procedural silhouette this used to need.
const ZOMBIE_RENDER: Record<ZombieType, { scale: number; hover: boolean; glow?: string; tint?: string }> = {
  normal: { scale: 1.1, hover: false },
  flying: { scale: 1.0, hover: true, glow: "rgba(90, 220, 230, 0.35)" },
  giant: { scale: 1.9, hover: false, glow: "rgba(140, 90, 40, 0.25)", tint: "rgba(255, 150, 40, 0.3)" },
  boss: { scale: 2.6, hover: false, glow: "rgba(220, 40, 40, 0.4)", tint: "rgba(255, 30, 30, 0.35)" },
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
  return layer;
}

// Interior courtyard floor: fills the square the fortress walls enclose
// (FORTRESS_INTERIOR_HALF_EXTENT around BASE_POS) so the ground reads as
// "inside the walls" right up to them, rather than leaving bare grass
// visible between the walls and the base. Tiles FORTRESS_TILES.floorPad once
// that art exists; until then, a flat-colour + border placeholder fill.
function renderFortressCourtyardFloor(ctx: CanvasRenderingContext2D): void {
  const half = FORTRESS_INTERIOR_HALF_EXTENT * BAKE_PX_PER_UNIT;
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
const PROP_NATIVE_SIZE: Record<Prop["type"], { w: number; h: number }> = {
  tree: { w: 96, h: 112 },
  bush: { w: 96, h: 112 },
  barrel: { w: 32, h: 64 },
  chest: { w: 32, h: 32 },
};
// World-unit width each prop type is drawn at (height follows its own aspect
// ratio) — chosen so a tree reads as a real landmark and a chest/barrel
// reads as a small, human-scale object, same relative sizing the old
// CraftPix crate/barrel/tree crops had.
const PROP_DRAW_WIDTH: Record<Prop["type"], number> = {
  tree: 46,
  bush: 40,
  barrel: 16,
  chest: 20,
};

// Only props within (roughly) the visible viewport are drawn — the full
// prop list can include points far outside whatever window the camera
// currently shows, and with the camera now zoomed in (viewSize ~420 of the
// 1000-unit world) most of them are off-screen at any given moment.
const PROP_CULL_MARGIN = 80; // world units of slack beyond the viewport edge, so a prop doesn't pop in/out right at the edge

function renderProps(ctx: CanvasRenderingContext2D, camera: Camera): void {
  const scale = cameraScale(camera);
  const left = camera.originX - PROP_CULL_MARGIN;
  const top = camera.originY - PROP_CULL_MARGIN;
  const right = camera.originX + camera.viewSize + PROP_CULL_MARGIN;
  const bottom = camera.originY + camera.viewSize + PROP_CULL_MARGIN;
  for (const prop of DECORATIVE_PROPS) {
    if (prop.x < left || prop.x > right || prop.y < top || prop.y > bottom) continue;
    const img = PROP_IMAGES[prop.type];
    if (!isReady(img)) continue;
    const native = PROP_NATIVE_SIZE[prop.type];
    const dw = PROP_DRAW_WIDTH[prop.type] * scale;
    const dh = dw * (native.h / native.w);
    const screen = worldToScreen(camera, prop.x, prop.y);
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
function renderBuilding(ctx: CanvasRenderingContext2D, camera: Camera, b: Rect): void {
  const scale = cameraScale(camera);
  const screen = worldToScreen(camera, b.x, b.y);
  const x = screen.x;
  const y = screen.y;
  const w = b.w * scale;
  const h = b.h * scale;
  const tile = isReady(BUILDING_STONE_TILE) ? BUILDING_STONE_TILE : undefined;
  const brick = isReady(BUILDING_BRICK_TILE) ? BUILDING_BRICK_TILE : undefined;

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

  ctx.strokeStyle = "rgba(20, 18, 22, 0.6)";
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  ctx.restore();
}

// --- Fortress placeholder blockout: deliberately NOT an attempt at finished
// art. The user explicitly rejected composing "fake" finished visuals out of
// Canvas primitives (sandbags/fencing/etc drawn with shapes) — this instead
// reads unmistakably as a construction blockout (flat magenta/cyan debug
// fill, diagonal hazard hatch, a text label) until real PNGs exist at
// FORTRESS_TILES' paths, at which point isReady() flips these to the
// `tile ? ... : placeholder` branch automatically, same pattern renderBuilding
// already uses for BUILDING_STONE_TILE/BUILDING_BRICK_TILE. No logic needs to
// change when art is dropped in — only the files on disk. ---
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

// Fortress wall segment: tiled FORTRESS_TILES.wallSegment once art exists
// (same tiling loop renderBuilding uses for town buildings), else an
// explicit "WALL" blockout — see the comment above.
function renderFortressWall(ctx: CanvasRenderingContext2D, camera: Camera, b: Rect): void {
  const scale = cameraScale(camera);
  const screen = worldToScreen(camera, b.x, b.y);
  const w = b.w * scale;
  const h = b.h * scale;
  const tile = FORTRESS_TILES.wallSegment;
  if (isReady(tile)) {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    const ts = TERRAIN_TILE_SIZE * scale;
    for (let ty = 0; ty < h; ty += ts) {
      for (let tx = 0; tx < w; tx += ts) {
        const dw = Math.min(ts, w - tx);
        const dh = Math.min(ts, h - ty);
        ctx.drawImage(tile, 0, 0, TERRAIN_TILE_SIZE, TERRAIN_TILE_SIZE, screen.x + tx, screen.y + ty, dw, dh);
      }
    }
    ctx.restore();
  } else {
    drawPlaceholderBlockout(ctx, screen.x, screen.y, w, h, "WALL");
  }
}

// Fortress corner tower platform: FORTRESS_TILES.cornerTower once art
// exists, else a "TOWER" blockout.
function renderFortressTower(ctx: CanvasRenderingContext2D, camera: Camera, b: Rect): void {
  const scale = cameraScale(camera);
  const screen = worldToScreen(camera, b.x, b.y);
  const w = b.w * scale;
  const h = b.h * scale;
  const tile = FORTRESS_TILES.cornerTower;
  if (isReady(tile)) {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tile, screen.x, screen.y, w, h);
    ctx.restore();
  } else {
    drawPlaceholderBlockout(ctx, screen.x, screen.y, w, h, "TOWER");
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

function renderZombie(ctx: CanvasRenderingContext2D, camera: Camera, z: ZombieSnapshot, lungeStartedAt: number | undefined): void {
  const scale = cameraScale(camera);
  const screen = worldToScreen(camera, z.x, z.y);
  const cfg = ZOMBIE_RENDER[z.type];
  const face = updateFacing(zombieFacing, z.id, z.x, z.y);

  const phase = hashStr(z.id);
  const now = performance.now();
  const hoverOffset = cfg.hover ? Math.sin(now / 260 + phase) * 5 : 0;
  const drawSize = 32 * cfg.scale * scale * 0.9;
  const lungeFrac = lungeStartedAt === undefined ? 0 : Math.max(0, 1 - (now - lungeStartedAt) / LUNGE_DURATION_MS);
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
      if (cfg.tint) {
        // Giant/boss are the same art as normal, told apart by scale (above)
        // plus a colour wash here, applied only to the sprite's own drawn
        // pixels (source-atop) so it tints the character, not a surrounding
        // box.
        ctx.globalCompositeOperation = "source-atop";
        ctx.fillStyle = cfg.tint;
        ctx.fillRect(-drawSize / 2, -drawSize / 2, drawSize, drawSize);
        ctx.globalCompositeOperation = "source-over";
      }
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
}
const DEATH_EFFECT_MS = 500;
export function collectDeathEffects(previous: readonly ZombieSnapshot[] | undefined, current: readonly ZombieSnapshot[], now: number, into: DeathEffect[]): void {
  if (!previous) return;
  const currentIds = new Set(current.map((z) => z.id));
  for (const z of previous) {
    if (!currentIds.has(z.id)) into.push({ type: z.type, x: z.x, y: z.y, diedAt: now });
  }
}
export function renderDeathEffects(ctx: CanvasRenderingContext2D, camera: Camera, effects: DeathEffect[], now: number): void {
  const scale = cameraScale(camera);
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    const age = now - e.diedAt;
    if (age > DEATH_EFFECT_MS) {
      effects.splice(i, 1);
      continue;
    }
    const alpha = 1 - age / DEATH_EFFECT_MS;
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

    if (!isReady(ZOMBIE_DEAD.image)) continue;
    const frameIdx = age > DEATH_EFFECT_MS / 2 ? ZOMBIE_DEAD.frameCount - 1 : Math.min(ZOMBIE_DEAD.frameCount - 2, Math.floor((age / DEATH_EFFECT_MS) * (ZOMBIE_DEAD.frameCount - 1)));
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(ZOMBIE_DEAD.image, frameIdx * ZOMBIE_DEAD.frameWidth, 0, ZOMBIE_DEAD.frameWidth, ZOMBIE_DEAD.frameHeight, x - drawSize / 2, y - drawSize / 2, drawSize, drawSize);
    ctx.restore();
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
type Drawable =
  | { kind: "building"; sortY: number; rect: Rect }
  | { kind: "fortress-wall"; sortY: number; rect: Rect }
  | { kind: "fortress-tower"; sortY: number; rect: Rect }
  | { kind: "zombie"; sortY: number; z: ZombieSnapshot; lungeStartedAt: number | undefined }
  | { kind: "player"; sortY: number; p: StateMessage["players"][number]; isSelf: boolean; aimAngle: number; flashStartedAt: number | undefined };

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
): void {
  const canvasSize = camera.canvasSize;
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
    const sSize = camera.viewSize * BAKE_PX_PER_UNIT;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(terrain, sx, sy, sSize, sSize, 0, 0, canvasSize, canvasSize);
  } else {
    ctx.fillStyle = "#2a2622";
    ctx.fillRect(0, 0, canvasSize, canvasSize);
  }
  renderProps(ctx, camera);

  const base = toScreen(BASE_POS.x, BASE_POS.y);
  // Wall status is now drawn mapped onto the rectangular fortress footprint
  // (FORTRESS_HALF_EXTENT, the same rect FORTRESS_WALLS physically occupies)
  // instead of the old free-floating WALL_RING_RADIUS circle, so the Wall's
  // level/HP/ability feedback reads as part of the one rectangular base
  // rather than a separate circular shape drawn over it. This is a visual
  // mapping only — wallHp/wallLevel/ability resolution are untouched.
  const fortressHalf = scale * FORTRESS_HALF_EXTENT;
  const fortX = base.x - fortressHalf;
  const fortY = base.y - fortressHalf;
  const fortSize = fortressHalf * 2;

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
    // No protection at all — a dim, clearly "broken" dashed outline traced
    // over the fortress rectangle itself (not a free-floating circle) so
    // "I have no wall" reads at a glance instead of only by its absence.
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

    // A solid border tinted by the level's colour, traced over the
    // rectangular fortress perimeter (rather than a separate circle drawn
    // over it), with a thicker inner wash for a bit of material depth — no
    // fence-panel sprite exists for this (the LPC set has no tileable
    // barricade texture at this scale), so this is deliberately simple
    // Canvas geometry (CLAUDE.md: "prefer simple Canvas geometry over
    // inventing assets that don't exist").
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = visual.color;
    ctx.lineWidth = visual.lineWidth;
    ctx.strokeRect(fortX, fortY, fortSize, fortSize);
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = visual.lineWidth * 2;
    ctx.strokeRect(fortX, fortY, fortSize, fortSize);
    ctx.restore();

    if (visual.ability === "spike") {
      // Tick marks along the rectangle's own perimeter (evenly spaced by
      // side) instead of radiating out from a circle.
      const spikeLength = 7;
      const perSide = 4;
      ctx.strokeStyle = visual.color;
      ctx.lineWidth = 2;
      const sides: Array<{ x0: number; y0: number; x1: number; y1: number; nx: number; ny: number }> = [
        { x0: fortX, y0: fortY, x1: fortX + fortSize, y1: fortY, nx: 0, ny: -1 }, // top
        { x0: fortX + fortSize, y0: fortY, x1: fortX + fortSize, y1: fortY + fortSize, nx: 1, ny: 0 }, // right
        { x0: fortX + fortSize, y0: fortY + fortSize, x1: fortX, y1: fortY + fortSize, nx: 0, ny: 1 }, // bottom
        { x0: fortX, y0: fortY + fortSize, x1: fortX, y1: fortY, nx: -1, ny: 0 }, // left
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
      // player-facing indicator, now drawn as a dashed rectangle just
      // outside the fortress footprint so it reads as "this base's ability"
      // rather than a separate circular shape floating over it.
      const pulseMargin = 12 * scale;
      ctx.strokeStyle = "rgba(111, 194, 166, 0.3)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.strokeRect(fortX - pulseMargin, fortY - pulseMargin, fortSize + pulseMargin * 2, fortSize + pulseMargin * 2);
      ctx.setLineDash([]);
    }

    // Wall HP traced as a partial border over the fortress rectangle's own
    // perimeter (via a dash pattern sized to the rect's perimeter length) —
    // "how much wall is left" readable at a glance, without checking the
    // HUD, and turning visibly red as it nears breaking instead of only the
    // HUD number changing colour.
    const hpFraction = Math.max(0, Math.min(1, state.wallHp / state.wallMaxHp));
    const perimeter = fortSize * 4;
    ctx.save();
    ctx.lineWidth = 4;
    ctx.strokeStyle = hpFraction > 0.5 ? "rgba(140, 230, 160, 0.9)" : hpFraction > 0.2 ? "rgba(255, 205, 90, 0.9)" : "rgba(255, 90, 90, 0.95)";
    ctx.setLineDash([perimeter * hpFraction, perimeter]);
    ctx.strokeRect(fortX, fortY, fortSize, fortSize);
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

  renderBase(ctx, base, scale);

  for (const turret of state.turrets) {
    renderTurret(ctx, camera, turret);
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
  for (const b of FORTRESS_WALLS) {
    drawables.push({ kind: "fortress-wall", sortY: b.y + b.h, rect: b });
  }
  for (const b of FORTRESS_TOWERS) {
    drawables.push({ kind: "fortress-tower", sortY: b.y + b.h, rect: b });
  }
  for (const z of state.zombies) {
    drawables.push({ kind: "zombie", sortY: z.y, z, lungeStartedAt: zombieLunge.get(z.id) });
  }
  for (const p of state.players) {
    drawables.push({ kind: "player", sortY: p.y, p, isSelf: p.id === myPlayerId, aimAngle, flashStartedAt: playerFlash.get(p.id) });
  }
  drawables.sort((a, b) => a.sortY - b.sortY);
  for (const d of drawables) {
    if (d.kind === "building") renderBuilding(ctx, camera, d.rect);
    else if (d.kind === "fortress-wall") renderFortressWall(ctx, camera, d.rect);
    else if (d.kind === "fortress-tower") renderFortressTower(ctx, camera, d.rect);
    else if (d.kind === "zombie") renderZombie(ctx, camera, d.z, d.lungeStartedAt);
    else renderPlayer(ctx, camera, d.p, d.isSelf, d.aimAngle, d.flashStartedAt);
  }

  for (const prog of state.reviveProgress) {
    const target = state.players.find((p) => p.id === prog.targetId);
    if (!target) continue;
    renderReviveProgress(ctx, toScreen(target.x, target.y), prog.remainingMs);
  }
}

function renderBase(ctx: CanvasRenderingContext2D, base: { x: number; y: number }, scale: number): void {
  const size = 44 * scale;
  if (isReady(BUILDING_STONE_TILE)) {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    const ts = TERRAIN_TILE_SIZE * scale;
    for (let ty = -size / 2; ty < size / 2; ty += ts) {
      for (let tx = -size / 2; tx < size / 2; tx += ts) {
        const dw = Math.min(ts, size / 2 - tx);
        const dh = Math.min(ts, size / 2 - ty);
        ctx.drawImage(BUILDING_STONE_TILE, 0, 0, TERRAIN_TILE_SIZE, TERRAIN_TILE_SIZE, base.x + tx, base.y + ty, dw, dh);
      }
    }
    ctx.strokeStyle = "rgba(255, 210, 90, 0.7)";
    ctx.lineWidth = 2;
    ctx.strokeRect(base.x - size / 2, base.y - size / 2, size, size);
    // A dark "door" accent — simple Canvas geometry, same reasoning as the
    // turret's drawn body: no LPC crop is specifically shaped like this
    // project's single-entry vault/bunker door.
    ctx.fillStyle = "#1c1c20";
    ctx.fillRect(base.x - size * 0.18, base.y - size * 0.1, size * 0.36, size * 0.45);
    ctx.restore();
  } else {
    // Stone tile not loaded yet — a flat rectangular placeholder (matches
    // the shape renderBase draws once the tile is ready) so the base never
    // flashes as a circle before art loads.
    ctx.fillStyle = "#4477cc";
    ctx.fillRect(base.x - size / 2, base.y - size / 2, size, size);
  }
}

// Last known aim angle per turret id, so an idle turret (no current target)
// keeps pointing the way it last fired instead of snapping back to a
// default facing every time it loses its target.
const turretFacing = new Map<string, number>();

// Clear, flat-shaded 2D turret: a square base plate (reads as bolted to the
// ground) with a round traversing body and a drawn gun barrel on top — no
// LPC crop is shaped like a turret, so (CLAUDE.md: "prefer simple Canvas
// geometry over inventing assets that don't exist") this is deliberately
// drawn geometry rather than a repurposed prop sprite.
function renderTurret(ctx: CanvasRenderingContext2D, camera: Camera, turret: TurretSnapshot): void {
  if (turret.hp <= 0) return;
  const scale = cameraScale(camera);
  const screen = worldToScreen(camera, turret.x, turret.y);
  const range = TURRET_LEVELS[turret.level]?.range ?? TURRET_LEVELS[1].range;

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

  const bodyRadius = 8 + turret.level;
  const plateSize = (bodyRadius + 5) * 2;

  // Base plate: a fixed (non-rotating) square mount, so the body/barrel
  // above reads as the part that actually traverses.
  ctx.save();
  ctx.fillStyle = "#4a4e55";
  ctx.fillRect(screen.x - plateSize / 2, screen.y - plateSize / 2, plateSize, plateSize);
  ctx.strokeStyle = "#2a2c30";
  ctx.lineWidth = 2;
  ctx.strokeRect(screen.x - plateSize / 2, screen.y - plateSize / 2, plateSize, plateSize);
  // Corner bolts — a small detail that reads as "mounted hardware" rather
  // than a flat colour block.
  ctx.fillStyle = "#1c1c1c";
  const boltInset = plateSize * 0.22;
  for (const [dx, dy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    ctx.beginPath();
    ctx.arc(screen.x + dx * (plateSize / 2 - boltInset), screen.y + dy * (plateSize / 2 - boltInset), 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // Barrel: drawn BEHIND the body so its base is covered, pointing toward
  // `angle`, length/width scaling with level.
  const barrelLength = bodyRadius + 10 + turret.level * 2;
  const barrelWidth = 4 + turret.level * 0.6;
  ctx.save();
  ctx.translate(screen.x, screen.y);
  ctx.rotate(angle);
  ctx.fillStyle = "#3a3d42";
  ctx.fillRect(0, -barrelWidth / 2, barrelLength, barrelWidth);
  ctx.strokeStyle = "#cc6633";
  ctx.lineWidth = 1;
  ctx.strokeRect(0, -barrelWidth / 2, barrelLength, barrelWidth);
  // Muzzle tip accent.
  ctx.fillStyle = "#cc6633";
  ctx.fillRect(barrelLength - 3, -barrelWidth / 2, 3, barrelWidth);
  ctx.restore();

  // Turret body (the traversing round housing the barrel mounts to).
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, bodyRadius, 0, Math.PI * 2);
  ctx.fillStyle = "#8a8f98";
  ctx.fill();
  ctx.strokeStyle = "#cc6633";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = "#1c1c1c";
  ctx.font = "bold 10px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`${turret.level}`, screen.x, screen.y + 3);
  ctx.textAlign = "left";

  const barWidth = 22;
  const barHeight = 3;
  const barX = screen.x - barWidth / 2;
  const barY = screen.y - plateSize / 2 - 8;
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

function renderPlayer(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  p: StateMessage["players"][number],
  isSelf: boolean,
  aimAngle: number,
  flashStartedAt: number | undefined,
): void {
  const scale = cameraScale(camera);
  const screen = worldToScreen(camera, p.x, p.y);
  const color = isSelf ? LOCAL_PLAYER_COLOR : REMOTE_PLAYER_COLORS[p.colorIndex % REMOTE_PLAYER_COLORS.length];
  const now = performance.now();
  const flashFrac = flashStartedAt === undefined ? 0 : Math.max(0, 1 - (now - flashStartedAt) / PLAYER_FLASH_MS);

  // Always tracked from real WORLD position (p.x/p.y) — this is also what
  // the "moving" check below compares against, so facing and animation stay
  // consistent. A remote player has no broadcast aim angle (protocol.ts's
  // PlayerSnapshot never sends one), so its facing comes from movement delta
  // the same way a zombie's does.
  const face = updateFacing(playerFacing, p.id, p.x, p.y);
  if (isSelf) {
    // The local player's aim is the one real signal this client has about
    // where it's actually looking, independent of movement — override just
    // the direction (not lastX/lastY, which the "moving" check still needs)
    // with one derived straight from aimAngle.
    face.dir = directionFromVector(Math.cos(aimAngle), Math.sin(aimAngle), face.dir);
  }

  const sheet = PLAYER_SHEETS[p.colorIndex % PLAYER_SHEETS.length][face.dir];
  const drawSize = PLAYER_DRAW_SIZE * scale;

  // Ground shadow — drawn before the sprite, same light-direction
  // convention as buildings' own drop shadow.
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(screen.x + 2, screen.y + drawSize * 0.32, drawSize * 0.26, drawSize * 0.12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(screen.x, screen.y);
  if (p.status === "alive") {
    ctx.globalAlpha = p.invulnerable ? 0.55 + 0.35 * Math.sin(now / 80) : 1;
  } else {
    // Downed/dead: lower alpha, and visually "fallen" (squashed vertically,
    // no new asset needed for a dedicated down/death pose).
    ctx.globalAlpha = p.status === "dead" ? 0.3 : 0.6;
    ctx.scale(1, 0.6);
    ctx.translate(0, drawSize * 0.2);
  }

  if (isReady(sheet.image)) {
    // Idle when not actually moving this frame (face.moving, captured by
    // updateFacing from the real position delta above) — frame 0 of the
    // walk cycle doubles as a standing pose, same "no dedicated idle sheet,
    // reuse what exists" choice this project already made for zombies.
    const phase = hashStr(p.id);
    const frameIdx = face.moving ? Math.floor(now / 130 + phase) % sheet.frameCount : 0;
    ctx.imageSmoothingEnabled = false;
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
  camera: Camera,
  effects: readonly ShotEffect[],
  now: number,
): void {
  for (const e of effects) {
    const age = now - e.firedAt;
    if (age < 0 || age > TRACER_LIFETIME_MS) continue;
    const alpha = 1 - age / TRACER_LIFETIME_MS;

    const p1 = worldToScreen(camera, e.x, e.y);
    const p2 = worldToScreen(camera, e.x + Math.cos(e.angle) * TRACER_LENGTH, e.y + Math.sin(e.angle) * TRACER_LENGTH);
    const x1 = p1.x;
    const y1 = p1.y;
    const x2 = p2.x;
    const y2 = p2.y;

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
