// Message shapes shared between server and client, so there's one definition
// instead of a hand-copied second one on each side (src/client/protocol.ts
// mirrors this file — see its own comment on why it's a second copy, not a
// shared import).

import type { PlayerStatus, ZombieType } from "./game-state.ts";

export interface PlayerSnapshot {
  id: string;
  colorIndex: number;
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

export type ClientMessage =
  | InputMessage
  | ShootMessage
  | ControlMessage
  | InteractMessage
  | PlaceTurretMessage
  | TurretInteractMessage
  | UseMedkitMessage;
