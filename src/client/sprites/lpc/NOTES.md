# In-world art source: Liberated Pixel Cup (LPC) family, OpenGameArt.org

The Crit 11 map-visual pass replaces the CraftPix "Zombie Survival" sprites
(terrain, buildings, player, zombies — see `PROCESS.md`'s visual-redesign
entry) with a curated set of LPC-family assets. Unlike CraftPix's free tier,
which explicitly forbids redistributing source art files (the reason the
*UI* layer was already swapped to Kenney CC0 — see
`assets/ui-kenney/NOTES.md`), every pack below is CC-BY-SA or CC-BY and
explicitly permits redistribution in a public repository with attribution.
Full, unedited originals are vendored under `assets/LPC/` for provenance
(same pattern as `assets/City_Tileset/`); the files here are curated
crops/extracts actually loaded by the game, served the same way the CraftPix
subset was (`src/server/index.ts`'s `serveSprite`).

## Packs used

1. **[LPC] Terrains** by bluecarrot16, with Lanea Zimmerman (Sharm), Daniel
   Eddeland (Daneeklu), Richard Kettering (Jetrel), Zachariah Husiar
   (Zabin), Hyptosis, Casper Nilsson, Buko Studios, Nushio, ZaPaper,
   billknye, William Thompson, caeles, Stephen Challener (Redshrike),
   Bertram, and Rayane Félix (RayaneFLX) —
   <https://opengameart.org/content/lpc-terrains>
   License: CC-BY-SA 4.0 / CC-BY-SA 3.0. Full attribution file at
   `assets/LPC/terrains/CREDITS-terrain.txt`.
   Source file used: `terrain-v7.png` (32px-grid terrain atlas).
   → `terrain/grass.png`, `terrain/grass-light.png`, `terrain/road.png`
   (a "Mudstone_Gray" cobblestone fill — visually the closest match to a
   worn stone road in this atlas), `terrain/road-light.png` (a
   "Stone_White" alt variant), `terrain/dirt.png`.

2. **Liberated Pixel Cup (LPC) Base Assets** —
   <https://opengameart.org/content/liberated-pixel-cup-lpc-base-assets-sprites-map-tiles>
   License: CC-BY-SA 3.0 / GPL 3.0 (OGA-BY 3.0 also offered for the
   individual contributors' own work — see each name below).
   - **Lanea Zimmerman (Sharm)** — `house.png` (building wall tiles),
     `treetop.png` (tree/bush props), `barrel.png`, `chests.png`.
     → `buildings/building-brick.png`, `buildings/building-stone.png`
     (32×32 fill tiles cropped from `house.png`'s brick/stone wall
     regions), `props/tree.png`, `props/bush.png` (cropped from
     `treetop.png`), `props/barrel.png`, `props/chest.png`.
   - **Charles Sanchez (CharlesGabriel)** — `sprites/monsters/bat.png`.
     → `flying/bat-flight.png` (the down-facing 3-frame wingbeat row;
     replaces the procedurally-drawn bat silhouette render.ts used while no
     CC0/CC-BY-SA flying-creature sprite had been found — see
     `PROCESS.md`'s zombie-visual-identity entry. This one exists and fits
     the project's existing 32×32 zombie frame convention).
   - **Manuel Riecke (MrBeast)** — `sprites/people/soldier.png` and
     `soldier_altcolor.png` (two colour variants of the same character —
     grey/blue armour and gold/red armour).
     → `players/soldier-grey/*.png`, `players/soldier-gold/*.png` (4
     directional 9-frame walk cycles each, cropped from the sheet's
     up/left/down/right rows).
   - **Daniel Armstrong (HughSpectrum)** — `tiles/castlewalls.png` (see
     `assets/LPC/base-assets/CREDITS.TXT`'s "Castle work" entry).
     → `fortress/wall-segment.png` (a 32×32 tileable ashlar-stone crop from
     the sheet's solid masonry region, original coords (64,220)-(96,252)).
     Replaces the earlier magenta/yellow "WALL" construction-blockout
     placeholder (render.ts's `drawPlaceholderBlockout`) the purchasable
     Wall used before real art existed at this path.
   - **Daniel Armstrong (HughSpectrum)** — `tiles/castlefloors.png` (same
     "Castle work" credit entry as `castlewalls.png` above).
     → `fortress/floor-pad.png` (a 32×32 tileable blue-grey flagstone crop,
     original coords (192,192)-(224,224)). This file was referenced by
     `sprites.ts`/`render.ts` from the start of the Crit 11 LPC pass but
     never actually added — `renderFortressCourtyardFloor`'s `isReady()`
     check was silently always false, so the fortress interior has been
     rendering its "no art yet" fallback (a flat `#312d26` fill) the entire
     time, not a deliberate design choice. Found and fixed during the
     2026-10-24 visual-overhaul pass after the user reported the fortress
     interior still looking like "a large, mostly empty, dark square" in a
     live screenshot.

3. **[LPC] Zombie** by Benjamin K. Smith, commissioned by castelonia, based
   on the LPC male base by Stephen Challener (Redshrike) and the animation
   work of Johannes Sjölund (wulax) —
   <https://opengameart.org/content/lpc-zombie>
   License: CC-BY-SA 3.0 / GPL 3.0.
   Source file used: the base `Zombie.png` sheet (the LPC "universal"
   64×64-frame layout; damage-overlay variants were not used).
   → `zombies/zombie-walk-{up,left,down,right}.png` (9-frame walk cycle,
   rows 8–11), `zombies/zombie-attack-{up,left,down,right}.png` (6-frame
   slash/attack, rows 12–15), `zombies/zombie-dead.png` (6-frame hurt/death,
   row 20). Used for all three sprited zombie types (normal/giant/boss),
   same as the CraftPix sheet it replaces — giant/boss are still told apart
   by render-time scale/tint only, not distinct art (sprites.ts's own
   documented choice, unchanged by this swap).

4. **[LPC] Sara** by William.Thompsonj, with Stephen "Redshrike" Challener
   (graphic artist) and Mandi Paugh (original character/OGA mascot
   creator) — <https://opengameart.org/content/lpc-sara>
   License: CC-BY 4.0 / CC-BY 3.0 (no share-alike requirement).
   Source file used: `SaraFullSheet.png` (LPC universal 64×64 layout).
   → `players/sara-teal/*.png` (4 directional 9-frame walk cycles, rows
   8–11 — same rows as the zombie sheet above, since both use the LPC
   universal layout).

5. **Princess** (Lanea Zimmerman/Sharm, from LPC Base Assets, see #2) —
   `sprites/people/princess.png`. Same license as #2.
   → `players/princess-blue/*.png` (4 directional 9-frame walk cycles,
   cropped from this sheet's own up/left/down/right rows — a 4-row layout
   like the soldier sheets, not the 21-row universal one Sara/the zombie
   use).

## Required attribution

- LPC Terrains: credit bluecarrot16 and the full contributor list above;
  link back to <https://opengameart.org/content/lpc-terrains>.
- LPC Base Assets: credit Lanea Zimmerman (Sharm), Charles Sanchez
  (CharlesGabriel), Manuel Riecke (MrBeast), and Daniel Armstrong
  (HughSpectrum) for the specific files used (see
  `assets/LPC/base-assets/CREDITS.TXT`); link back to
  <https://opengameart.org/content/liberated-pixel-cup-lpc-base-assets-sprites-map-tiles>.
- LPC Zombie: credit Benjamin K. Smith (graphic artist), Stephen "Redshrike"
  Challener (base character), and Johannes Sjölund (wulax) (animation);
  link back to <https://opengameart.org/content/lpc-zombie>.
- LPC Sara: credit Stephen "Redshrike" Challener (graphic artist),
  William.Thompsonj (contributor), and Mandi Paugh (original character/OGA
  mascot creator); link back to <https://opengameart.org/content/lpc-sara>.
- LPC castle: credit Evert (author), with Sharm and Xenodora
  (collaborators); link back to <https://opengameart.org/content/lpc-castle>.
  Full sheet vendored at `assets/LPC/castle-evert/`; used for the base/
  command-post structure's lookout tower — see `sprites/base/NOTES.md`.

## Four distinct player identities

`colorIndex` 0–3 each get a visually DISTINCT character sheet (not a
palette-swap/recolour tool) so teammates stay identifiable at a glance:
`soldier-grey` (P1/local-player default), `soldier-gold`, `sara-teal`,
`princess-blue` — matching `render.ts`'s existing `REMOTE_PLAYER_COLORS`/
`LOCAL_PLAYER_COLOR` slot order.

## What's unaffected by this pass

The HUD/menu icon and panel layer (`src/client/sprites/ui/`, Kenney CC0) is
untouched — out of scope for this pass, see `assets/ui-kenney/NOTES.md`.
Turrets stay Canvas-drawn geometry (no LPC turret sprite exists; same
"prefer simple Canvas geometry over a mismatched asset" reasoning this
project already applied before — see `sprites.ts`'s own comment), restyled
only in colour to fit the new palette.

## Later change: the fixed fortress became a buildable wall, with real art

A later change (see PROCESS.md) removed the always-on fortress walls/corner
towers and replaced them with the purchasable Wall's own dynamic rectangle
geometry (only present once built, with a gate only on the player-facing
side — see `src/server/obstacles.ts`'s own comment). The corner-tower and
gate-post art slots were cut entirely (no towers in the new design; the
gate renders as open space, not a tile). `fortress/wall-segment.png` (item
2's Daniel Armstrong crop above) was real, finished art from day one of that
change, used for all five wall levels alike (colour/thickness only
distinguished them — see the next entry for why that changed).

## Wall levels (2026-11-02 wall visual redesign): five distinct materials

`fortress/wall-segment.png` is no longer used by the renderer — replaced by
five genuinely different wall MATERIALS, one per `WALL_LEVELS` tier, so an
upgrade reads as new construction rather than the same tile in a different
outline colour (`render.ts`'s `WALL_VISUALS` HP/ability overlay is
unchanged and still draws on top of whichever material is active). Each
level ships two hand-varied 32x32 crops, `-a`/`-b` (`renderWallSegment`
picks between them per grid cell by a position hash, the same pattern
`buildingDamageSeed` already uses for town buildings) so a long wall run
doesn't look like one tile stamped repeatedly.

1. **`wall-level-1-{a,b}.png`** — Wooden Barricade. Base texture: a 32x32
   crop of `assets/LPC/base-assets/tiles/bridges.png` (Lanea Zimmerman/Sharm,
   LPC Base Assets, CC-BY-SA 3.0/GPL 3.0/OGA-BY 3.0 — same pack and licence
   as item 2 above; verified self-tileable before use), darkened slightly,
   with a hand-drawn diagonal support plank and a few rough nick marks
   layered on top in Canvas.
2. **`wall-level-2-{a,b}.png`** — Reinforced Wooden Wall. Same `bridges.png`
   source (a different 32x32 crop, vertical-grain), tinted darker/warmer,
   with drawn metal corner brackets, rivets, and (variant b) an extra rivet
   pair — the "thicker timber, metal brackets" tier. Spike damage begins at
   this level in the real ability table, drawn separately by the existing
   `WALL_VISUALS` tick-mark overlay.
3. **`wall-level-3-{a,b}.png`** — Stone/Brick Defensive Wall. Base texture:
   a 32x32 crop of `Wall-Stone_01-64x64.png` from the **Top Down Dungeon
   Pack** by Screaming Brain Studios — CC0/Public Domain, no attribution
   required (full pack page:
   <https://opengameart.org/content/top-down-dungeon-pack>; the two sheet
   crops actually used are vendored at `assets/TopDownDungeonPack/Walls/`
   with the pack's own `License.txt`) — tinted cool blue-grey (distinct from
   the town buildings' own warm-grey stone fill) with drawn reinforcing
   mortar-joint lines.
4. **`wall-level-4-{a,b}.png`** — Reinforced Concrete Wall. Base texture: a
   32x32 crop of the same CC0 pack's `Wall-Concrete_03-64x64.png`, tinted
   lighter grey, with a drawn panel seam, bolt heads, and rebar hint lines —
   "concrete segments, steel reinforcement."
5. **`wall-level-5-{a,b}.png`** — Fortress-Grade Wall. Base texture: a 32x32
   crop of the same CC0 pack's `Wall-Metal_04-64x64.png` (a rusted
   diamond-plate/armour photo texture), warmed toward this level's own gold
   `WALL_VISUALS` accent colour, with a drawn overlapping armour-plate seam,
   a rivet row, and angular spike silhouettes along the top edge — "heavy
   armoured sections, reinforced metal plating, advanced spikes."

All five were generated with a small local Node/`node-canvas` script (not
checked into the repo — a one-off asset-authoring tool, not game code) that
crops/downscales/tints the licensed source photos and layers the structural
detail (brackets, seams, rivets, spikes) with plain Canvas drawing calls —
the same "prefer simple Canvas geometry" approach this project already uses
for turrets, applied here on top of real licensed material rather than
replacing it, since no single existing asset pack covered this exact five-
tier wood-to-fortress progression at this project's 32x32 top-down scale.
