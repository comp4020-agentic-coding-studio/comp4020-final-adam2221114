// Procedural Canvas art for "giant" and "boss" zombies (2026-10-24 visual
// overhaul, substantially redesigned 2026-11-04). Both used to be the same
// LPC civilian-zombie sprite as "normal", told apart only by scale + a
// colour tint (sprites.ts/render.ts's own documented choice) — the overhaul
// brief explicitly calls that out as insufficient ("do not reintroduce ...
// scaled-up existing sprites").
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
  id: string; // ZombieSnapshot.id — keys the module-level wind-up timer below
  dir: Direction;
  walking: boolean;
  attacking: boolean;
  lungeFrac: number; // 0..1, 1 = attack just landed (render.ts's existing lunge convention)
  hitFlashFrac: number; // 0..1, 1 = this zombie's hp just dropped, decaying — render.ts-computed, see HIT_FLASH_DURATION_MS there
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

// Parses a "#rrggbb" literal (every colour constant below is one) and lerps
// toward `to` by `t` — used for the hit-flash wash, which needs every body
// part's OWN fill brightened for an instant rather than one overlay rect
// (there's no single sprite to source-atop-tint the way the player's LPC
// sheet already does; see render.ts's PLAYER_FLASH_MS comment for that
// technique, which doesn't apply to a many-shape procedural body).
function lerpColor(from: string, to: string, t: number): string {
  if (t <= 0) return from;
  const f = Number.parseInt(from.slice(1), 16);
  const g = Number.parseInt(to.slice(1), 16);
  const fr = (f >> 16) & 0xff;
  const fg = (f >> 8) & 0xff;
  const fb = f & 0xff;
  const tr = (g >> 16) & 0xff;
  const tg = (g >> 8) & 0xff;
  const tb = g & 0xff;
  const r = Math.round(fr + (tr - fr) * t);
  const gr = Math.round(fg + (tg - fg) * t);
  const b = Math.round(fb + (tb - fb) * t);
  return `rgb(${r}, ${gr}, ${b})`;
}

// --- Shared attack wind-up timer -----------------------------------------
// Neither ZombieSnapshot nor MonsterPose carries "time this swing started" —
// the server's own `attacking` field (game-state.ts's advanceZombie) is a
// continuous "currently in range" bool, true for the zombie's entire dwell
// time at range (which can be seconds), not a per-swing pulse. A convincing
// wind-up needs "time since attacking MOST RECENTLY became true", so this
// module keeps its own id-keyed memory of that transition — purely a client
// animation-timing concern, never influencing when a hit actually lands
// (ZombieSnapshot.attacksLanded/lungeFrac, unchanged, still the only thing
// that gates the forward-swing pose below). Same "small enough it never
// needs pruning" reasoning render.ts's zombieFacing/playerFacing maps
// already document.
const attackStateById = new Map<string, { attacking: boolean; since: number }>();
const WINDUP_MS = 380;

// Returns 0..1: 0 the instant `attacking` becomes true, ramping to 1 over
// WINDUP_MS and HOLDING at 1 for as long as `attacking` stays true (a giant
// can stand in range for up to its full attackIntervalMs between hits — see
// game-state.ts's ZOMBIE_TYPES.giant — so "ready" is a held pose, not a
// one-shot).
function windupFraction(id: string, attacking: boolean, now: number): number {
  let st = attackStateById.get(id);
  if (!st) {
    st = { attacking, since: now };
    attackStateById.set(id, st);
  } else if (attacking !== st.attacking) {
    st.attacking = attacking;
    st.since = now;
  }
  if (!attacking) return 0;
  return Math.min(1, (now - st.since) / WINDUP_MS);
}

// --- Giant sprite-animation frame selection -------------------------------
// Picks which of the giant's real directional sheets (sprites.ts's
// GIANT_SHEETS) to draw and which frame of it, reusing the SAME windup/lunge
// signals the procedural renderer above already derives its pose from (never
// a new server/protocol field): idle when standing still, walk while
// moving, and — during an attack — the wind-up ramp holds on the sheet's
// FIRST frame (a "readying" pose) until the hit actually lands
// (`lungeFrac`), at which point the sequence plays forward through impact
// and back down to its last ("recovered") frame, matching the procedural
// giant's own wind-up -> swing -> recovery phases.
export const GIANT_WALK_FRAME_MS = 130;
export const GIANT_IDLE_FRAME_MS = 420;
export function giantAnimState(pose: MonsterPose): { anim: "idle" | "walk" | "attack"; frameFrac: number } {
  const { id, now, phase, walking, attacking, lungeFrac } = pose;
  if (attacking) {
    const readyPull = windupFraction(id, attacking, now);
    // Held on frame 0 throughout wind-up, then lungeFrac (1 at the instant
    // the hit lands, decaying to 0 over LUNGE_DURATION_MS — render.ts) scrubs
    // forward through the rest of the sheet for the swing + recovery.
    const frameFrac = readyPull < 1 ? 0 : 1 - lungeFrac;
    return { anim: "attack", frameFrac };
  }
  if (walking) {
    const t = (now / GIANT_WALK_FRAME_MS + phase) % 1000;
    return { anim: "walk", frameFrac: t - Math.floor(t) };
  }
  const t = (now / GIANT_IDLE_FRAME_MS + phase) % 1000;
  return { anim: "idle", frameFrac: t - Math.floor(t) };
}

// --- Giant: a hulking, asymmetric mutation — broad uneven shoulders, one
// grossly oversized two-segment arm (the one it swings) with the other
// withered and small, a hunched swollen torso with multiple torn/exposed
// wounds and a glowing pressurised crack that telegraphs its on-death
// explosion (explosionRadius/explosionDamage, game-state.ts's
// ZOMBIE_TYPES.giant — unchanged by this visual pass), and a heavy,
// alternating lumbering gait. Deliberately NOT a scaled-up normal
// silhouette: wider stance, lower centre of mass, one arm roughly 1.8x the
// other, dark cel-shaded "shadow side" down its left flank so the body reads
// as a rounded volume rather than a flat cutout. ---
const GIANT_OUTLINE = "#14160d";
const GIANT_SKIN = "#5c6e3c";
const GIANT_SKIN_SHADOW = "#404f28";
const GIANT_LEG = "#3a4624";
const GIANT_WOUND_DARK = "#1c0f0f";
const GIANT_WOUND_RED = "#7a2222";
const FLASH_WHITE = "#ffffff";

export function renderGiantZombie(ctx: CanvasRenderingContext2D, drawSize: number, pose: MonsterPose): void {
  const { now, phase, walking, attacking, lungeFrac, hitFlashFrac } = pose;
  const s = drawSize / 32; // this project's zombies are drawn at a 32-unit base footprint (render.ts's renderZombie)
  const sign = facingSign(pose.dir) || 1;
  const facingFront = pose.dir === "down";
  const facingBack = pose.dir === "up";
  const outline = Math.max(1, 1.3 * s);

  // Hit-flash: brighten every fill toward white for an instant, and a short
  // backward flinch nudge — the only hp-drop-driven feedback any zombie type
  // gets today (see render.ts's HIT_FLASH_DURATION_MS for the decay).
  const skin = lerpColor(GIANT_SKIN, FLASH_WHITE, hitFlashFrac * 0.75);
  const skinShadow = lerpColor(GIANT_SKIN_SHADOW, FLASH_WHITE, hitFlashFrac * 0.65);
  const legColor = lerpColor(GIANT_LEG, FLASH_WHITE, hitFlashFrac * 0.65);
  const flinch = hitFlashFrac * 3 * s;

  ctx.save();
  ctx.scale(sign, 1);
  ctx.translate(-flinch, 0);

  // Idle breathing (only when not walking/attacking — a static body
  // otherwise read as dead-still even while fully alive) — a slow chest
  // scale pulse plus a matching faint head bob, independent of the walk
  // bob below so standing-still giants are never perfectly frozen.
  const idleBreath = !walking && !attacking ? Math.sin(now / 900 + phase) * 0.018 : 0;

  // Lumbering gait: a slow, heavy side-to-side rock plus a per-step bob —
  // two overlaid sine waves at different rates (not one), reading as "too
  // heavy to move smoothly" rather than a simple bounce.
  const stepPhase = now / 420 + phase;
  const bob = walking ? Math.abs(Math.sin(stepPhase)) * 2.4 : 0;
  const rock = walking ? Math.sin(stepPhase * 0.5) * 0.06 : 0;
  ctx.rotate(rock);
  ctx.translate(0, -bob * s);

  // Alternating stride: each leg gets its own forward/back swing AND a
  // stomp-lift that only rises during that leg's forward half-cycle
  // (Math.max(0, sin) rather than a raw sine), 180° out of phase from the
  // other leg — one leg planted while the other steps, instead of both legs
  // swinging the same amount in lockstep (the old symmetric
  // `legSwing`/`-legSwing` pair, which read as a slide since neither leg
  // ever looked "planted").
  const STRIDE = 5.5 * s;
  const LIFT = 3 * s;
  const leftPhase = stepPhase;
  const rightPhase = stepPhase + Math.PI;
  const leftStride = walking ? Math.sin(leftPhase) * STRIDE : 0;
  const rightStride = walking ? Math.sin(rightPhase) * STRIDE : 0;
  const leftLift = walking ? Math.max(0, Math.sin(leftPhase)) * LIFT : 0;
  const rightLift = walking ? Math.max(0, Math.sin(rightPhase)) * LIFT : 0;

  // Legs: thick, uneven stance, outlined so they read as separate from the
  // torso above them rather than blending into one mass.
  ellipsePath(ctx, -7 * s + leftStride * 0.3, 12 * s + leftStride * 0.4 - leftLift, 5 * s, 7.5 * s);
  fillAndStroke(ctx, legColor, GIANT_OUTLINE, outline);
  ellipsePath(ctx, 6 * s + rightStride * 0.3, 12 * s + rightStride * 0.4 - rightLift, 5.5 * s, 8 * s);
  fillAndStroke(ctx, legColor, GIANT_OUTLINE, outline);

  // Small/weak arm — two segments (upper arm + forearm) so it bends at an
  // elbow rather than reading as one rigid ellipse — drawn BEFORE the torso
  // so the torso's outline overlaps and visually "owns" the joint, reads
  // behind the body rather than floating. A faint idle sway keeps it from
  // looking dead/pinned even while the giant stands still.
  const weakArmSway = (walking ? Math.sin(stepPhase) * 0.1 : 0) + idleBreath * 0.5;
  ctx.save();
  ctx.translate(-9 * s, -2 * s);
  ctx.rotate(0.3 + weakArmSway);
  ellipsePath(ctx, 0, 4.5 * s, 3 * s, 5 * s);
  fillAndStroke(ctx, skinShadow, GIANT_OUTLINE, outline);
  ctx.translate(0, 8.5 * s);
  ctx.rotate(0.15);
  ellipsePath(ctx, 0, 2.5 * s, 2.4 * s, 3.5 * s);
  fillAndStroke(ctx, skinShadow, GIANT_OUTLINE, outline * 0.85);
  ctx.restore();

  // Torso: swollen, hunched, asymmetric barrel, tilted toward the oversized
  // arm's side and pitched forward (a brute hunch, not an upright stance).
  // Two-tone shading — a darker-shade pass clipped to the body's left half
  // gives it a rounded, lit-from-the-right read instead of a flat disc.
  const torsoTilt = 0.1;
  const torsoScale = 1 + idleBreath;
  ctx.save();
  ctx.rotate(torsoTilt);
  ctx.translate(0, -1 * s);
  ctx.scale(torsoScale, torsoScale);
  ellipsePath(ctx, 0, -1 * s, 11.5 * s, 14 * s);
  fillAndStroke(ctx, skin, GIANT_OUTLINE, outline);
  ctx.save();
  ellipsePath(ctx, 0, -1 * s, 11.5 * s, 14 * s);
  ctx.clip();
  ctx.fillStyle = skinShadow;
  ctx.beginPath();
  ctx.ellipse(-6 * s, -1 * s, 7 * s, 14.5 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.restore();

  // Torn flesh gash (main wound, over the chest) — a dark outlined wedge
  // with a crisp red interior edge, not a soft smudge, so it reads as a
  // wound at a glance.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(-4 * s, -9 * s);
  ctx.lineTo(1.5 * s, -3 * s);
  ctx.lineTo(-2 * s, 3 * s);
  ctx.lineTo(-6.5 * s, -2 * s);
  ctx.closePath();
  fillAndStroke(ctx, GIANT_WOUND_DARK, GIANT_OUTLINE, outline * 0.7);
  ctx.beginPath();
  ctx.moveTo(-3 * s, -6 * s);
  ctx.lineTo(0 * s, -2.5 * s);
  ctx.lineTo(-2.3 * s, 1 * s);
  ctx.closePath();
  ctx.fillStyle = GIANT_WOUND_RED;
  ctx.fill();
  ctx.restore();

  // Second wound — a smaller torn patch of exposed muscle on the near
  // shoulder, so the body reads as mutated/damaged from more than one
  // single gash.
  ctx.save();
  ellipsePath(ctx, 6.5 * s, -9 * s, 2.6 * s, 1.8 * s, 0.4);
  fillAndStroke(ctx, GIANT_WOUND_RED, GIANT_OUTLINE, outline * 0.5);
  ctx.restore();

  // Third wound — a dark scar/graze low on a leg, visible between strides.
  ctx.save();
  ellipsePath(ctx, -6 * s, 8 * s, 1.8 * s, 1.2 * s, -0.3);
  fillAndStroke(ctx, GIANT_WOUND_DARK, GIANT_OUTLINE, outline * 0.4);
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
  // pitched low/forward (hunched neck) rather than sitting upright on the
  // shoulders, outlined separately from the torso so the neck joint is
  // legible.
  const headBob = idleBreath * 0.6 + (walking ? Math.sin(stepPhase * 2) * 0.3 : 0);
  ellipsePath(ctx, 1.5 * s, -16 * s + headBob, 5.5 * s, 5 * s);
  fillAndStroke(ctx, skin, GIANT_OUTLINE, outline);
  if (facingFront) {
    ctx.fillStyle = "#e23c3c";
    ctx.beginPath();
    ctx.arc(-0.5 * s, -16.5 * s + headBob, 1.2 * s, 0, Math.PI * 2);
    ctx.arc(3.5 * s, -16.5 * s + headBob, 1.2 * s, 0, Math.PI * 2);
    ctx.fill();
  } else if (!facingBack) {
    ctx.fillStyle = "#e23c3c";
    ctx.beginPath();
    ctx.arc(4 * s, -16.5 * s + headBob, 1.2 * s, 0, Math.PI * 2);
    ctx.fill();
  }

  // Oversized swinging arm — two segments (upper arm, pivoted at the
  // shoulder; forearm+fist, pivoted at the elbow) so a real wind-up/swing
  // reads as a bending limb, not one rigid ellipse rotating. Drawn LAST
  // (always in front) with its shoulder pivot anchored right at the torso's
  // edge, so it never reads as a disconnected shape floating beside the
  // body.
  //
  // Three-phase attack, entirely derived from two signals already available
  // (never a new server/protocol field): `readyPull` ramps 0->1 over
  // WINDUP_MS the instant `attacking` turns true and HOLDS at 1 for as long
  // as the giant stays in range (wind-up, then a held "ready" stance);
  // `swingForward` is `lungeFrac`, which the existing pipeline already
  // spikes to 1 at the exact instant a hit lands (attacksLanded
  // incrementing — see render.ts/main.ts) and decays to 0 over
  // LUNGE_DURATION_MS — so the arm snaps forward through impact then eases
  // back to the held "ready" pose (recovery), ready to swing again on the
  // next landed hit without re-winding up.
  const readyPull = windupFraction(pose.id, attacking, now);
  const swingForward = attacking ? lungeFrac : 0;
  const PULLBACK_RAD = 0.55;
  const FORWARD_RAD = 1.35;
  const walkCounterSwing = walking ? Math.sin(stepPhase + Math.PI) * 0.1 : 0;
  const armRotation = -0.35 - PULLBACK_RAD * readyPull + (PULLBACK_RAD + FORWARD_RAD) * swingForward + walkCounterSwing;
  // Elbow bends most while pulled back/ready, straightens out through the
  // swing for a real "extend on impact" read.
  const elbowBend = -0.65 * readyPull * (1 - swingForward);

  ctx.save();
  ctx.translate(8.5 * s, -6 * s);
  ctx.rotate(armRotation);
  // Upper arm.
  ellipsePath(ctx, 2 * s, 6 * s, 5 * s, 7 * s);
  fillAndStroke(ctx, skin, GIANT_OUTLINE, outline);
  ctx.save();
  ellipsePath(ctx, 2 * s, 6 * s, 5 * s, 7 * s);
  ctx.clip();
  ctx.fillStyle = skinShadow;
  ctx.beginPath();
  ctx.ellipse(5.5 * s, 6 * s, 4 * s, 8 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Elbow pivot -> forearm + fist.
  ctx.translate(2 * s, 12 * s);
  ctx.rotate(elbowBend);
  ellipsePath(ctx, 0, 6 * s, 4.4 * s, 7 * s);
  fillAndStroke(ctx, skin, GIANT_OUTLINE, outline);
  ctx.save();
  ellipsePath(ctx, 0, 6 * s, 4.4 * s, 7 * s);
  ctx.clip();
  ctx.fillStyle = skinShadow;
  ctx.beginPath();
  ctx.ellipse(3 * s, 6 * s, 3.5 * s, 7.5 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Oversized fist, with knuckle creases so it doesn't read as a plain ball.
  ellipsePath(ctx, 0, 13 * s, 4.6 * s, 4.8 * s);
  fillAndStroke(ctx, skin, GIANT_OUTLINE, outline);
  ctx.strokeStyle = GIANT_OUTLINE;
  ctx.lineWidth = outline * 0.6;
  for (const kx of [-1.6, 0, 1.6]) {
    ctx.beginPath();
    ctx.moveTo(kx * s, 10 * s);
    ctx.lineTo(kx * s, 16 * s);
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

  // Hit-reaction wash: a quick white flash over the whole silhouette,
  // independent of the attack flash above — this is the giant TAKING damage,
  // not dealing it.
  if (hitFlashFrac > 0) {
    ctx.save();
    ctx.globalAlpha = hitFlashFrac * 0.45;
    ctx.fillStyle = FLASH_WHITE;
    ellipsePath(ctx, 0, -2 * s, 13 * s, 17 * s);
    ctx.fill();
    ctx.restore();
  }
}

// A giant's on-death explosion already has its own shockwave ring
// (render.ts's renderImpactEffects "explosion" kind, driven by main.ts
// diffing real zombie-death state, timed to finish alongside this collapse
// — see render.ts's GIANT_DEATH_EFFECT_MS/EXPLOSION_EFFECT_MS) — this gives
// the giant itself a proper direction-aware topple instead of a uniform
// vertical squash: it rotates/leans toward its last known facing and
// settles into a sprawled heap with a flung-out arm, rather than simply
// shrinking in place.
export function renderGiantDeath(ctx: CanvasRenderingContext2D, drawSize: number, ageFrac: number, dir: Direction = "down"): void {
  const s = drawSize / 32;
  const collapse = Math.min(1, ageFrac * 1.5);
  const outline = Math.max(1, 1.3 * s);
  const sign = facingSign(dir) || 1;
  ctx.save();
  ctx.globalAlpha = 1 - ageFrac;
  ctx.rotate(sign * collapse * 0.5);
  ctx.scale(1 + collapse * 0.3, 1 - collapse * 0.72);
  ctx.translate(0, collapse * 11 * s);

  // Flung-out big arm, drawn first so the torso heap overlaps its shoulder
  // end — reads as a limb thrown clear during the fall, not tucked under.
  ctx.save();
  ctx.translate(sign * 9 * s, -2 * s);
  ctx.rotate(sign * (0.4 + collapse * 0.9));
  ellipsePath(ctx, 0, 7 * s, 4.2 * s, 9 * s);
  fillAndStroke(ctx, GIANT_SKIN_SHADOW, GIANT_OUTLINE, outline);
  ctx.restore();

  // Torso heap.
  ellipsePath(ctx, 0, 0, 12 * s, 11 * s);
  fillAndStroke(ctx, GIANT_SKIN_SHADOW, GIANT_OUTLINE, outline);

  // Head, slumped to one side.
  ellipsePath(ctx, -sign * 7 * s, -2 * s, 4.5 * s, 4 * s);
  fillAndStroke(ctx, GIANT_SKIN_SHADOW, GIANT_OUTLINE, outline * 0.85);

  // The main wound, still visible on the fallen body.
  ctx.beginPath();
  ctx.ellipse(-2 * s, -1 * s, 4 * s, 3 * s, 0.3, 0, Math.PI * 2);
  fillAndStroke(ctx, GIANT_WOUND_DARK, GIANT_OUTLINE, outline * 0.6);
  ctx.restore();
}

// --- Boss: a genuinely distinct silhouette, not a bigger giant. Armoured
// chest plate (scavenged scrap, a "survived longer, got meaner" read),
// an exposed glowing mutated core as its one weak-looking point, a crown of
// small bone/horn spikes, and visible dragging vestigial arms for a
// silhouette no other zombie type has. Boss stats (HP by day, damage,
// attack interval — game-state.ts's ZOMBIE_TYPES.boss/BOSS_HP_BY_DAY) are
// untouched; this is drawing only. Not otherwise redesigned this pass — only
// the shared hit-flash wash below is new. ---
const BOSS_OUTLINE = "#140a08";
const BOSS_SKIN = "#4a2624";
const BOSS_SKIN_SHADOW = "#30191a";
const BOSS_ARMOUR = "#6b7278";
const BOSS_ARMOUR_SHADOW = "#484e54";
const BOSS_SPIKE = "#d8cfc0";

export function renderBossZombie(ctx: CanvasRenderingContext2D, drawSize: number, pose: MonsterPose): void {
  const { now, phase, walking, attacking, lungeFrac, hitFlashFrac } = pose;
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

  // Shared hit-reaction wash (see renderGiantZombie's own comment) — the
  // only new treatment boss gets this pass.
  if (hitFlashFrac > 0) {
    ctx.save();
    ctx.globalAlpha = hitFlashFrac * 0.4;
    ctx.fillStyle = FLASH_WHITE;
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
