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

// Mirrors src/server/obstacles.ts's wall geometry exactly — see that file's
// own comment for the full rationale (half-extent/thickness/gate-width, and
// why the wall is live state derived from wallLevel rather than a fixed
// always-on fortress, with no corner towers). Exported so render.ts can
// anchor the Wall status overlay (level/HP/ability indicators) and the
// courtyard floor decoration to the same rectangle instead of a separate
// invented shape.
export const WALL_HALF_EXTENT = 116;
const WALL_THICKNESS = 16;
// Exported so render.ts can draw the same gate gap into the HP/level
// overlay's perimeter stroke instead of re-deriving or duplicating it.
export const WALL_GATE_WIDTH = 90;

// Half-extent of the open interior the wall encloses (inner wall face
// distance from BASE_POS) — exported so render.ts can size the courtyard
// floor decoration to match without re-deriving or duplicating the two
// constants above.
export const WALL_INTERIOR_HALF_EXTENT = WALL_HALF_EXTENT - WALL_THICKNESS;

// Empty array while wallLevel is 0 — no wall exists (and nothing renders or
// collides) until it's built. Only the player-facing GATED shape lives on
// the client: zombies aren't predicted client-side, so the client never
// needs the zombie-facing solid-on-all-sides shape the server's
// wallRectsForZombies produces.
export function wallRectsForPlayers(wallLevel: number): Rect[] {
  if (wallLevel <= 0) return [];
  return [
    { x: BASE_POS.x - WALL_HALF_EXTENT, y: BASE_POS.y - WALL_HALF_EXTENT, w: WALL_HALF_EXTENT * 2, h: WALL_THICKNESS },
    {
      x: BASE_POS.x - WALL_HALF_EXTENT,
      y: BASE_POS.y + WALL_HALF_EXTENT - WALL_THICKNESS,
      w: WALL_HALF_EXTENT - WALL_GATE_WIDTH / 2,
      h: WALL_THICKNESS,
    },
    {
      x: BASE_POS.x + WALL_GATE_WIDTH / 2,
      y: BASE_POS.y + WALL_HALF_EXTENT - WALL_THICKNESS,
      w: WALL_HALF_EXTENT - WALL_GATE_WIDTH / 2,
      h: WALL_THICKNESS,
    },
    { x: BASE_POS.x + WALL_HALF_EXTENT - WALL_THICKNESS, y: BASE_POS.y - WALL_HALF_EXTENT, w: WALL_THICKNESS, h: WALL_HALF_EXTENT * 2 },
    { x: BASE_POS.x - WALL_HALF_EXTENT, y: BASE_POS.y - WALL_HALF_EXTENT, w: WALL_THICKNESS, h: WALL_HALF_EXTENT * 2 },
  ];
}

// Town buildings are the only fixed, always-on solid obstacles now — the
// wall is live state, handled separately above (see wallRectsForPlayers).
export const BUILDINGS: Rect[] = [...TOWN_BUILDINGS];

const COLLISION_MARGIN = 10;

function inflated(r: Rect, margin: number): Rect {
  return { x: r.x - margin, y: r.y - margin, w: r.w + margin * 2, h: r.h + margin * 2 };
}

export function pointInRect(p: Vec2, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

const NO_EXTRA_RECTS: readonly Rect[] = [];

export function overlapsAnyBuilding(p: Vec2, extraRects: readonly Rect[] = NO_EXTRA_RECTS): boolean {
  for (const b of BUILDINGS) {
    if (pointInRect(p, inflated(b, COLLISION_MARGIN))) return true;
  }
  for (const b of extraRects) {
    if (pointInRect(p, inflated(b, COLLISION_MARGIN))) return true;
  }
  return false;
}

// Same axis-separated resolution as the server's resolveMove — see its own
// comment for why (wall-sliding for free). extraRects lets prediction.ts
// fold in the live wall rects (wallRectsForPlayers) without them being part
// of the fixed BUILDINGS constant.
export function resolveMove(from: Vec2, desired: Vec2, extraRects: readonly Rect[] = NO_EXTRA_RECTS): Vec2 {
  let x = from.x;
  let y = from.y;
  const clampedDesiredX = Math.min(Math.max(desired.x, 0), WORLD_SIZE);
  const clampedDesiredY = Math.min(Math.max(desired.y, 0), WORLD_SIZE);

  if (!overlapsAnyBuilding({ x: clampedDesiredX, y }, extraRects)) {
    x = clampedDesiredX;
  }
  if (!overlapsAnyBuilding({ x, y: clampedDesiredY }, extraRects)) {
    y = clampedDesiredY;
  }
  return { x, y };
}
