# Turret level artwork (2026-11-02 turret visual redesign)

`turret-lv{1-5}-base.png` / `turret-lv{1-5}-weapon.png` are cut from a
single user-supplied reference image (uploaded directly to the conversation
that requested this redesign) showing five top-down futuristic turret
designs on a plain black background — one design per existing gameplay
level, in order. Like `sprites/base/base-structure.png`, this is not from
the LPC or Kenney CC0 families vendored under `sprites/lpc/`/`sprites/ui/`,
so it lives in its own `sprites/turrets/` directory; used here as supplied
by the project owner for their own game.

## Why two files per level

render.ts's renderTurret already drew a fixed base plate and a separately
rotating barrel as two independent draw calls (procedural shapes, pre-dating
this redesign). The reference image's five turret icons are each a single
flattened illustration, so keeping that same fixed/rotating split meant
splitting each icon into its own base layer (plate + outer ring + any
decorative fins/pods — never rotates) and weapon layer (barrel + inner hub
dial — rotates to face the current target), rather than rotating the whole
icon. Rotating the whole icon would spin the fixed plate/armour along with
the barrel, which is wrong (a turret that just turned to face a zombie
behind it would appear to spin its entire mount, not just its gun).

## Processing applied

A one-off node-canvas script (not checked into the repo — same
"local asset-authoring tool, not a build dependency" precedent as the wall
levels and base structure passes, see `sprites/lpc/NOTES.md` and
`sprites/base/NOTES.md`):

1. Cropped each of the five turret icons out of the source composite image
   by hand-measured bounding boxes.
2. Removed the source image's opaque pure-black background via a
   corner-seeded flood fill (color-distance tolerance, not a flat chroma-key
   threshold — the turrets' own dark gunmetal armor is close in luminance to
   pure black, so a flat threshold would have bitten into it), with a
   softened alpha-blended boundary ring so the cutout edge stays
   anti-aliased.
3. For each level, hand-measured a rotation pivot point, a `ringTop` y
   coordinate (above which only the barrel shaft exists), a `holeRadius`
   (the inner hub dial's radius around the pivot), and a `weaponBox`
   (rectangular crop containing the full barrel + hub assembly). From these:
   - **base layer**: the full cropped icon with the barrel shaft (the full
     width strip above `ringTop`) erased to transparent, UNION a circle of
     `holeRadius` around the pivot erased to transparent — clears the
     rotating assembly's footprint while leaving the surrounding ring/
     armor/decorative fins (which must stay fixed) untouched.
   - **weapon layer**: the `weaponBox` region cropped out, with anything
     below `ringTop` that's farther than `holeRadius` from the pivot ALSO
     masked to transparent — a plain rectangular crop would otherwise carry
     along fixed base-plate corner pixels that don't belong to the rotating
     assembly (confirmed by pixel-sampling the crop's corners before adding
     this mask).
4. Verified each level's split by compositing the base once and the weapon
   layer at 8 angles (0°, 45°, ..., 315°) side by side, confirming no gaps,
   no seams, and no fixed-plate pixels rotating with the barrel, before
   wiring either layer into the actual game.

## Using these in render.ts

Each weapon image's own rotation pivot (within that cropped image) is
recorded in render.ts's `TURRET_SPRITES` table as `weaponPivot`, alongside
each level's measured `muzzle` offset (the barrel-tip point(s) within the
weapon image, used so projectiles/muzzle flashes originate from the actual
drawn barrel tip rather than the turret's centre) — render.ts draws the
base layer unrotated at the turret's screen position, then separately
translates to the world pivot, rotates to the turret's current aim angle,
and draws the weapon layer offset by its own pivot, exactly mirroring the
base/weapon split already used for the player's own weapon-on-character
rig (see render.ts's `weaponMuzzleOffset`/`drawPlayerWeapon`).
