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

// Server -> client, broadcast at a stable rate (ws-server.ts).
export interface StateMessage {
  type: "state";
  day: number;
  baseHp: number;
  baseMaxHp: number;
  baseLevel: number;
  sharedXp: number;
  wallUnlocked: boolean; // derived (baseLevel >= 1), not a separate persisted field
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

export type ClientMessage = InputMessage | ShootMessage;
