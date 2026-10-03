Project intent
This project is a small cooperative zombie base-defence game for 2–4 players.
The design goal is:
Good means cooperation is structural, not decorative.

Players should affect the same shared world: the same base, the same waves, the same shared XP, and the same defensive upgrades. Multiplayer should eventually change strategy and survival, not just show several players on the same screen.
Keep the project small enough to understand, test, deploy, and explain.
Scope rules
Do not add features just because they seem impressive.
Prefer a small, complete core loop over a large unfinished feature list.
Current core loop:
1. Start a day.
2. Zombies attack the shared base.
3. Players kill zombies.
4. Kills add shared XP.
5. Players spend shared XP on base defences.
6. The current day ends only when its wave is cleared.
7. Key progression persists across sessions/restarts.
Do not add the following unless I explicitly ask:
- open world
- accounts/authentication
- matchmaking or public lobby
- multiple maps
- complex inventory
- crafting
- vehicles
- skill trees
- complex zombie pathfinding
- many weapons or attachments
- ammunition/calibre/durability systems
- chat or voice
- multiple turret placement systems
- unrelated polish
When requirements are ambiguous, ask before inventing game rules, prices, balance values, or new mechanics.
Architecture rules
The server is authoritative.
The client may predict or interpolate for responsiveness, but it must not decide authoritative gameplay state.
Authoritative server state includes, where relevant:
- player position used for validation
- zombie position and HP
- base HP
- wall state and HP
- turret state
- shared XP
- day/wave progression
- purchases and upgrades
The client is responsible for:
- rendering
- input collection
- client-side movement prediction
- interpolation
- crosshair and visual feedback
- tracers and muzzle flashes
- placement previews
- menus and HUD
Client-side visual effects must not become a second source of gameplay truth.
Networking rules
Use the existing WebSocket architecture.
Do not introduce another realtime framework without a documented reason.
For shooting:
- keep authoritative hit resolution on the server
- use hitscan rather than networked bullet physics
- client bullet/tracer effects are visual only
For movement:
- local player movement may use client-side prediction
- the server remains authoritative
- reconcile client prediction with server state
- remote entities should use interpolation rather than local authority
Do not duplicate game logic separately on client and server unless the client copy is clearly prediction/preview logic only.
Persistence rules
Persist only durable game progress.
Durable state may include:
- current day
- base HP
- shared XP
- wall level / HP
- turret built state / HP / position
- other future base progression that should survive restart/redeploy
Do not persist high-frequency transient state such as:
- active WebSocket connections
- aim direction
- temporary tracer effects
- live zombie positions
- live zombie target selection
- per-frame player movement state
SQLite is the source of durable state for the current single-machine Fly deployment.
Schema changes must be backward-compatible with existing databases where practical.
Do not silently destroy existing stored progress during a migration.
Gameplay invariants
Unless I explicitly change them, preserve these rules.
Waves
A day advances only after its complete zombie wave is spawned and defeated.
The current wave size rule is:
zombiesForDay(day) = 3 + (day - 1) * 6
Do not reintroduce timer-only day advancement.
Zombies
Normal zombie HP is 90.
Player pistol damage is 30, so a normal zombie requires three successful pistol hits.
Zombie health shown in the UI must come from authoritative server HP.
Shared XP
XP is a shared team resource.
XP must not automatically create buildings or upgrades.
Players must deliberately spend XP through the base interaction system.
Wall
The wall must physically block zombies while it has HP.
While wallHp > 0:
- zombies stop at the wall
- zombies attack the wall
- the base must not take zombie damage through the wall
Only after the wall is destroyed may zombies continue to the base.
Building/rebuilding Wall Level 1 costs 100 XP.
Upgrading an intact wall to Level 2 costs 300 XP.
A destroyed wall must be rebuilt from Level 1 rather than restoring its previous level for free.
Wall Level 2 damages an attacking zombie for 5 damage according to the existing server-side attack rhythm.
Do not invent missing Level 3 prices or new Level 3 abilities unless I specify them.
Turret
Building the first turret costs 200 XP.
Turret Level 1 currently has:
- 50 HP
- server-authoritative targeting
- limited attack range
- slow automatic fire
- server-side instant hit resolution
The player chooses the turret location, but the server must validate that the position is inside the allowed base build area.
Only one turret is allowed until I explicitly change this.
Do not invent Level 2 or Level 3 upgrade prices.
Input and interaction rules
The base interaction menu is opened near the base with X.
Do not trust the client when validating interaction range.
The server must independently validate:
- player distance from the base
- available XP
- current building state
- requested upgrade/build action
- turret placement coordinates
Invalid actions must not mutate state.
UI rules
Clarity is more important than decoration.
The player should be able to understand:
- current day
- zombies killed / total zombies in the wave
- base HP
- shared XP
- wall HP/state
- turret state
- current game phase
Keep Start / Pause / Resume / Restart behaviour clear.
Do not hide important game state behind decorative UI.
When adding visual feedback, prefer simple Canvas geometry over introducing a new rendering framework.
Game-state rules
Use explicit game phases:
- waiting
- running
- paused
- game_over
- victory
When the game is not running, gameplay simulation must not continue advancing behind the UI.
Restart behaviour must be explicit and tested.
Do not silently reset persisted state as a side effect of page refresh.
Testing rules
Do not claim a behaviour works without verifying it.
Prefer tests for important promises and invariants, not test-count inflation.
High-value checks include:
- three pistol hits kill a normal zombie
- wall blocks base damage while wall HP is above zero
- zombies cannot pass an intact wall
- a wave must be cleared before the next day
- turret placement is rejected outside the legal area
- purchases reject insufficient XP
- persistence survives process restart
- restart produces the intended reset state
- client input cannot directly mutate authoritative server state
When testing realtime behaviour, inspect authoritative WebSocket state where useful instead of relying only on screenshots or logs.
If a test script is wrong, say so clearly; do not mislabel a test-script failure as a product bug.
Development workflow
Before changing code:
1. inspect the existing implementation
2. identify the smallest change that satisfies the request
3. preserve existing architectural decisions unless there is a clear reason to change them
After changing code:
1. run relevant focused checks
2. run pnpm typecheck
3. run pnpm check when the app/check harness is available
4. run pnpm check:evidence when relevant
5. run pnpm run build
6. inspect git status
Do not leave test processes or dev servers running accidentally.
Be alert for stale tsx / Node processes, stale build output, or stale SQLite data before diagnosing a new bug.
Do not treat old dist/ output as evidence that current source code works.
Git rules
Make small commits around coherent changes.
Do not push unless I explicitly ask.
Do not deploy unless I explicitly ask.
Do not run /comp4020:ship unless I explicitly ask.
Before any push, deploy, or ship:
- confirm the working tree state
- confirm tests/checks
- confirm no secrets are tracked
- confirm mise.local.toml is ignored
- confirm data/ is ignored
- confirm generated dist/ output is not accidentally committed
Do not rewrite history or force-push unless I explicitly request it.
Secrets
Never print, commit, or expose Fly tokens or other secrets.
mise.local.toml is local-only and must remain ignored.
If a secret appears in output, do not repeat it unnecessarily.
Fly deployment rules
The deployed app must keep using the persistent Fly volume at /data.
The application should read the database location from DATA_DIR.
A successful deploy is not enough by itself.
When I ask to verify persistence, test that meaningful game state survives:
1. normal browser return
2. process/machine restart
3. redeploy, when requested
Do not claim Fly persistence is verified until the deployed version has actually been tested.
Documentation and process evidence
README.md explains what “good” means for this project.
PROCESS.md explains important decisions, trade-offs, corrections, and how the work changed.
Do not turn PROCESS.md into a raw chronological log.
Record meaningful corrections, including cases where testing or real use changed the design.
Examples from this project include:
- stale Node/tsx processes causing misleading behaviour
- stale build output causing false conclusions
- main.js missing because the dev command did not build the client
- DATA_DIR disagreement between runtime and CI
- interpolation that was technically smooth but still felt wrong in play
- a decorative wall becoming a real blocking defence after playtesting
- timed day progression changing to wave-clear progression
- turret damage appearing broken until authoritative HP was inspected and the real problem was found to be missing visual feedback
Do not invent sources, results, tests, user feedback, or process events.
Course / Crit rules
For Crit 8, proof of life matters more than feature count.
A stranger should be able to open the deployed app, perform the core interaction, and leave durable progress that is still present when they return.
Realtime multiplayer is a later requirement; do not force unfinished multiplayer into Crit 8 only to increase scope.
The project must remain explainable: every major feature should support the core idea rather than exist only because it can be built.
Agent behaviour
Be conservative with scope.
Do not silently make product decisions for me.
When I give a concrete requirement:
- implement that requirement
- avoid unrelated refactors
- avoid adding adjacent features
- report important trade-offs
- report any assumptions
- report what was actually verified
If something is not verified, say that it is not verified.
If the implementation already works and the problem is only presentation or feedback, diagnose that before rewriting working logic.
When a requested change conflicts with an existing rule in this file, stop and point out the conflict before changing it.