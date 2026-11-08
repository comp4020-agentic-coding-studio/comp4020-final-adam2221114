// Wall visual rendering (2026-11-08 replacement) — draws the user-supplied
// AI-generated panel image for the current wallLevel directly with
// drawImage, instead of the earlier hand-built procedural Canvas art this
// file used to contain. Per the user's explicit instruction: display the
// exact provided PNG images, do not redraw/reinterpret/procedurally
// recreate them. See sprites/wall-ai-gen/NOTES.md for the five images' own
// provenance/licensing and sprites.ts's wallLevelImage() for how they're
// loaded.
//
// wallRectsForPlayers' actual rectangles (obstacles.ts), and every bit of
// HP/level/ability/upgrade/repair resolution (game-state.ts/game-loop.ts,
// server-authoritative), are completely untouched by anything in this
// file — this module only decides what gets drawn, never where a player or
// zombie can walk or how much damage anything takes.
import { cameraScale, worldToScreen, type Camera } from "./camera.ts";
import type { Rect } from "./obstacles.ts";
import { isReady, wallLevelImage } from "./sprites.ts";

// How far above its own real collision footprint the wall's drawn image
// rises, anchored at the footprint's bottom/south edge (the actual ground
// line) — each level is taller than the last so an upgrade still reads as a
// bigger structure, not just a different picture at the same size. Carried
// over from the previous procedural renderer's own per-level progression.
const FACE_HEIGHT_BY_LEVEL: Record<number, number> = {
  1: 30,
  2: 38,
  3: 46,
  4: 52,
  5: 58,
};

// Ground-contact shadow at the segment's REAL footprint edge (not the
// drawn image's taller top) — same soft dark convention every other shadow
// in this project already uses (renderBuildingShadows/renderProps' own
// comments), so the structure reads as standing on the ground rather than
// floating in front of it.
function drawGroundShadow(ctx: CanvasRenderingContext2D, screenX: number, screenY: number, screenW: number): void {
  const grad = ctx.createLinearGradient(0, 0, 0, 7);
  grad.addColorStop(0, "rgba(8, 8, 6, 0.4)");
  grad.addColorStop(1, "rgba(8, 8, 6, 0)");
  ctx.save();
  ctx.translate(screenX, screenY);
  ctx.fillStyle = grad;
  ctx.fillRect(-3, 0, screenW + 6, 7);
  ctx.restore();
}

// Draws one level's image tiled end-to-end along a LOCAL "length" axis
// (0..totalLength), each tile exactly `thickness` tall in the cross axis
// and `thickness * aspect` wide — i.e. every tile keeps the source image's
// own width:height ratio undistorted, repeating as many times as needed to
// cover the segment's real length instead of stretching one copy to fit
// (which would squash/stretch the art out of proportion on a long wall
// run). `yTop` lets the vertical (rotated) caller offset the draw rect to
// the negative side of the rotated axis — see renderWallImageLevel.
function drawTiledPanel(ctx: CanvasRenderingContext2D, img: HTMLImageElement, totalLength: number, thickness: number, yTop: number): void {
  const aspect = img.naturalWidth / img.naturalHeight;
  const tileLen = Math.max(1, thickness * aspect);
  const tileCount = Math.max(1, Math.ceil(totalLength / tileLen));
  for (let i = 0; i < tileCount; i++) {
    const x = i * tileLen;
    const w = Math.min(tileLen, totalLength - x);
    if (w <= 0) continue;
    // Draw the FULL source image into a (tileLen x thickness) box, then
    // clip to the remaining length for the last (possibly partial) tile —
    // cropping which part of the image shows rather than squashing it.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, yTop, w, thickness);
    ctx.clip();
    ctx.drawImage(img, x, yTop, tileLen, thickness);
    ctx.restore();
  }
}

// Renders one straight wall side segment (any of wallRectsForPlayers' 5
// rects) using the current level's supplied image. Returns false (drawing
// nothing but the caller's own fallback) if that level's image hasn't
// finished loading yet.
export function renderWallImageLevel(ctx: CanvasRenderingContext2D, camera: Camera, rect: Rect, level: number): boolean {
  const img = wallLevelImage(level);
  if (!isReady(img)) return false;

  const faceHeight = FACE_HEIGHT_BY_LEVEL[level] ?? FACE_HEIGHT_BY_LEVEL[1];
  const scale = cameraScale(camera);
  const vertical = rect.h > rect.w;

  const groundScreen = worldToScreen(camera, rect.x, rect.y + rect.h);
  const faceScreen = worldToScreen(camera, rect.x, rect.y - faceHeight);
  const boxW = rect.w * scale;
  const boxH = (rect.h + faceHeight) * scale;

  drawGroundShadow(ctx, groundScreen.x, groundScreen.y, boxW);

  ctx.save();
  ctx.imageSmoothingEnabled = false; // nearest-neighbour: keep the pixel art crisp, never blurry
  ctx.translate(faceScreen.x, faceScreen.y);
  if (vertical) {
    // East/west run: only one horizontal-facing panel image exists per
    // level, so it's rotated 90° to run along the wall's own (vertical)
    // length instead of stretching the wide image sideways into a thin
    // strip. Rotating the canvas 90° clockwise and drawing at a NEGATIVE
    // y (from -boxW to 0) lands the image back inside the segment's own
    // screen-space box [0,boxW] x [0,boxH] — see the derivation in this
    // function's own git history/PROCESS.md entry if this ever needs
    // re-deriving: a plain ctx.rotate(Math.PI/2) maps local (x, y) to
    // screen-relative (-y, x), so local x sweeps the box's HEIGHT (0..boxH)
    // and local -y (i.e. y in [-boxW, 0]) sweeps its WIDTH (0..boxW).
    ctx.rotate(Math.PI / 2);
    drawTiledPanel(ctx, img, boxH, boxW, -boxW);
  } else {
    drawTiledPanel(ctx, img, boxW, boxH, 0);
  }
  ctx.restore();

  return true;
}
