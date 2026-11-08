# Base menu icons + base-surroundings infrastructure — AI-generated (2026-11-08 base redesign)

**Source:** OpenAI / ChatGPT image generation
**Asset type:** AI-generated game artwork
**Usage:** Authorized for integration and modification in Last Stand

These replace the flat Kenney-style 16×16 icons specifically inside the
base/turret X-menu (`#interact-menu`), and add real sprite artwork to the
fortress interior (previously hand-drawn procedural Canvas shapes in
`fortress-decor.ts`). Not LPC/CC0 assets — kept out of `sprites/lpc/` for the
same reason `sprites/base/`, `sprites/wall-ai-gen/`, and `sprites/map-ai-gen/`
(also user-supplied, non-LPC art) are kept out of that directory.

The user supplied two reference images (a base-menu mockup and a base-
surroundings mockup); both were cropped/cutout from those same two source
images, not freshly generated or hand-drawn, per the user's "use my uploaded
reference images" / "real, detailed sprite artwork rather than simplified
Canvas-shape approximations" instruction.

## Files

| File | Role | Source region |
|---|---|---|
| `icon-fortress.png` | BASE menu header icon | base-menu reference, header |
| `icon-wall.png` | "Build/Upgrade Wall" row icon | base-menu reference, row 1 |
| `icon-turret.png` | "Build Turret" row icon | base-menu reference, row 2 |
| `icon-medkit.png` | "Buy Medkit" row icon | base-menu reference, row 3 |
| `icon-xp.png` | XP-cost gear/coin icon (all 3 rows) | base-menu reference, cost column |
| `dish.png` | Satellite dish decoration | base-surroundings reference, NW/NE corners |
| `mast.png` | Radio mast / comms tower + generator base | base-surroundings reference, north edge centre |
| `elecpanel.png` | Small electrical control panel | base-surroundings reference, north edge |
| `genpanel.png` | Generator / power panel pair | base-surroundings reference, north edge |
| `floodlight.png` | Industrial floodlight on a pole | base-surroundings reference, gate-flanking lights |
| `medcrate.png` | Stacked medical supply crates | base-surroundings reference, south edge |
| `supply-sw.png` | Crate + sandbag supply cluster | base-surroundings reference, SW corner |
| `barrels.png` | Barrel + crate cluster | base-surroundings reference, SE/E area |

## Processing applied

Every file is a crop of one of the two user-uploaded reference PNGs (no
redraw, no recolouring). Icons (`icon-*.png`) were cut out with a BFS flood-
fill alpha cutout (flood from border pixels, accept neighbours within an RGB
distance tolerance of ~12, same technique already used for this project's
ruin-building/car-wreck cutouts in `sprites/map-ai-gen/`) against their
mockup's near-black panel background, which gave a clean hard-edged result
since that background is flat and high-contrast against the icon art.

The infrastructure objects (`dish.png`, `mast.png`, `elecpanel.png`,
`genpanel.png`, `floodlight.png`, `medcrate.png`, `supply-sw.png`,
`barrels.png`) sit on a textured stone-tile background in the source image
that is too close in colour/value to parts of the objects themselves for a
flood-fill cutout to isolate cleanly (it ate into dish rims and pole
shadows). These were instead cropped tightly to the object and given a soft
alpha feather (blurred rounded-rect alpha mask, ~14-16px falloff) around the
crop edge, so the sprite blends onto this project's own courtyard-floor
background instead of showing a hard rectangular seam, while every pixel
inside the object itself is still the original source artwork.

## Rendering

`fortress-decor.ts` draws these objects as fixed, hand-placed set-dressing
around the fortress interior's perimeter (replacing the previous procedural
sandbag/crate/light-tower/wire-coil/barrier Canvas drawings), baked once into
the static terrain layer exactly like before. Placement keeps the courtyard
CENTER clear (nothing placed within the existing interior reach used for the
base building itself) and keeps every object outside `BASE_GATE`'s opening
and `BASE_INTERACT_RANGE`'s own prompt ring, same placement rules the
previous procedural version already followed.

**Critical:** none of these objects represent the game's own 5-level
upgradeable Wall — the reference image's own low perimeter "wall-like"
structure is deliberately NOT included among these crops. The real wall is
still rendered entirely by `wall-render.ts` from `sprites/wall-ai-gen/`,
appearing only when `wallLevel > 0`, exactly as before. These decorations
have no collision and never block players, zombies, or turret placement.

`icon-*.png` are drawn via `main.ts`'s `renderMenu()`, as a sibling path to
the existing `uiIcon()` Kenney-icon helper — see `sprites.ts`'s
`baseMenuIconUrl()`/`BaseMenuIconName`. Only `#interact-menu`'s own icon
usage was changed; the HUD (`uiIcon`) keeps the original flat icon set
everywhere else, since that wasn't part of this request.
