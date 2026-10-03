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

The browser disconnect / refresh pause behaviour is fixed and working correctly.

The remaining issue is specifically the short shutdown window during a Fly machine restart, where gameplay can continue briefly before the old process exits.

Plan: fix this next week.
