// Mirrors src/server/protocol.ts. Duplicated here rather than splitting the
// build into a third shared/ package — these are a handful of plain type
// shapes (erased at compile time), not logic, so keeping two copies in sync
// by eye is simpler than the build restructuring a real shared package would
// need (server emits to dist/server, client to dist/client; a shared source
// directory would need its own rootDir/outDir story on both sides).

export type ZombieType = "normal" | "flying" | "giant" | "boss";
export type PlayerStatus = "alive" | "downed" | "dead";

export interface PlayerSnapshot {
  id: string;
  colorIndex: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  status: PlayerStatus;
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

export interface ReviveProgressSnapshot {
  reviverId: string;
  targetId: string;
  remainingMs: number;
}

export type GamePhase = "waiting" | "running" | "paused" | "game_over" | "victory";

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
  dayIntroRemainingMs: number;
  killedZombies: number;
  totalZombiesForDay: number;
  players: PlayerSnapshot[];
  zombies: ZombieSnapshot[];
  turrets: TurretSnapshot[];
  reviveProgress: ReviveProgressSnapshot[];
}

export interface WelcomeMessage {
  type: "welcome";
  playerId: string;
}

export interface FullMessage {
  type: "full";
}

export interface DuplicateIdentityMessage {
  type: "duplicate_identity";
}

export interface RejectedMessage {
  type: "rejected";
  action: string;
  reason: string;
}

export type ServerMessage = StateMessage | WelcomeMessage | FullMessage | DuplicateIdentityMessage | RejectedMessage;

export interface InputMessage {
  type: "input";
  move: { up: boolean; down: boolean; left: boolean; right: boolean };
  aimAngle: number;
  reviving: boolean;
}

export interface ShootMessage {
  type: "shoot";
}

export interface ControlMessage {
  type: "start" | "pause" | "resume" | "restart" | "retry_day";
}

export type InteractAction = "build_wall" | "upgrade_wall" | "revive_dead" | "buy_medkit";

export interface InteractMessage {
  type: "interact";
  action: InteractAction;
}

export interface PlaceTurretMessage {
  type: "place_turret";
  x: number;
  y: number;
}

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
