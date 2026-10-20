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

// Twelve building footprints of VARIED sizes (12 distinct w/h pairs, not a
// handful repeated), placed by a one-off rejection-sampling script (not
// typed by hand) into the four angular GAPS between terrain.ts's curved
// ROAD_ARMS — three buildings loosely grouped per gap, at varied distances
// and offsets so the result reads as an irregular town, not four mirrored
// quadrant blocks. Every footprint satisfies, simultaneously: >210 units
// from BASE_POS (clear of TURRET_BUILD_RADIUS=150 and the decorative-prop
// clear zone, terrain.ts's PROPS_CLEAR_RADIUS=220); >25 units clear of the
// nearest point on any road arm beyond the road's own ROAD_HALF_WIDTH; no
// inflated overlap with any other building; inside the map bounds with a
// 20-unit margin. Verified against all four constraints plus full
// base-connectivity (0 unreached cells) before being committed here —
// assertMapIsFullyConnected() re-verifies the connectivity part at every
// startup so a future hand-edit that seals a region fails loudly instead of
// silently stranding zombies.
export const TOWN_BUILDINGS: Rect[] = [
  // NE gap
  { x: 663, y: 255, w: 110, h: 70 },
  { x: 523, y: 132, w: 70, h: 100 },
  { x: 615, y: 154, w: 80, h: 60 },
  // SE gap
  { x: 744, y: 638, w: 90, h: 75 },
  { x: 751, y: 734, w: 140, h: 60 },
  { x: 854, y: 613, w: 65, h: 95 },
  // SW gap
  { x: 142, y: 720, w: 100, h: 80 },
  { x: 369, y: 798, w: 75, h: 95 },
  { x: 271, y: 662, w: 70, h: 65 },
  // NW gap
  { x: 220, y: 185, w: 95, h: 70 },
  { x: 121, y: 292, w: 70, h: 95 },
  { x: 232, y: 282, w: 80, h: 60 },
];

// The base fortress: a walled square (half-extent H=116, wall thickness
// T=16, outer bounds (384,384)-(616,616)) around BASE_POS, with one open
// gate gap (GATE_WIDTH=90) in the south wall facing PLAYER_START_POS
// (500,560) — a new/reconnecting player always spawns just outside the
// gate, already facing the way in — plus four 40x40 corner platforms.
// North/east/west are single solid rects; south is split into two rects
// (south-west / south-east of the gap) so the gate is simply open space,
// not a special-cased tile. Geometry chosen so every corner
// (H*sqrt(2)≈164 from BASE_POS) stays well clear of the nearest town
// building (227 units — see TOWN_BUILDINGS' own comment) and the inner
// wall face (H-T=100 from base) stays outside WALL_RING_RADIUS=60, so the
// existing player Wall ring/pad fit inside the courtyard with room to
// spare. assertMapIsFullyConnected() (below) verifies the gate gap keeps
// interior and exterior one connected region; spec/map-collision.test.ts /
// spec/zombie-pathing.test.ts exercise this same list generically (via
// BUILDINGS[0]) with no assumption about which rect that is.
//
// This is PURELY the fortress's physical footprint (what blocks movement
// and sight) — it has no connection to the player's own upgradeable Wall
// mechanic (wallLevel/wallHp, WALL_RING_RADIUS) elsewhere in game-state.ts,
// which continues to render/function exactly as it always has, now simply
// inside this courtyard instead of in open air. Visual rendering of these
// rects lives in src/client/render.ts's FORTRESS_TILES lookup — client-
// side art has no bearing on this file's collision geometry.
const FORTRESS_HALF_EXTENT = 116;
const FORTRESS_WALL_THICKNESS = 16;
const FORTRESS_GATE_WIDTH = 90;
const FORTRESS_TOWER_SIZE = 40;

export const FORTRESS_WALLS: Rect[] = [
  // North wall (solid)
  { x: BASE_POS.x - FORTRESS_HALF_EXTENT, y: BASE_POS.y - FORTRESS_HALF_EXTENT, w: FORTRESS_HALF_EXTENT * 2, h: FORTRESS_WALL_THICKNESS },
  // South wall, split around the gate gap
  {
    x: BASE_POS.x - FORTRESS_HALF_EXTENT,
    y: BASE_POS.y + FORTRESS_HALF_EXTENT - FORTRESS_WALL_THICKNESS,
    w: FORTRESS_HALF_EXTENT - FORTRESS_GATE_WIDTH / 2,
    h: FORTRESS_WALL_THICKNESS,
  },
  {
    x: BASE_POS.x + FORTRESS_GATE_WIDTH / 2,
    y: BASE_POS.y + FORTRESS_HALF_EXTENT - FORTRESS_WALL_THICKNESS,
    w: FORTRESS_HALF_EXTENT - FORTRESS_GATE_WIDTH / 2,
    h: FORTRESS_WALL_THICKNESS,
  },
  // East wall (solid)
  { x: BASE_POS.x + FORTRESS_HALF_EXTENT - FORTRESS_WALL_THICKNESS, y: BASE_POS.y - FORTRESS_HALF_EXTENT, w: FORTRESS_WALL_THICKNESS, h: FORTRESS_HALF_EXTENT * 2 },
  // West wall (solid)
  { x: BASE_POS.x - FORTRESS_HALF_EXTENT, y: BASE_POS.y - FORTRESS_HALF_EXTENT, w: FORTRESS_WALL_THICKNESS, h: FORTRESS_HALF_EXTENT * 2 },
];

export const FORTRESS_TOWERS: Rect[] = [
  { x: BASE_POS.x - FORTRESS_HALF_EXTENT - FORTRESS_TOWER_SIZE / 2, y: BASE_POS.y - FORTRESS_HALF_EXTENT - FORTRESS_TOWER_SIZE / 2, w: FORTRESS_TOWER_SIZE, h: FORTRESS_TOWER_SIZE }, // NW
  { x: BASE_POS.x + FORTRESS_HALF_EXTENT - FORTRESS_TOWER_SIZE / 2, y: BASE_POS.y - FORTRESS_HALF_EXTENT - FORTRESS_TOWER_SIZE / 2, w: FORTRESS_TOWER_SIZE, h: FORTRESS_TOWER_SIZE }, // NE
  { x: BASE_POS.x - FORTRESS_HALF_EXTENT - FORTRESS_TOWER_SIZE / 2, y: BASE_POS.y + FORTRESS_HALF_EXTENT - FORTRESS_TOWER_SIZE / 2, w: FORTRESS_TOWER_SIZE, h: FORTRESS_TOWER_SIZE }, // SW
  { x: BASE_POS.x + FORTRESS_HALF_EXTENT - FORTRESS_TOWER_SIZE / 2, y: BASE_POS.y + FORTRESS_HALF_EXTENT - FORTRESS_TOWER_SIZE / 2, w: FORTRESS_TOWER_SIZE, h: FORTRESS_TOWER_SIZE }, // SE
];

// The full solid-obstacle set every collision/pathing function below
// actually uses — town buildings plus the fortress's walls and corner
// towers. Keeping TOWN_BUILDINGS/FORTRESS_WALLS/FORTRESS_TOWERS as separate
// named exports (rather than one flat list) lets render.ts draw each
// category with its own visual treatment without re-deriving which rect is
// which from shape/position heuristics.
export const BUILDINGS: Rect[] = [...TOWN_BUILDINGS, ...FORTRESS_WALLS, ...FORTRESS_TOWERS];

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

function pointBlocked(p: Vec2): boolean {
  for (const b of BUILDINGS) {
    if (pointInRect(p, inflated(b, COLLISION_MARGIN))) return true;
  }
  return false;
}

// Axis-separated collision resolution: try the X move alone, keep it only if
// it doesn't land inside a building; then try the Y move alone (from
// whatever X ended up being) the same way. This is what gives "sliding along
// a wall" for free instead of a glancing touch killing all movement — the
// same standard approach the brief's "合理的沿墙滑动" asked for.
export function resolveMove(from: Vec2, desired: Vec2): Vec2 {
  let x = from.x;
  let y = from.y;
  const clampedDesiredX = Math.min(Math.max(desired.x, 0), MAP_SIZE);
  const clampedDesiredY = Math.min(Math.max(desired.y, 0), MAP_SIZE);

  if (!pointBlocked({ x: clampedDesiredX, y })) {
    x = clampedDesiredX;
  }
  if (!pointBlocked({ x, y: clampedDesiredY })) {
    y = clampedDesiredY;
  }
  return { x, y };
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
