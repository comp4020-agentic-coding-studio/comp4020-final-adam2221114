# 1. Simultaneous build/upgrade/placement conflicts

## Status

Accepted (Crit 9).

## Context

Crit 9 makes the final project genuinely multiplayer: up to 4 players share
one base, one wave, one shared XP pool and the same wall/turret build state
(README's "good means cooperation is structural"). Once more than one
connection exists, two players can both try to spend the same shared XP, or
build the same structure, at effectively the same instant — e.g. both click
"Build Wall" within the same fraction of a second, or one tries to build the
turret while another is placing it.

The brief asks for one decision about this, grounded in what this project's
own README says "good" means, written down with the alternatives considered
and what the choice costs.

## Decision

**Whichever request the server actually processes first wins and mutates
state; every request after it re-reads that already-updated state and is
rejected, with a reason sent only to the player who lost the race.**

This falls directly out of the architecture already in place, not a new
mechanism:

- The server is the sole source of truth (`CLAUDE.md`'s architecture rules);
  Node's event loop is single-threaded, so two `interact`/`place_turret`
  messages arriving "at the same time" are still handled one at a time, in
  whatever order the WebSocket layer delivers them.
- `GameLoop.interact()` / `GameLoop.placeTurret()` already re-check cost,
  range and current build state against `PersistedState.get()` at the moment
  each message is handled — not against whatever the client believed when it
  sent the request. So the second request in a race naturally sees the
  first one's result (XP already spent, wall already built) and fails its
  own check.
- What Crit 9 actually added: those failed checks used to just log and
  silently no-op (fine for one player, confusing for several). They now
  return a reason, and `ws-server.ts` relays it only to the socket that sent
  the losing request, as a `rejected` message — the client shows it briefly
  near the HUD.

Concretely: shared XP is only ever deducted once per successful action; the
loser is never charged; the loser sees a short reason ("build_wall: a wall
already stands") instead of nothing happening with no explanation.

## Alternatives considered

- **Client-side locking / turn order** (e.g. only the "closest" player, or
  whoever opened the menu first, is allowed to act). Rejected: this would
  require the client to track lock state as a second source of truth, which
  conflicts directly with `CLAUDE.md`'s "the server is authoritative" rule —
  and it adds a visible negotiation step for a conflict that's actually rare
  in a 2-4 player session.
- **A request queue with visible "pending" state** (show "Alice is
  building..." and queue Bob's identical request behind it instead of
  rejecting it). Rejected as unnecessary complexity for this project's scope:
  it needs a new state machine and new UI just to soften a conflict that, in
  practice, resolves in well under the "about a second" the brief's realtime
  requirement already allows for, and that two players deliberately choosing
  the same structure at the same instant is not a problem this game needs to
  make comfortable — just legible.
- **Silently ignore the loser's request** (Crit 8's actual behaviour, kept
  as-is). Rejected because it's the one option that doesn't actually explain
  anything to a second player: from their side, nothing distinguishes
  "my request failed" from "the game didn't hear me," which is exactly the
  kind of confusion a shared economy shouldn't produce.

## Consequences

- A rejected player gets a short, generic reason, not a live indicator of
  what someone else is currently doing — acceptable under README's "clarity
  is more important than decoration" and the course's own scope-discipline
  rule; a presence/live-intent system is a different (and bigger) feature.
- No new server state machine, no client-side authority over build state —
  the fix is entirely "tell the loser why," on top of checks that already
  existed.
- This decision only covers build/upgrade/turret-placement actions (the
  shared resource players actively contend over). It says nothing about
  reconnect behaviour or player presence/visibility — those remain open for
  a later crit if the brief asks for them.
