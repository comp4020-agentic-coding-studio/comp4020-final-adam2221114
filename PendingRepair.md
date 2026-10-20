# TODO: Fix Fly Machine Restart Shutdown Boundary

## Current Issue

The following behaviour is already fixed:

- When the browser is closed or the WebSocket disconnects, the game automatically enters `paused`.
- After refreshing and reconnecting, the game remains `paused`.
- If the server is killed with `SIGKILL`, a stored `running` state is safely restored as `paused` on the next startup.

However, there is still one shutdown boundary issue during a real Fly machine restart.

In the latest verification:

- Before restart: `baseHp = 100`
- After restart: `baseHp = 80`

This shows that after Fly began shutting the process down, the old server continued running the simulation for a short period before it actually exited.

During that window, zombies were still able to damage the base.

## Expected Behaviour

As soon as the server begins shutting down, gameplay should stop immediately.

Expected shutdown flow:

```text
Receive SIGTERM / SIGINT
→ immediately stop the game simulation
→ if phase === running, switch to paused
→ prevent any further zombie movement / attacks / spawning / turret fire / wave progression
→ immediately flush durable state
→ then close WebSocket / HTTP / database / process
```

## Existing Startup Safety That Must Remain

The current startup behaviour should stay:

```text
stored waiting   -> startup waiting
stored paused    -> startup paused
stored running   -> startup paused
stored game_over -> startup game_over
stored victory   -> startup victory
```

This is still necessary because a `SIGKILL` or crash may prevent the graceful shutdown handler from running at all.

## What Needs to Be Fixed

The shutdown handler should:

1. React immediately to `SIGTERM` / `SIGINT`.
2. Stop the game loop before any other shutdown work.
3. Change `running` to `paused`.
4. Prevent any more zombie movement, zombie attacks, spawning, turret fire, or wave progression.
5. Flush durable state immediately.
6. Only then close WebSocket connections, the HTTP server, the database, and the process.
7. Guard against the shutdown handler running more than once.

The existing startup protection must remain in place so a crash or `SIGKILL` still boots safely into `paused`.

## What to Verify Next Week

### 1. Normal SIGTERM

While the game is running, record:

- `day`
- `baseHp`
- `sharedXp`
- `wallHp`
- `wallLevel`

Send a normal `SIGTERM`.

After restart:

- all durable fields should be unchanged
- `phase` should be `paused`

### 2. Real Fly Machine Restart

Run the game in `running` state and record the durable state.

Execute a real Fly machine restart.

Verify:

- `baseHp` does not continue dropping during shutdown
- `wallHp` does not continue dropping during shutdown
- no new zombie attacks happen after shutdown begins
- after restart, `phase` is `paused`
- durable state matches the last state saved before shutdown

### 3. SIGKILL Regression Test

Hard-kill the server with `SIGKILL`.

Verify:

- graceful shutdown logic does not run
- the database may still contain `running`
- on the next startup, `running` is safely converted to `paused`

This test must continue to pass after the shutdown fix.

## Scope Note

This fix does **not** require persistence for:

- live zombies
- `killedZombies`
- current in-memory wave state

For Crit 8, only durable progression needs to survive restart.

Full live-wave persistence can be reconsidered in a later crit.

## Current Conclusion

The browser disconnect / refresh pause behaviour (a player closing or
refreshing their own tab) is fixed and working correctly — that's
`ws-server.ts`'s `socket.on("close", ...)` handler pausing the round once
the last player leaves, unrelated to the process-level shutdown below.

**The process-level Fly-restart issue this document was originally opened
for is still NOT fixed.** `src/server/index.ts`'s `shutdown()` has not
changed since this document was first written (diff against the commit that
introduced this file is empty). It still does:

```
gameLoop.stop();   // clears the tick interval — no MORE simulation steps run
progress.flush();  // writes whatever is in memory right now
progress.stop();
db.close();
server.close(() => process.exit(0));
```

`gameLoop.stop()` does stop new simulation ticks immediately — confirmed by
reading `GameLoop.stop()` (`clearInterval(this.#timer)`), so no *new* zombie
attack can be scheduled after shutdown begins. That part of the original
report may have been a correct diagnosis of a problem that `gameLoop.stop()`
already running before `progress.flush()` was enough to fix for the ordering
within one process. It was never re-verified against a real Fly restart
after the fact, and this session didn't have time to run that specific
end-to-end check either (see "Not yet re-verified" below).

**A separate, newly-observed problem, found while investigating this
report:** `server.close(() => process.exit(0))` — Node's documented
behaviour for `http.Server.close()` — does not fire its callback until every
still-open connection on that server closes, and an upgraded WebSocket
connection (the `ws` library attaches its sockets to the same HTTP server)
counts as "still open" until something closes it. `shutdown()` never closes
the WebSocket server or its open sockets before calling `server.close()`. In
a local reproduction (fresh isolated server + a single WS client left open,
`DATA_DIR`/`PORT` scratch values, removed after), sending `SIGTERM` to the
server process with one WS connection still open took the process about
**14 seconds** to actually exit — the client's `close` event never fired
within that window either, meaning the browser tab would show a `WebSocket`
still in `OPEN` state for that whole time, not an immediate visible
disconnect.

On Fly, `kill_timeout` defaults to 5 seconds before Fly escalates from its
configured `kill_signal` to a harder stop — this repo's `fly.toml` doesn't
override either, so a real machine restart only gives this process ~5s
before Fly stops waiting politely. `progress.flush()` and `db.close()`
already run BEFORE `server.close()` in the current code, so they should
complete regardless of how long the WS teardown takes — that part is not
obviously broken by this finding alone. What this finding does mean: if
`server.close()`'s callback (`process.exit(0)`) never fires within Fly's
~5s budget because an open WS connection is still blocking it, Fly's own
forced stop (SIGKILL, per the docs) cuts the process off mid-exit rather
than letting it finish cleanly — a harder, less predictable termination
than a graceful `process.exit(0)` would have been, even though the actual
state-saving calls had already run moments earlier. The original Fly log
this document was written against (`PID 643`, `Sending signal SIGINT to
main child process`) shows the signal reaching this project's own process —
the container's `CMD` runs `node dist/server/index.js` directly, so there's
no extra supervisor process in between — but doesn't show how long that
process then took to actually exit, which is the open question this finding
raises and the original report didn't investigate.

**Risk, stated plainly: this is unresolved.** A real Fly machine restart or
redeploy while a player is connected may still not flush the exact
pre-shutdown state, for a reason (`server.close()` blocking on an open WS
connection) that the original report didn't identify. Nothing in this
session's changes touches `src/server/index.ts`'s shutdown path — fixing it
would mean explicitly closing the WebSocket server (and/or each open socket)
before or alongside `server.close()`, not after relying on it to wait for
connections. That fix is still to-do, not done.

**Not yet re-verified** (none of these were run this session — listed so
the gap is explicit, not implied-fixed by omission):

1. A normal `SIGTERM` against the real `dist/` build (not just `tsx`'s dev
   runtime) with a connected client, confirming `baseHp`/`wallHp`/etc. match
   pre-shutdown exactly after restart.
2. An actual Fly machine restart with a player connected and mid-combat,
   repeating the original test that found `baseHp: 100 -> 80`.
3. The `SIGKILL` regression case (should still safely boot into `paused`
   regardless of the above, since `STARTUP_PHASE` doesn't depend on a clean
   shutdown having happened).

Plan: close the WebSocket server/sockets explicitly in `shutdown()` before
depending on `server.close()`'s callback, then re-run all three checks above
against a real Fly restart before calling this fixed.
