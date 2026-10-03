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

export interface Player {
  pos: Vec2;
  hp: number; // not yet lowered by anything — zombies don't hurt the player this step
}

// What WASD + the held keys look like once decoded. aimAngle is radians,
// atan2 convention (0 = facing +x), set by the client from its own mouse
// position relative to the player.
export interface InputState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  aimAngle: number;
}

export const MAP_SIZE = 1000;
export const BASE_POS: Vec2 = { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
export const BASE_ATTACK_RANGE = 40;
export const BASE_MAX_HP = 100; // also persistence.ts's default — single source of truth
export const ZOMBIE_SPEED = 40; // units/second
export const ZOMBIE_ATTACK_DAMAGE = 5;
export const ZOMBIE_ATTACK_INTERVAL_MS = 1000;
export const ZOMBIE_MAX_HP = 90;
export const DAY_DURATION_MS = 60_000; // ~45-60s/day; using the top of that range
export const DAY_VICTORY = 28; // completing this day ends the round in victory
export const PLAYER_MAX_HP = 100;
export const PLAYER_SPEED = 150; // units/second
export const PLAYER_START_POS: Vec2 = { x: MAP_SIZE / 2, y: MAP_SIZE / 2 + 60 };

export const PISTOL_DAMAGE = 30; // 3 shots kill a ZOMBIE_MAX_HP zombie
export const PISTOL_RANGE = 600;
export const PISTOL_CONE_HALF_ANGLE = 0.15; // radians, ~8.6 degrees either side of aimAngle

export const XP_PER_KILL = 50;
// thresholds[level] is the cumulative sharedXp needed to reach level+1. One
// entry is all this step needs ("base level 至少能升 1 次"); a further level
// (turret/weapon unlocks) is just appending to this array later.
export const LEVEL_UP_THRESHOLDS = [100];

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

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

// Continuous WASD movement: whatever's held moves the player this tick, at a
// fixed speed, clamped to the map. No acceleration/friction — nothing here
// asked for that.
export function movePlayer(player: Player, input: InputState, dtMs: number): void {
  let dx = 0;
  let dy = 0;
  if (input.up) dy -= 1;
  if (input.down) dy += 1;
  if (input.left) dx -= 1;
  if (input.right) dx += 1;
  if (dx === 0 && dy === 0) return;

  const len = Math.hypot(dx, dy);
  const step = (PLAYER_SPEED * dtMs) / 1000;
  player.pos = {
    x: clamp(player.pos.x + (dx / len) * step, 0, MAP_SIZE),
    y: clamp(player.pos.y + (dy / len) * step, 0, MAP_SIZE),
  };
}

function angleTo(from: Vec2, to: Vec2): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

// Instant hit resolution: no bullet entity, no travel time, no network
// simulation of a projectile — the server just asks "given where the player
// is and which way they're aiming, is a zombie there?" Among zombies within
// range and inside the aim cone, the nearest one takes the hit. Returns the
// zombie that got hit, or undefined if the shot found nothing; applying the
// damage and removing a dead zombie is the caller's job, not this function's.
export function resolveShot(playerPos: Vec2, aimAngle: number, zombies: readonly Zombie[]): Zombie | undefined {
  let best: Zombie | undefined;
  let bestDist = Infinity;
  for (const z of zombies) {
    const d = distance(playerPos, z.pos);
    if (d > PISTOL_RANGE) continue;
    if (angleDiff(angleTo(playerPos, z.pos), aimAngle) > PISTOL_CONE_HALF_ANGLE) continue;
    if (d < bestDist) {
      best = z;
      bestDist = d;
    }
  }
  return best;
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
