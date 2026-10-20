# 2. Player identity and per-player authorization

## Status

Accepted (Crit 10).

## Context

Crit 10's brief requires the server, not just the client, to tell two
simultaneous players apart, and to independently decide what each one may
see and change. Before this, Crit 9 already made the game genuinely
multiplayer (up to 4 shared connections), but every per-connection identity
was ephemeral — a fresh `randomUUID()` assigned at connect time, gone on
disconnect — so there was nothing for the server to check a request
*against* beyond "is this socket currently connected." The brief's two
concrete asks on top of that are: a browser-persistent identity a reconnect
can resume, and a written account of what stops one player's requests from
touching another player's own resources (HP, medkits, status, character
choice).

## Decision

**A connection's identity is bound exactly once, at connect time, from the
`?playerId=` query param on the WebSocket URL — never re-derived from
anything inside a later message body.**

Concretely (`src/server/ws-server.ts`):

- `extractPlayerId(request.url)` reads the query param once, validates it
  against `PLAYER_ID_PATTERN` (`/^[A-Za-z0-9_-]{8,64}$/`), and falls back to
  a fresh `randomUUID()` if it's missing or malformed. The result is bound
  to a local `id` variable, closed over by every message handler that
  socket's connection ever runs.
- Every `GameLoop` method that can mutate a player
  (`selectCharacter`, `shoot`, `interact`, `placeTurret`,
  `turretInteract`, `useMedkit`) takes that closed-over `id` as an explicit
  first argument supplied by `ws-server.ts` — e.g.
  `gameLoop.useMedkit(id)`, `gameLoop.selectCharacter(id, msg.characterIndex, msg.displayName)`.
  None of them read an `id`, `playerId`, or `targetId` field out of the
  parsed message. A client that puts one of those fields in a message body
  anyway has it silently ignored — `spec/player-isolation.test.ts` proves
  this directly: a `select_character` or `use_medkit` message carrying
  another connected player's real id still only ever mutates the sender's
  own record, and the named target is left byte-for-byte unchanged.
- The one place a request legitimately *targets* another player — field
  revive — never takes a target id from the client at all. `#updateRevives`
  (`game-loop.ts`) derives the target itself: for each reviver holding E, it
  scans `this.#players.values()` for the nearest player currently
  `"downed"` within `REVIVE_RANGE`. A client cannot request "revive player
  X"; it can only hold E and let the server decide who, if anyone, is close
  enough and actually eligible.
- One identity drives at most one open socket at a time. If a connection
  arrives with a `playerId` that `gameLoop.isConnected()` says already has
  an open session, the new connection is sent `duplicate_identity` and
  closed (not allowed to silently replace or race the existing one) —
  `spec/multiplayer.test.ts`'s and `spec/gameplay-expansion.test.ts`'s
  duplicate-identity test covers this.
- Durable per-player state (`PlayerRecord`: hp, maxHp, status, medkits,
  characterIndex, displayName) is loaded/saved keyed by this same id
  (`persistence.ts`'s `loadPlayerRecord`/`savePlayerRecord`), so a
  reconnect with the same browser-stored id resumes the same record — but
  loading by id is something only the server does, from its own
  closed-over `id`, never from a client-supplied lookup key in a message.

This is not new coordination machinery layered on top of the game — it's
the same principle the Crit 9 ADR already established ("the server
independently validates range/cost/current state against its own data, not
whatever the client believes") extended to cover *whose* record a request
is even allowed to name. Where Crit 9's ADR is about two players racing to
mutate *shared* state (XP, the wall), this one is about why a request can
never name *someone else's* individual state at all — the two are
complementary, not overlapping.

## Alternatives considered

- **A client-supplied `playerId`/`targetId` field on each message, checked
  against the connection's bound identity.** Rejected: this would require
  every handler to carry an extra "does this field match what the socket
  authenticated as" check, repeated at every call site, for a comparison
  that's entirely unnecessary if the field is never read in the first
  place. Not reading it is strictly simpler and has no attack surface to
  get the check wrong on.
- **Session tokens or real authentication (passwords, OAuth).** Rejected per
  `CLAUDE.md`'s explicit scope rule against "accounts/authentication" — the
  brief's own wording allows "an account, a pseudonym, an anonymous
  browser" as equally valid identity, and this project's local-only
  Fly deployment (one SQLite file, no user base to protect across devices)
  doesn't need more than an opaque, browser-persisted id the server treats
  as a database key, not a credential.
- **Let a client name an explicit revive target by id.** Rejected because
  it would reopen exactly the hole this ADR closes — a client claiming "I
  am reviving player X" is one step from a client claiming "mutate player
  X's record directly." Deriving the target server-side from proximity and
  status removes the possibility entirely rather than validating it after
  the fact.

## Consequences

- A compromised or malicious client can only ever act as the identity its
  own WebSocket connection authenticated as (its `?playerId=` at connect
  time) — it has no way to name another player as the subject of a
  mutating request, because no handler ever looks at a client-supplied
  field to decide whose record to touch.
- This still isn't real authentication: the "identity" is an opaque
  browser-stored id with no secret backing it, and swapping another
  player's exact id string into your own `localStorage` *would* let you
  reconnect as them (the duplicate-identity check only blocks two sockets
  driving the same id *simultaneously*, not one socket later claiming an id
  it never had before). That's an accepted, documented gap — stealing
  someone else's id string requires already knowing it (it's never sent to
  anyone but its owner), and real auth is explicitly out of scope per
  `CLAUDE.md`.
- `spec/player-isolation.test.ts` is the automated, repeatable version of
  this ADR's central claim; `docs/decisions/0001-simultaneous-build-conflicts.md`
  remains the ADR for the separate concern of two players racing over
  *shared* resources.
