# Asset source: Top Down Dungeon Pack by Screaming Brain Studios (CC0)

Three 64x64 wall-material sheets from this pack are vendored here (a trimmed
subset of the full pack, which also includes floor tiles and many more
material variants not used by this project) — see `License.txt` in this
folder (copied verbatim from the pack's own) for the full CC0 grant.

**Pack**: Top Down Dungeon Pack by Screaming Brain Studios —
<https://opengameart.org/content/top-down-dungeon-pack>
**License**: CC0 1.0 Universal / Public Domain. No attribution required
(credit is welcomed but explicitly optional, per the pack's own
`License.txt`).

## Files used

- `Walls/Wall-Stone_01-64x64.png` — source for the 2026-11-02 wall visual
  redesign's Level 3 (Stone/Brick Defensive Wall) texture.
- `Walls/Wall-Concrete_03-64x64.png` — source for Level 4 (Reinforced
  Concrete Wall).
- `Walls/Wall-Metal_04-64x64.png` — source for Level 5 (Fortress-Grade Wall).

Three more sheets (`Wall-Brick_01-64x64.png`, `Wall-Concrete_01-64x64.png`,
`Wall-Metal_03-64x64.png`) are also vendored here as alternates considered
during that same pass but not used in the final five-level set — kept for
provenance/traceability rather than deleted, same reasoning as the full
unedited LPC originals under `assets/LPC/`.

See `src/client/sprites/lpc/NOTES.md`'s "Wall levels" entry for exactly
which crop of each sheet was used, how it was processed (downscale/tint/
hand-drawn detail), and where the generated per-level tiles actually live
(`src/client/sprites/lpc/fortress/wall-level-*.png`).
