# Last Stand

A small cooperative zombie base-defence game: up to 4 players survive 28 days of waves, earn shared XP, and decide together how to defend one base — a wall, up to four turrets, and each other, since a downed teammate needs a hand up before the timer runs out. The per-crit sections below record how the scope grew; the game itself is always the current state of the code, not any one crit's snapshot of it.

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

## Gameplay expansion scope

The full 28-day wave table is live: four zombie types (normal, flying,
giant, a boss on days 5/10/20/28), each with its own behaviour — flying
zombies attack from range and ignore the wall, giants explode on death, a
ground zombie that reaches a turret fights it instead of passing by. Zombies
now threaten players directly, not just the base: HP loss can down a
player (field-revivable by a teammate holding E, or paid-resurrectable at
the base once truly dead), and medkits give players an active way to look
after themselves and each other. The wall now has 5 levels and up to 4
independently-built, independently-upgraded, independently-repaired turrets
can stand at once, each a real choice of where to spend shared XP. A day
now opens with a 5-second countdown and a daily heal, and a Game Over can be
retried from that day's own start rather than only ever restarting from
Day 1.

Where the brief left specifics open (turret "pierce"/"splash" with no
projectile system to pierce along, what actually damages a turret, boss
attack stats beyond HP, several interaction ranges), the choice made and why
is recorded in `PROCESS.md`'s gameplay-expansion entry and in code comments
at each value's declaration — not left for a reader to guess at.

## Visual style

Terrain, zombies, the base, the wall and the HUD use the CraftPix "Zombie
Survival" pixel-art pack; the player stays hand-drawn Canvas shapes, since
the pack has no player-character sprite and a mismatched one would read
worse than a clean drawn one. Which of the pack's four reskinned zombie
sets stands in for normal/flying/giant/boss (none are shaped like any of
those roles — see `PROCESS.md`) and a real, unresolved licensing question
about the pack's free-tier terms versus this course's public-repo workflow
are both recorded in `PROCESS.md`'s visual-redesign entry rather than
quietly assumed away.

## What it deliberately leaves out

There are no accounts, public lobbies, crafting systems, inventories, vehicles, weapon attachments beyond the pistol, ammo/durability systems, or large maps. Turret "piercing" and "splash" are a hitscan-based approximation (this project's architecture has no projectile entity), not real projectile physics. The project should become deeper through shared decisions, not through unrelated systems.

## Which claims are checked, and which are judged

The checks in `spec/` can protect concrete rules such as zombie health and weapon damage, wall blocking, wave completion, legal turret placement, persistence, and restart behaviour.

Other parts of “good” cannot be proved by tests alone. Movement must feel responsive, defence choices must feel meaningful, wave difficulty must feel fair, and later multiplayer must actually create cooperation. Those claims need to be judged through playtesting.

## Sources

- The COMP4020 Final Project brief, especially its emphasis on small-scale multiplayer, co-presence, persistence, and defining what “good” means for a specific app.
- Crit 8 playtesting of this build, which changed movement, wall behaviour, wave progression, and turret feedback.
- The Crit 9 brief's call for a single documented decision about concurrent use, which produced the simultaneous-build-conflicts ADR linked above.
- A detailed gameplay-expansion specification (28-day wave table, zombie types, wall/turret levels, player HP/downed/revive/medkits, X-menu redesign) that drove the current scope — see `PROCESS.md`.

This list is intentionally short and includes only sources actually used so far.