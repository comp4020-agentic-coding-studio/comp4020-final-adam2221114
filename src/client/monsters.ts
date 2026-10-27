// Procedural Canvas art for "giant" and "boss" zombies (2026-10-24 visual
// overhaul). Both used to be the same LPC civilian-zombie sprite as "normal",
// told apart only by scale + a colour tint (sprites.ts/render.ts's own
// documented choice) — the overhaul brief explicitly calls that out as
// insufficient ("do not reintroduce ... scaled-up existing sprites").
//
// No suitably-themed, properly-licensed replacement exists: searched
// OpenGameArt for a CC0/CC-BY(-SA) LPC-compatible "giant zombie"/"boss
// zombie" sprite sheet (walk+attack+death, this project's existing frame
// convention) and found only fantasy-themed candidates that don't fit this
// game's post-apocalyptic zombie setting ("[LPC] Golem" — a crystalline
// construct, CC-BY/GPL, opengameart.org/content/lpc-golem; "[LPC] Monsters"'
// pumpking/man-eater-flower, already vendored under assets/LPC/base-assets/
// — a jack-o'-lantern and a carnivorous plant) and a set of wound/gore
// OVERLAYS for the exact zombie sheet already in use ("[LPC] Zombie" by
// Benjamin K. Smith, CC-BY-SA/GPL3 — Brain.png/Ribs.png, confirmed
// byte-identical to assets/LPC/zombie/zombie.png) that add detail but don't
// change size/silhouette, so they don't solve "giant" or "boss" distinction
// either. Forcing any of these in would violate the brief's own "avoid
// mixing incompatible asset styles" rule more than it would solve the
// placeholder problem.
//
// Following the exact precedent this codebase already set for the flying
// zombie, turrets, and the base's door ("no sprite in the pack is shaped
// like this, so draw it" — see sprites.ts/render.ts's own comments): both
// are hand-built, layered, animated Canvas monsters. Every filled shape
// below gets a dark outline stroke and a two-tone (base + shadow) cel-shade
// rather than a single flat fill or a soft gradient blob — a first version
// without outlines read as translucent overlapping blobs at any real zoom
// level, not a character; separating every body part with its own stroke is
// what actually makes the silhouette and wounds/armour read at a glance.
// Kept in their own module per CLAUDE.md's "keep rendering code organised by
// concern" visual-scope rule rather than growing render.ts further.
import type { Direction } from "./sprites.ts";

export interface MonsterPose {
  dir: Direction;
  walking: boolean;
  attacking: boolean;
  lungeFrac: number; // 0..1, 1 = attack just landed (render.ts's existing lunge convention)
  now: number;
  phase: number; // per-entity animation offset (hashStr(id)), stops every giant/boss animating in lockstep
}

function facingSign(dir: Direction): number {
  return dir === "left" ? -1 : dir === "right" ? 1 : 0;
}

// Fills the current path with `fill`, then strokes it with a dark outline —
// the one change that turns every shape below from a flat/blurry blob into
// something that reads as a distinct, bounded body part. `width` is already
// pre-scaled by the caller (world-unit `s`).
function fillAndStroke(ctx: CanvasRenderingContext2D, fill: string, strokeColor: string, width: number): void {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = width;
  ctx.stroke();
}

function ellipsePath(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rot = 0): void {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
}

// --- Giant: a hulking, asymmetric mutation — one grossly oversized arm
// (the one it swings), a swollen torn torso with a glowing pressurised crack
// that telegraphs its on-death explosion (explosionRadius/explosionDamage,
// game-state.ts's ZOMBIE_TYPES.giant — unchanged by this visual pass), and a
// heavy, uneven lumbering gait. Deliberately NOT a scaled-up normal
// silhouette: wider stance, lower centre of mass, one arm roughly 1.7x the
// other, dark cel-shaded "shadow side" down its left flank so the body reads
// as a rounded volume rather than a flat cutout. ---
const GIANT_OUTLINE = "#14160d";
const GIANT_SKIN = "#5c6e3c";
const GIANT_SKIN_SHADOW = "#404f28";
const GIANT_LEG = "#3a4624";

export function renderGiantZombie(ctx: CanvasRenderingContext2D, drawSize: number, pose: MonsterPose): void {
  const { now, phase, walking, attacking, lungeFrac } = pose;
  const s = drawSize / 32; // this project's zombies are drawn at a 32-unit base footprint (render.ts's renderZombie)
  const sign = facingSign(pose.dir) || 1;
  const facingFront = pose.dir === "down";
  const facingBack = pose.dir === "up";
  const outline = Math.max(1, 1.3 * s);

  ctx.save();
  ctx.scale(sign, 1);

  // Lumbering gait: a slow, heavy side-to-side rock plus a per-step bob —
  // two overlaid sine waves at different rates (not one), reading as "too
  // heavy to move smoothly" rather than a simple bounce.
  const stepPhase = now / 420 + phase;
  const bob = walking ? Math.abs(Math.sin(stepPhase)) * 2.2 : 0;
  const rock = walking ? Math.sin(stepPhase * 0.5) * 0.05 : 0;
  ctx.rotate(rock);
  ctx.translate(0, -bob * s);

  const legSwing = walking ? Math.sin(stepPhase) * 5 * s : 0;

  // Legs: thick, uneven stance, outlined so they read as separate from the
  // torso above them rather than blending into one mass.
  ellipsePath(ctx, -7 * s, 12 * s + legSwing * 0.4, 5 * s, 7.5 * s);
  fillAndStroke(ctx, GIANT_LEG, GIANT_OUTLINE, outline);
  ellipsePath(ctx, 6 * s, 12 * s - legSwing * 0.4, 5.5 * s, 8 * s);
  fillAndStroke(ctx, GIANT_LEG, GIANT_OUTLINE, outline);

  // Small/weak arm drawn BEFORE the torso so the torso's outline overlaps and
  // visually "owns" the joint, reads behind the body rather than floating.
  ctx.save();
  ctx.translate(-9 * s, -2 * s);
  ctx.rotate(0.3 + (walking ? Math.sin(stepPhase) * 0.1 : 0));
  ellipsePath(ctx, 0, 6 * s, 3 * s, 6.5 * s);
  fillAndStroke(ctx, GIANT_SKIN_SHADOW, GIANT_OUTLINE, outline);
  ctx.restore();

  // Torso: swollen, asymmetric barrel, tilted toward the oversized arm's
  // side. Two-tone shading — a darker-shade pass clipped to the body's left
  // half gives it a rounded, lit-from-the-right read instead of a flat disc.
  const torsoTilt = 0.04;
  ctx.save();
  ctx.rotate(torsoTilt);
  ellipsePath(ctx, 0, -2 * s, 11 * s, 14.5 * s);
  fillAndStroke(ctx, GIANT_SKIN, GIANT_OUTLINE, outline);
  ctx.save();
  ellipsePath(ctx, 0, -2 * s, 11 * s, 14.5 * s);
  ctx.clip();
  ctx.fillStyle = GIANT_SKIN_SHADOW;
  ctx.beginPath();
  ctx.ellipse(-6 * s, -2 * s, 7 * s, 15 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.restore();

  // Torn flesh gash — a dark outlined wedge with a crisp red interior edge,
  // not a soft smudge, so it reads as a wound at a glance.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(-4 * s, -9 * s);
  ctx.lineTo(1.5 * s, -3 * s);
  ctx.lineTo(-2 * s, 3 * s);
  ctx.lineTo(-6.5 * s, -2 * s);
  ctx.closePath();
  fillAndStroke(ctx, "#1c0f0f", GIANT_OUTLINE, outline * 0.7);
  ctx.beginPath();
  ctx.moveTo(-3 * s, -6 * s);
  ctx.lineTo(0 * s, -2.5 * s);
  ctx.lineTo(-2.3 * s, 1 * s);
  ctx.closePath();
  ctx.fillStyle = "#7a2222";
  ctx.fill();
  ctx.restore();

  // Pressurised glowing crack — a crisp bright line with a thin soft halo
  // (not a wide blur), pulsing as a silent "about to pop" tell. Purely
  // cosmetic, no gameplay timing implied.
  const veinPulse = 0.5 + 0.5 * Math.sin(now / 260 + phase);
  ctx.save();
  ctx.globalAlpha = 0.35 + 0.25 * veinPulse;
  ctx.strokeStyle = "#ffb13a";
  ctx.lineWidth = 3 * s;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-8 * s, 5 * s);
  ctx.quadraticCurveTo(-3 * s, -1 * s, 2.5 * s, -9.5 * s);
  ctx.stroke();
  ctx.globalAlpha = 0.8 + 0.2 * veinPulse;
  ctx.strokeStyle = `rgba(255, ${210 + Math.round(30 * veinPulse)}, 140, 1)`;
  ctx.lineWidth = 1 * s;
  ctx.beginPath();
  ctx.moveTo(-8 * s, 5 * s);
  ctx.quadraticCurveTo(-3 * s, -1 * s, 2.5 * s, -9.5 * s);
  ctx.stroke();
  ctx.restore();

  // Head: small relative to the body (classic "giant brute" proportion),
  // outlined separately from the torso so the neck joint is legible.
  ellipsePath(ctx, 1 * s, -17 * s, 5.5 * s, 5 * s);
  fillAndStroke(ctx, GIANT_SKIN, GIANT_OUTLINE, outline);
  if (facingFront) {
    ctx.fillStyle = "#e23c3c";
    ctx.beginPath();
    ctx.arc(-1 * s, -17.5 * s, 1.2 * s, 0, Math.PI * 2);
    ctx.arc(3 * s, -17.5 * s, 1.2 * s, 0, Math.PI * 2);
    ctx.fill();
  } else if (!facingBack) {
    ctx.fillStyle = "#e23c3c";
    ctx.beginPath();
    ctx.arc(3.5 * s, -17.5 * s, 1.2 * s, 0, Math.PI * 2);
    ctx.fill();
  }

  // Oversized swinging arm: drawn LAST (always in front) with its pivot
  // anchored right at the torso's shoulder edge, so it never reads as a
  // disconnected shape floating beside the body.
  const attackSwing = attacking ? lungeFrac : 0;
  ctx.save();
  ctx.translate(8 * s, -6 * s);
  ctx.rotate(-0.35 + attackSwing * -1.2 + (walking ? Math.sin(stepPhase + Math.PI) * 0.08 : 0));
  ellipsePath(ctx, 2 * s, 8 * s, 5 * s, 10 * s);
  fillAndStroke(ctx, GIANT_SKIN, GIANT_OUTLINE, outline);
  ctx.save();
  ellipsePath(ctx, 2 * s, 8 * s, 5 * s, 10 * s);
  ctx.clip();
  ctx.fillStyle = GIANT_SKIN_SHADOW;
  ctx.beginPath();
  ctx.ellipse(6 * s, 8 * s, 4 * s, 11 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Oversized fist, with knuckle creases so it doesn't read as a plain ball.
  ellipsePath(ctx, 2 * s, 18 * s, 4.6 * s, 4.8 * s);
  fillAndStroke(ctx, GIANT_SKIN, GIANT_OUTLINE, outline);
  ctx.strokeStyle = GIANT_OUTLINE;
  ctx.lineWidth = outline * 0.6;
  for (const kx of [-1.6, 0, 1.6]) {
    ctx.beginPath();
    ctx.moveTo((2 + kx) * s, 15 * s);
    ctx.lineTo((2 + kx) * s, 21 * s);
    ctx.stroke();
  }
  ctx.restore();

  ctx.restore();

  // A bright flash wash the instant the hit lands — brighter and more orange
  // than the flying zombie's cyan, matching the crack glow colour.
  if (attacking && lungeFrac > 0.5) {
    ctx.save();
    ctx.globalAlpha = (lungeFrac - 0.5) * 2 * 0.35;
    ctx.fillStyle = "#ffcf8a";
    ellipsePath(ctx, 0, -2 * s, 13 * s, 16 * s);
    ctx.fill();
    ctx.restore();
  }
}

// A giant's on-death explosion already has its own shockwave ring
// (render.ts's renderImpactEffects "explosion" kind, driven by main.ts
// diffing real zombie-death state) — this just gives the giant itself a
// distinct collapse instead of reusing the shared LPC zombie-dead sheet.
export function renderGiantDeath(ctx: CanvasRenderingContext2D, drawSize: number, ageFrac: number): void {
  const s = drawSize / 32;
  const collapse = Math.min(1, ageFrac * 1.6);
  const outline = Math.max(1, 1.3 * s);
  ctx.save();
  ctx.globalAlpha = 1 - ageFrac;
  ctx.scale(1 + collapse * 0.25, 1 - collapse * 0.7);
  ctx.translate(0, collapse * 10 * s);
  ellipsePath(ctx, 0, 0, 12 * s, 11 * s);
  fillAndStroke(ctx, GIANT_SKIN_SHADOW, GIANT_OUTLINE, outline);
  ctx.beginPath();
  ctx.ellipse(-2 * s, -1 * s, 4 * s, 3 * s, 0.3, 0, Math.PI * 2);
  fillAndStroke(ctx, "#1c0f0f", GIANT_OUTLINE, outline * 0.6);
  ctx.restore();
}

// --- Boss: a genuinely distinct silhouette, not a bigger giant. Armoured
// chest plate (scavenged scrap, a "survived longer, got meaner" read),
// an exposed glowing mutated core as its one weak-looking point, a crown of
// small bone/horn spikes, and visible dragging vestigial arms for a
// silhouette no other zombie type has. Boss stats (HP by day, damage,
// attack interval — game-state.ts's ZOMBIE_TYPES.boss/BOSS_HP_BY_DAY) are
// untouched; this is drawing only. ---
const BOSS_OUTLINE = "#140a08";
const BOSS_SKIN = "#4a2624";
const BOSS_SKIN_SHADOW = "#30191a";
const BOSS_ARMOUR = "#6b7278";
const BOSS_ARMOUR_SHADOW = "#484e54";
const BOSS_SPIKE = "#d8cfc0";

export function renderBossZombie(ctx: CanvasRenderingContext2D, drawSize: number, pose: MonsterPose): void {
  const { now, phase, walking, attacking, lungeFrac } = pose;
  const s = drawSize / 32;
  const sign = facingSign(pose.dir) || 1;
  const facingFront = pose.dir === "down";
  const facingBack = pose.dir === "up";
  const outline = Math.max(1, 1.3 * s);

  ctx.save();
  ctx.scale(sign, 1);

  const stepPhase = now / 380 + phase;
  const bob = walking ? Math.abs(Math.sin(stepPhase)) * 1.6 : 0;
  ctx.translate(0, -bob * s);

  // Vestigial second arm pair — small, dragging, drawn first (and darker,
  // with their own outline) so they sit clearly BEHIND the main silhouette
  // as extra limbs rather than competing with the main arms.
  const dragSwing = walking ? Math.sin(stepPhase * 0.7) * 3 * s : 0;
  ctx.save();
  ctx.translate(-10 * s, 5 * s + dragSwing);
  ctx.rotate(0.5);
  ellipsePath(ctx, 0, 0, 2.6 * s, 7.5 * s);
  fillAndStroke(ctx, BOSS_SKIN_SHADOW, BOSS_OUTLINE, outline * 0.8);
  ctx.restore();
  ctx.save();
  ctx.translate(10 * s, 5 * s - dragSwing);
  ctx.rotate(-0.5);
  ellipsePath(ctx, 0, 0, 2.6 * s, 7.5 * s);
  fillAndStroke(ctx, BOSS_SKIN_SHADOW, BOSS_OUTLINE, outline * 0.8);
  ctx.restore();

  // Legs.
  const legSwing = walking ? Math.sin(stepPhase) * 4 * s : 0;
  ellipsePath(ctx, -6 * s, 13 * s + legSwing * 0.3, 4.5 * s, 7.5 * s);
  fillAndStroke(ctx, BOSS_SKIN_SHADOW, BOSS_OUTLINE, outline);
  ellipsePath(ctx, 6 * s, 13 * s - legSwing * 0.3, 4.5 * s, 7.5 * s);
  fillAndStroke(ctx, BOSS_SKIN_SHADOW, BOSS_OUTLINE, outline);

  // Torso: dark mutated body.
  ellipsePath(ctx, 0, -2 * s, 10.5 * s, 14 * s);
  fillAndStroke(ctx, BOSS_SKIN, BOSS_OUTLINE, outline);

  // Scavenged, asymmetric scrap-armour chest plate over the front — flat
  // shapes + outline + a couple of highlight lines + rivets, no sprite
  // needed. Outlined distinctly from the body so it reads as a separate,
  // harder material on top of soft flesh.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(-8 * s, -11 * s);
  ctx.lineTo(8 * s, -12 * s);
  ctx.lineTo(9 * s, 2 * s);
  ctx.lineTo(3 * s, 7.5 * s);
  ctx.lineTo(-6 * s, 5.5 * s);
  ctx.lineTo(-9 * s, -3 * s);
  ctx.closePath();
  fillAndStroke(ctx, BOSS_ARMOUR, BOSS_OUTLINE, outline);
  // Shadow half of the plate, clipped — same cel-shade trick as the giant.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(-8 * s, -11 * s);
  ctx.lineTo(8 * s, -12 * s);
  ctx.lineTo(9 * s, 2 * s);
  ctx.lineTo(3 * s, 7.5 * s);
  ctx.lineTo(-6 * s, 5.5 * s);
  ctx.lineTo(-9 * s, -3 * s);
  ctx.closePath();
  ctx.clip();
  ctx.fillStyle = BOSS_ARMOUR_SHADOW;
  ctx.beginPath();
  ctx.ellipse(-5 * s, -2 * s, 6 * s, 13 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Rivets.
  ctx.fillStyle = "#9aa0a6";
  for (const [rx, ry] of [
    [-6, -8],
    [5, -9],
    [6, -1],
    [-7, 0],
  ]) {
    ctx.beginPath();
    ctx.arc(rx * s, ry * s, 0.9 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = BOSS_OUTLINE;
    ctx.lineWidth = outline * 0.4;
    ctx.stroke();
  }
  ctx.restore();

  // Exposed mutated core — a CRISP bright ring + centre (not a wide blur),
  // pulsing independent of any real gameplay hitbox: a visual focal point so
  // the boss reads as "aim here" even though hit resolution is whole-entity
  // (this project has no per-bodypart damage model, same simplification
  // turret/player hit detection already makes elsewhere).
  const corePulse = 0.5 + 0.5 * Math.sin(now / 200 + phase);
  ctx.save();
  ellipsePath(ctx, 0, -3 * s, 4.4 * s, 4.4 * s);
  ctx.fillStyle = `rgb(${90 + Math.round(40 * corePulse)}, 10, ${70 + Math.round(30 * corePulse)})`;
  ctx.fill();
  ctx.strokeStyle = `rgba(255, ${140 + Math.round(60 * corePulse)}, 240, 1)`;
  ctx.lineWidth = 1.2 * s;
  ctx.stroke();
  ctx.fillStyle = `rgba(255, 225, 255, ${0.8 + 0.2 * corePulse})`;
  ctx.beginPath();
  ctx.arc(0, -3 * s, 1.7 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Head: a crown of small bone/horn spikes, each individually outlined —
  // the single most important "boss, not a bigger zombie" read, since
  // nothing else in this game's roster has a spiked silhouette.
  ellipsePath(ctx, 0, -18 * s, 5 * s, 4.6 * s);
  fillAndStroke(ctx, BOSS_SKIN, BOSS_OUTLINE, outline);
  for (const a of [-1.3, -0.7, 0, 0.7, 1.3]) {
    ctx.save();
    ctx.translate(Math.sin(a) * 4.6 * s, -21 * s - Math.cos(a) * 2 * s);
    ctx.rotate(a * 0.6);
    ctx.beginPath();
    ctx.moveTo(-1.1 * s, 0);
    ctx.lineTo(1.1 * s, 0);
    ctx.lineTo(0, -5.5 * s);
    ctx.closePath();
    fillAndStroke(ctx, BOSS_SPIKE, BOSS_OUTLINE, outline * 0.6);
    ctx.restore();
  }
  if (facingFront) {
    ctx.fillStyle = `rgba(255, 220, 255, ${0.8 + 0.2 * corePulse})`;
    ctx.beginPath();
    ctx.arc(-1.6 * s, -18 * s, 1 * s, 0, Math.PI * 2);
    ctx.arc(1.6 * s, -18 * s, 1 * s, 0, Math.PI * 2);
    ctx.fill();
  } else if (!facingBack) {
    ctx.fillStyle = `rgba(255, 220, 255, ${0.8 + 0.2 * corePulse})`;
    ctx.beginPath();
    ctx.arc(3 * s, -18 * s, 1 * s, 0, Math.PI * 2);
    ctx.fill();
  }

  // Main arms — pivoted at the shoulder edge (not floating), clawed swing on
  // attack, same lunge-fraction convention as every other zombie type.
  const attackSwing = attacking ? lungeFrac : 0;
  ctx.save();
  ctx.translate(8.5 * s, -6 * s);
  ctx.rotate(-0.25 + attackSwing * -1.3 + (walking ? Math.sin(stepPhase + Math.PI) * 0.12 : 0));
  ellipsePath(ctx, 1.5 * s, 7 * s, 3.6 * s, 8.5 * s);
  fillAndStroke(ctx, BOSS_SKIN, BOSS_OUTLINE, outline);
  ctx.strokeStyle = BOSS_SPIKE;
  ctx.lineWidth = 1 * s;
  for (const cx of [0, 1.5, 3]) {
    ctx.beginPath();
    ctx.moveTo(cx * s, 12 * s);
    ctx.lineTo(cx * s * 1.3, 16.5 * s);
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.translate(-8.5 * s, -6 * s);
  ctx.rotate(0.25 + (walking ? Math.sin(stepPhase) * 0.12 : 0));
  ellipsePath(ctx, -1.5 * s, 7 * s, 3.6 * s, 8.5 * s);
  fillAndStroke(ctx, BOSS_SKIN, BOSS_OUTLINE, outline);
  ctx.restore();

  ctx.restore();

  if (attacking && lungeFrac > 0.5) {
    ctx.save();
    ctx.globalAlpha = (lungeFrac - 0.5) * 2 * 0.4;
    ctx.fillStyle = "#ff8adf";
    ellipsePath(ctx, 0, -3 * s, 13 * s, 17 * s);
    ctx.fill();
    ctx.restore();
  }
}

export function renderBossDeath(ctx: CanvasRenderingContext2D, drawSize: number, ageFrac: number): void {
  const s = drawSize / 32;
  const collapse = Math.min(1, ageFrac * 1.4);
  const outline = Math.max(1, 1.3 * s);
  ctx.save();
  ctx.globalAlpha = 1 - ageFrac;
  ctx.scale(1 + collapse * 0.2, 1 - collapse * 0.65);
  ctx.translate(0, collapse * 9 * s);
  ellipsePath(ctx, 0, 0, 11 * s, 10 * s);
  fillAndStroke(ctx, BOSS_SKIN_SHADOW, BOSS_OUTLINE, outline);
  // The core fades out last — the last visible thing before it's gone.
  ctx.globalAlpha = Math.max(0, 1 - ageFrac * 1.8);
  ctx.fillStyle = "rgba(255, 150, 230, 0.9)";
  ctx.beginPath();
  ctx.arc(0, -2 * s, 3.5 * s * (1 - ageFrac), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// A dramatic, one-shot entrance flash the instant a boss first appears on
// screen — brief, bright, and self-expiring; purely cosmetic (never gates
// or delays when the boss is actually able to act server-side).
export const BOSS_ENTRANCE_MS = 900;
export function renderBossEntrance(ctx: CanvasRenderingContext2D, screenX: number, screenY: number, ageFrac: number): void {
  const t = ageFrac;
  ctx.save();
  ctx.globalAlpha = (1 - t) * 0.65;
  const radius = 10 + t * 90;
  const grad = ctx.createRadialGradient(screenX, screenY, 0, screenX, screenY, radius);
  grad.addColorStop(0, "rgba(255, 160, 230, 0.9)");
  grad.addColorStop(0.6, "rgba(180, 30, 120, 0.4)");
  grad.addColorStop(1, "rgba(180, 30, 120, 0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(screenX, screenY, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = `rgba(255, 220, 255, ${(1 - t) * 0.8})`;
  ctx.lineWidth = 3 * (1 - t) + 1;
  ctx.beginPath();
  ctx.arc(screenX, screenY, 18 + t * 55, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
