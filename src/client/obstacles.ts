// Mirrors src/server/obstacles.ts's BUILDINGS/resolveMove exactly — same
// build-separation reason defense-config.ts/protocol.ts duplicate constants
// instead of importing across the client/server build boundary (disjoint
// tsconfig rootDirs). Used here only for rendering and for local movement
// prediction/turret-placement preview; the server's copy is what's actually
// authoritative. If the two ever drift apart, prediction stops matching the
// server and reconciliation corrections stop being rare — same risk this
// project already accepts for PLAYER_SPEED/MAP_SIZE in prediction.ts.
import type { Vec2 } from "./defense-config.ts";
import { BASE_POS, WORLD_SIZE } from "./defense-config.ts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const TOWN_BUILDINGS: Rect[] = [
  { x: 663, y: 255, w: 110, h: 70 },
  { x: 523, y: 132, w: 70, h: 100 },
  { x: 615, y: 154, w: 80, h: 60 },
  { x: 744, y: 638, w: 90, h: 75 },
  { x: 751, y: 734, w: 140, h: 60 },
  { x: 854, y: 613, w: 65, h: 95 },
  { x: 142, y: 720, w: 100, h: 80 },
  { x: 369, y: 798, w: 75, h: 95 },
  { x: 271, y: 662, w: 70, h: 65 },
  { x: 220, y: 185, w: 95, h: 70 },
  { x: 121, y: 292, w: 70, h: 95 },
  { x: 232, y: 282, w: 80, h: 60 },
];

// Mirrors src/server/obstacles.ts's FORTRESS_WALLS/FORTRESS_TOWERS exactly
// — see that file's own comment for the geometry rationale (half-extent,
// wall thickness, gate gap, corner-tower placement). Kept as separate named
// exports (not merged into one flat list) so render.ts can draw walls,
// towers, and town buildings with distinct visual treatments.
// Exported (unlike WALL_THICKNESS/GATE_WIDTH below) so render.ts can anchor
// the player-facing Wall status overlay (level/HP/ability indicators) to
// this same rectangle instead of a separate invented shape.
export const FORTRESS_HALF_EXTENT = 116;
const FORTRESS_WALL_THICKNESS = 16;
const FORTRESS_GATE_WIDTH = 90;
const FORTRESS_TOWER_SIZE = 40;

export const FORTRESS_WALLS: Rect[] = [
  { x: BASE_POS.x - FORTRESS_HALF_EXTENT, y: BASE_POS.y - FORTRESS_HALF_EXTENT, w: FORTRESS_HALF_EXTENT * 2, h: FORTRESS_WALL_THICKNESS },
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
  { x: BASE_POS.x + FORTRESS_HALF_EXTENT - FORTRESS_WALL_THICKNESS, y: BASE_POS.y - FORTRESS_HALF_EXTENT, w: FORTRESS_WALL_THICKNESS, h: FORTRESS_HALF_EXTENT * 2 },
  { x: BASE_POS.x - FORTRESS_HALF_EXTENT, y: BASE_POS.y - FORTRESS_HALF_EXTENT, w: FORTRESS_WALL_THICKNESS, h: FORTRESS_HALF_EXTENT * 2 },
];

// Half-extent of the open interior the walls enclose (inner wall face
// distance from BASE_POS) — exported so render.ts can size the courtyard
// floor decoration to match without re-deriving or duplicating the two
// constants above.
export const FORTRESS_INTERIOR_HALF_EXTENT = FORTRESS_HALF_EXTENT - FORTRESS_WALL_THICKNESS;

export const FORTRESS_TOWERS: Rect[] = [
  { x: BASE_POS.x - FORTRESS_HALF_EXTENT - FORTRESS_TOWER_SIZE / 2, y: BASE_POS.y - FORTRESS_HALF_EXTENT - FORTRESS_TOWER_SIZE / 2, w: FORTRESS_TOWER_SIZE, h: FORTRESS_TOWER_SIZE },
  { x: BASE_POS.x + FORTRESS_HALF_EXTENT - FORTRESS_TOWER_SIZE / 2, y: BASE_POS.y - FORTRESS_HALF_EXTENT - FORTRESS_TOWER_SIZE / 2, w: FORTRESS_TOWER_SIZE, h: FORTRESS_TOWER_SIZE },
  { x: BASE_POS.x - FORTRESS_HALF_EXTENT - FORTRESS_TOWER_SIZE / 2, y: BASE_POS.y + FORTRESS_HALF_EXTENT - FORTRESS_TOWER_SIZE / 2, w: FORTRESS_TOWER_SIZE, h: FORTRESS_TOWER_SIZE },
  { x: BASE_POS.x + FORTRESS_HALF_EXTENT - FORTRESS_TOWER_SIZE / 2, y: BASE_POS.y + FORTRESS_HALF_EXTENT - FORTRESS_TOWER_SIZE / 2, w: FORTRESS_TOWER_SIZE, h: FORTRESS_TOWER_SIZE },
];

export const BUILDINGS: Rect[] = [...TOWN_BUILDINGS, ...FORTRESS_WALLS, ...FORTRESS_TOWERS];

const COLLISION_MARGIN = 10;

function inflated(r: Rect, margin: number): Rect {
  return { x: r.x - margin, y: r.y - margin, w: r.w + margin * 2, h: r.h + margin * 2 };
}

export function pointInRect(p: Vec2, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function overlapsAnyBuilding(p: Vec2): boolean {
  for (const b of BUILDINGS) {
    if (pointInRect(p, inflated(b, COLLISION_MARGIN))) return true;
  }
  return false;
}

// Same axis-separated resolution as the server's resolveMove — see its own
// comment for why (wall-sliding for free).
export function resolveMove(from: Vec2, desired: Vec2): Vec2 {
  let x = from.x;
  let y = from.y;
  const clampedDesiredX = Math.min(Math.max(desired.x, 0), WORLD_SIZE);
  const clampedDesiredY = Math.min(Math.max(desired.y, 0), WORLD_SIZE);

  if (!overlapsAnyBuilding({ x: clampedDesiredX, y })) {
    x = clampedDesiredX;
  }
  if (!overlapsAnyBuilding({ x, y: clampedDesiredY })) {
    y = clampedDesiredY;
  }
  return { x, y };
}
