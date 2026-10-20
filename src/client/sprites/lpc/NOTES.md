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
  (CharlesGabriel), and Manuel Riecke (MrBeast) for the specific files used
  (see `assets/LPC/base-assets/CREDITS.TXT`); link back to
  <https://opengameart.org/content/liberated-pixel-cup-lpc-base-assets-sprites-map-tiles>.
- LPC Zombie: credit Benjamin K. Smith (graphic artist), Stephen "Redshrike"
  Challener (base character), and Johannes Sjölund (wulax) (animation);
  link back to <https://opengameart.org/content/lpc-zombie>.
- LPC Sara: credit Stephen "Redshrike" Challener (graphic artist),
  William.Thompsonj (contributor), and Mandi Paugh (original character/OGA
  mascot creator); link back to <https://opengameart.org/content/lpc-sara>.

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
