# Map background + ruin/car artwork — AI-generated (2026-11-08 map-visual pass)

These files replace the procedural grass/road tile-stamped ground layer
(`render.ts`'s old `groundTileFor`/`hash2D` tile-stamping loop, now removed)
and the procedural tiled-wall/roof-band `renderBuilding()` (also removed) for
the four `TOWN_BUILDINGS` footprints, with a single painted top-down map image
and alpha-cutout crops of the structures already painted into it.

**Source:** OpenAI / ChatGPT image generation
**Asset type:** AI-generated game artwork
**Usage:** Authorized for integration and modification in Last Stand

These are **not** LPC/CC0 assets and carry no LPC-specific licence — kept out
of `sprites/lpc/` for the same reason `sprites/base/base-structure.png` and
`sprites/wall-ai-gen/*` (also user-supplied, non-LPC art) are kept out of that
directory. See those directories' own `NOTES.md` for the same precedent.

## Files

| File | Role |
|---|---|
| `map-background.png` | The full 1254×1254 painted map — a 4-way crossroads town: grass, roads meeting at a central plaza, car wrecks/crates/trees, and 4 ruined buildings (one per diagonal quadrant). Drawn directly as the baked terrain layer's base image (`render.ts`'s `buildTerrainLayer`), scaled to fill the full 1000×1000 world. |
| `ruin-nw-cutout.png`, `ruin-ne-cutout.png`, `ruin-sw-cutout.png`, `ruin-se-cutout.png` | Alpha cutouts of the same four ruined buildings already visible in `map-background.png` (background grass erased), drawn directly over their matching `TOWN_BUILDINGS` collision rect (`src/server/obstacles.ts`) by `render.ts`'s `renderBuilding()`, Y-sorted against zombies/players. |
| `car-ne-cutout.png`, `car-sw-cutout.png` | Alpha cutouts of two of the painted car wrecks, exported from `sprites.ts` (`CAR_WRECK_IMAGES`) for completeness. Not currently drawn separately — the wrecks already read correctly baked into `map-background.png` itself, and (like every other decorative wreck in this project) have no collision. |
| `courtyard-floor.png` | A small 56×56 tileable flagstone crop sampled directly from the map background's own plaza pavement, used by `render.ts`'s `renderFortressCourtyardFloor` to fill the base's interior courtyard floor so it matches the surrounding plaza stone instead of the previous mismatched LPC pixel tile. |
| `road-sample.png`, `grass-sample.png` | Small reference crops of the background's own road/grass texture, kept for provenance; not currently wired into any renderer. |
| `ruin-nw.png`, `ruin-ne.png`, `ruin-sw.png`, `ruin-se.png`, `car-ne.png`, `car-sw.png` | Uncropped, pre-cutout source crops (full rectangular crop from the source PNG, grass background still present) kept alongside their `-cutout` counterparts for provenance/reference; not referenced by any renderer. |

## Processing applied

`map-background.png` is the source image with residue cleanup only — no
redraw of the painted art itself. The source's original center contained a
painted wall/gate structure (per the user's Option 2 instruction, since this
project's own purchasable Wall system, `src/server/obstacles.ts`'s
`wallRectsForPlayers`/`wallRectsForZombies`, already renders its own 5-level
wall art there — `wall-ai-gen/`); that structure was removed from the center
via inpainting (BFS donor-color fill and, for two stubborn residue patches
that survived the first pass, tile-based inpainting — tiling a clean nearby
texture patch with randomized flips across the erased region, which avoids
the faint silhouette "ghosting" a plain color-smear fill leaves behind) so
the plaza center is now clean open pavement, matching this project's existing
"wall only appears once built, rendered separately" behaviour.

The four `ruin-*-cutout.png` and two `car-*-cutout.png` files are alpha-channel
cutouts of their corresponding structure/vehicle in the source image (grass
background erased via an erosion/dilation mask), cropped tight to their own
opaque bounding box — no recoloring or redraw of the source pixels.

`courtyard-floor.png` is an unmodified small crop of the source's own plaza
flagstone texture, chosen to be seamlessly tileable at small scale.

## Collision geometry

The four `TOWN_BUILDINGS` rects in `src/server/obstacles.ts` (mirrored in
`src/client/obstacles.ts`) were replaced to match the four ruin structures'
real painted position/size: each rect was measured by hand against the source
image (pixel-space bounding box of the visible brick/stone structure,
including its rubble pile, converted to world units at scale 1000/1254) and
visually verified (rect overlaid on the source image) to tightly enclose the
painted structure it represents, with no excess empty-grass margin. The
replacement was checked against: no inflated overlap between buildings;
comfortable clearance beyond every road arm's `ROAD_HALF_WIDTH`; and full
base-connectivity (`assertMapIsFullyConnected()`, 0 unreached grid cells).

## Rendering

- `render.ts`'s `buildTerrainLayer()` draws `map-background.png` once into the
  baked terrain canvas (`imageSmoothingEnabled = true`, since this is painted/
  anti-aliased art, not a repeating pixel tile — same convention
  `renderBase`/`renderWallImageLevel` already use for their own AI-gen art),
  scaled to exactly fill the baked world size. Building shadows, ground marks,
  the courtyard floor, and the fortress interior decor are still baked on top
  of it afterward, same order as before.
- `render.ts`'s `renderBuilding()` draws the matching `ruin-*-cutout.png`
  scaled to exactly fill its `TOWN_BUILDINGS` rect (not letterboxed) via a
  single `drawImage`, replacing the old procedural tiled-wall/roof-band/door/
  window renderer entirely for these four rects.
- Decorative LPC prop clustering (`terrain.ts`'s `buildClusters`) is disabled
  (`DECORATIVE_PROPS` is now `[]`) since the new background already paints its
  own trees/rocks/debris/wrecks at fixed positions — drawing the old
  procedural scatter on top would duplicate objects already visible in the
  art. `buildClusters()` itself is left intact, unused, in case a future pass
  wants a non-overlapping prop layer.
