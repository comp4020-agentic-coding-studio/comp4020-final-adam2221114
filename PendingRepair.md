# TODO: Fix Fly Machine Restart Shutdown Boundary

## STATUS: Shutdown issue below is FIXED. A separate, unrelated issue — Fly log retention — is OPEN/PENDING; see the bottom of this file. Do not confuse the two: fixing the shutdown bug did not touch logging.

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

## Fixed (this session)

`src/server/ws-server.ts`'s `attachWebSocketServer` now returns a
`WsServerHandle` with `closeAllConnections()`, which `src/server/index.ts`'s
`shutdown()` calls — AFTER `gameLoop.stop()`/`progress.flush()`/
`progress.stop()`/`db.close()`, and BEFORE `server.close()` — doing three
things: `socket.terminate()` on every currently-open WebSocket (an
immediate TCP-level close, no close handshake to wait on, since the process
is exiting either way and there's nothing left to negotiate with the
client about), `wss.close()` to stop the `WebSocketServer` itself, and
clearing the periodic state-broadcast `setInterval`. `shutdown()` also
gained a `shuttingDown` guard so a second `SIGTERM`/`SIGINT` while already
mid-shutdown (Fly can send more than one) can't flush or close an
already-closed db a second time. `ws-server.ts`'s own `close` handler on
each socket now checks a `shuttingDown` flag and no-ops instead of running
`gameLoop.removePlayer()`/`pause()` for a process-exit teardown — that
bookkeeping is unnecessary (durable per-player fields are already persisted
synchronously by whichever action last changed them) and would otherwise
run after `db.close()` already ran, which would throw.

**Verified, this session:**

1. **Root cause confirmed in isolation**, independent of this project's own
   code: a minimal `http.createServer()` + `ws.WebSocketServer` with one
   client connected, sent `SIGTERM`, calling `server.close(cb)` — `cb` was
   measured not firing for the lifetime of the open connection (client
   never closed, server still alive after 20s). This is Node's documented
   `http.Server#close()` behaviour (an upgraded WebSocket connection is
   detached from the server's normal connection tracking the moment it
   upgrades, so it's still counted as "open" by `close()` indefinitely) —
   not specific to this project's dependencies or SQLite usage.
2. **Fix verified in the same isolated repro**: adding `socket.terminate()`
   for every open connection plus `wss.close()` before `server.close()`
   brought the callback's firing time down to single-digit milliseconds.
3. **Regression test added**: `spec/shutdown.test.ts` spawns a real server
   subprocess (via `tsx`, the same entry point `pnpm dev` uses), connects a
   live WebSocket client, sends `SIGTERM` to the process group (matching
   how Fly signals a container's `PID 1`), and asserts the process exits
   within 2500ms — well inside Fly's 5000ms default `kill_timeout` — in
   both a fresh-boot scenario and a mid-round scenario (character selected,
   round started, `baseHp` read from the live state broadcast). Both tests
   also re-open the SQLite file the subprocess wrote and confirm the
   flushed `Progress` row matches exactly what the client last observed
   before shutdown, proving `progress.flush()` genuinely completed, not
   just that the process exited quickly. **This test was confirmed to be a
   real regression test**, not just incidentally passing: temporarily
   reverting `index.ts`/`ws-server.ts` to their pre-fix state and re-running
   it reproduces the original failure (`process did not exit within
   2500ms`), then passes again once the fix is restored.
4. **Verified against the real production build**, not just `tsx`'s dev
   runtime: `pnpm run build` then running `node dist/server/index.js`
   directly, with a client connected and a round started, `SIGTERM`
   brought the process down in ~0.2s (polled every 100ms), and the
   resulting `data/game.db` (a scratch copy, not the real one) showed
   `phase: "running"` with the same `baseHp` the client had last seen —
   i.e. the exact state at the moment of shutdown, not a stale or
   corrupted write.
5. `pnpm typecheck`, the full `pnpm test` suite (46/46, including the two
   new shutdown tests), and `pnpm run build` all pass clean with this fix
   in place.

**Not verified, and explicitly not claimed as verified:**

- **An actual Fly machine restart or redeploy** with a real player
  connected. Everything above reproduces the exact mechanism (an open
  WebSocket connection blocking `server.close()`'s callback) and confirms
  the fix addresses it at the process level, under Fly's documented
  `kill_timeout`/`kill_signal` behaviour — but this session did not deploy
  or restart the real Fly machine to confirm end-to-end, per instruction
  not to deploy without explicit confirmation. The original report's test
  (`baseHp: 100 -> 80` across a real restart) should be re-run against a
  real deploy before this is called fully closed in production, not just
  fixed in local testing.
- The `SIGKILL` regression case (server hard-killed, `STARTUP_PHASE` safely
  converting a stored `"running"` to `"paused"` on next boot) was not
  re-run this session, but nothing in this fix touches startup behaviour or
  the `SIGKILL` path at all, so it should be unaffected.

---

# TODO (separate, unrelated issue): Fly log retention does not outlive a crit

## STATUS: OPEN / PENDING. Not fixed. Do not implement a log-shipping/storage
change without explicit confirmation — see PROCESS.md's "Checking whether
Fly's default log retention actually satisfies the brief" entry for the
full investigation this summarizes.

## The problem

Crit 10's spec requires server-side logs that "outlive the crit." This
project has no log-shipping configured, so it relies entirely on Fly's own
built-in retention — checked this session, not assumed:

- `flyctl logs -a comp4020-final-adam2221114 --no-tail` currently returns
  only about 100 lines, spanning roughly one machine boot-to-restart
  window.
- Fly's HTTP Logs API (`GET /api/v1/apps/:app/logs`) can page back further,
  but only to Fly's own retention window (documented at roughly 7 days) —
  there is no way to see anything older than that without having shipped it
  somewhere else at the time it was written.

Crits in this course run weekly. A ~7-day retention window is tight against
that gap: a log written early in one crit week can roll off before the next
one, so "the log outlived the crit it was written for" is not reliably true
today.

## Why this wasn't fixed this session

Every real fix (shipping logs to an external sink, or even just writing a
local log file to the existing Fly volume) is an infrastructure/cost
decision, not a code bug — and the lowest-friction fix that keeps
`flyctl`-style convenience (Fly's own Log Shipper to a free-tier external
sink like Grafana Cloud or Axiom) requires running a second always-on Fly
machine, which has a real, nonzero cost beyond what's already provisioned.
Per explicit instruction, no paid service or new infrastructure was
configured without asking first.

## Options on the table (see PROCESS.md for the full writeup)

1. Accept Fly's ~7-day window as-is (zero cost, real but bounded risk).
2. Write a local log file to the existing Fly volume (`/data`, same one
   `game.db` already uses) — zero additional cost, no new account, but only
   as durable as the volume itself and only readable via SSH, not
   `flyctl logs`.
3. Fly's Log Shipper to a free-tier external sink (Grafana Cloud or Axiom)
   — keeps `flyctl`-style convenience and gets a real retention guarantee,
   but costs a second Fly machine plus a new external account.

## Next step

This needs a decision from the project owner (cost/complexity tradeoff, not
a correctness question) before any code or infrastructure change is made.
