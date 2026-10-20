# Crit 10 Reflection

## 1. What was the breakthrough that moved the work forward?

Going in, I assumed the hard part of "the server tells two players apart" would be building something new — some kind of per-request authentication check. Directing Claude to actually trace every `GameLoop` method that mutates a player showed the opposite: `ws-server.ts` already binds `id` once, from the WebSocket's own connection, and closes over it for every message that socket ever sends — no handler reads an `id`/`playerId` field out of a message body at all. The real work wasn't adding a check, it was proving the absence of a hole, so I had Claude actually try to break it: forge another player's id into a `select_character`/`use_medkit` message and see what happens. It did nothing — the sender's own record moved, the forged target stayed untouched. That's grounding, not assuming: I didn't accept "the server is authoritative" as true because `CLAUDE.md` says so, I had it demonstrated against a running instance and turned into `spec/player-isolation.test.ts` so it stays true.

The same instinct caught something I'd have otherwise shipped wrong. `PendingRepair.md` already claimed a Fly-restart shutdown bug was "fixed." Instead of trusting that, I had Claude re-run the actual shutdown and measure it — and found `server.close()` was silently stalling on an open WebSocket connection for 14 seconds, far past Fly's 5-second kill budget. That's a correction of my own documentation, not just the code: I'd rather an honest "still broken" than a confident "fixed" I never re-checked.

## 2. What did this work change about who I want to be as a software developer?

This week sharpened a specific discipline: a security or reliability claim ("the server is authoritative," "this is fixed") is not evidence until something tried to violate it and failed. I want to keep treating my own prior write-ups the same way I'd treat a stranger's — re-verifiable, not just re-stated.
