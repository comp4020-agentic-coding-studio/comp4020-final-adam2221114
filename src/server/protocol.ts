// The server -> client message shape, shared so the (future) client can
// import the same types instead of a second hand-written copy. Step 3 only
// ever sends "state"; client -> server messages (input/shoot) are Step 4.

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

export interface StateMessage {
  type: "state";
  day: number;
  baseHp: number;
  baseMaxHp: number;
  baseLevel: number;
  sharedXp: number;
  player: PlayerSnapshot;
  zombies: ZombieSnapshot[];
}
