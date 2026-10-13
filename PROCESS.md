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

## UI asset licensing fix + redesign: Kenney CC0 icons/panels replace the CraftPix HUD atlas

The visual-redesign entry above flagged, but deliberately left unresolved,
that CraftPix's free-tier license forbids redistributing art source files
— in tension with this course's public-repo workflow. Re-examined
specifically for the HUD/menu layer (not the terrain/zombie/base sprites,
which are a separate, larger asset and out of scope here): rather than
accept that risk or ask for an exception, `src/client/sprites/ui.png` (a
cropped region of the CraftPix pack) and its source `assets/UI/` have been
removed outright and replaced with icons/panel chrome from two Kenney.nl
packs released CC0 (1-Bit Pack, Pixel UI Pack) — public domain,
redistribution of the original files explicitly permitted, no attribution
required. Full sourcing — pack URLs, author, license text, and the exact
tile coordinates each icon was cropped from — is in
`assets/ui-kenney/NOTES.md`.

**Individual icon files, not a second atlas.** The CraftPix icons were a
single `ui.png` sprite sheet addressed by pixel-coordinate regions
(`UI_REGIONS` in `sprites.ts`). The Kenney icons are shipped as one PNG per
icon (`src/client/sprites/ui/icons/*.png`) instead — nothing to get a pixel
coordinate wrong on, and `uiIconUrl()`/`uiIcon()` replace the old
coordinate-based `uiIconStyle()` helper. Locating which Kenney 1-Bit Pack
tile is "heart" vs "skull" vs "shield" still used the same grid-overlay
methodology as the CraftPix tileset above (a scripted, scaled, grid-lined
render of the sheet, tiles identified visually and cross-checked against a
zoomed crop before use) — only a one-time cost to find the seven tiles
actually used, not an ongoing per-render coordinate dependency.

**Darkened panel variants are a derivative, which CC0 explicitly allows
(unlike the CraftPix clause this whole change exists to get away from).**
Kenney's "Ancient grey" 9-slice panel is a mid-tone slate, too light for
the brief's "dark grey panels" and for the HUD text's contrast against it.
A CSS `filter: brightness()` on the live panel element was tried first and
rejected — it also darkens the icons/text drawn on top of the panel, not
just the panel texture. Instead, `assets/ui-kenney/darken.js` (a one-off
script, not part of the build) produces `panel-grey-dark.png`/
`panel-red-dark.png`/`panel-green-dark.png` by a uniform per-pixel RGB
multiply, shipped alongside the untouched originals.

**Redesigned, not just reskinned**, within what the existing architecture
already tracks (no new gameplay mechanics, no new persisted fields): the
HUD now shows HP/wall/XP as icon + meter bar + numbers rather than numbers
alone; a new team-status panel surfaces each connected player's HP, colour,
downed/dead state, and live revive-progress countdown (`state.players` /
`state.reviveProgress` were already sent every tick — this only renders
them, it was previously just a team-wide alive/downed/dead count); the
base/turret X-menu shows each option's icon and cost and visually dims/
reddens it when `sharedXp` is below that cost (still sends the action to
the server either way — the server's existing reject-with-reason flow is
the real validation, this is only a hint); and a small contextual prompt
("[X] Base Menu", "[Hold E] Revive", "[H] Use Medkit") surfaces existing
keybinds when in range instead of requiring the player to remember them.
The waiting/paused phase banners gained a static controls legend (serving
as this project's "main menu"/"pause-help" screens, since the architecture
has no separate menu screens beyond the existing game phases) and
Game Over/Victory got distinct red/green panel treatments. None of this
touches combat, spawning, XP calculation, persistence, or any server-side
validation — everything rendered was already in `StateMessage`.

**A real, pre-existing gap, not introduced here**: the canvas is a fixed
800×800 element (`CANVAS_SIZE` in `main.ts`); below that viewport width the
page already needed horizontal scroll before this change. This redesign
makes the HUD/menu chrome itself responsively stack and cap its own width
(`#hud`/`#team-panel` flex-stack instead of independently-guessed fixed
offsets — the two overlapped at narrow widths before this fix, caught by
screenshotting at 480px), but does not change the canvas's own fixed-size
behaviour, which would mean reworking the coordinate math `render.ts` and
`input.ts` both depend on — out of scope for a UI-asset redesign.

## Bug fix: a ground zombie could permanently walk through an intact, undamaged wall

Reported symptom: a player would sometimes lose HP "for no apparent reason,"
with no obvious attacker on screen.

**Diagnosis, not assumption.** Read through every code path that can reduce
player HP (`#damagePlayer`'s one call site — zombie melee, the base-menu
actions, giant explosions on death — and the targeting/movement that decides
when a zombie is even allowed to hit a player) without finding a conclusive
cause by inspection alone. Reproduced empirically instead: a scripted
WebSocket client (an isolated server + scratch SQLite DB, never the real
`data/`) held a player exactly at the base, farmed real XP by shooting
zombies, built a wall, and logged full context — self HP, wall HP/level,
and every zombie's id/type/position/distance/`attacking` flag — on every HP
change. That reproduced it directly: the player lost HP in 10-point hits
while `wallLevel` stayed 1 and `wallHp` stayed at 50 (the wall's max,
completely undamaged) the whole time, with a normal zombie sitting at
distance ~28 from the player, `attacking: true`.

**Root cause** (`advanceZombie()`, `src/server/game-state.ts`): a ground
zombie's wall-ring-blocking override only applied while the zombie's own
current position was outside `WALL_RING_RADIUS`. That flag was recomputed
fresh every tick from the zombie's just-moved position — so the very first
tick an approaching zombie's ordinary ~2-unit movement step happened to
land its distance-to-base at or under the ring radius (not a deliberate
breach, just normal approach), it was judged "no longer outside," the
override stopped applying, and every tick after that it chased the real
player directly at melee range (its actual attack-range stop condition)
instead of the wall — walking straight through a fully intact wall for the
rest of its life. This fires essentially every time a wall exists and a
ground zombie's hunted target is a player standing within the ring
(`BASE_INTERACT_RANGE` is 80, well past the 60-unit ring, so standing there
to use the base menu is normal play), which matches "sometimes" rather than
"always" — it depends on a zombie actually closing to the ring while a
player is inside it.

**Fix**: whether a ground zombie is blocked by an intact wall now depends
only on whether its real target is behind the wall (`targetInsideRing`),
never on the zombie's own current position — removing the exact condition
that let an ordinary approach step permanently disable the block. Also
added a hard clamp on the computed movement step so a blocked zombie's new
position can never end up closer to the base than the ring, as defence in
depth against the same class of one-tick-overshoot bug (not reachable today
at current zombie speeds, but shouldn't be relied on implicitly). Turret
targeting/firing, player movement, invulnerability, and every other damage
source were read through and are unaffected — this is a single, scoped fix
in zombie pathing/targeting, not a balance change (no HP, damage, or
cooldown numbers were touched).

**Regression test**: `spec/wall-ring-protection.test.ts` plays a short real
game against the live app (same pattern as `gameplay-expansion.test.ts`) —
farms a wall through actual combat, then holds a player inside the ring and
asserts HP never drops while `wallHp > 0`, with a sanity check that the wall
actually took damage (so the test can't pass vacuously). Verified both ways:
reverting the fix locally reproduces the exact failure this test is for
("player hp dropped 100 -> 90 while wallHp was 50 ... wall still intact");
with the fix, the same scenario runs the wall down to 0 through legitimate
combat before anything touches the player. Like the existing
`turret_interact` test, it restarts the shared app to a known baseline on
entry and exit, since every file in `spec/` runs sequentially against one
live instance (`vitest.config.ts`'s `fileParallelism: false`).

## Zombie visual identity, attack effects, and damage feedback

Follow-up to the wall-ring bug fix above: the player's report of "losing HP
for no apparent reason" had a second, real cause alongside the wall bypass —
once that was fixed, legitimate hits still had almost no visual feedback.
Flying zombies reused a palette-swapped copy of the same civilian-zombie
sprite every ground zombie uses, zombie attacks had no impact effect when
they actually connected, a flying zombie's "ranged" attack had no visible
projectile at all, and a player taking damage had no flash, no floating
number, nothing beyond the HP bar quietly ticking down. All four zombie
types (`normal`, `flying`, `giant`, `boss`) were inspected individually —
their stats, attack range/cooldown, and existing animation state are exactly
as `game-state.ts`'s `ZOMBIE_TYPES` already specified; nothing here changes
a damage, HP, range, or cooldown number.

**Flying zombies are now drawn procedurally, not sprited.** Checked Kenney,
OpenGameArt, and itch.io for a CC0, redistributable, animated flying-enemy
sprite sheet matching this project's 32x32 frame convention — the closest
real candidate (`Bat (32x32)` by MoikMellah, OpenGameArt, CC0) is GIF/XCF-
only with no attack frame and a generic-bat rather than undead silhouette;
everything else with matching frames explicitly forbids redistribution (the
same restriction this project is already avoiding elsewhere). Rather than
force a mismatched or legally-murky asset in, `render.ts`'s
`renderFlyingZombie` draws a bat/wraith silhouette instead — wings, a dark
body, glowing eyes that brighten mid-attack — the same call this project
already made for the player character and turrets ("no sprite in the pack
is shaped like this, so draw it"). `ZOMBIE_SHEETS` (`sprites.ts`) no longer
loads a flying sprite sheet at all; `renderDeathEffects` draws a matching
procedural wing-fold collapse instead of a "dead" sprite frame for it.

**The protocol gained the minimum needed to synchronise effects with real
combat, not a client-side guess.** `ZombieSnapshot` (both `protocol.ts`
copies) adds `attacksLanded` (monotonic, incremented only in
`GameLoop#applyZombieHit` when a hit actually lands — the same pattern
`TurretSnapshot.shotsFired` already uses) and `lastHitKind`/
`lastHitTargetId` (what was actually hit: a player, a turret, the wall, or
the base). The client diffs `attacksLanded` between consecutive snapshots to
know exactly when and what a zombie hit — never from `attacking`/timing
alone, which could show an effect for an attack that missed its cooldown
window or guess wrong about the target. Player damage numbers/flash are
driven even more directly: a real hp drop between two authoritative
`PlayerSnapshot`s, which covers every damage source there is (zombie melee,
a flying zombie's hit, a giant's death explosion) for free, since
`#damagePlayer` is already documented as the one place anything server-side
can lower a player's hp.

**Effects added** (`render.ts`, wired up in `main.ts`'s state-diffing):
a brief forward lunge + scale pulse on the attacking zombie exactly when its
hit lands; a melee impact burst at the real hit location (player, turret, or
a point on the wall ring/base, picked from `lastHitKind`); a flying zombie's
hit instead spawns a cyan projectile (visually distinct from the yellow
player/turret tracers) that travels from the zombie to the target over
300ms before the same impact burst fires — damage was already applied the
same tick it was dealt; the projectile is a cosmetic reveal of an
already-resolved hit, never a second damage source, and never contradicts
what the server already decided; a giant's death additionally spawns a
wider orange shockwave ring, since "a giant exploded on someone across the
base" is exactly the kind of damage a player could otherwise never
attribute to anything; and on the player side, a red silhouette flash, a
floating "-N" damage number, and (local player only) a brief red screen-edge
vignette.

**Verified live, not just by reading the code.** An isolated server against
a scratch database (day fast-forwarded past 3/4 so flying and giant zombies
were actually present — day 1 has neither) with Playwright driving a real
browser confirmed: the flying zombie's bat silhouette renders distinctly
next to an unchanged normal-zombie sprite; a flying zombie's hit produced
the exact "-20" floating number (its configured damage) together with the
impact burst, at the point the projectile should have arrived; and the full
existing test suite, including the wall-ring-protection regression test
from the previous fix, still passes (9/9) — this work touches targeting
output, never targeting logic. The giant explosion shockwave was verified
by code/type review rather than a captured screenshot (reuses the identical,
already-verified impact-effect pipeline under a different `kind`, and no
giant happened to die within a practical test window); worth a live spot-
check if it matters before relying on it further.

**A process-hygiene lapse, not a gameplay one, caught during this work's own
final cleanup**: a dev server started in an earlier session had not been
fully terminated, and `tsx watch`'s own file-watcher kept restarting it
every time server source files were edited in later sessions — including
once still bound to the real `data/` database on its default port. It
served only passive reads from this agent (no start/input/shoot was ever
sent to it), but the real save's `sharedXp` and phase had changed in the
meantime in a way consistent with genuine, independent play through that
same leftover process rather than a freshly-started one of the player's own
— flagged here rather than silently absorbed. Several more orphaned `tsx
watch` processes from this and earlier sessions' isolated test servers were
found and killed during the same cleanup pass; none were bound to a real
database.

## Map/HUD readability pass + "new enemy" intro popups

Pure presentation work — nothing here changes a damage, HP, range, cooldown,
spawn, XP, or persistence value; `render.ts`'s `render()` and `main.ts`'s
message handling are the only places touched beyond the one small protocol
addition below.

**HUD/map readability**: the DAY/zombie-count readout now sits on a
translucent panel (legible over any terrain tile underneath, not just
whichever one happens to be there), and gains small wave-composition badges
(FLYING/GIANT/BOSS, with counts) whenever the current day's fixed
composition includes them — a "my/day 5 has a boss in it" read at a glance
without opening the HUD. The base now has a constant soft glow (so it never
gets lost among props/zombies) and a constantly-visible, dashed base-
interact-range ring that brightens when the local player is actually inside
it — the same range the existing `[X] Base Menu` prompt already used, now
with a matching visual. The wall ring gained a proportional HP arc (green →
yellow → red as it nears breaking) traced over the ring itself, and — when
there's no wall at all — a dim red dashed "exposed" ring, so "I have no
wall" is visible at a glance instead of only inferable from its absence.
Every non-normal zombie (flying, giant, boss) now carries a small bobbing
warning chevron above it, coloured to match its own in-world glow, so the
one dangerous zombie among a crowd of normal ones doesn't depend on the
player noticing a size/colour difference on its own.

**Protocol addition**: `StateMessage.dayWaveComposition` (both `protocol.ts`
copies) is `game-state.ts`'s own `waveForDay(progress.day)` — a read-only
lookup against the fixed `WAVE_TABLE`, not a new stored field — exposing
what a day's wave actually *contains* (not how many of each are currently
alive) to the client. It's what both the wave-composition badges and the
"new enemy" intro below are driven by.

**"New enemy" intro popups**: shown once, the first time a zombie type
genuinely appears in a run — triggered when a day boundary is crossed and
that day's `dayWaveComposition` includes a type not seen before (`main.ts`'s
`checkForNewEnemies`), not when an actual instance happens to spawn, so the
warning arrives during the day-intro countdown, before the player is
already fighting one. Text content (title/name/bullets) is exactly what the
brief specified for flying and giant; the data structure (`ENEMY_INTRO`,
keyed by type) has no entry for normal/boss, so neither is ever queued —
not an oversight, just nothing was asked for them. The popup's portrait
reuses the real in-game art directly: `renderFlyingZombie` (exported from
render.ts, the same bat silhouette drawn in-world) for flying, and the
existing CraftPix idle-sheet frame for giant — one definition of "what this
enemy looks like," not a second copy that could drift from the real one.

Dismissal is a real, clickable "Got it" button (plus Enter/Space/Escape, and
a 9-second auto-dismiss) — the popup container itself is
`pointer-events: none` so the player's aim/shoot keeps working underneath
it everywhere except directly over the button, and nothing about dismissing
it touches game state; the round keeps running (and zombies keep *not*
spawning, same as any other moment during the existing 5-second day-intro
window) regardless of whether the player has looked at the popup yet. A
queue (`introQueue`) handles the rare case of two new types in one day
boundary, though in practice the wave table never introduces two at once.

**Tracking is deliberately client-only, in-memory, not persisted** — the
simplest thing that satisfies "once per run," at the cost of one disclosed
edge case: a page refresh re-seeds "already seen" from whatever day it
reconnects on (so a type introduced days ago is correctly not re-shown),
but doesn't remember exactly which day *this browser* already saw it, same
spirit as this project's existing position/zombie/turret-cooldown state
(CLAUDE.md's persistence rules already exclude exactly this class of
transient, per-session state). Clicking "Restart (Day 1)" clears the
tracking at the same time it resets the round, so a genuinely new run
shows both intros again on schedule.

**Verified live**, not just read: a WebSocket bot played real combat through
Days 1→5 (no shortcuts to the actual zombie-killing/day-progression logic)
while a real browser page only watched, confirming — in one continuous
run — the Flying intro appeared exactly at Day 3 with the exact specified
text and portrait, the Giant intro appeared exactly at Day 4, neither
repeated once dismissed, the wave-composition badges matched each day's
real composition, and gameplay (HUD, team panel, day counter, the bot's own
combat) continued normally throughout. The full existing test suite
(9/9, including the wall-ring-protection regression test from two entries
up) still passes unchanged — this is a client-rendering/HUD change, not a
combat-logic one.

**A recurring process-hygiene gap, caught and fixed again during this
work's own cleanup**: for a third time this session, a dev server from
server-file edits in an earlier task had survived via `tsx watch`'s
auto-restart and was found bound to the real `data/` database on its
default port — killed immediately, never sent a command from here. The
real save's `sharedXp`/`day`/`phase` had again changed in a way consistent
with genuine independent play through that leftover process. Confirmed via
three independent checks (listening ports, process list, dev-server
wrapper processes) that nothing remains before finishing this entry.

## Map redesign: a zoned, clustered battlefield instead of a uniform test-tile scatter

Pure visual work — `src/client/terrain.ts` and `render.ts` only, nothing
server-side touched. No gameplay mechanic, map size, collision, or spawn
rule changed; props were already purely decorative (never consulted by
movement/targeting/placement code — terrain.ts's own file comment already
said so) and stay that way.

**No new assets.** Before reaching for a new pack, I rendered the existing
CraftPix `City_Tileset` through the same scaled, grid-lined overlay
technique this project already used to locate its tileset regions (see the
visual-redesign entry above), and found it already had several previously-
uncatalogued tiles this redesign needed: three stained/cracked beige
pavement variants and a heavily-cracked dark variant (`pavementCracked`/
`pavementDamaged` in `sprites.ts`'s `TILESET_REGIONS`), plus a second,
undamaged chain-link fence panel next to the one already in use for the
wall ring (confirmed the in-use one is in fact the *damaged* panel — already
fitting a ruined aesthetic). That was enough to cover "dusty/cracked
ground" and "dark damaged patches" without introducing any new licensing
surface at all.

**Three zones, not a uniform tile roll** (`render.ts`'s `tileRegionFor`,
keyed off distance from `BASE_POS`): a kept-clean base zone (under
`BASE_PAD_RADIUS`, 92 units — comfortably inside the wall ring), a mid
"combat zone" out to `OUTER_ZONE_RADIUS` (400) with a believable minority of
stained/cracked tiles, and an outer "danger zone" beyond that where the
ground itself is visibly more damaged (the heavily-cracked dark tile
appears far more often). The zone boundaries are exported constants
(`terrain.ts`), not duplicated magic numbers.

**A fortified base pad** (`renderBasePad`): a dark circular platform with a
hazard-stripe border and subtle texture streaks, baked into the same cached
terrain layer as the ground tiles (one extra draw at cache-build time, not
per frame). It sits under the existing wall ring and the base-interact-range
ring from the previous HUD pass, reading as the deliberate "defended core"
the brief asked for rather than just more tiled ground with a door on it.

**Clustered, not scattered, decoration** (`terrain.ts`'s `buildClusters`):
props are now placed as named cluster templates — a debris pile
(crates/barrel/dumpster), a scrap heap (barrels/crate), a barricade remnant
(two fence panels at random rotation plus a crate — reading as a fallen,
not standing, barrier), a thicket (trees/bushes), a roadside rest
(bench/barrel/crate) — rolled per cluster, not per individual prop, with
each prop placed a short random distance from its cluster's own centre.
The mid zone gets more clusters and the full template mix; the outer zone
gets fewer, weighted toward the broken/abandoned templates plus some lone
trees, rather than more green thickets. `PROPS_CLEAR_RADIUS` (220, the
project's existing keep-clear distance) is unchanged — still comfortably
past `TURRET_BUILD_RADIUS` (150), so nothing crowds the actual build area.

**Ground-level marks baked into the terrain cache** (`renderGroundMark`):
cracks (jagged branching lines), scorch marks (a radial dark smudge), blood
stains (a small cluster of dark-red splats), and dark damage patches
(overlapping soft blotches) — all procedural Canvas shapes, not sprites, in
the same spirit as this project's player/turret/flying-zombie art ("no
asset fits this, so draw it"). Kept deliberately subtle (12–55% opacity)
and zone-weighted (none in the base zone, moderate in mid, heaviest in the
outer zone) specifically so the result reads as atmosphere, not clutter —
the brief's own "do not make the background too busy" and "preserve good
contrast" constraints.

**Verified visually**, not just by reading the diff: screenshots against an
isolated scratch database confirm the fortified pad reads clearly at the
base, a barricade-remnant cluster shows two differently-rotated fence
panels with a crate between them (not a uniform scatter), and the outer
zone visibly carries more damage patches and cracked dark tiles than the
area just past the base. The full existing test suite (9/9) still passes —
expected, since this changes nothing server-side.

**A fourth recurrence of the process-hygiene gap, root cause found this
time**: yet another dev server from an earlier task's edits was still bound
to the real `data/` database on port 8080. The actual bug: `pkill -9 -f
"tsx watch"` does not match this project's real process — `pnpm run dev`
invokes `tsx`'s CLI as `node .../tsx/dist/cli.mjs watch src/server/
index.ts`, so the literal substring `"tsx watch"` never appears in the
command line, and the pattern silently kills nothing while looking like it
succeeded. Killing the exact PIDs found via `ps aux` (not a `pkill -f`
pattern guess) worked immediately. Again, never sent this leftover process
a command from here — the real save's day/XP/wall had changed in the
meantime, consistent with genuine independent play, including what looks
like a real "Restart" (day and XP both dropped) sometime after the previous
entry's final check.

## Horde spawning: full 360° perimeter spawns, simultaneous day-tiered batches

**The problem.** Zombies only ever spawned from four fixed sides (picked
randomly, but always top/bottom/left/right of the map), one at a time, on an
adaptive interval that stretched or shrank to fit a day's whole zombie count
into a fixed-ish time span (`spawnIntervalForDay`). Requested replacement:
spawn angles anywhere in 0–360° around the base, converted onto the real
rectangular map boundary (not just the four sides), batched so several
zombies appear in the same server tick instead of trickling in one at a
time, and paced by fixed, named day-tier batch sizes/intervals rather than a
formula — while leaving the actual *content* of each day (how many of each
type, from `WAVE_TABLE`) completely alone.

**Geometry (`game-state.ts`).** `perimeterPositionAtAngle(angle)` ray-casts
from the map's exact centre (`BASE_POS`, which is already the map's
midpoint) outward at that angle until it crosses the square boundary —
`scale = half / max(|cos|, |sin|)` — so every angle in `[0, 2π)` lands on a
real point somewhere on the perimeter, corners included, not a choice among
four fixed sides or even four fixed points. `batchSpawnAngles(count)`
shuffles the 10 equal 36° sectors a full-size batch could ever need (the
day-11+ tier's max batch is 10) and gives each zombie in the batch a random
angle inside its own assigned sector, in shuffled order — so a batch's
zombies are guaranteed to spread across different parts of the circle
instead of each independently rolling an angle that could, by chance, put
them all on one side. `spawnPositionAtAngle` then nudges a candidate point
around by a sector-width if an alive player is standing within
`SPAWN_PLAYER_CLEARANCE` (60 units) of it — structures were deliberately not
checked, since the base/wall/turrets all sit well inside
`TURRET_BUILD_RADIUS` (150) of the centre, nowhere near a boundary spawn
point, so they can never be landed on in the first place.

**Pacing (`spawnTierForDay`, in `game-state.ts`; wired into
`game-loop.ts`'s `#maybeSpawn`).** Exactly the four tiers requested — day
1–2: 4–5 per batch/6s, day 3–5: 5–7/5s, day 6–10: 7–10/4s, day 11+: 8–10/3s
— replacing `spawnIntervalForDay`/`TARGET_DAY_SPAWN_SPAN_MS`/
`MIN_SPAWN_INTERVAL_MS`/`MAX_SPAWN_INTERVAL_MS` outright rather than keeping
them alongside the new system. `#maybeSpawn` rolls one batch size per
interval (`randomBatchSize`, clamped to the tier's min/max), caps it to
however many zombies are left in `#spawnQueue` so the final batch of a day
never overshoots the day's fixed quota, assigns each zombie its own angle
from one `batchSpawnAngles` call, and pushes all of them onto `#zombies` in
the same function call — i.e. the same 50ms tick, so the same outgoing
`state` broadcast — which is what "spawn simultaneously" means in a
tick-based server loop. `buildSpawnQueue`/`WAVE_TABLE`/`waveForDay` (what
spawns and in what type mix) were not touched at all; only *how a position
and batch are chosen* changed. `spawnZombie`'s signature changed from
computing its own position internally to taking one in (`pos: Vec2`), since
position is now decided by the caller (`#maybeSpawn`) before the zombie
object exists — confirmed via grep this is its only call site, so a safe,
non-breaking signature change.

**Testing.** `spec/horde-spawn-geometry.test.ts` is a new pure-function
unit test file (no live app needed) exhaustively checking the geometry at
3600 angles: every angle lands in-bounds and on the boundary, the four axis
angles hit the exact edge midpoints, the four diagonals hit the exact
corners, and all four edges get continuously varying positions (not fixed
points). It also checks `spawnTierForDay` against the exact numbers
requested for every day boundary, `randomBatchSize` staying in range over
2000 draws, and `batchSpawnAngles` never repeating a sector within one
batch. `spec/horde-spawn-live.test.ts` plays a real Day 1 against the live
app over its actual WebSocket protocol (same pattern as
`wall-ring-protection.test.ts`): it watches real `state` broadcasts,
reconstructs batches from zombie first-seen timestamps, and asserts the
day's total is exactly 10 (unchanged from `WAVE_TABLE`), every batch but the
last is within the day-1 tier's 4–5 size (the last capped to whatever
quota remains), batches land roughly 6s apart, and any batch of 3+ actually
touched more than one edge of the map — confirming the perimeter spread is
real in practice, not just correct on paper. Full suite (22/22, up from 9)
passes against an isolated scratch database (`PORT=8099`,
`DATA_DIR=/tmp/horde-spawn-task/data`, deleted afterward); `pnpm typecheck`
and `pnpm run build` both pass clean. The real `data/game.db` was untouched
— its mtime predates this task's isolated server start. Cleanup used the
exact-PID-kill approach from the previous entry's fix, not a `pkill -f`
guess.

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