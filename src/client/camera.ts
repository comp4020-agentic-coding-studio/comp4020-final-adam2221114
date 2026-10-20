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
  // World units visible across the (square) canvas — the "zoom": smaller
  // means more zoomed in (bigger on-screen characters), larger means more
  // of the map visible at once.
  viewSize: number;
  // Canvas size in CSS pixels (the canvas is always square here).
  canvasSize: number;
}

// How many world units are visible across the canvas. Characters draw in
// world units (e.g. PLAYER_DRAW_SIZE=34 — see render.ts), so a smaller
// viewSize means a larger on-screen character for the same canvasSize. The
// old whole-map view was effectively viewSize=1000 on an 800px canvas; 420
// roughly doubles apparent character size at that same canvas size, and
// more again once the canvas itself grows past 800px (index.html's
// responsive resize).
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
export function computeCamera(followX: number, followY: number, canvasSize: number, viewSize: number = DEFAULT_VIEW_SIZE): Camera {
  const half = viewSize / 2;
  // If viewSize ever exceeds WORLD_SIZE the clamp range would invert (min >
  // max); guard by capping the half-extent so the camera just centres on
  // the map instead of producing nonsense bounds.
  const clampedHalf = Math.min(half, WORLD_SIZE / 2);
  const centerX = clamp(followX, clampedHalf, WORLD_SIZE - clampedHalf);
  const centerY = clamp(followY, clampedHalf, WORLD_SIZE - clampedHalf);
  return { originX: centerX - viewSize / 2, originY: centerY - viewSize / 2, viewSize, canvasSize };
}

// Pixels per world unit — used for SIZES (draw dimensions, line widths,
// radii) that need uniform scaling only, not the camera's pan offset.
export function cameraScale(camera: Camera): number {
  return camera.canvasSize / camera.viewSize;
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
