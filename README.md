# Last Stand

A small zombie base-defence game about surviving waves, earning shared resources, and deciding how to protect one base. The current Crit 8 build is a proof-of-life slice: the core loop works, progress persists, and the project is ready to grow into multiplayer later.

## What good means here

**Good means cooperation is structural, not decorative.**

The final game is intended for 2–4 friends defending the same base. Multiplayer should not mean several people standing on one map while each person effectively plays alone. Players should depend on the same world state: one base, one wave, one shared XP pool, and the same defences.

A good version of this game should make another player change what I decide to do.

That means:

1. **Progress is shared.** Zombie kills contribute to one XP pool instead of separate personal upgrade trees.
2. **Defence requires choices.** XP does not automatically create upgrades. Players choose whether to rebuild a wall, improve defence, or build a turret.
3. **Defences really matter.** Walls block zombies and absorb damage before the base can be attacked. Turrets occupy chosen positions and attack enemies inside their range.
4. **A day has a clear goal.** The next day begins only when the current wave has been completely defeated.
5. **Actions leave a trace.** Day progress, base state, XP and constructed defences are persisted so returning does not mean starting from nothing.
6. **Controls should feel immediate.** The client can predict local movement for responsiveness while the server remains authoritative.

## Who it is for

The target is a small group of friends, not a public competitive audience. A session should be understandable without accounts, matchmaking ladders, a large lobby, or a long tutorial. The shared problem should be obvious: zombies are approaching, the base has limited protection, and the group has to decide how to spend what it earns.

## Crit 8 scope

This version proves the core loop end-to-end: the player can move, aim and shoot; zombies arrive in waves; kills earn shared XP; XP can be spent through the base menu; walls block and take damage; a turret can be placed inside the build area; zombie HP is visible; days advance only after the wave is cleared; and durable progress is stored in SQLite and survives restart.

Realtime multiplayer and concurrency are deliberately deferred to later crits.

## Crit 9 scope

Multiplayer is now real, not deferred: up to 4 players connect at once, see
each other move and shoot in the same shared world, and spend the same
shared XP pool — a change one player makes reaches every other open session
in about a second, with no reload. A 5th connection is turned away rather
than silently dropping someone already playing.

Two or more players can race to build the same thing (the wall, the turret)
at once. How that's resolved — and why — is written up as an architecture
decision record at
[`docs/decisions/0001-simultaneous-build-conflicts.md`](docs/decisions/0001-simultaneous-build-conflicts.md),
chosen specifically because shared XP and shared build state are the one
place this game's players actually contend with each other.

## What it deliberately leaves out

There are no accounts, public lobbies, crafting systems, inventories, vehicles, weapon attachments, multiple zombie classes, or large maps. Only one turret is currently supported, and later upgrade values are left unset until there is enough playtesting evidence to justify them. The project should become deeper through shared decisions, not through unrelated systems.

## Which claims are checked, and which are judged

The checks in `spec/` can protect concrete rules such as zombie health and weapon damage, wall blocking, wave completion, legal turret placement, persistence, and restart behaviour.

Other parts of “good” cannot be proved by tests alone. Movement must feel responsive, defence choices must feel meaningful, wave difficulty must feel fair, and later multiplayer must actually create cooperation. Those claims need to be judged through playtesting.

## Sources

- The COMP4020 Final Project brief, especially its emphasis on small-scale multiplayer, co-presence, persistence, and defining what “good” means for a specific app.
- Crit 8 playtesting of this build, which changed movement, wall behaviour, wave progression, and turret feedback.
- The Crit 9 brief's call for a single documented decision about concurrent use, which produced the simultaneous-build-conflicts ADR linked above.

This list is intentionally short and includes only sources actually used so far.