# Base structure artwork

## 2026-11-05: reverted to the user's sci-fi command-post render

The user explicitly asked to swap the base back to the original
realistic/painted sci-fi illustration ("你可以把基地换成这个", re-uploading
the same image), superseding the 2026-11-04 LPC pixel-art keep rebuild (see
"2026-11-04 rebuild" below for that attempt's own reasoning — it is no
longer in use but kept here for history). `base-structure.png` is once
again the user-supplied painted illustration, not LPC/CC0 sourced.

Processing applied (same technique as the original 2026-11-02 upload,
re-run on the freshly re-supplied file): the source (1254×1254, solid black
background, 0% alpha nowhere — i.e. a fully opaque PNG with no existing
transparency) was flood-filled from all four corners by colour similarity
to black (tolerance-based, not a hard chroma-key threshold) and cleared to
transparent, with a softened alpha-blended boundary ring so the silhouette
edge stays anti-aliased rather than jagged. Cropped to the subject's own
opaque-pixel bounding box: 909×957 (aspect ≈0.95, close to but not exactly
square — `render.ts`'s `renderBase()` already scale-to-fits preserving
aspect ratio, so this needed no code change, same as before).

`render.ts`'s `renderBase()` needed one adjustment: the hand-drawn
ground-contact shadow ellipse (position/size tuned for the previous LPC
keep's silhouette) left a visible gap of bare ground under this art's own
feet (the entry ramp and the right-side pedestal are narrower/lower than
the keep's square footprint was), which read as the whole base floating —
the user flagged this directly ("可以落地吗，不是腾空状态" — can it be
grounded, not floating). Fixed by moving the shadow ellipse up and
shrinking it (`base.y + size * 0.48` → `size * 0.35`, `ry` from `0.18` to
`0.12`, `rx` from `0.52` to `0.48`) so it actually sits under the ramp/
pedestal's real lowest points instead of a generic "big ellipse near the
bottom." Everything else about `renderBase()` — scale-to-fit draw,
`imageSmoothingEnabled = true` (anti-aliased painted art, not a pixel-art
tile), highlight-glow/HP-bar — is unchanged. If this art is swapped again,
re-check the shadow placement against the new silhouette's actual lowest
points rather than assuming the same ellipse still fits.

## 2026-11-04 rebuild (superseded 2026-11-05): LPC pixel-art command keep

The original `base-structure.png` was replaced after the user rejected it
as a stylistic mismatch against the rest of the game's LPC pixel-art
identity ("用LPC像素素材重做基地" — rebuild the base with LPC pixel
assets), given alongside the same instruction that drove the giant zombie
rebuild (see `sprites/zombies/giant-directional/NOTES.md`). The user then
reversed this decision the next day (see above) and asked for the original
sci-fi art back, so the LPC keep described below is **no longer in use**,
though its source files remain in the repo (`assets/LPC/castle-evert/`) in
case this decision is revisited again.

The LPC rebuild was a single fortified command keep, composited with
node-canvas from real, licensed, already-top-down pixel assets:

- **Wall/roof fill**: `sprites/lpc/buildings/building-stone.png` (walls) and
  `building-brick.png` (roof band) — the exact same two 32×32 tile fills
  `render.ts`'s `renderBuilding()` already uses for every ordinary town
  building (`src/server/obstacles.ts`'s `BUILDINGS`), sourced from Lanea
  Zimmerman's `house.png` in the LPC Base Assets pack (CC-BY-SA 3.0/GPL 3.0;
  see `sprites/lpc/NOTES.md`'s "Packs used" entry 2).
- **Lookout tower ring**: a crop of the round top-down tower from "LPC
  castle" by **Evert**, with collaborators **Sharm** and **Xenodora**
  (OpenGameArt, <https://opengameart.org/content/lpc-castle>, CC-BY 3.0).
  This was the one piece of genuinely top-down (not side-view-facade)
  castle architecture found across the LPC castle packs already vendored
  under `assets/LPC/base-assets/tiles/` (`castle_outside.png` and
  `castlewalls.png` there are both side-view facades). The full original
  sheet (`lpc_castle.png`, 480×320) is vendored at `assets/LPC/castle-evert/`
  for provenance.
- **Door, arrow-slit windows, mortar-joint outline**: simple Canvas
  geometry layered on top, the same "prefer licensed material, add plain
  Canvas detail only where no asset exists" technique already used for
  `renderBuilding`'s scorch/collapse/boarded-window details and the five
  `fortress/wall-level-*.png` textures.
- Deliberately did NOT stamp the tower at all four corners with a
  perimeter wall/gate — that would have echoed the shape of the game's
  actual purchasable Wall (`WALL_HALF_EXTENT`/`WALL_GATE_WIDTH` in
  `obstacles.ts`), and CLAUDE.md's Gameplay invariants explicitly state "No
  corner towers exist in this design... only the plain square wall."

Composited with a one-off node-canvas script (not checked into the repo):
tile-fill a 224×224 canvas with the stone material, lay a brick roof band
across the top third, scale-draw the tower-ring crop centred in the roof
band with a dark ellipse behind it, then draw the door/window/outline
details with Canvas drawing calls.

## Original artwork, first upload (2026-11-02)

The original upload (a ~1254x1254 render on a near-white background, with
its own baked-in ground shadow) was a user-supplied painted illustration,
not sourced from the LPC or Kenney CC0 families — kept in its own
`sprites/base/` directory instead of mixed into `sprites/lpc/` for that
reason. It was processed with a one-off node-canvas script (background
flood-filled to transparent, cropped to its opaque bounding box) and used
as the base's artwork until the 2026-11-04 LPC rebuild above. The
2026-11-05 revert re-ran the same processing on a freshly re-supplied copy
of (as far as could be determined) the same image.
