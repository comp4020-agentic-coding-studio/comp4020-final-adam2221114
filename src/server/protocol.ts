// Message shapes shared between server and client, so there's one definition
// instead of a hand-copied second one on each side (src/client/protocol.ts
// mirrors this file — see its own comment on why it's a second copy, not a
// shared import).

import type { DayWave, PlayerStatus, ZombieType } from "./game-state.ts";

export interface PlayerSnapshot {
  id: string;
  colorIndex: number;
  // Which of the 4 character sheets this player chose (game-state.ts's
  // CHARACTER_COUNT) — distinct from colorIndex, which only ever decides
  // spawn offset (a live-connection slot), never which outfit renders.
  // -1 means "hasn't chosen yet" (see GameLoop.addPlayer/selectCharacter):
  // the client shows the character-select overlay for itself and skips
  // sprite/name-tag rendering for anyone else still in this state.
  characterIndex: number;
  // "" exactly when characterIndex is -1; otherwise the player's own chosen
  // display name, already trimmed/length-capped server-side.
  displayName: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  status: PlayerStatus;
  // 0 while not downed; counts down from DOWNED_DURATION_MS while downed, so
  // the client can show a timer without re-deriving it from a clock offset.
  downedRemainingMs: number;
  medkits: number;
  healing: boolean;
  invulnerable: boolean;
}

export interface ZombieSnapshot {
  id: string;
  type: ZombieType;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  // Purely a rendering cue (walk vs. attack animation) — the actual attack
  // resolution already happened server-side by the time this is seen.
  attacking: boolean;
  // Monotonic — increments exactly once each time this zombie's attack
  // interval actually landed a hit (on a player, turret, wall, or base).
  // The client diffs this against the previous snapshot to know "a real
  // attack happened this tick" rather than guessing from `attacking`/timing
  // — the same pattern TurretSnapshot.shotsFired already uses. Combined
  // with lastHitKind/lastHitTargetId below, lets the client place an impact
  // effect/projectile exactly where (and only where) damage was really
  // dealt, instead of a client-side guessed hit that could disagree with
  // the server's own combat resolution.
  attacksLanded: number;
  lastHitKind: "player" | "turret" | "wall" | "base" | null;
  lastHitTargetId: string | null; // playerId or turretId; null for wall/base/none
}

export interface TurretSnapshot {
  id: string;
  level: number;
  hp: number;
  maxHp: number;
  x: number;
  y: number;
  target: { x: number; y: number } | null;
  shotsFired: number;
}

// Someone currently mid-revive (holding E on a downed teammate) — broadcast
// so every client can show the hold-progress, not just the reviver's own.
export interface ReviveProgressSnapshot {
  reviverId: string;
  targetId: string;
  remainingMs: number;
}

// The round's state machine. "waiting" is also every process's boot state —
// see GameLoop's own comment on why a stored "running" is never trusted as-is.
export type GamePhase = "waiting" | "running" | "paused" | "game_over" | "victory";

// Server -> client, broadcast at a stable rate (ws-server.ts).
export interface StateMessage {
  type: "state";
  phase: GamePhase;
  day: number;
  baseHp: number;
  baseMaxHp: number;
  sharedXp: number;
  wallLevel: number;
  wallHp: number;
  wallMaxHp: number;
  // > 0 while the day's 5-second countdown banner is showing; 0 once zombies
  // are allowed to spawn. Still "running" throughout — players can move/
  // build/interact during this window, only spawning is held back.
  dayIntroRemainingMs: number;
  killedZombies: number;
  totalZombiesForDay: number;
  // The fixed per-type composition for the CURRENT day (game-state.ts's
  // WAVE_TABLE) — not how many of each have spawned/died so far, just what
  // this day contains. Lets the client show wave composition and trigger a
  // "new enemy" intro the first time a type appears in a run, without
  // guessing from which zombies happen to be alive right now.
  dayWaveComposition: DayWave;
  players: PlayerSnapshot[];
  zombies: ZombieSnapshot[];
  turrets: TurretSnapshot[];
  reviveProgress: ReviveProgressSnapshot[];
}

// Sent once, right after a connection is accepted, so the client knows which
// entry in players[] is itself.
export interface WelcomeMessage {
  type: "welcome";
  playerId: string;
}

// Sent instead of "welcome" (then the socket is closed) when MAX_PLAYERS are
// already connected.
export interface FullMessage {
  type: "full";
}

// Sent instead of "welcome" (then the socket is closed) when the supplied
// playerId is already driving an open connection — one identity, one socket.
export interface DuplicateIdentityMessage {
  type: "duplicate_identity";
}

// Sent only to the socket whose request was rejected — the Crit 9 ADR's
// "make the loser's rejection visible" behaviour, now covering every
// server-validated action, not just build/upgrade.
export interface RejectedMessage {
  type: "rejected";
  action: string;
  reason: string;
}

// Client -> server. input carries the full held-key state, current aim
// angle, and whether E (revive) is currently held, on every send.
export interface InputMessage {
  type: "input";
  move: { up: boolean; down: boolean; left: boolean; right: boolean };
  aimAngle: number;
  reviving: boolean;
}

export interface ShootMessage {
  type: "shoot";
}

// Start and resume are the same transition server-side (GameLoop.play()).
// retry_day is new: only valid from "game_over", restores the day-start
// snapshot and re-plays the same day (see GameLoop.retryDay()) — distinct
// from "restart", which resets everything back to Day 1.
export interface ControlMessage {
  type: "start" | "pause" | "resume" | "restart" | "retry_day";
}

// The base X-menu's actions. The server re-validates range/cost/current
// state independently every time — this message is a request, not a grant.
// build_turret isn't here — picking it client-side enters placement mode
// instead; only the follow-up click, as a PlaceTurretMessage, is a request.
export type InteractAction = "build_wall" | "upgrade_wall" | "revive_dead" | "buy_medkit";

export interface InteractMessage {
  type: "interact";
  action: InteractAction;
}

// Sent once, when the player clicks a (client-side-judged) valid spot during
// placement mode. The server re-validates everything independently.
export interface PlaceTurretMessage {
  type: "place_turret";
  x: number;
  y: number;
}

// The turret X-menu's actions — distinct from InteractMessage because it
// needs a target id (there's no longer exactly one implicit turret).
export type TurretAction = "upgrade" | "repair";

export interface TurretInteractMessage {
  type: "turret_interact";
  turretId: string;
  action: TurretAction;
}

export interface UseMedkitMessage {
  type: "use_medkit";
}

// Sent once a player picks a character card and confirms a name on the
// select-character overlay (shown while characterIndex is -1). The server
// re-validates range/uniqueness-among-connected-players/name length
// independently — this message is a request, not a grant, same as every
// other action here. Re-sending it (e.g. changing your mind before
// confirming) is also how a connected player would change their own pick.
export interface SelectCharacterMessage {
  type: "select_character";
  characterIndex: number;
  displayName: string;
}

export type ClientMessage =
  | InputMessage
  | ShootMessage
  | ControlMessage
  | InteractMessage
  | PlaceTurretMessage
  | TurretInteractMessage
  | UseMedkitMessage
  | SelectCharacterMessage;
