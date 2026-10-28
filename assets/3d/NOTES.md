# 3D model sources (feature/3d-migration)

All models below are **CC0 1.0 Universal (public domain)** — no attribution
required, redistribution explicitly permitted. Vendored here (not
hotlinked at runtime) per good practice for a deployed app with no
third-party runtime dependency.

## Player character (Phase 3)

**Rifleman** — Gobkit Free Character Pack Vol.4 (`human004/Rifleman.glb`)
Source: https://github.com/Ariescar/gobkit-free-assets (CC0, confirmed via
that repo's own `LICENSE` file, not just its README's claim)
A rigged low-poly chibi-style humanoid, already modeled holding a real
rifle (not a primitive). Animation clips: `Idle`, `Walk`, `Run`, `Attack`,
`Hit`, `Death`, `Special`. Used for all four player character slots
(character-select skin variants applied via material tint, matching the
2D client's 4-colour roster, since Gobkit's human character packs are
reskins of the same base rig).

## Zombies (Phase 4)

- **normal** — `WardPatient` (Gobkit Character Pack Vol.5,
  `human005/WardPatient.glb`) — bandaged hospital-patient figure on an IV
  stand prop; reads as "turned patient" without needing a custom undead
  sculpt. Same 7-clip animation set as Rifleman.
- **flying** — `Bat` (Gobkit Animal Pack Vol.1, `animal/Bat.glb`) — small
  rigged flying creature, clips `idle/attack/dead/walk`.
- **giant** — `BloodironJuggernaut` (Gobkit Character Pack Vol.10,
  `human010/BloodironJuggernaut.glb`) — oversized horned ogre with a
  spiked club, visually reads as "giant" at the 2D client's existing
  giant-zombie scale multiplier.
- **boss** — `OrcWarbandChampion` (Gobkit Character Pack Vol.6,
  `human006/OrcWarbandChampion.glb`) — armoured horned orc with a battle
  axe and spiked pauldron, distinct silhouette from the giant.

## Environment (Phase 5)

- **Nature Kit** (Gobkit, `environment/*.glb`) — trees (TreeHigh/TreeMed/
  TreeLow), bushes, rocks — used for terrain.ts's existing prop placement
  logic, same positions, 3D meshes instead of Canvas sprites. Static (no
  rig).
- **Abandoned vehicle** — `vehicle-truck-*.glb`, Kenney/KenneyNL
  Starter-Kit-Racing (MIT license — see
  https://github.com/KenneyNL/Starter-Kit-Racing/blob/main/LICENSE,
  copyright Kenney). Static mesh, used at terrain.ts's existing wreck
  positions along the road network.
- Buildings/walls/turrets/fortress structures: **no suitable licensed
  asset found** after checking Kenney, OpenGameArt, itch.io CC0 packs,
  and the Gobkit manifest (none of the reachable sources had direct
  CC0 GLB building/wall/turret models, only JS-gated itch.io download
  flows this sandbox's fetch tool cannot complete). These are built as
  original, hand-authored Three.js geometry (boxes/extrusions with
  PBR materials for brick/concrete/metal/roofing), matching the exact
  fixed rectangles already in obstacles.ts/defense-config.ts. Labeled
  here explicitly per CLAUDE.md's "say so plainly rather than silently
  substituting a thin placeholder" rule — this is original geometry, not
  a primitive placeholder: multi-part construction with proper materials,
  not a single untextured box.

## Weapon (Phase 3)

The Rifleman model's built-in rifle mesh is reused directly (already
correctly hand-attached to the model's right-hand bone by its original
author) rather than building a separate weapon mesh — this is the
"correct hand attachment" and "must not look like a rectangular
placeholder" requirement satisfied by construction, not by hand-tuning an
offset.

## Download provenance

Fetched via direct HTTPS from:
- `https://gobkit.com/freebies/<pack>/<Model>.glb` (Gobkit's own CDN,
  CORS-enabled, matches the manifest at https://gobkit.com/api/free)
- `https://raw.githubusercontent.com/KenneyNL/Starter-Kit-Racing/main/models/vehicle-truck-red.glb`

No model was generated or altered; files are used as downloaded.
