# Process overview

## What I built

Last Stand is a cooperative zombie survival game for up to four players. Players defend one base through 28 days of zombie waves, earn shared XP, build defences, and rescue teammates. My goal was to make cooperation part of the gameplay rather than simply placing multiple players on the same screen.

The game uses WebSockets for real-time synchronisation and SQLite for persistence. Players share resources and consequences, but each has their own health and survival status.

## How I worked

I used Claude Code as my main coding agent. I decided what the game should do, explained the requirements, reviewed implementations, and requested corrections when something did not match my expectations.

I chose Node.js and TypeScript for both the client and server to keep development easier to follow. WebSockets allowed direct real-time communication without a larger framework, although more networking logic had to be implemented ourselves. SQLite suited the single-machine Fly.io deployment without requiring an external database. Canvas2D kept rendering simple and gave me control over the game's visual presentation.

The first server implementation is recorded in [`5b680de`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-adam2221114/commit/5b680de).

I used `CLAUDE.md` to define rules about server authority, persistence, testing, and scope. The checks in `spec/` protected important game behaviour. My workflow gradually changed from accepting Claude's reports to asking for specific evidence through tests, WebSocket state, and actual gameplay.

## The moments that mattered

### 1. Turning a single-player prototype into multiplayer

**What happened:** The early version supported only one player. Although shared XP already existed, there was no real cooperation because two people could not play together.

**What I did:** I directed Claude to make the server manage several players and broadcast the same world state to everyone. The changes are recorded in [`0dc526a`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-adam2221114/commit/0dc526a) and [`043c541`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-adam2221114/commit/043c541).

This introduced another problem: two players could try to spend the same XP simultaneously. I chose **first-committed-wins**. The server processes requests in order, rejects invalid later requests, and does not charge the rejected player.

I preferred this over client-side locking or a request queue because it kept the server authoritative without adding unnecessary complexity. The trade-offs are documented in the [concurrency ADR](docs/decisions/0001-simultaneous-build-conflicts.md).

**What I learned:** Multiplayer requires more than synchronising positions. It also needs clear rules for shared decisions and conflicting actions.

### 2. A turret problem that was not actually a damage bug

**What happened:** During playtesting, turrets appeared ineffective against zombies. I initially thought their damage was too low or not working.

**What I did:** Instead of immediately changing the damage values, I had Claude inspect the server's authoritative zombie HP while turrets attacked.

The investigation showed that damage was being applied correctly. The real problem was missing visual feedback. Zombies had no visible health bars, so players could not tell whether attacks were working.

**How I knew:** The correction added visible zombie HP feedback without changing the damage calculation ([`33c50c0`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-adam2221114/commit/33c50c0)).

**What I learned:** What looks broken is not always the actual problem. I became more careful about checking game state before asking Claude to rewrite working logic. This principle was also recorded in `CLAUDE.md`.

### 3. Fixing zombies that became stuck near buildings

**What happened:** After adding obstacles, some zombies became permanently stuck near building corners. This prevented them from reaching the base and disrupted the wave progression.

**What I did:** I asked Claude to investigate the movement system rather than simply remove obstacles. The problem involved the precomputed flow field and collision boundaries. Sometimes the movement direction pointed into an obstacle, leaving the zombie unable to move.

I chose to preserve the existing flow field instead of introducing more complex dynamic pathfinding. The fix added a local steering fallback when a zombie became blocked.

**How I checked:** The investigation tested 1,405 accessible grid cells and examined whether zombies could become permanently trapped. The map-related checks in `spec/` and the pathfinding constraints in `CLAUDE.md` help protect this behaviour.

**What I learned:** A good correction should solve the underlying problem without replacing an entire working system. This reinforced my preference for focused changes supported by repeatable tests.

### 4. Trying 3D and deciding to return to 2D

**What happened:** I wanted to improve the game's appearance, so I asked Claude to experiment with Three.js on a separate `feature/3d-migration` branch, keeping the existing 2D game available.

The experiment introduced problems with character movement, aiming, animations, and visual consistency. For example, WASD movement initially did not match the camera's direction.

**What I did:** Claude corrected part of the movement problem using camera-relative controls ([`b1bf520`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-adam2221114/commit/b1bf520)). However, I was still dissatisfied with the overall result.

I decided that continuing the migration would increase complexity without clearly improving cooperation. I abandoned the experiment and removed the 3D implementation ([`f6269ec`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-adam2221114/commit/f6269ec)).

**What I learned:** Time already spent on an implementation is not a reason to keep it. Returning to Canvas2D allowed me to focus on a playable and consistent final game.

### 5. Finding a server shutdown problem

**What happened:** The Node.js server could hang during shutdown when WebSocket connections remained open. This created a risk for restarting the application on Fly.io.

**What I did:** I had Claude reproduce the problem using a minimal server rather than guessing at the cause. The investigation showed that open WebSocket connections prevented the HTTP server from closing properly.

The fix explicitly terminated those connections during shutdown ([`ba5f86a`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-adam2221114/commit/ba5f86a)).

**How I checked:** A subprocess regression test sent `SIGTERM` and checked that the server exited within the required timeout. The test also checked the saved SQLite state. The initial fix was verified locally rather than through a production redeployment.

**What I learned:** Passing gameplay tests does not prove deployment reliability. Server lifecycle behaviour and persistence need their own checks.

## Verification and reflection

I used automated tests, browser testing, WebSocket inspection, and SQLite checks for different kinds of evidence. Tests protected rules, server messages showed authoritative state, and actual gameplay revealed problems that automated checks could miss.

I also encountered misleading test failures caused by stale development processes and shared test state. This led to stronger environment-isolation rules in `CLAUDE.md`.

The biggest lesson was that AI-generated code still requires human judgement. Claude helped me implement features quickly, but I needed to define the goals, question unexpected results, and sometimes reject an entire direction.

I now see good agentic development as directing and verifying work, not simply accepting code that appears to run. More detailed historical evidence is preserved in the [Process History Archive](docs/process-history.md), while unresolved operational limitations are documented in [PendingRepair.md](PendingRepair.md).