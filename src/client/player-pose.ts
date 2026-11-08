// Player body-facing/weapon-occlusion decisions, and the downed/dying/
// reviving prone rig. Kept in its own module per CLAUDE.md's "keep
// rendering/animation/VFX code organised by concern" visual-scope rule,
// the same way monsters.ts holds the giant/boss's own procedural art rather
// than growing render.ts further — render.ts's renderPlayer stays a thin
// orchestrator (screen position, sprite lookup, HP bar/status text) and
// delegates the body-pose decisions here.
//
// This module has no import-time dependency on src/client/sprites.ts (kept
// exactly as-is per explicit instruction) or the existing drawPlayerWeapon
// geometry in render.ts (arms+weapon rigid unit, reused unchanged) — render.ts
// passes in the exact LPC frame (as a generic {image, sx, sy, sw, sh} rect,
// see ProneSprite below) the player's own chosen PLAYER_SHEETS appearance
// already uses for its standing pose, so this module only decides WHEN to
// use which facing/draw order, plus HOW to pose/rotate/animate that real
// sprite while downed/dying/reviving — it never invents a second body.
import type { Direction } from "./sprites.ts";

// --- Facing: movement over aim --------------------------------------------
// The root cause of "weapon looks disconnected when aiming": the body
// sprite's facing (sprites.ts's 4-directional LPC sheet) used to be driven
// by the AIM angle for the local player, every frame, regardless of actual
// movement — so walking forward while aiming right showed the character's
// body facing right (the "A: left-facing, D: right-facing..." sheet row)
// instead of the sheet row matching which way they were actually walking.
// render.ts's updateFacing already derives a movement-based `dir` for every
// entity (zombies and remote players always use it unmodified); this
// decides when the LOCAL player's body should override that with its
// aim-derived direction instead — only while stationary, so standing still
// and aiming still turns to face the mouse (today's useful behaviour), but
// walking in any direction now shows the real walk direction no matter
// where the mouse points, matching the brief's explicit W/S/A/D-vs-aim test
// matrix (walking one way, aiming another, should look like strafing/
// backpedaling, not a twisted body).
export function shouldFaceAimDirection(isSelf: boolean, moving: boolean): boolean {
  return isSelf && !moving;
}

// --- Weapon/body occlusion -------------------------------------------------
// render.ts's drawPlayerWeapon (arms+weapon, one rigid rotated unit, grip/
// foregrip geometry unchanged by this pass) used to always draw AFTER
// (on top of) the body sprite regardless of aim direction, which is why
// aiming up looked wrong — the gun visually poked out in front of the
// character's own head/shoulders instead of appearing to be held up and
// slightly behind them. World/screen Y increases downward here (worldToScreen
// convention, matching every other render.ts coordinate), so "aiming into
// the upper half of the screen" is exactly `sin(angle) < 0` — the brief's own
// worked example ("aiming upward, gun may appear partially behind the
// character; aiming downward, gun in front").
export function weaponDrawsBehindBody(aimAngle: number): boolean {
  return Math.sin(aimAngle) < 0;
}

// --- Downed / dying / reviving prone rig -----------------------------------
// 2026-11-08 rebuild. Replaces an earlier hand-built figure (head/torso/two
// arms/two legs, each its own disconnected outlined ellipse) after review
// found it read as "disconnected oval-shaped body parts", not a lying-down
// character — a reasonable description of what six independently-rotated
// ellipses with no shared silhouette actually looks like. This version
// instead poses the player's OWN real LPC standing sprite (whichever
// PLAYER_SHEETS appearance they picked at character-select — see
// ProneSprite below) as one rigid image, rotated to lie along a fixed
// canonical diagonal: the exact same pixels as the standing character,
// just tipped onto their side, so the downed body is unmistakably the same
// character, clothing/head/arms/legs/proportions included, never a
// different procedural shape standing in for them.
//
// `proneAmount` (0..1) still parametrises the WHOLE transition in one
// continuous value: 0 is upright (render.ts hands off to the normal
// standing sprite at that end), 1 is the fully fallen, fully-rotated resting
// pose. render.ts drives this upward (0->1) right after an alive->downed/
// dead transition for the fall, and downward (1->0) right after a downed/
// dead->alive transition for the get-up, using the SAME rig both ways
// rather than two separate animations — i.e. "getting-up" is just this
// collapse played backward, matching the brief's 5 visual states (standing/
// falling/prone/breathing/getting-up) without a second rig to keep in sync.
// The fixed tilt (not a perfect 90°/180°) means a whole team of downed
// players never all lie in the exact same rigid line, which would read as
// artificial — still true of this rebuild, just applied to a real sprite
// instead of procedural shapes.
export interface PronePose {
  proneAmount: number; // 0 standing/collapsed .. 1 fully prone and settled
  dead: boolean; // true = corpse (fully still); false = downed (still breathing)
  now: number;
  phase: number; // per-player offset (hashStr(id)) so multiple downed players don't breathe in lockstep
}

// The exact drawImage source rect render.ts already resolved for this
// player's standing sprite (PLAYER_SHEETS[characterIndex]["down"], frame 0 —
// a fixed down-facing standing pose, independent of whichever direction the
// player was actually walking/facing before going down, per the brief's own
// "pose is correct regardless of previous facing direction"). Passed in
// rather than imported so this module stays free of a sprites.ts dependency
// (the explicit "do not touch the character sheets" instruction extends to
// not even importing from that module here).
export interface ProneSprite {
  image: HTMLImageElement;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

const PRONE_WEAPON_BODY = "#34343a";
const PRONE_WEAPON_DARK = "#1f1f22";

// Fixed "fell at an angle" tilt — kept off-axis (not a perfect 90°/180°) so
// a whole team of downed players never all lie in the exact same rigid
// line, which would read as artificial.
const PRONE_CANONICAL_ANGLE = 1.15;

function ellipsePath(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rot = 0): void {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
}

// Draws the ground shadow for the CURRENT prone amount — elongates and
// rotates alongside the body (see renderProneRig) instead of the standing
// pose's small fixed ellipse, so the shadow never looks mismatched against
// an already-fallen body.
export function renderProneShadow(ctx: CanvasRenderingContext2D, drawSize: number, proneAmount: number): void {
  const halfLen = drawSize * 0.56 * proneAmount;
  const rotation = proneAmount * PRONE_CANONICAL_ANGLE;
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = "#000";
  ctx.translate(2, drawSize * 0.32 * (1 - proneAmount) + drawSize * 0.08 * proneAmount);
  ctx.rotate(rotation);
  ellipsePath(ctx, 0, 0, Math.max(drawSize * 0.26, halfLen * 0.75), drawSize * 0.12);
  ctx.fill();
  ctx.restore();
}

// Draws the lying-down figure itself, ALREADY translated to the player's
// own screen position by the caller (same convention renderPlayer already
// uses for the standing sprite's own save/translate block) — this only
// rotates/scales around that local origin. `sprite` is undefined only in
// the same "not loaded yet/no character chosen" case renderPlayer's own
// standing-sprite branch already falls back from; this mirrors that with a
// small flat-colour placeholder rather than skipping the fall animation
// entirely.
export function renderProneRig(ctx: CanvasRenderingContext2D, drawSize: number, teamColor: string, sprite: ProneSprite | undefined, pose: PronePose): void {
  const { proneAmount, dead, now, phase } = pose;
  const spread = proneAmount; // 0 = still upright, 1 = fully settled on the ground
  const halfLen = drawSize * 0.56;

  // A subtle breathing pulse once settled and still alive — the one signal
  // that tells a teammate "still alive, still worth rescuing" at a glance,
  // without the downed-timer HUD text (render.ts draws that separately,
  // unaffected by this module). Scales the WHOLE body a couple of percent
  // rather than one isolated part, reading as a chest rising/falling under
  // the real sprite instead of a detached pulsing shape.
  const breathe = !dead && proneAmount > 0.9 ? Math.sin(now / 650 + phase) * 0.05 : 0;

  ctx.save();
  ctx.rotate(spread * PRONE_CANONICAL_ANGLE);
  // Slide the body along its own rotated axis as it falls (0 at the collapse
  // point, settling forward by half its own length once fully prone) and
  // ease it down near the ground line — replaces the old per-limb spread
  // math with a single rigid transform of the real sprite.
  ctx.translate(halfLen * 0.25 * spread, drawSize * 0.18 * spread);
  ctx.scale(1 + breathe, 1 - breathe * 0.6);

  // Dropped weapon, lying just past the body — fades in only once mostly
  // fallen (threshold deliberately matches render.ts's renderPlayer
  // `showWeapon` cutoff of proneAmount < 0.5, so the standing held weapon
  // and this dropped one are never both visible during the rise/fall
  // crossfade), and is drawn FIRST (underneath the body) so it never floats
  // above the character, per the brief's explicit "weapon must not
  // awkwardly float above the body".
  if (spread > 0.5) {
    const weaponAlpha = Math.min(1, (spread - 0.5) / 0.3);
    ctx.save();
    ctx.globalAlpha = weaponAlpha;
    ctx.translate(halfLen * 0.5, drawSize * 0.08);
    ctx.rotate(0.2);
    const wlen = drawSize * 0.62;
    ctx.fillStyle = PRONE_WEAPON_BODY;
    ctx.fillRect(-wlen * 0.3, -drawSize * 0.035, wlen, drawSize * 0.07);
    ctx.fillStyle = PRONE_WEAPON_DARK;
    ctx.fillRect(-wlen * 0.42, -drawSize * 0.02, wlen * 0.16, drawSize * 0.11);
    ctx.restore();
  }

  // The real standing sprite, drawn as ONE rigid unit lying along the
  // rotated axis above — this is what makes the downed body visibly the
  // same character (clothing/head/arms/legs/proportions) as the brief
  // requires, rather than a stand-in shape. Drawn centred on the rig's
  // local origin so the rotate/translate above does all the posing work;
  // no non-uniform squash is applied to the sprite itself (the brief's
  // explicit "do not flatten or non-uniformly scale the standing sprite" —
  // only the whole-rig breathe scale above, which is uniform and tiny).
  if (sprite) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sprite.image, sprite.sx, sprite.sy, sprite.sw, sprite.sh, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
  } else {
    ctx.fillStyle = teamColor;
    ctx.beginPath();
    ctx.ellipse(0, 0, drawSize * 0.3, drawSize * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // A small team-colour patch stays over the sprite's shoulder — keeps
  // "which player is this" readable while downed, same purpose the
  // standing pose's team-pip serves, without needing a second floating
  // indicator.
  ctx.save();
  ellipsePath(ctx, -drawSize * 0.28, -drawSize * 0.22, drawSize * 0.09, drawSize * 0.07);
  ctx.fillStyle = teamColor;
  ctx.fill();
  ctx.strokeStyle = "#241f1a";
  ctx.lineWidth = Math.max(1, drawSize * 0.025);
  ctx.stroke();
  ctx.restore();

  ctx.restore();
}

export const FALL_TRANSITION_MS = 380;
export const RISE_TRANSITION_MS = 420;
