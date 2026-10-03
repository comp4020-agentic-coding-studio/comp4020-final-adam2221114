// Pure world/zombie shapes and the little math the game loop needs. No
// persistence here, no networking — just "where is this zombie now".
// Numbers below (speed, damage, map size) are placeholders to make the loop
// observable, not the balance pass; that's final-polish work, not this step's.

export interface Vec2 {
  x: number;
  y: number;
}

export interface Zombie {
  id: string;
  pos: Vec2;
  hp: number;
  attacking: boolean;
  lastAttackAt: number; // ms, relative to the current day's own clock
}

// Static this step — nothing mutates it yet (no WASD, no shooting; that's
// Step 4). It exists now because the Step 3 state snapshot needs a shape for
// it, not because the player can do anything yet.
export interface Player {
  pos: Vec2;
  hp: number;
}

export const MAP_SIZE = 1000;
export const BASE_POS: Vec2 = { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
export const BASE_ATTACK_RANGE = 40;
export const ZOMBIE_SPEED = 40; // units/second
export const ZOMBIE_ATTACK_DAMAGE = 5;
export const ZOMBIE_ATTACK_INTERVAL_MS = 1000;
export const ZOMBIE_MAX_HP = 30; // ~3 pistol shots once Step 4 adds shooting
export const DAY_DURATION_MS = 60_000; // ~45-60s/day; using the top of that range
export const PLAYER_MAX_HP = 100;
export const PLAYER_START_POS: Vec2 = { x: MAP_SIZE / 2, y: MAP_SIZE / 2 + 60 };

// A day-over-day bump, not the full 28-day curve — that's later work.
export function spawnsForDay(day: number): number {
  return 2 + day;
}

let nextZombieId = 1;

export function randomEdgePosition(): Vec2 {
  const side = Math.floor(Math.random() * 4);
  const along = Math.random() * MAP_SIZE;
  switch (side) {
    case 0:
      return { x: along, y: 0 };
    case 1:
      return { x: MAP_SIZE, y: along };
    case 2:
      return { x: along, y: MAP_SIZE };
    default:
      return { x: 0, y: along };
  }
}

export function spawnZombie(): Zombie {
  return {
    id: `z${nextZombieId++}`,
    pos: randomEdgePosition(),
    hp: ZOMBIE_MAX_HP,
    attacking: false,
    lastAttackAt: -Infinity,
  };
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Moves one zombie a dtMs-sized step straight toward the base, or flips it
// into "attacking" once it's in range. No pathfinding — there's nothing to
// path around yet, and the brief's own call to keep this simple holds here.
export function stepZombie(z: Zombie, dtMs: number): void {
  const d = distance(z.pos, BASE_POS);
  if (d <= BASE_ATTACK_RANGE) {
    z.attacking = true;
    return;
  }
  z.attacking = false;
  const step = (ZOMBIE_SPEED * dtMs) / 1000;
  const ratio = Math.min(step / d, 1);
  z.pos = {
    x: z.pos.x + (BASE_POS.x - z.pos.x) * ratio,
    y: z.pos.y + (BASE_POS.y - z.pos.y) * ratio,
  };
}
