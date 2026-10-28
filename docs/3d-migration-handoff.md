# 3D migration — session handoff

This is a working-notes handoff for continuing the `feature/3d-migration`
branch in a future Claude Code session. It is NOT a PROCESS.md replacement
and is not meant to satisfy the course's cited-evidence/word-count rules —
see `PROCESS.md` and `docs/process-history.md` for the graded account.

## Branch / commit state

- Branch: `feature/3d-migration`
- Checkpoint commit: see the top of `git log` on this branch — this file
  is committed in the SAME commit as the rest of this session's work,
  titled `WIP: save 3D migration progress for next session`. Run
  `git log --oneline -1` to confirm the exact hash when resuming.
- `main` is untouched by this branch's work and remains the deployable 2D
  baseline (verify with `git diff main feature/3d-migration -- src/client/main.ts src/client/render.ts src/client/camera.ts` if ever in doubt — only `input.ts`'s
  constructor signature changed, in a behavior-preserving way covered below).

## What's actually done (verified in a real browser, not just compiled)

- **Full 3D scene** at `/3d` (separate route/bundle from `/`): Three.js
  orthographic isometric camera, lit ground plane with baked road texture,
  shadow-casting directional light + ambient/hemisphere fill, fog.
- **Player model**: real rigged, animated humanoid (`rifleman.glb`, CC0) with
  an integrated rifle, correct scale, idle/walk/run/attack/hit/death clip
  state machine driven by server snapshots.
- **Zombie models**: all 4 types (normal/flying/giant/boss) as distinct
  rigged CC0 models, correct scale, idle/attack/death animation, hit-flash
  emissive tint.
- **Structures**: original hand-built geometry for town buildings, the base
  (with blinking antenna), the wall (rebuilt live from `wallRectsForPlayers`
  whenever `wallLevel` changes), and turrets (rotating head tracking the
  live target).
- **Environment**: trees/bushes/vehicle wrecks placed at the exact same
  positions `terrain.ts`'s existing `DECORATIVE_PROPS` already computes for
  the 2D renderer.
- **Combat VFX**: bullet tracers, muzzle flashes, zombie-attack impacts,
  flying-zombie projectiles, giant death explosions, floating damage
  numbers — all driven by diffing real server snapshot fields
  (`shotsFired`, `attacksLanded`, hp deltas), never guessed client-side.
- **Full HUD/menu port**: character select, X-menu (base/turret), team
  panel, phase banners, "new enemy" intros, rejection notices — same logic
  as `main.ts`, reusing `uiIcon()` from `render.ts` directly.
- **A real, fixed rendering bug**: player/zombie models were rendering at
  up to ~48,000× their intended scale (a `Box3.setFromObject()` precision/
  matrix-update bug on freshly-cloned `SkinnedMesh` objects — see "Known
  technical decisions" below). This was the root cause of what earlier
  sessions misdiagnosed as a shadow/fog "dark gradient" bug. Fixed in
  `character.ts`/`zombie.ts`; verified live that all 4 zombie types, the
  wall, and turrets now render at correct, consistent scale.

## What's explicitly NOT done — this is the active task

The user tested the running 3D game and rejected the current control feel.
**Restoring 2D-equivalent controls in 3D is the current, unfinished task.**
Concrete gaps found before this checkpoint (verified live with Playwright
against the real dev server, not assumed):

1. **WASD is not screen-relative.** `movePlayer`/`prediction.ts` map W/S/A/D
   directly to world -y/+y/-x/+x. In 2D this IS screen-relative, because the
   2D camera has no rotation. In 3D, the camera sits at a 45°-azimuth
   isometric angle, so pressing W moves the player toward the
   top-RIGHT of the screen, not straight up — confirmed with a live
   screenshot test (`/tmp/3d-research/preview/before_w.png` /
   `after_w.png` from this session, not committed — reproduce fresh if
   needed). **Fix needed**: derive movement from the 3D camera's own
   projected forward/right vectors on the ground plane, not raw world axes
   — client-side prediction only; the server's `movePlayer` must stay on
   raw world-axis `{up,down,left,right}` input exactly as today (changing
   the WIRE PROTOCOL's meaning of up/down/left/right would be a
   server-authoritative behavior change requiring explicit permission, not
   asked for here). The likely correct approach: keep sending the same
   `{up,down,left,right}` input shape, but have the 3D client itself
   translate "screen-up" key to whichever `{up,down,left,right}` combination
   actually corresponds to "away from camera" at the current fixed
   45°-azimuth — since the camera azimuth is fixed (not player-rotatable),
   this is a static remapping, not a dynamic camera-relative calculation.
2. **No crosshair at all in the 3D client.** Confirmed via grep — no
   crosshair drawing exists anywhere in `src/client/three/`. The 2D
   client's `render.ts` has `renderCrosshair` (a red screen-space + marker)
   — equivalent needed for 3D, likely as an HTML/CSS overlay element (since
   there's no Canvas2D context over the WebGL canvas) positioned from
   `scene3d`'s own camera-to-screen projection of the mouse's ground-plane
   hit point.
3. **No long yellow debug aiming line was found** in the current code
   (`grep -rn "Line\|yellow" src/client/three/` returns nothing matching
   that description) — the user's screenshot may show this from a stale
   browser cache or a build predating this session's fixes. Re-verify
   against a hard-refreshed, freshly-built client before assuming it's a
   new bug to fix.
4. **Aiming/weapon orientation**: the player model's facing
   (`pivot.rotation.y = -facingAngle - Math.PI / 2`) is driven by
   `input.getAimAngle()` for the local player already — this part is
   likely correct already, but needs re-verification once movement is
   screen-relative (since aim direction and move direction are independent
   in both 2D and the requirement).

## Explicit decision this session: NO hold-to-fire, NO new cooldown

The user's brief asked for "continuous firing while holding the mouse
button, subject to the existing attack interval." Investigation found:
**neither the 2D client (`input.ts`) nor the server (`game-loop.ts`'s
`shoot()`) has any fire-rate limit today** — shooting is click-only, one
shot per click, with no cooldown in either client. "Hold to fire" would
therefore be NEW behavior, not a restoration of 2D's feel, and adding a
server-side cooldown is a server-authoritative combat-balance change.

**Decision (user-confirmed this session): keep click-only shooting for
now. Do NOT introduce hold-to-fire or a new server-side shooting cooldown
as part of this control-parity work.** If hold-to-fire is wanted later,
it needs its own explicit scoping (a real cooldown value, applied
identically to both clients) — out of scope for "make 3D feel like 2D."

## Architecture / source files relevant to the current task

- `src/client/input.ts` — shared by 2D and 3D; movement/aim/shoot input
  reading, screen-to-world injected via callback (already refactored,
  verified pixel-identical for 2D — see PROCESS.md's Phase 2 entry).
- `src/client/prediction.ts` — client-side local-player movement
  prediction; duplicates `movePlayer`'s math intentionally (see its own
  header comment) — any WASD remapping must be applied here too, consistently
  with whatever the 3D entry point does, or prediction will visibly diverge
  from the server's reconciled position.
- `src/server/game-state.ts`'s `movePlayer()` — authoritative movement;
  do NOT change its `{up,down,left,right}` semantics without explicit
  permission, since that is the wire-protocol contract both clients and
  the server agree on.
- `src/client/three/scene.ts` — `CAMERA_ELEVATION`/`CAMERA_AZIMUTH`
  constants (55°/45°) and `cameraOffset()` — the fixed camera-relative
  vectors any screen-relative movement remap needs to derive from.
- `src/client/three/main3d.ts` — wires `InputController` for the 3D
  client; this is where a 3D-specific move-key remap would likely live
  (translating "screen-relative WASD intent" into the `{up,down,left,right}`
  shape `prediction.ts`/the server both expect), and where a crosshair
  overlay would be added.
- `src/client/render.ts`'s `renderCrosshair` (line ~1995) — the 2D
  reference implementation to port the *behavior* of, not the Canvas2D
  drawing code itself.
- `src/client/three/character.ts` — player model facing/animation; the
  `-facingAngle - Math.PI / 2` yaw convention is documented in its own
  comment and should not need to change for this work.

## Known technical decisions from this session (for context)

- **The scale bug's root cause**: `THREE.Box3.setFromObject()`'s default
  (imprecise) path ignores skin/bone transforms entirely for a
  `SkinnedMesh`, and even `precise: true` needs an explicit
  `root.updateMatrixWorld(true)` call first, because the skeleton's bones
  are sibling nodes of the mesh in these glTF files, not descendants — so
  Box3's own traversal order alone doesn't update them before computing
  vertex positions. Fixed in both `character.ts` and `zombie.ts` with the
  same two-line fix (`updateMatrixWorld(true)` then
  `setFromObject(root, true)`). This also made `renderer.shadowMap.enabled`
  safe to turn back on in `scene.ts` — it had been disabled as a (wrong)
  workaround for what was actually this scale bug, not a shadow bug.
- **Stale WebSocket test pollution**: extensive manual Playwright testing
  against the shared dev server (port 8080) during the scale-bug
  investigation left stale connections occupying player slots, causing 4
  of 52 tests to fail transiently. Confirmed NOT a code regression by
  re-running the full suite against a freshly isolated server instance
  (52/52 pass). **Lesson for next session**: always run `pnpm test`
  against a fresh, isolated `PORT`/`DATA_DIR` instance (not the shared dev
  server on 8080) if many manual browser sessions were opened first, per
  this file's own verification section below.

## CLAUDE.md requirements still in force (3D migration rules section)

- Server remains authoritative for all gameplay state — nothing in the 3D
  client may decide damage, position validation, XP, or day/wave
  progression. Any WASD remapping must happen in client-side
  presentation/prediction only; the actual wire protocol's
  `{up,down,left,right}` meaning must not change without explicit permission.
- Hitscan-only shooting, finite `PISTOL_RANGE`, and existing damage/cadence
  numbers are unchanged — confirmed no cooldown exists yet; do not add one
  without being asked (see "no hold-to-fire" decision above).
- The existing flow-field zombie pathfinding is unchanged.
- `main` must remain the preserved, playable 2D baseline; all work stays on
  `feature/3d-migration`.
- Do not commit placeholder primitive geometry as "final" without labeling
  it such — not relevant to the current task (no new models needed for
  control-parity work).
- Do not push, merge to main, deploy, or run `/comp4020:ship` from this
  branch without explicit permission.

## Academic integrity / COMP4020 constraints

- `PROCESS.md` must stay within the course's stated 900–1100 word
  indicative length for the final project, citing real commits as evidence
  (uncited claims don't count). The full historical account (~17,000
  words) is preserved verbatim in `docs/process-history.md`, created this
  session — do not delete or rewrite it. `PROCESS.md` itself has NOT yet
  been condensed to the target length as of this checkpoint — a structure
  was proposed to the user but not approved/applied. That remains a
  separate, pending task from the control-parity work.
- Do not fabricate commit hashes, test results, or development events.
  Any new work must be either (a) actually committed before being cited,
  or (b) described as "verified but uncommitted" per the existing pattern
  already used in `PROCESS.md`'s "Starting the 3D migration" entry.
- Do not commit, push, merge, or deploy without explicit user permission —
  this checkpoint commit is the one explicit exception the user granted
  for this session, scoped to a single local WIP commit only.

## Current test/build status at this checkpoint

- `pnpm typecheck` — PASS (no errors).
- `pnpm run build` — PASS (server `tsc` + client esbuild, both clean).
- `pnpm test` — **52/52 PASS**, verified against a freshly isolated server
  instance (`PORT=8094`, `DATA_DIR=/tmp/checkpoint-test-instance`, both
  since torn down — not part of this commit). The shared dev server on
  port 8080 may still have stale connections from earlier manual testing
  sessions; re-verify against a fresh isolated instance again if `pnpm
  test` against port 8080 shows unexpected multiplayer/character-select
  failures (see "Stale WebSocket test pollution" above — this is a known,
  understood non-issue, not a new bug to chase).

## Exact next steps for the resuming session

1. Re-read this file, `CLAUDE.md`'s 3D migration rules section, and
   `PROCESS.md`'s latest entries.
2. Confirm the click-only-shooting decision is still what's wanted before
   touching `input.ts`/`game-loop.ts`'s `shoot()`.
3. Implement screen-relative WASD for the 3D client: translate the fixed
   45°-azimuth camera's forward/right ground-plane vectors into the
   existing `{up,down,left,right}` input shape, applied consistently in
   both `prediction.ts`'s local dead-reckoning and whatever the 3D entry
   point sends over the wire — the server's `movePlayer` semantics must
   not change.
4. Add a 3D crosshair (HTML/CSS overlay recommended, following
   `renderCrosshair`'s 2D behavior, not its Canvas2D implementation) tied
   to `scene3d.screenToWorld`'s ground-plane raycast result.
5. Re-verify aim/weapon orientation still works correctly at all camera
   zoom levels once movement is remapped (they're currently independent
   systems, but worth a fresh live check after movement changes).
6. Test the brief's numbered verification checklist (WASD moves visually
   up/down/left/right on screen, diagonal speed normalized, aim/move
   independence, shooting while moving, zoom accuracy, crosshair matches
   real shot direction, multiplayer consistency) live in a real browser,
   not just via typecheck/build.
7. Run the full regression suite against a FRESH isolated server instance
   before reporting results.
8. Only after the above is both implemented and verified: revisit the
   separate, still-pending `PROCESS.md` condensation task (proposed
   structure already drafted in this session's chat transcript, not yet
   applied to any file).
