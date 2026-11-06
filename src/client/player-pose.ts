// Player body-facing/weapon-occlusion decisions, and the downed/dying/
// reviving prone rig. Kept in its own module per CLAUDE.md's "keep
// rendering/animation/VFX code organised by concern" visual-scope rule,
// the same way monsters.ts holds the giant/boss's own procedural art rather
// than growing render.ts further — render.ts's renderPlayer stays a thin
// orchestrator (screen position, sprite lookup, HP bar/status text) and
// delegates the body-pose decisions here.
//
// Deliberately does NOT touch src/client/sprites.ts's LPC character sheets
// (kept exactly as-is per explicit instruction) or the existing
// drawPlayerWeapon geometry in render.ts (arms+weapon rigid unit, reused
// unchanged) — this module only decides WHEN to use which facing/draw order,
// plus the brand-new downed/prone artwork that previously didn't exist at
// all (the old pose was a plain vertical squash of the standing sprite).
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
// Replaces the old `ctx.scale(1, 0.6)` vertical squash (render.ts's previous
// renderPlayer), which is what actually produced the "unnaturally
// flattened" look the brief calls out — squashing a TOP-DOWN sprite
// vertically doesn't read as "lying down" at all, since a body lying flat
// and viewed from directly above should show its FULL length, not a
// shorter/thinner silhouette. This draws a small hand-built figure (head,
// torso, two arms, two legs — each its own outlined shape, same
// fill-then-stroke technique monsters.ts already established so parts read
// as distinct rather than blending into one blob) lying along a fixed
// canonical diagonal, independent of whatever direction the player was
// last facing before going down (the brief explicitly asks for this: "the
// pose is correct regardless of the player's previous facing direction").
//
// `proneAmount` (0..1) parametrises the WHOLE transition in one continuous
// value: 0 is a collapsed point at the player's own centre (the instant
// before they start to fall/the instant they're fully back on their feet —
// render.ts hands off to the normal standing sprite at that end), 1 is the
// fully fallen, fully spread-out resting pose. render.ts drives this upward
// (0->1) right after an alive->downed/dead transition for the fall, and
// downward (1->0) right after a downed/dead->alive transition for the
// get-up, using the SAME rig both ways rather than two separate animations.
export interface PronePose {
  proneAmount: number; // 0 standing/collapsed .. 1 fully prone and settled
  dead: boolean; // true = corpse (fully still); false = downed (still breathing)
  now: number;
  phase: number; // per-player offset (hashStr(id)) so multiple downed players don't breathe in lockstep
}

const PRONE_OUTLINE = "#241f1a";
const PRONE_SKIN = "#caa37c";
const PRONE_SKIN_SHADOW = "#a07e58";
const PRONE_SLEEVE = "#454a3c";
const PRONE_SLEEVE_SHADOW = "#333a2c";
const PRONE_WEAPON_BODY = "#34343a";
const PRONE_WEAPON_DARK = "#1f1f22";

// Fixed "fell at an angle" tilt — kept off-axis (not a perfect 90°/180°) so
// a whole team of downed players never all lie in the exact same rigid
// line, which would read as artificial.
const PRONE_CANONICAL_ANGLE = 1.15;

function fillAndStrokeProne(ctx: CanvasRenderingContext2D, fill: string, width: number): void {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = PRONE_OUTLINE;
  ctx.lineWidth = width;
  ctx.stroke();
}

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
// rotates/scales around that local origin.
export function renderProneRig(ctx: CanvasRenderingContext2D, drawSize: number, teamColor: string, pose: PronePose): void {
  const { proneAmount, dead, now, phase } = pose;
  const spread = proneAmount; // 0 = collapsed to a point, 1 = fully extended
  const halfLen = drawSize * 0.56;
  const outline = Math.max(1, drawSize * 0.035);

  // A subtle breathing pulse once settled and still alive — the one signal
  // that tells a teammate "still alive, still worth rescuing" at a glance,
  // without the downed-timer HUD text (render.ts draws that separately,
  // unaffected by this module).
  const breathe = !dead && proneAmount > 0.9 ? Math.sin(now / 650 + phase) * 0.07 : 0;

  ctx.save();
  ctx.rotate(spread * PRONE_CANONICAL_ANGLE);

  // Dropped weapon, lying just past the torso — fades in only once mostly
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
    ctx.translate(halfLen * 0.05 * spread, drawSize * 0.26);
    ctx.rotate(0.25);
    const wlen = drawSize * 0.62;
    ctx.fillStyle = PRONE_WEAPON_BODY;
    ctx.fillRect(-wlen * 0.3, -drawSize * 0.035, wlen, drawSize * 0.07);
    ctx.fillStyle = PRONE_WEAPON_DARK;
    ctx.fillRect(-wlen * 0.42, -drawSize * 0.02, wlen * 0.16, drawSize * 0.11);
    ctx.restore();
  }

  // Far leg (drawn first so the near leg/torso overlap it, reading as
  // slightly behind) — the two legs end at slightly different lengths/
  // angles rather than a perfectly mirrored pair, so the pose reads as a
  // relaxed/collapsed body rather than a rigid stick figure.
  ctx.save();
  ctx.translate(halfLen * 0.12 * spread, drawSize * 0.145 * spread);
  ctx.rotate(0.12 * spread);
  ellipsePath(ctx, halfLen * 0.42 * spread, 0, halfLen * 0.4 * spread, drawSize * 0.075);
  fillAndStrokeProne(ctx, PRONE_SLEEVE_SHADOW, outline);
  ctx.restore();

  // Far arm.
  ctx.save();
  ctx.translate(-halfLen * 0.22 * spread, drawSize * 0.19 * spread);
  ctx.rotate(-0.18 * spread);
  ellipsePath(ctx, -halfLen * 0.22 * spread, 0, halfLen * 0.26 * spread, drawSize * 0.065);
  fillAndStrokeProne(ctx, PRONE_SLEEVE_SHADOW, outline * 0.85);
  ctx.restore();

  // Torso — the breathing pulse scales its own ry only, so it reads as a
  // chest rising/falling rather than the whole body pulsing.
  ellipsePath(ctx, -halfLen * 0.12 * spread, 0, halfLen * 0.34 * spread + drawSize * 0.02, drawSize * (0.15 + breathe));
  fillAndStrokeProne(ctx, PRONE_SLEEVE, outline);
  // A small team-colour patch on the shoulder — keeps "which player is
  // this" readable while downed, same purpose the standing pose's team-pip
  // serves, without needing a second floating indicator.
  ctx.save();
  ellipsePath(ctx, -halfLen * 0.3 * spread, -drawSize * 0.05, drawSize * 0.09, drawSize * 0.07);
  ctx.fillStyle = teamColor;
  ctx.fill();
  ctx.strokeStyle = PRONE_OUTLINE;
  ctx.lineWidth = outline * 0.6;
  ctx.stroke();
  ctx.restore();

  // Head.
  ellipsePath(ctx, -halfLen * 0.82 * spread, 0, drawSize * 0.15, drawSize * 0.14);
  fillAndStrokeProne(ctx, PRONE_SKIN, outline);
  ctx.save();
  ellipsePath(ctx, -halfLen * 0.82 * spread, 0, drawSize * 0.15, drawSize * 0.14);
  ctx.clip();
  ctx.fillStyle = PRONE_SKIN_SHADOW;
  ctx.beginPath();
  ctx.ellipse(-halfLen * 0.82 * spread + drawSize * 0.05, drawSize * 0.05, drawSize * 0.1, drawSize * 0.1, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Near arm, draped slightly across/forward of the torso.
  ctx.save();
  ctx.translate(-halfLen * 0.3 * spread, -drawSize * 0.2 * spread);
  ctx.rotate(0.3 * spread);
  ellipsePath(ctx, -halfLen * 0.2 * spread, 0, halfLen * 0.28 * spread, drawSize * 0.07);
  fillAndStrokeProne(ctx, PRONE_SLEEVE, outline * 0.9);
  ctx.restore();

  // Near leg.
  ctx.save();
  ctx.translate(halfLen * 0.14 * spread, -drawSize * 0.15 * spread);
  ctx.rotate(-0.08 * spread);
  ellipsePath(ctx, halfLen * 0.44 * spread, 0, halfLen * 0.42 * spread, drawSize * 0.08);
  fillAndStrokeProne(ctx, PRONE_SLEEVE, outline);
  ctx.restore();

  ctx.restore();
}

export const FALL_TRANSITION_MS = 380;
export const RISE_TRANSITION_MS = 420;
