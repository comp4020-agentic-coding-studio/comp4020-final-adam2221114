// Camera: a client-only viewport transform — follows the local player and
// shows a zoomed-in window of the world instead of squeezing the whole
// 1000x1000 map onto one canvas (which made every character draw at ~27px
// on the old fixed 800x800/whole-map view — the "characters too small to
// read" problem). NEVER authoritative: this only changes what's drawn and
// how input.ts/main.ts translate a mouse position back to world
// coordinates — every gameplay number (speed, ranges, positions) is exactly
// what the server already sends, untouched by this file.
import { WORLD_SIZE } from "./defense-config.ts";

export interface Camera {
  // World-space top-left corner of the visible viewport — already clamped
  // so the view never shows past the map edge. NOT the same as the follow
  // target's own position (that's the viewport's centre, not its corner).
  originX: number;
  originY: number;
  // World units visible across the canvas's WIDTH/HEIGHT respectively — the
  // canvas fills the whole (possibly non-square) browser window now, so a
  // wide window shows MORE world side-to-side at the same zoom, rather than
  // stretching a square view to fit. viewWidth/viewHeight are always in the
  // same ratio as canvasWidth/canvasHeight (see computeCamera), which is
  // exactly what keeps cameraScale() a single valid scalar for both axes.
  viewWidth: number;
  viewHeight: number;
  // Canvas size in CSS pixels — independently sized now, not forced square.
  canvasWidth: number;
  canvasHeight: number;
}

// How many world units are visible across the canvas's SHORTER axis — the
// "zoom": smaller means more zoomed in (bigger on-screen characters), larger
// means more of the map visible at once. computeCamera derives the LONGER
// axis's view size from the canvas's own aspect ratio, so this one number
// keeps meaning the same thing (and the zoom-wheel UX in main.ts stays
// unchanged) regardless of window shape. Characters draw in world units
// (e.g. PLAYER_DRAW_SIZE=34 — see render.ts), so a smaller viewSize means a
// larger on-screen character for the same canvas size.
export const DEFAULT_VIEW_SIZE = 420;

// Mouse-wheel zoom range (main.ts owns the actual wheel listener and the
// per-tab target/current viewSize state — this file just defines the
// legal range so every clamp agrees on the same numbers). MIN keeps a
// player from zooming in so far that the readable play area shrinks to
// nothing; MAX is exactly WORLD_SIZE, i.e. "zoomed out as far as the whole
// map" — computeCamera's own clampedHalf already caps the effective view at
// WORLD_SIZE even if a caller ignored this, so the two can never disagree
// and the camera can never show space outside the map.
export const MIN_VIEW_SIZE = 180;
export const MAX_VIEW_SIZE = WORLD_SIZE;

export function clampViewSize(viewSize: number): number {
  return clamp(viewSize, MIN_VIEW_SIZE, MAX_VIEW_SIZE);
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

// Builds a camera centred on `followX/Y` (the local player's current
// predicted/displayed position), clamped so the viewport never shows past
// the map edge — a standard camera clamp, not a gameplay rule; it has no
// effect on where a player can actually move (obstacles.ts/game-state.ts
// own that entirely).
//
// viewSize is "world units visible across the SHORTER canvas axis" — the
// longer axis's view size is derived from the canvas's own aspect ratio
// (fit-to-shorter-axis, extend-the-longer-one), so a wide window sees MORE
// world horizontally at the same zoom instead of a stretched image.
export function computeCamera(followX: number, followY: number, canvasWidth: number, canvasHeight: number, viewSize: number = DEFAULT_VIEW_SIZE): Camera {
  const aspect = canvasWidth / canvasHeight;

  // Bug fixed here: this used to only clamp the CENTER so it couldn't pan
  // past the map edge, without ever shrinking viewWidth/viewHeight
  // themselves. On a wide window zoomed far out, viewWidth (= viewSize *
  // aspect) could exceed WORLD_SIZE even though the center was still
  // clamped "correctly" — the view then genuinely extended past the map on
  // both sides. render()'s terrain blit samples the baked map using exactly
  // this origin/viewWidth/viewHeight; once the sampled rect ran outside the
  // baked canvas's own bounds, drawImage silently skips painting the
  // out-of-bounds destination columns (per spec, a source rect clipped to
  // the source image also clips the destination by the same amount) — nothing
  // redraws those edge columns, so whatever was drawn there last frame (e.g.
  // a full-canvas red damage-flash fill) stayed stuck there indefinitely,
  // visible as a persistent red band down the sides that only scrolling/
  // resizing back into bounds would clear.
  //
  // Fix: clamp viewSize itself, before deriving width/height, to whatever
  // the canvas's aspect ratio can actually support without either axis
  // exceeding WORLD_SIZE. On an aspect ratio far from square this means you
  // can't zoom out quite as far as MAX_VIEW_SIZE on an ultra-wide window —
  // a real, necessary limit at that aspect ratio (there isn't that much map
  // to show on the long axis), not a bug.
  const maxViewSizeForAspect = WORLD_SIZE * Math.min(1 / aspect, aspect);
  const effectiveViewSize = Math.min(viewSize, maxViewSizeForAspect);

  const viewWidth = aspect >= 1 ? effectiveViewSize * aspect : effectiveViewSize;
  const viewHeight = aspect >= 1 ? effectiveViewSize : effectiveViewSize / aspect;

  // viewWidth/viewHeight can now never exceed WORLD_SIZE on their own axis
  // (by construction above), so half <= WORLD_SIZE/2 always holds and this
  // clamp range can never invert.
  const halfX = viewWidth / 2;
  const halfY = viewHeight / 2;
  const centerX = clamp(followX, halfX, WORLD_SIZE - halfX);
  const centerY = clamp(followY, halfY, WORLD_SIZE - halfY);
  return {
    originX: centerX - halfX,
    originY: centerY - halfY,
    viewWidth,
    viewHeight,
    canvasWidth,
    canvasHeight,
  };
}

// Pixels per world unit — used for SIZES (draw dimensions, line widths,
// radii) that need uniform scaling only, not the camera's pan offset.
// Correct as a SINGLE scalar for both axes by construction: viewWidth/
// canvasWidth and viewHeight/canvasHeight are always equal (both derive from
// the same viewSize and the same canvas aspect ratio — see computeCamera).
export function cameraScale(camera: Camera): number {
  return camera.canvasWidth / camera.viewWidth;
}

// World -> screen (canvas pixel) coordinates for a POSITION — applies both
// the camera's pan offset and its zoom scale. Every drawn world position
// must go through this (or the equivalent inline math) now that the canvas
// no longer shows the whole map at a fixed 1:1-from-origin scale.
export function worldToScreen(camera: Camera, x: number, y: number): { x: number; y: number } {
  const scale = cameraScale(camera);
  return { x: (x - camera.originX) * scale, y: (y - camera.originY) * scale };
}

// Screen (canvas pixel) -> world coordinates — the inverse of
// worldToScreen, used by input.ts's mouse tracking and main.ts's turret-
// placement preview so aiming/placement never desyncs from what's actually
// drawn.
export function screenToWorld(camera: Camera, sx: number, sy: number): { x: number; y: number } {
  const scale = cameraScale(camera);
  return { x: sx / scale + camera.originX, y: sy / scale + camera.originY };
}
