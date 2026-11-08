// Authoritative building/ruin geometry for the Crit-11 map-visual pass: a
// fixed, hand-placed set of solid rectangles players and ground zombies
// cannot walk through, plus the machinery that lets a ground zombie whose
// direct line to its target is blocked by one still reliably reach the
// base — a single precomputed flow field, not per-target dynamic search
// (CLAUDE.md's amended scope rule: "a static, precomputed flow field toward
// the base — no per-target dynamic search, no runtime recomputation").
//
// src/client/obstacles.ts mirrors BUILDINGS verbatim (same reason
// defense-config.ts/protocol.ts duplicate constants instead of importing
// across the client/server build boundary — see those files' own comments).
// Decorative props (terrain.ts's trees/bushes/crates/etc.) are NOT here and
// stay exactly as cosmetic as they are today; only buildings are solid.
//
// MAP_SIZE/BASE_POS are duplicated from game-state.ts (not imported) purely
// to avoid a circular import: game-state.ts's own movePlayer/advanceZombie
// need to call into this file, and GRID_SIZE below is computed at module
// top-level from MAP_SIZE, which a circular import could evaluate before
// game-state.ts has finished defining it. Both values are long-settled
// (MAP_SIZE has never changed since Crit 8) — if game-state.ts's copy ever
// changes, this one must change with it.
export interface Vec2 {
  x: number;
  y: number;
}
const MAP_SIZE = 1000;
const BASE_POS: Vec2 = { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };

export interface Rect {
  x: number; // top-left corner, world units
  y: number;
  w: number;
  h: number;
}

// Four ruined-building footprints (replacing the prior twelve procedural
// ones), one per diagonal quadrant, matching the four ruin structures
// painted directly into the new AI-generated map background
// (src/client/sprites/map-ai-gen/map-background.png — see that directory's
// NOTES.md for asset provenance). Each rect was measured by hand against the
// source PNG (pixel-space bounding box of the visible brick/stone ruin,
// including its rubble pile, converted to world units at scale
// 1000/1254) and visually verified to tightly enclose — without excess
// empty-grass margin — the painted structure it represents. Buildings here
// are deliberately NOT decorative recreations of the art; the art itself is
// drawn directly (render.ts/sprites.ts's ruin-*-cutout images), and these
// rects exist purely to give that already-visible geometry real
// server-authoritative collision. Verified against: no inflated overlap
// with any other building; comfortable clearance beyond every road arm's
// ROAD_HALF_WIDTH; and full base-connectivity (0 unreached cells) —
// assertMapIsFullyConnected() re-verifies the connectivity part at every
// startup so a future hand-edit that seals a region fails loudly instead of
// silently stranding zombies.
export const TOWN_BUILDINGS: Rect[] = [
  { x: 128, y: 68, w: 120, h: 104 }, // NW ruin
  { x: 729, y: 76, w: 179, h: 96 }, // NE ruin
  { x: 63.8, y: 809.4, w: 203.3, h: 119.6 }, // SW ruin
  { x: 745, y: 721, w: 136, h: 104 }, // SE ruin
];

// The purchasable Wall's physical geometry: a square ring (half-extent
// H=99, thickness T=14, outer bounds (401,401)-(599,599)) around BASE_POS,
// present ONLY while wallLevel > 0 (game-state.ts's wallLevel/wallHp) — no
// fixed always-on fortress and no corner towers (both removed; see git
// history for the Crit 11 fortress this replaces). Geometry (half-extent/
// thickness/gate-width) was the original fortress's own numbers x0.85,
// rounded (2026-11-06 footprint shrink: "leave more room for zombies" — see
// game-state.ts's own comment on BASE_ATTACK_RANGE/BASE_INTERACT_RANGE,
// scaled by the same factor so the ring geometry stays internally
// consistent), now conditional on wallLevel instead of always present.
//
// PLAYERS and ZOMBIES see deliberately DIFFERENT wall shapes once built:
//   - wallRectsForPlayers: north/east/west solid, south split around a
//     GATE_WIDTH=77 gap facing PLAYER_START_POS (500,551) — a player can
//     always walk in/out through the gate once the wall stands.
//   - wallRectsForZombies: all four sides solid, NO gate at all.
// This asymmetry is deliberate, not an oversight: CLAUDE.md's invariant is
// "ground zombies cannot cross an intact wall to reach the base" with no
// exception for the gate — if zombies shared the player's gated shape,
// they'd simply walk in through it. Both shapes share the same half-extent/
// thickness, so visually it reads as one wall; only the gate differs by
// who's asking.
//
// Neither shape is folded into BUILDINGS/the flow field: the flow field
// (buildFlowField/cachedField, below) is a lazy-once, never-recomputed
// singleton per CLAUDE.md's "no runtime recomputation" invariant, and a
// wall that appears/disappears with wallLevel can't live inside it without
// violating that. Instead, every (re)build of these rects is a handful of
// plain object literals computed fresh on every call — resolveMove takes
// them as an extra-rects parameter (see below) and advanceZombie
// (game-state.ts) consults wallRectsForZombies directly, independent of
// BUILDINGS/the BFS entirely.
export const WALL_HALF_EXTENT = 99; // was 116
export const WALL_THICKNESS = 14; // was 16
export const WALL_GATE_WIDTH = 77; // was 90
// How far inside the outer half-extent the wall's inner face sits — the
// boundary of the courtyard a player/the base sits inside once walled in.
export const WALL_INTERIOR_HALF_EXTENT = WALL_HALF_EXTENT - WALL_THICKNESS;

function wallRects(wallLevel: number, gated: boolean): Rect[] {
  if (wallLevel <= 0) return [];
  const rects: Rect[] = [
    // North wall (solid either way)
    { x: BASE_POS.x - WALL_HALF_EXTENT, y: BASE_POS.y - WALL_HALF_EXTENT, w: WALL_HALF_EXTENT * 2, h: WALL_THICKNESS },
  ];
  if (gated) {
    // South wall, split around the gate gap so the gate is simply open
    // space, not a special-cased tile.
    rects.push(
      { x: BASE_POS.x - WALL_HALF_EXTENT, y: BASE_POS.y + WALL_HALF_EXTENT - WALL_THICKNESS, w: WALL_HALF_EXTENT - WALL_GATE_WIDTH / 2, h: WALL_THICKNESS },
      { x: BASE_POS.x + WALL_GATE_WIDTH / 2, y: BASE_POS.y + WALL_HALF_EXTENT - WALL_THICKNESS, w: WALL_HALF_EXTENT - WALL_GATE_WIDTH / 2, h: WALL_THICKNESS },
    );
  } else {
    // South wall, solid — the zombie side has no gate at all.
    rects.push({ x: BASE_POS.x - WALL_HALF_EXTENT, y: BASE_POS.y + WALL_HALF_EXTENT - WALL_THICKNESS, w: WALL_HALF_EXTENT * 2, h: WALL_THICKNESS });
  }
  rects.push(
    // East wall (solid)
    { x: BASE_POS.x + WALL_HALF_EXTENT - WALL_THICKNESS, y: BASE_POS.y - WALL_HALF_EXTENT, w: WALL_THICKNESS, h: WALL_HALF_EXTENT * 2 },
    // West wall (solid)
    { x: BASE_POS.x - WALL_HALF_EXTENT, y: BASE_POS.y - WALL_HALF_EXTENT, w: WALL_THICKNESS, h: WALL_HALF_EXTENT * 2 },
  );
  return rects;
}

// Empty array while wallLevel is 0 — no wall exists until it's built.
export function wallRectsForPlayers(wallLevel: number): Rect[] {
  return wallRects(wallLevel, true);
}
export function wallRectsForZombies(wallLevel: number): Rect[] {
  return wallRects(wallLevel, false);
}

// Town buildings are the only fixed, always-on solid obstacles now — the
// wall is live state, handled separately above. spec/map-collision.test.ts/
// spec/zombie-pathing.test.ts exercise this generically via BUILDINGS[0]
// with no assumption about which rect that is.
export const BUILDINGS: Rect[] = [...TOWN_BUILDINGS];

// Entities are treated as points (this project's existing model — see
// movePlayer/advanceZombie, neither of which has an entity radius), so a
// small buffer is added around every building when testing collision/line-
// of-sight, purely so a player or zombie visually reads as touching a wall
// rather than standing with its point-centre exactly on the edge.
const COLLISION_MARGIN = 10;

function inflated(r: Rect, margin: number): Rect {
  return { x: r.x - margin, y: r.y - margin, w: r.w + margin * 2, h: r.h + margin * 2 };
}

export function pointInRect(p: Vec2, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

const NO_EXTRA_RECTS: readonly Rect[] = [];

// extraRects lets a caller fold in rects beyond the fixed BUILDINGS set
// without touching BUILDINGS itself — used for the wall, whose rects are
// live state (wallRectsForPlayers/wallRectsForZombies above), never a fixed
// constant, and deliberately kept out of BUILDINGS/the flow field (see the
// wall geometry comment above for why).
function pointBlocked(p: Vec2, extraRects: readonly Rect[] = NO_EXTRA_RECTS): boolean {
  for (const b of BUILDINGS) {
    if (pointInRect(p, inflated(b, COLLISION_MARGIN))) return true;
  }
  for (const b of extraRects) {
    if (pointInRect(p, inflated(b, COLLISION_MARGIN))) return true;
  }
  return false;
}

// Axis-separated collision resolution: try the X move alone, keep it only if
// it doesn't land inside a building; then try the Y move alone (from
// whatever X ended up being) the same way. This is what gives "sliding along
// a wall" for free instead of a glancing touch killing all movement — the
// same standard approach the brief's "合理的沿墙滑动" asked for. The same
// function (not a parallel copy) resolves BOTH player movement and, via
// extraRects, ground-zombie movement against the live wall rects — one
// shared collision code path for both, per the project's own "do not
// duplicate game logic" rule.
export function resolveMove(from: Vec2, desired: Vec2, extraRects: readonly Rect[] = NO_EXTRA_RECTS): Vec2 {
  let x = from.x;
  let y = from.y;
  const clampedDesiredX = Math.min(Math.max(desired.x, 0), MAP_SIZE);
  const clampedDesiredY = Math.min(Math.max(desired.y, 0), MAP_SIZE);

  if (!pointBlocked({ x: clampedDesiredX, y }, extraRects)) {
    x = clampedDesiredX;
  }
  if (!pointBlocked({ x, y: clampedDesiredY }, extraRects)) {
    y = clampedDesiredY;
  }
  return { x, y };
}

// Shortest distance from a point to an (uninflated) rect's edge — 0 if the
// point is inside it. Used by advanceZombie to decide "close enough to the
// wall to attack it" without re-deriving a circular stand-in, now that the
// wall is real rectangle geometry.
function distanceToRect(p: Vec2, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

export function nearestRectDistance(p: Vec2, rects: readonly Rect[]): number {
  let best = Infinity;
  for (const r of rects) best = Math.min(best, distanceToRect(p, r));
  return best;
}

// Point-in-square test against the wall's INNER face (the courtyard the
// wall encloses) — used by advanceZombie to decide whether a zombie's real
// target (the base, or a player who made it inside through the gate) is
// "behind the wall" and must be approached as BASE_POS instead, exactly the
// role the old circular WALL_RING_RADIUS test played.
export function isWithinWallInterior(pos: Vec2): boolean {
  return Math.abs(pos.x - BASE_POS.x) <= WALL_INTERIOR_HALF_EXTENT && Math.abs(pos.y - BASE_POS.y) <= WALL_INTERIOR_HALF_EXTENT;
}

// Liang-Barsky style segment/rect test, used to decide whether a zombie's
// direct line to its current target is actually walkable. Inflated by the
// same collision margin as movement, so "blocked" agrees with what
// resolveMove would actually stop a point entity from crossing.
function segmentIntersectsRect(p1: Vec2, p2: Vec2, r: Rect): boolean {
  if (pointInRect(p1, r) || pointInRect(p2, r)) return true;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  let tMin = 0;
  let tMax = 1;
  const edges: [number, number][] = [
    [-dx, p1.x - r.x],
    [dx, r.x + r.w - p1.x],
    [-dy, p1.y - r.y],
    [dy, r.y + r.h - p1.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false; // parallel and outside this edge's slab
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > tMax) return false;
      if (t > tMin) tMin = t;
    } else {
      if (t < tMin) return false;
      if (t < tMax) tMax = t;
    }
  }
  return tMin <= tMax;
}

export function lineOfSightClear(from: Vec2, to: Vec2): boolean {
  for (const b of BUILDINGS) {
    if (segmentIntersectsRect(from, to, inflated(b, COLLISION_MARGIN))) return false;
  }
  return true;
}

// --- Static flow field: a single BFS from the base's cell, computed once at
// startup, not recomputed per zombie or per tick. Every free cell stores a
// unit direction toward the neighbouring cell one step closer to the base
// (its BFS parent) — looked up, not searched, whenever a zombie's direct
// line to its real target is blocked (game-state.ts's advanceZombie). ---
const CELL_SIZE = 25; // matches render.ts's GROUND_TILE_WORLD — same coarseness, not a coincidence
const GRID_SIZE = Math.ceil(MAP_SIZE / CELL_SIZE);

function cellCenter(gx: number, gy: number): Vec2 {
  return { x: (gx + 0.5) * CELL_SIZE, y: (gy + 0.5) * CELL_SIZE };
}

function cellBlocked(gx: number, gy: number): boolean {
  return pointBlocked(cellCenter(gx, gy));
}

interface FlowField {
  dir: Float32Array; // 2 floats per cell: dx, dy (unit vector toward base; 0,0 if blocked or unreached)
  dist: Int32Array; // BFS distance in steps; -1 if unreached
}

function buildFlowField(): FlowField {
  const n = GRID_SIZE * GRID_SIZE;
  const dir = new Float32Array(n * 2);
  const dist = new Int32Array(n).fill(-1);
  const parent = new Int32Array(n).fill(-1);

  const idx = (gx: number, gy: number): number => gy * GRID_SIZE + gx;
  const baseCell = { gx: Math.floor(BASE_POS.x / CELL_SIZE), gy: Math.floor(BASE_POS.y / CELL_SIZE) };

  const queue: number[] = [];
  const startIdx = idx(baseCell.gx, baseCell.gy);
  dist[startIdx] = 0;
  queue.push(startIdx);

  // 8-directional neighbours for a smoother flow direction than a pure
  // 4-directional BFS would give.
  const neighbours = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    const cx = current % GRID_SIZE;
    const cy = Math.floor(current / GRID_SIZE);
    for (const [ox, oy] of neighbours) {
      const nx = cx + ox;
      const ny = cy + oy;
      if (nx < 0 || ny < 0 || nx >= GRID_SIZE || ny >= GRID_SIZE) continue;
      if (cellBlocked(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (dist[ni] !== -1) continue;
      dist[ni] = dist[current] + 1;
      parent[ni] = current;
      queue.push(ni);
    }
  }

  for (let gy = 0; gy < GRID_SIZE; gy++) {
    for (let gx = 0; gx < GRID_SIZE; gx++) {
      const i = idx(gx, gy);
      const p = parent[i];
      if (p === -1) continue; // base cell itself, or unreached
      const from = cellCenter(gx, gy);
      const to = cellCenter(p % GRID_SIZE, Math.floor(p / GRID_SIZE));
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len = Math.hypot(dx, dy) || 1;
      dir[i * 2] = dx / len;
      dir[i * 2 + 1] = dy / len;
    }
  }

  return { dir, dist };
}

let cachedField: FlowField | undefined;

function getField(): FlowField {
  if (!cachedField) cachedField = buildFlowField();
  return cachedField;
}

// Every non-obstacle cell must be reachable from the base — a hand-placed
// layout (not generated) can in principle seal off a region by accident, and
// this is the one-time startup check that turns that mistake into an
// immediate, loud failure instead of zombies silently piling up forever
// somewhere off-screen. Called once from game-loop.ts's GameLoop
// constructor.
export function assertMapIsFullyConnected(): void {
  const field = getField();
  const unreached: string[] = [];
  for (let gy = 0; gy < GRID_SIZE; gy++) {
    for (let gx = 0; gx < GRID_SIZE; gx++) {
      if (cellBlocked(gx, gy)) continue;
      if (field.dist[gy * GRID_SIZE + gx] === -1) unreached.push(`(${gx},${gy})`);
    }
  }
  if (unreached.length > 0) {
    throw new Error(
      `obstacles.ts: ${unreached.length} map cell(s) cannot reach the base — the BUILDINGS layout seals off a region: ${unreached.slice(0, 10).join(", ")}${unreached.length > 10 ? "…" : ""}`,
    );
  }
}

// The flow direction a zombie standing at `pos` should step along when its
// direct line to its real target is blocked. Falls back to a direct vector
// toward the base if `pos` itself is in an unreached/blocked cell (should
// not happen in practice — zombies never spawn or get pushed inside a
// building — but never returns a zero vector, which would freeze a zombie
// in place).
export function flowDirectionAt(pos: Vec2): Vec2 {
  const field = getField();
  const gx = Math.min(GRID_SIZE - 1, Math.max(0, Math.floor(pos.x / CELL_SIZE)));
  const gy = Math.min(GRID_SIZE - 1, Math.max(0, Math.floor(pos.y / CELL_SIZE)));
  const i = gy * GRID_SIZE + gx;
  const dx = field.dir[i * 2];
  const dy = field.dir[i * 2 + 1];
  if (dx === 0 && dy === 0) {
    const toBaseX = BASE_POS.x - pos.x;
    const toBaseY = BASE_POS.y - pos.y;
    const len = Math.hypot(toBaseX, toBaseY) || 1;
    return { x: toBaseX / len, y: toBaseY / len };
  }
  return { x: dx, y: dy };
}

// Used by placeTurret's validation (a turret can't legally stand inside a
// solid building) and by map-collision tests.
export function overlapsAnyBuilding(pos: Vec2): boolean {
  return pointBlocked(pos);
}

// Used by placeTurret's validation to also reject a spot inside the wall's
// own rects (BUILDINGS never includes the wall — see its own comment on
// why — so this is a separate, explicit check rather than folded into
// overlapsAnyBuilding).
export function overlapsWallRect(pos: Vec2, wallRects: readonly Rect[]): boolean {
  for (const r of wallRects) {
    if (pointInRect(pos, inflated(r, COLLISION_MARGIN))) return true;
  }
  return false;
}

// The closest point on the boundary of whichever (inflated) BUILDINGS/
// extraRects rect is nearest to `pos`, and that rect's own identity (for
// strict-equality grouping by the caller). Used by game-state.ts's
// avoidanceStep to steer TANGENT to the real obstacle surface a stuck
// zombie is pressed against, instead of re-deriving a direction from noisy
// per-tick movement deltas — see that function's own comment for why.
export function nearestObstaclePoint(pos: Vec2, extraRects: readonly Rect[] = NO_EXTRA_RECTS): { point: Vec2; rect: Rect } | null {
  let best: { point: Vec2; rect: Rect } | null = null;
  let bestDist = Infinity;
  for (const r of BUILDINGS) {
    const ir = inflated(r, COLLISION_MARGIN);
    const px = Math.min(Math.max(pos.x, ir.x), ir.x + ir.w);
    const py = Math.min(Math.max(pos.y, ir.y), ir.y + ir.h);
    const d = Math.hypot(pos.x - px, pos.y - py);
    if (d < bestDist) {
      bestDist = d;
      best = { point: { x: px, y: py }, rect: r };
    }
  }
  for (const r of extraRects) {
    const ir = inflated(r, COLLISION_MARGIN);
    const px = Math.min(Math.max(pos.x, ir.x), ir.x + ir.w);
    const py = Math.min(Math.max(pos.y, ir.y), ir.y + ir.h);
    const d = Math.hypot(pos.x - px, pos.y - py);
    if (d < bestDist) {
      bestDist = d;
      best = { point: { x: px, y: py }, rect: r };
    }
  }
  return best;
}
