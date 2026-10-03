// Mirrors src/server/protocol.ts. Duplicated here rather than splitting the
// build into a third shared/ package — these are a handful of plain type
// shapes (erased at compile time), not logic, so keeping two copies in sync
// by eye is simpler than the build restructuring a real shared package would
// need (server emits to dist/server, client to dist/client; a shared source
// directory would need its own rootDir/outDir story on both sides).

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

export type GamePhase = "waiting" | "running" | "paused" | "game_over" | "victory";

export interface StateMessage {
  type: "state";
  phase: GamePhase;
  day: number;
  baseHp: number;
  baseMaxHp: number;
  baseLevel: number;
  sharedXp: number;
  wallUnlocked: boolean;
  player: PlayerSnapshot;
  zombies: ZombieSnapshot[];
}

export interface InputMessage {
  type: "input";
  move: { up: boolean; down: boolean; left: boolean; right: boolean };
  aimAngle: number;
}

export interface ShootMessage {
  type: "shoot";
}

export interface ControlMessage {
  type: "start" | "pause" | "resume" | "restart";
}

export type ClientMessage = InputMessage | ShootMessage | ControlMessage;
