# UI asset source: Kenney.nl (CC0)

The HUD/menu icons and panel chrome under `src/client/sprites/ui/` are a
curated subset of two Kenney.nl packs, both released under **CC0 1.0
Universal (public domain)** — see the `*-LICENSE.txt` files in this folder
(copied verbatim from each pack's own `License.txt`). CC0 explicitly permits
redistributing the original files, including in a public repository; no
attribution is required (Kenney asks for a credit "if possible," which this
file provides).

This replaces `src/client/sprites/ui.png` (a cropped region of the CraftPix
"Zombie Survival" freebie pack — see `PROCESS.md`'s visual-redesign entry),
whose free-tier license explicitly forbids redistributing source art files,
an unresolved conflict with this course's public-repo workflow. Only the
*UI* layer (HUD icons, menu/panel chrome) is replaced here; the in-world
terrain/zombie/base sprites are a separate, larger asset (not "UI") and are
intentionally left untouched — see PROCESS.md's UI-asset-swap entry for why.

## Packs used

1. **1-Bit Pack** by Kenney — <https://kenney.nl/assets/1-bit-pack>
   License: CC0 1.0 Universal (`1-bit-pack-LICENSE.txt`)
   Source file used: `Tilesheet/colored.png` (a 49x22, 16px-grid sprite
   sheet, 1px spacing between tiles — tile coordinates below are
   `(column, row)`, 0-indexed).

2. **Pixel UI Pack** by Kenney Vleugels, with help by Lynn Evers —
   <https://kenney.nl/assets/pixel-ui-pack>
   License: CC0 1.0 Universal (`pixel-ui-pack-LICENSE.txt`)
   Source files used: the `9-Slice/Ancient/*` and `9-Slice/Colored/*` panel
   textures (48x48 px, designed for CSS `border-image` 9-slicing).

Full original downloads (750 and 1078+ files respectively) are not vendored
into this repo — only the handful of files actually used are, listed below
for full provenance. Both packs are versioned CC0 releases hosted
indefinitely at the URLs above if the originals are ever needed again.

## Icons extracted (`src/client/sprites/ui/icons/`, native 16x16 PNG, no edits)

Coordinates are read off `1-bit-pack/Tilesheet/colored.png`'s 16px grid
(17px pitch: 16px tile + 1px spacing), the same methodology this project
already used for the CraftPix tileset (see PROCESS.md) — a rendered,
scaled, grid-lined overlay was used to locate each tile precisely rather
than guessing from the thumbnail.

| File          | Tile (col,row) | Used for                              |
|---------------|-----------------|----------------------------------------|
| `heart.png`   | (39, 10)        | Player/base HP                        |
| `medkit.png`  | (46, 10)        | Medkit inventory                      |
| `skull.png`   | (38, 11)        | Downed/dead status, Game Over         |
| `shield.png`  | (39, 4)         | Wall level/HP                         |
| `coin.png`    | (22, 4)         | Shared XP                             |
| `house.png`   | (41, 16)        | Day / base                            |
| `trophy.png`  | (40, 16)        | Victory screen                        |

## Panels (`src/client/sprites/ui/panels/`)

| File                   | Source                       | Used for                                |
|------------------------|-------------------------------|-------------------------------------------|
| `panel-grey.png`       | `9-Slice/Ancient/grey.png`   | Kept for provenance (unmodified original) |
| `panel-grey-dark.png`  | derived from the above        | Default HUD/menu panel chrome             |
| `panel-green.png`      | `9-Slice/Colored/green.png`  | Kept for provenance (unmodified original) |
| `panel-green-dark.png` | derived from the above        | Victory screen panel                      |
| `panel-red.png`        | `9-Slice/Colored/red.png`    | Kept for provenance (unmodified original) |
| `panel-red-dark.png`   | derived from the above        | Game Over screen panel                    |

The `-dark` files are the pack's own textures with RGB uniformly scaled down
(an automated per-pixel multiply, not hand-edited — see `darken.js` in this
folder, a standalone one-off script, not part of the build; needs `pngjs`
installed to re-run) to push them toward the brief's "dark grey and military
green" palette and to give light HUD text enough contrast against them. This
is a derivative/modified version of the art, which is exactly what the
CraftPix pack this replaces explicitly forbids — CC0 has no such
restriction, so it's unproblematic here. CSS `filter` was tried first and
rejected: applied to the live element it also darkens the text/icons drawn
on top of the panel, not just the panel texture.
