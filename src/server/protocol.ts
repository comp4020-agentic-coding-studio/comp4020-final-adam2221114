// Message shapes shared between server and (future) client, so there's one
// definition instead of a hand-copied second one on each side.

export interface PlayerSnapshot {
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
  // Not persisted (GameLoop's own comment explains why) — just this tick's
  // targeting, so the client can draw the turret's barrel/aim line and tell
  // a real shot apart from an idle turret via turretShotsFired increasing.
  turretTarget: { x: number; y: number } | null;
  turretShotsFired: number;
  // This day's wave: the client renders its progress bar straight from
  // these, nothing computed locally.
  killedZombies: number;
  totalZombiesForDay: number;
  player: PlayerSnapshot;
  zombies: ZombieSnapshot[];
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
export type InteractAction = "build_wall" | "upgrade_wall" | "build_turret";

export interface InteractMessage {
  type: "interact";
  action: InteractAction;
}

export type ClientMessage = InputMessage | ShootMessage | ControlMessage | InteractMessage;
