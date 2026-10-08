# Process overview

A cooperative zombie base-defence game with the server as the sole source of truth and the client limited to rendering, input, prediction and interpolation. I used Claude Code as a pair-programmer: I defined the scope and constraints for each round, reviewed the result in the running game, corrected behaviour that did not match my intent, and had Claude implement and verify the resulting changes. Each round landed as its own commit so regressions could be traced back to one scoped change. This account focuses on corrections that changed the design rather than listing every feature.

## Stack

Node and TypeScript run on both sides, with a raw `ws` WebSocket connection instead of a higher-level realtime framework, `better-sqlite3` for persistence, and a hand-rolled Canvas2D renderer rather than a game engine or UI framework. The project started from the course placeholder container; the first step replaced it with a minimal Node HTTP server that still satisfied the starter contract at `/` and `/readme/` before any game logic existed, so later work built on something already known to deploy correctly ([`5b680de`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-adam2221114/commit/5b680de)). The server owns authoritative gameplay values. The client mirrors only the small subset of configuration it needs for previews and display, while the server independently validates costs, ranges and placement rules.

## Workflow

Each round began with a narrow, explicit scope: a short numbered brief plus a list of what not to add. After implementation, I verified behaviour against a real running instance rather than relying on unit tests alone. The most useful habit was checking authoritative WebSocket state directly whenever a claim concerned server truth, using a headless browser when the claim concerned what a player actually saw, and querying SQLite directly to confirm persistence rather than trusting a restart that merely looked correct. This prevented several test mistakes from being mislabelled as product bugs and kept corrections focused on the actual problem.

## Corrections that changed the design

**Dev server never built the client.** `pnpm dev` only watched `src/server`, so a fresh checkout had no `dist/client` and `/main.js` returned 404 even though the HTML and route were correct. I changed the dev workflow so the client is built before the server watch starts ([`4fd7d41`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-adam2221114/commit/4fd7d41)). This mattered because a marker will run the project from a cold state, so the development command needed to work without relying on stale build output.

**CI's `/data` mount and `DATA_DIR` disagreed.** The workflow mounted a temporary `/data` directory for checks but did not set `DATA_DIR`, so the application would have fallen back to another path and silently ignored the mounted database location ([`7760964`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-adam2221114/commit/7760964)). It had not failed yet, but it would have hidden persistence bugs later. Fixing the environment contract early made local, CI and Fly behaviour agree.

**Snapshot interpolation alone did not feel right.** Interpolating between server snapshots made movement visually smoother, but the local player still waited for a round trip before movement appeared, so the controls felt delayed. I replaced that with client-side prediction for the local player and reconciliation against server snapshots ([`537e681`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-adam2221114/commit/537e681)). The server still decides the real position; prediction only improves responsiveness before the next authoritative correction arrives.

**Days advanced on a timer.** The first design allowed a day to end while zombies were still alive, which did not match the idea of defending against a wave. I changed progression so the next day begins only when the full zombie quota has spawned and been defeated ([`a9c79c6`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-adam2221114/commit/a9c79c6)). This made the progression rule match the player's mental model of clearing a wave rather than simply surviving a clock.

**The wall was cosmetic.** The original wall was only a drawn ring and did not stop zombies from reaching the base. That made the word "wall" misleading and gave the upgrade no meaningful defensive role. I changed it into real combat state with its own HP that physically blocks zombies and absorbs damage until destroyed ([`a9c79c6`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-adam2221114/commit/a9c79c6)). A named defence mechanic should actually alter the game's survival logic before more systems are layered on top of it.

**Wall-building was automatic.** Reaching 100 shared XP originally created a wall automatically, which removed any decision from the shared economy. I replaced that with an explicit `X` interaction near the base, where the player chooses how to spend XP and the server independently validates range, cost and current building state ([`3e680c9`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-adam2221114/commit/3e680c9)). This turned shared XP from a passive threshold into a resource that supports deliberate defensive choices.

**Turret placement was fixed.** The first turret worked, but it always appeared at one hardcoded position, so building it involved no placement decision. I changed it so the player chooses a location and the server validates that the requested position falls inside the allowed build area around the base ([`33c50c0`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-adam2221114/commit/33c50c0)). The same server-authority rule that already governed combat and purchases therefore also applies to building placement.

**"Turret damage has no effect" was not a logic bug.** During playtesting the turret looked ineffective, but before changing damage values I inspected authoritative zombie HP while the turret fired and confirmed the damage was already being applied correctly. The real problem was presentation: zombies had no visible health feedback, so slow damage looked like no damage at all ([`33c50c0`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-adam2221114/commit/33c50c0)). The correction was to add zombie health bars rather than arbitrarily increasing turret damage. This reinforced a useful rule for the project: diagnose state first, then decide whether the problem is logic or feedback.

## Crit 9: single-player to real multiplayer

Crit 8's server tracked exactly one WebSocket connection and one player —
deliberate for that week, but it meant the project wasn't actually
cooperative yet, just a single-player slice with shared-economy code sitting
unused. For Crit 9 I converted `GameLoop`'s single `Player`/`InputState`
fields to a map keyed by an ephemeral per-connection id, had `ws-server.ts`
track every open socket instead of replacing the last one, and broadcast the
same snapshot (now carrying a `players[]` array) to all of them
([`0dc526a`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-adam2221114/commit/0dc526a)).
The client picks itself out of that array using a `welcome` message the
server sends right after connecting, applies prediction only to itself, and
interpolates everyone else exactly like it already did for zombies
([`043c541`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-adam2221114/commit/043c541)).
The session caps at 4 players (README's own "2-4 friends" scope); a 5th
connection gets a `full` message and is closed.

**Simultaneous build/upgrade/placement races needed a decision, not just
code.** Once several players can reach the same X-menu, two of them can both
try to build the wall (or the turret) at once. The existing server-side
checks already resolve this correctly — Node processes one message at a
time, and `interact()`/`placeTurret()` already re-read current XP/build
state at call time, so the loser's request naturally fails against
already-updated state and shared XP is never double-spent. What Crit 8 never
needed was telling the loser why nothing happened: a failed check used to
just log and silently no-op, which is fine with one player and confusing
with several. I changed those checks to return a reason
([`0dc526a`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-adam2221114/commit/0dc526a)),
and the server now relays it only to the socket whose request lost the race,
as a `rejected` message the client shows briefly near the HUD. The full reasoning, including
the alternatives I considered (client-side locking, a visible request
queue) and what this costs, is recorded as an ADR at
[`docs/decisions/0001-simultaneous-build-conflicts.md`](docs/decisions/0001-simultaneous-build-conflicts.md).

I did not add a `players` table to SQLite for this. Per `CLAUDE.md`'s own
persistence rules, a connection id and a live position are exactly the kind
of per-frame, per-socket transient state that's explicitly excluded from
durable storage, and there's still no per-player durable value to store —
XP stays one shared pool, there are no accounts. A stale comment in
`persistence.ts` had guessed a players table would be needed here; I
corrected it instead of adding a table nothing actually required.

That conclusion didn't survive the next round of requirements — see below:
once players have their own HP and a downed/dead status that must survive a
reconnect, there genuinely is a per-player durable value, and a `players`
table became the right call after all. Recorded here rather than edited away
so the reasoning that was correct for Crit 9's actual requirements stays
visible, not just the part that changed.

## Gameplay expansion: zombie types, 28-day waves, player HP, multi-turret, medkits

A large, explicitly-specified round: four zombie types (normal/flying/giant/
boss) replacing the single type and linear day formula; zombies now damage
and down/kill players, not just the wall/base; downed players can be field-
revived (hold E) or, once dead, paid-resurrected at the base; up to four
independently-built/upgraded/repaired turrets replacing the single turret;
a 5-level wall whose level 2 ability changed shape (a periodic AOE pulse,
not an on-hit reflect); medkits; a day-start countdown with daily healing;
Game Over's "Retry Current Day" snapshot/restore; and browser-persistent
player identity so a reconnect resumes the same HP/status/medkits instead of
joining as someone new.

**The brief left real decisions open on purpose, and I made them rather than
guessing silently** — each is called out in a code comment at its point of
use, not just here:

- **Turret "pierce"/"multi-target" has no projectile to pierce along.** This
  project's architecture deliberately has no bullet/line entity (`CLAUDE.md`:
  hitscan only). "Attacks 2 targets" and "pierce up to N" are both
  implemented the same way — one shot simultaneously hits the N nearest
  zombies in a turret's range — rather than inventing a line-raycast system
  the rest of the codebase has no equivalent for.
- **Turrets needed to be attackable for "repair" to mean anything.** The
  brief specifies turret HP and repair cost but never says what damages a
  turret. I made ground zombies that end up within melee range of a live
  turret fight it instead of their real target (`game-loop.ts`'s
  `#applyZombieHit`) — the only way the repair system has a purpose. Flying
  zombies ignore turrets the same way they ignore the wall.
- **Boss damage/attack-interval/speed aren't in the brief** ("basic melee
  attacks initially... keep extensible") — only each boss's HP is specified.
  I picked one flat melee profile reused across all four bosses
  (`ZOMBIE_TYPES.boss` in `game-state.ts`) rather than inventing four
  different kits.
- **The day-start retry snapshot is in-memory only, not SQLite.** A process
  restart mid-day already loses live zombie/spawn-queue state under this
  project's existing persistence rules (nothing new here — Crit 8's
  single-type version had the same limitation, documented in
  `PendingRepair.md`'s history). `retryDay()` falls back to the last
  *persisted* state if a restart happened since the day began, rather than
  failing outright — a degraded case I'd rather document than silently
  pretend doesn't exist.
- **Several numeric ranges weren't specified**: melee contact distance,
  flying attack range, revive range, turret minimum separation, wall pulse
  radius, turret splash radius. Each has a one-line comment at its
  declaration in `game-state.ts` explaining the choice; none of them are
  balance-critical enough to need a design conversation on their own, but
  they're not hidden either.

One pre-existing invariant this round genuinely breaks: `CLAUDE.md` used to
state "normal zombie HP is 90, so three pistol hits kill one." Normal zombie
HP is now 100 by explicit specification, and pistol damage wasn't asked to
change — `CLAUDE.md`'s Gameplay invariants section has been rewritten to
match the current numbers rather than silently leaving the old, now-false
claim in place.

## Visual redesign: CraftPix pixel-art assets

Replaced the plain black/grid Canvas placeholder with the CraftPix "Zombie
Survival" freebie pack: a tiled ground layer and scattered decoration (city
tileset), animated per-type zombies (four reskinned enemy sets), a real base
sprite, a textured wall ring, and HUD icons. The player stays a drawn Canvas
shape by explicit instruction — the pack has no player-character sprite, and
a mismatched placeholder sprite would be worse than a clean drawn one.

**A real licensing question, not resolved, deliberately proceeding anyway.**
CraftPix's free-tier license permits using the assets in a deployed game but
explicitly says *"You can NOT resell the art source files... or a slightly
modified version of the art,"* drawing the line at *"an app that uses the art
as part of the play of the game is fine [...] an app that allows the user to
save or export [...] the artwork itself is not fine."* This course's normal
workflow makes assessment repos public on GitHub, which puts the raw PNG
files (committed under `src/client/sprites/`) in a public, clonable,
downloadable location — arguably exactly what that clause is written against,
though the clause doesn't contemplate "public source repo" specifically. I
flagged this before touching any code; the call to proceed anyway is mine to
honour, not mine to make — recorded here so it isn't silently forgotten. If
this matters for submission, it's worth a direct question to the course
convenor or CraftPix support before the repo goes public.

**Zombie type -> sprite set is an arbitrary, documented mapping, not a
semantic one.** All four `Enimies_N` sets in the pack are palette-swapped
reskins of the same civilian-zombie character — none is shaped like a
flyer, a giant, or a boss. normal/flying/giant/boss are told apart at
render time by scale, a hover motion + glow (flying), and a larger size +
glow (giant/boss) — see `render.ts`'s `ZOMBIE_RENDER` table — not by
different art. This was a deliberate choice over inventing a shape the pack
doesn't have.

**Tileset region coordinates were read off a rendered, labelled grid
overlay, not guessed from the thumbnail.** `City_Tileset/PSD/Tile.png` has
no accompanying per-tile metadata beyond a generic `Tile.tsx` (16px grid,
374 tiles, no names). I rendered the sheet through a scaled, grid-lined,
coordinate-labelled HTML page via a headless browser, read off exact pixel
regions for the ground tiles, trees, bushes, fence panels, doors and small
props, and visually re-verified each crop before using it — several initial
guesses (pavement, bench, both doors) were off by one or more tiles and
were corrected this way rather than shipped unchecked.

**Found and fixed in passing: a pre-existing file was collaterally deleted
by the asset re-import, breaking the course's own baseline check.**
`assets/readme-template.html` — unrelated to CraftPix, committed since
`5b680de`, read by `render-readme.ts` to serve `/readme/` — was missing from
disk (`git status` showed it as deleted) after the CraftPix pack was copied
into `assets/`, almost certainly because the import replaced the whole
folder rather than adding to it. This crashed the server on the first
request to `/readme/` and failed `spec/invariants.test.ts`'s "publishes
README.md at /readme/" check — one of the two fixed invariants this project
treats as never-break. Restored with `git restore` (the file was tracked,
untouched otherwise); every other `assets/` change is exactly the CraftPix
import, left alone.

**Performance**: the ground layer is built once into an offscreen canvas
and blitted whole each frame, not re-tiled per frame (~1,600 draws once
instead of per frame) — the map's world size and tile layout never change,
so there's nothing to invalidate the cache for except a canvas resize.
Decorative props are a fixed list (a small seeded PRNG, not `Math.random()`,
so the scatter is identical every load) kept clear of the base/wall/turret
build area, and are drawn but never consulted by any gameplay code —
movement, targeting, and placement validation are exactly as before.

## What was deliberately left out

Multiple turrets, turret repair, four zombie types, player HP/downed/revive,
medkits and multiplayer — all previously listed here as not-yet-built — are
now implemented; see the sections above. Every wall and turret level now has
a real, specified cost, so there are no more intentionally-unpriced levels
left to call out.

What's still out of scope, per `CLAUDE.md`'s own scope rules: accounts or
real authentication (identity is still just a browser-stored random id),
public matchmaking/lobbies, multiple maps, crafting, vehicles, skill trees,
extra weapons beyond the pistol, ammo/durability systems, chat or voice, and
any second turret-placement mechanism alongside the existing X-menu one. A
turret's "pierce"/"splash" abilities are a documented approximation of the
brief (see above), not a projectile-physics system — adding one would be
scope creep this project's own architecture rules already warn against.