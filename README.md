# Last Stand

Last Stand is a cooperative zombie survival game for up to four players. Players defend one base through 28 days of zombie waves, earn shared XP, build defences, and rescue downed teammates. Everyone shares the same battlefield and progress.

To try it, open [Last Stand](https://comp4020-final-adam2221114.fly.dev/). Open it in two separate browser profiles to see multiplayer in action. Progress is saved in SQLite and can survive server restarts.

## Why I built this

I enjoy zombie survival games, but I wanted cooperation to matter more than individual performance. My question was: what makes another player useful, rather than just someone else shooting zombies?

I chose base defence because it gives everyone one objective. Decisions about resources and survival affect the whole team.

## What good means here

**Good means cooperation is structural, not decorative.**

Another player's presence should change how I play.

- **Shared progress.** Zombie kills earn XP for the team, not individual players.
- **Meaningful choices.** Players decide whether to build turrets, upgrade or repair defences, or spend XP reviving teammates.
- **Mutual survival.** Downed players need help. Rescuing someone means taking a risk instead of continuing to fight.
- **Real-time cooperation.** Movement, enemies and upgrades are synchronised through WebSockets without reloading.
- **Persistent progress.** The day, base condition, XP and defences are saved in SQLite.
- **Readable gameplay.** Enemy health, defensive indicators and clear controls help players understand the battle.

Depping and Mandryk's research on cooperation and interdependence helped me evaluate why shared responsibility matters more than simply placing players together.

## How multiplayer works

The server controls the shared state and validates player actions.

If two players try to buy the same upgrade simultaneously, the first valid request processed by the server succeeds. The other is rejected without spending XP.

I chose this over client-side locking or a request queue because it keeps the rules simple and resources consistent. The cost is that a player's request may be rejected even if both acted at nearly the same time.

See the [concurrency decision record](docs/decisions/0001-simultaneous-build-conflicts.md).

## What is checked and judged

Tests in `spec/` check gameplay rules, multiplayer restrictions and persistence. They cannot prove that cooperation is enjoyable or the controls feel responsive. Those qualities require playtesting, and I have not established that all 28 days are equally balanced.

## What I left out

I excluded matchmaking, rankings, accounts, crafting and large maps to focus on cooperation. I also tried Three.js but returned to Canvas2D because 3D added complexity without clearly improving gameplay.

## Limits

The game supports four concurrent players on one server. Browser-stored identities are not secure accounts; losing that identity may prevent recovery of the same player record.

## What I looked at

- [COMP4020 Final Project Brief](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/assessments/final-project/) — multiplayer, persistence and defining good.
- [Liberated Pixel Cup](https://lpc.opengameart.org/content/lpc-about) — consistent 2D pixel-art direction.
- [Depping and Mandryk (2017)](https://doi.org/10.1145/3116595.3116639) — cooperation and interdependence.
- [UmaiPixel — Godot 3 Tutorials](https://www.youtube.com/playlist?list=PLyckz_-Rzq6ClGevL2fneJ5YJnMPKWa4M) — general 2D development reference.

## Development evidence

- [Concurrency ADR](docs/decisions/0001-simultaneous-build-conflicts.md)
- [Player Identity ADR](docs/decisions/0002-player-identity-and-authorization.md)
- [PROCESS.md](PROCESS.md) — development decisions and verification.
- [Process History Archive](docs/process-history.md) — earlier experiments, failures and corrections.