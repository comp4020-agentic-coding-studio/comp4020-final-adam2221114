# Giant zombie directional art

2026-11-04 rebuild. Replaces an earlier pass (built from a user-uploaded
reference sheet via a "cutout limb rig" — single static poses per direction,
segmented into core+limb pieces and re-posed by rotating the limb pieces
about their pivots) after review found that approach stylistically
inconsistent with the rest of this project's LPC-sourced cast, and visually
unconvincing at gameplay zoom compared to this project's other real
multi-frame sprites. This rebuild uses genuinely licensed, real multi-frame
LPC pixel art for every direction instead — no rig, no rotated cutouts, no
procedural shapes for walk/attack.

## Sources (all via OpenGameArt.org)

- **Body**: "[LPC] modular bodies and heads" by Sebastian Riedel (Baŝto) —
  <https://opengameart.org/content/lpc-modular-heads> — CC-BY-SA 3.0 / GPL
  3.0. This pack repackages existing LPC character-base work as a
  **headless** body (for swapping in different heads) in two animations:
  - `male_ivory_muscular_headless_walkcycle.png` — based on "LPC Barbarian
    Sprite Base" by dalonedrau
    (<https://opengameart.org/content/lpc-barbarian-sprite-base>), a
    muscular variant of the LPC male base by Stephen Challener (Redshrike).
    Genuine 4-direction (up/left/down/right), 9-frame walk cycle.
  - `male_ivory_muscular_headless_slash.png` — based on "[LPC] Muscular
    Swing Animation" by ElizaWy
    (<https://opengameart.org/content/lpc-muscular-swing-animation>).
    Genuine 4-direction, 6-frame slash/attack (wind-up, swing, recovery).
  - The pack also ships `lpc-shell-tools/`, a small shell toolkit including
    per-frame head-ALIGNMENT data (`animation/head/male/walkcycle.map.csv`,
    `slash.map.csv`) — each cell is `headPoseIndex;xOffset;yOffset`, i.e.
    exactly which head pose to use for that body frame and how far to shift
    it from the frame's default anchor. This is the pack's OWN measured
    alignment data, not eyeballed placement.
- **Head**: `male_ivory_ogre_head.png`, same pack, based on "Four
  characters: My LPC entries" by Stephen Challener (Redshrike)
  (<https://opengameart.org/content/four-characters-my-lpc-entries>). A
  4-pose head sheet (one pose per direction) already colour-matched to the
  same `ivory` skin palette as the muscular body (verified by direct
  pixel-histogram comparison before compositing — no palette mismatch at
  the neck seam).

Both sources are CC-BY-SA 3.0 / GPL 3.0, same licence family as this
project's other LPC assets (`sprites/lpc/NOTES.md`) — safe to combine and
redistribute with attribution.

## Build pipeline (one-off local scripts, not checked into the repo — same
"local asset-authoring tool" precedent as every other NOTES.md in this
project's `sprites/` tree)

1. **Compositing** (`compose.mjs`): for each of the 4 rows (up/left/down/
   right) x N columns (9 for walk, 6 for slash), drew the body frame first,
   then looked up that exact cell's `{headPoseIndex, xOffset, yOffset}` from
   the pack's own CSV and drew the corresponding head pose on top, shifted
   by the CSV's offset — i.e. literally running the pack's own `duplimap.sh`
   alignment algorithm in JS (via `node-canvas`) instead of shelling out to
   ImageMagick, since the sandbox has no ImageMagick installed. Output: one
   576x256 walkcycle sheet and one 384x256 slash sheet, each 4 rows x
   64x64 tiles, in the LPC-standard row order (up, left, down, right).
2. **Recolour** (`tint.mjs`): the source head+body use a warm tan/ivory
   "ogre" skin tone with blue eyes. Remapped to this project's own giant-
   zombie identity — a sick olive-green skin (matched to `monsters.ts`'s
   existing procedural `GIANT_SKIN`/`GIANT_SKIN_SHADOW` family, which the
   giant already uses as its hurt/death fallback, so the sprite and its
   procedural fallback now read as the same creature) and red eyes (matching
   the reference the project's original giant-redesign brief was based on,
   and the zombie-eye convention `monsters.ts` already uses elsewhere) — via
   a per-source-colour lookup table that remaps each of the handful of
   distinct skin-tone/eye colours in the source to a green/red equivalent at
   the same relative lightness, preserving all of the original art's
   shading/muscle definition. This is a hue/saturation remap of real
   shaded pixel art, not a flat colour overlay.
3. **Slicing** (`slice.mjs`): sliced the composited+recoloured sheets into
   this project's existing per-direction horizontal-strip convention
   (`sprites.ts`'s `giantSheet()` loader: one PNG per direction+animation,
   frames left-to-right), producing `{up,left,down,right}-{walk,attack}.png`
   (9 and 6 frames respectively, each tile 64x64 — uniform across every
   direction and animation, unlike the old rig's per-direction frame sizes).
   Idle (`{dir}-idle.png`, 4 frames) is sampled from 4 near-neutral-stance
   columns of the real walk cycle (where both legs are close together)
   rather than invented — still genuine licensed art, just a sparser
   sampling of the same walk sheet, matching the previous rig's 4-frame
   idle count so `giantAnimState`'s frame-fraction math needed no changes.

## Left/right mirroring

Per the LPC format's own convention (confirmed by direct pixel comparison:
the source body sheet's "left" and "right" rows are genuinely identical
art, both drawn facing left — this is standard LPC practice, not a defect),
`left-*.png` and `right-*.png` are the same leftward-facing frames.
`render.ts`'s existing `ctx.scale(face.dir === "left" ? -1 : 1, 1)` (already
applied to every other LPC zombie/player sheet in this project, e.g.
`zombies/zombie-walk-left.png`/`-right.png`) mirrors the "right" sheet at
draw time to produce the true right-facing pose — so `right-*.png` here is
deliberately the same un-mirrored source art as `left-*.png`; no separate
mirrored PNG was baked, consistent with how every other directional sheet
in this project already works.

## What's NOT covered by real art

No hurt or death animation exists for any direction. The hurt/death-capable
companion sheet for this exact body
("[LPC] Muscular Hurt Animation" by Death's Darling,
<https://opengameart.org/content/lpc-muscular-hurt-animation>) was
evaluated and rejected: it only supplies a single non-directional 7-frame
sequence, and critically its own head-alignment data assumes a FULL
universal-sheet head-pose set (head tilting back, head on the ground, etc.)
that the ogre head file here does not have — only 4 simple standing poses.
Compositing attempt (see git history of this NOTES.md's prior revision)
produced a correctly-aligned first frame followed by frames with no head at
all once the animation needed a pose the head sheet doesn't contain. Rather
than ship that, every direction falls back to the original procedural
hit-flash (white tint) and direction-aware topple death
(`monsters.ts`'s `renderGiantZombie`'s flash path / `renderGiantDeath`) —
the same honest, narrower-scope choice the previous rig already made for
up/left/right, now applied uniformly to all four directions including down.
