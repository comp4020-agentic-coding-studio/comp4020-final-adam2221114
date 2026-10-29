// Screen-relative WASD for the 3D client only (feature/3d-migration).
//
// The 2D client's camera has no rotation, so raw W/A/S/D (as read by
// input.ts and sent as the wire protocol's {up,down,left,right}) already
// points the way it looks on screen. The 3D client's camera sits at a
// FIXED 45°-azimuth isometric angle (scene.ts's CAMERA_AZIMUTH), so world
// "up" (-y) is not screen-up — it's the upper-right of the screen. This
// remaps "the player's screen-relative intent" onto the SAME
// {up,down,left,right} wire shape the server's movePlayer already expects,
// so no wire-protocol or server change is needed (see CLAUDE.md's 3D
// migration rules: movePlayer's semantics must not change).
//
// Because the azimuth is fixed (not player-rotatable), this is a static
// remap, not a per-frame camera-relative calculation — computed once from
// scene.ts's own CAMERA_AZIMUTH constant so it can never drift out of sync
// with the camera that's actually rendered.
import type { MoveState } from "../input.ts";
import { CAMERA_AZIMUTH } from "./scene.ts";

const azRad = (CAMERA_AZIMUTH * Math.PI) / 180;
const sinAz = Math.sin(azRad);
const cosAz = Math.cos(azRad);

// Below this, treat a rotated axis component as exactly zero rather than a
// sign-flipping sliver of float noise — avoids both flags on an axis ever
// being set (or neither, when one key's rotated contribution should
// dominate) from rounding alone.
const EPSILON = 1e-6;

// Converts raw, as-physically-held W/A/S/D/arrow state into the
// {up,down,left,right} combination that moves the character the direction
// those keys visually point on screen, by rotating the raw screen-space
// intent vector by the camera's fixed azimuth and re-deriving which wire
// flags produce that same world-space direction out of movePlayer's own
// dx/dy-from-flags math (game-state.ts's movePlayer, duplicated for
// prediction in prediction.ts) — this composes correctly for diagonals too,
// since movePlayer's dx/dy are themselves a sum of each flag's ±1
// contribution.
export function remapIsometricMove(raw: MoveState): MoveState {
  let screenDx = 0;
  let screenDy = 0;
  if (raw.left) screenDx -= 1;
  if (raw.right) screenDx += 1;
  if (raw.up) screenDy -= 1;
  if (raw.down) screenDy += 1;
  if (screenDx === 0 && screenDy === 0) return { up: false, down: false, left: false, right: false };

  const worldX = screenDx * sinAz + screenDy * cosAz;
  const worldY = screenDy * sinAz - screenDx * cosAz;

  return {
    left: worldX < -EPSILON,
    right: worldX > EPSILON,
    up: worldY < -EPSILON,
    down: worldY > EPSILON,
  };
}
