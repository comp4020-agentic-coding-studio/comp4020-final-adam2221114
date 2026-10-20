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
- any zombie pathfinding beyond a single static, precomputed flow field toward the base (no per-target dynamic search, no runtime recomputation — see Gameplay invariants' Map/obstacles entry)
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

Superseded by Crit 10 (2026-10-08): the single-turret, 3-level-wall,
one-zombie-type, no-player-damage design below (zombie HP 90 / "three
pistol hits", one turret, wall levels 1-3, zombiesForDay formula) was
Crit 8/9's scope. Crit 10 explicitly replaced it with the 28-day/4-type
zombie table, 5-level wall, up to 4 independent turrets, and player HP/
downed/dead/revive/medkits. The rules below describe the CURRENT system;
see PROCESS.md's Crit 10 entry for what changed and why, and
docs/decisions/ for the one documented concurrency-style decision that
entry links (simultaneous turret build/upgrade/repair conflicts).

Map/obstacles (added Crit 11, map-visual pass; wall made dynamic in a later
change)
Buildings (obstacles.ts's BUILDINGS, a fixed hand-placed rectangle list —
town buildings only, not the wall) are real, server-authoritative obstacles:
players and GROUND zombies cannot walk through them. Decorative props
(terrain.ts's trees/bushes/crates/benches/etc.) stay purely cosmetic exactly
as before and never block movement. Flying zombies ignore buildings the
same way they already ignore the wall. Player movement resolves against
buildings with axis-separated collision (obstacles.ts's resolveMove), which
gives sliding along a wall for free instead of a glancing touch stopping
movement entirely.
A ground zombie whose direct line to its current target is blocked by a
building follows a single precomputed flow field toward the base instead
(obstacles.ts's flowDirectionAt) — this is the ONLY pathfinding this project
does: static, built once at startup from one BFS, never recomputed per
zombie or per tick, and never an exact route to a live player (it flows
toward the base only). Do not replace this with per-target dynamic search,
A* against a moving target, or any runtime recomputation.
The BUILDINGS layout must always leave every map cell able to reach the base
— assertMapIsFullyConnected() enforces this at every startup (throws if a
hand-edit to BUILDINGS ever seals off a region) and spec/map-connectivity.
test.ts re-asserts the same thing in CI.
The purchasable Wall's own rectangle geometry (obstacles.ts's
wallRectsForPlayers/wallRectsForZombies, built fresh from wallLevel on every
call) is deliberately NOT part of BUILDINGS or the flow field above — it is
live state that appears/disappears with wallLevel, and folding it into the
flow field's BFS would mean recomputing that field whenever a wall is
built/destroyed, which conflicts with the flow field's own "never
recomputed" invariant. Instead, movePlayer and advanceZombie each take the
current wallLevel and resolve collision against the wall's rects directly
(still via the SAME resolveMove axis-separated collision function
buildings use — not a parallel copy), independent of the flow field
entirely. See the Wall entry below for the wall's own rules, including why
players and zombies see different wall shapes.

Waves
A day advances only after its complete zombie wave (every type, including
any boss) is spawned and defeated.
The wave table (day -> normal/flying/giant/boss counts) is fixed, not a
formula — see game-state.ts's WAVE_TABLE. Day 28 is the final day
(DAY_VICTORY); completing it ends the round in victory.
Spawn pacing is adaptive (spawnIntervalForDay), not a flat interval, so a
late-game day's much larger zombie count doesn't take excessively long to
finish spawning.
Do not reintroduce timer-only day advancement.
At the start of every day (including Day 1's first Start click, but NOT a
mid-day resume or process restart), there is a 5-second intro: players can
move/build/interact, but no zombie spawns until it ends. Alive players heal
DAILY_HEAL_AMOUNT (30, capped at maxHp) at that same moment. This must never
re-fire from a reconnect, a pause/resume, or a process restart — only a
genuine new day (see game-loop.ts's #beginNewDay vs #resetDayCombatState
split, which exists specifically to keep this true).
Zombies
Four types — normal, flying, giant, boss — each with its own HP/damage/
attack-interval/speed in game-state.ts's ZOMBIE_TYPES (boss HP additionally
varies by spawn day, BOSS_HP_BY_DAY). Pistol damage (30) is unchanged, so
"three hits kills a normal zombie" is NO LONGER true (normal HP is 100);
do not reintroduce that specific invariant without also reconciling the
numbers.
Zombies prioritise the nearest alive player within AGGRO_RADIUS; otherwise
they head for the base. Ground zombies (normal/giant/boss) cannot cross an
intact wall to reach anything inside its ring, including a player who
wandered in there — they stop at the wall and attack it instead, same as
before. Flying zombies ignore the wall entirely (ranged attack, "may attack
over walls") and also ignore turrets.
A ground zombie that ends up within melee range of a live turret fights it
instead of its real target — this is what makes turret HP/repair mean
anything; it is a documented assumption (game-loop.ts's #applyZombieHit),
not stated explicitly in the original brief.
A giant deals its explosion damage to every ALIVE player within its
explosion radius when it dies.
Zombie health/type shown in the UI must come from authoritative server
state (ZombieSnapshot.hp/maxHp/type).
Shared XP
XP is a shared team resource.
XP must not automatically create buildings or upgrades.
Players must deliberately spend XP through the base interaction system (or,
for a specific turret, that turret's own menu — see Turret below).
Player HP, downed, dead, revive, medkits
Each player has their own HP (maxHp 100), independent of shared XP.
At 0 HP a player becomes "downed": cannot move or attack, 45-second timer
(DOWNED_DURATION_MS). Another alive player holding E within REVIVE_RANGE for
REVIVE_HOLD_MS (3s) field-revives them to 50 HP with a short invulnerability
window — free, no XP cost. If the timer expires first, they become "dead";
any alive player can pay XP (resurrectCostForDay, scaling by current day) at
the BASE menu to fully resurrect the earliest-dead teammate to 100 HP with a
longer invulnerability window.
A dead or downed player keeps their medkit count; reconnecting must never
grant free HP/XP/medkits (hp/status/medkits are the only durable per-player
fields — see persistence.ts).
Medkits: bought at the base (100 XP each, cap 2 per player), used with H,
take 2 seconds, heal 50 HP, can be moved during but not attacked during, and
are only consumed on an uninterrupted completion — any damage during the
2 seconds cancels the heal without consuming the medkit.
Game Over triggers on baseHp reaching 0 OR every currently-connected player
being downed/dead simultaneously. "Retry Current Day" (only valid from
game_over) restores that day's start snapshot (sharedXp/baseHp/wall/
turrets/player hp-status-medkits) and replays the same day — it does not
reset to Day 1, and does not preserve XP/damage from the failed attempt.
Wall
The wall is a real, physical square obstacle that exists ONLY while
wallLevel > 0 — there is no fixed always-on fortress. It must physically
block ground zombies while it has HP; flying zombies bypass it entirely
(see Zombies above). While wallHp > 0, ground zombies stop at the wall and
attack it; the base must not take zombie damage through it. Only after the
wall is destroyed may ground zombies continue to the base.
Once built, the wall ALSO physically blocks players — a player must walk
through its gate (a gap in the south side, same side PLAYER_START_POS
faces) to get in or out; there is no gate on the side GROUND ZOMBIES see
(obstacles.ts's wallRectsForZombies is solid on all four sides, no gap at
all). This asymmetry is deliberate, not an oversight: it is what keeps "a
player's gate" and "ground zombies cannot cross an intact wall" both true
at once — if zombies shared the player's gated shape, they could simply
walk in through it. Do not give zombies the gated shape without first
reconciling this invariant.
Five levels (game-state.ts's WALL_LEVELS): level 2's ability is a periodic
AOE pulse (not an on-hit reflect); levels 3-4 are an on-hit spike reflect;
level 5 adds both the spike reflect AND a flat 20% damage reduction on
incoming wall damage. A destroyed wall must be rebuilt from Level 1 rather
than restoring its previous level for free — and once destroyed, it stops
physically blocking anyone (player or zombie) until rebuilt, the same as
wallHp reaching 0 already stopped it from damage-blocking the base.
No corner towers exist in this design (cut entirely) — only the plain
square wall.
Turret
Up to MAX_TURRETS (4) independent turrets at once, shared by the whole team
— each with its own id, position, level, HP, and fire cooldown
(persistence.ts's turrets table). A destroyed turret frees its slot.
The player chooses each turret's location when building it; the server
validates both the allowed build ring around the base AND a minimum
separation from any existing turret (TURRET_MIN_SEPARATION).
Building any new turret always costs Level 1's price; upgrading/repairing
an EXISTING turret is a separate, turret-targeted action (not available from
the base menu — see Input and interaction rules) at that specific turret's
own level-based cost.
Levels 2+'s "attacks N targets" / "pierce up to N" are both implemented the
same way — a shot hits the N nearest in-range zombies simultaneously — since
this project's hitscan-only architecture has no projectile/line entity to
pierce along. Level 5's splash is a separate, position-based AOE around the
single primary hit. All levels can hit flying zombies (targeting was never
type-restricted).
Input and interaction rules
Pressing X opens ONE of two contexts, chosen by proximity: near an existing
turret, its own menu (Upgrade This Turret / Repair This Turret, affecting
only that turret); otherwise near the base, the base menu (Build Turret,
Build Wall, Upgrade Wall, Revive Dead Teammate, Buy Medkit). The base menu
must never offer turret upgrade/repair — that split is deliberate, not an
oversight, and a turret in range takes priority over the base when both
overlap.
Do not trust the client when validating interaction range.
The server must independently validate, for every one of these: player
distance from the target (base or the specific turret), available XP,
current building/turret/player state, and (for placement) the build ring
AND minimum separation from other turrets.
Holding E near a downed teammate (REVIVE_RANGE, REVIVE_HOLD_MS) and
pressing H to use a medkit are both separate from the X-menu and have their
own server-side validation (status, range, cost, cooldown/duration).
Invalid actions must not mutate state, and must tell the requester why
(the "rejected" message) rather than silently doing nothing — see the
Crit 9 ADR this generalizes.
UI rules
Clarity is more important than decoration.
The player should be able to understand:
- current day, and the day-intro countdown when one is active
- zombies killed / total zombies in the wave, and each zombie's type
- base HP
- shared XP
- wall HP/state
- every turret's own state (id implicitly, level, HP, position)
- their own HP/status (alive/downed/dead), medkit count, and any teammate's status
- current game phase
Keep Start / Pause / Resume / Retry Current Day / Restart behaviour clear —
Retry Current Day only appears after a Game Over and is distinct from
Restart (which resets to Day 1).
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
- a normal zombie's HP and the pistol's damage together decide how many hits
  kill one — verify the actual numbers in game-state.ts, not a memorised count
- wall blocks base damage while wall HP is above zero; flying zombies bypass
  the wall entirely
- ground zombies cannot pass an intact wall; flying zombies can
- a wave (every type, including any boss) must be cleared before the next day
- turret placement is rejected outside the legal area AND when too close to
  another turret AND once MAX_TURRETS is already built
- purchases (wall, turret build/upgrade/repair, medkit, resurrection) reject
  insufficient XP, and never partially mutate state on a rejected request
- a downed player's 45s timer, field revive (50 HP + brief invulnerability),
  and paid resurrection (100 HP) all behave as specified
- daily healing and the retry-day snapshot never re-apply from a reconnect,
  pause/resume, or process restart — only a genuine new day
- persistence survives process restart, including the multi-turret table and
  per-player identity (hp/status/medkits)
- restart produces the intended Day-1 reset state; retry_day restores the
  CURRENT day's start snapshot without resetting the day counter
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