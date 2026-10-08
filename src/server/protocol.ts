// Message shapes shared between server and (future) client, so there's one
// definition instead of a hand-copied second one on each side.

export interface PlayerSnapshot {
  id: string;
  colorIndex: number;
  x: number;
  y: number;
  hp: number;
}

export interface ZombieSnapshot {
  id: string;
  x: number;
  y: number;
  hp: number;
}

// The round's state machine. "waiting" is also every process's boot state —
// see GameLoop's own comment on why phase itself is never persisted.
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
  turretLevel: number;
  turretHp: number;
  turretMaxHp: number;
  turretBuilt: boolean;
  turretX: number; // meaningless while !turretBuilt
  turretY: number;
  // Not persisted (GameLoop's own comment explains why) — just this tick's
  // targeting, so the client can draw the turret's barrel/aim line and tell
  // a real shot apart from an idle turret via turretShotsFired increasing.
  turretTarget: { x: number; y: number } | null;
  turretShotsFired: number;
  // This day's wave: the client renders its progress bar straight from
  // these, nothing computed locally.
  killedZombies: number;
  totalZombiesForDay: number;
  players: PlayerSnapshot[];
  zombies: ZombieSnapshot[];
}

// Sent once, right after a connection is accepted, so the client knows which
// entry in players[] is itself (for prediction/reconciliation vs. plain
// interpolation of everyone else).
export interface WelcomeMessage {
  type: "welcome";
  playerId: string;
}

// Sent instead of "welcome" (then the socket is closed) when MAX_PLAYERS are
// already connected.
export interface FullMessage {
  type: "full";
}

// Sent only to the socket whose interact/place_turret request was rejected —
// the Crit 9 ADR's "make the loser's rejection visible" behaviour, instead of
// Crit 8's silent no-op.
export interface RejectedMessage {
  type: "rejected";
  action: InteractAction | "place_turret";
  reason: string;
}

// Client -> server. input carries the full held-key state and the current
// aim angle on every send; shoot is a bare one-shot event resolved against
// whatever input the server has stored most recently.
export interface InputMessage {
  type: "input";
  move: { up: boolean; down: boolean; left: boolean; right: boolean };
  aimAngle: number;
}

export interface ShootMessage {
  type: "shoot";
}

// Start and resume are the same transition server-side (GameLoop.play()) —
// two buttons in the UI for clarity, one state-machine edge underneath.
export interface ControlMessage {
  type: "start" | "pause" | "resume" | "restart";
}

// The X-menu's actions. The server re-validates range/cost/current building
// state independently every time — this message is a request, not a grant.
// build_turret isn't here any more — picking it client-side enters placement
// mode instead (purely local UI, no message sent yet); only the follow-up
// click, as a PlaceTurretMessage, is a real request.
export type InteractAction = "build_wall" | "upgrade_wall";

export interface InteractMessage {
  type: "interact";
  action: InteractAction;
}

// Sent once, when the player clicks a (client-side-judged) valid spot during
// placement mode. The server re-validates all of it independently — range,
// cost, "not already built", and whether (x, y) is actually inside the
// allowed ring — the client's own validity check is only ever a preview.
export interface PlaceTurretMessage {
  type: "place_turret";
  x: number;
  y: number;
}

export type ClientMessage = InputMessage | ShootMessage | ControlMessage | InteractMessage | PlaceTurretMessage;
