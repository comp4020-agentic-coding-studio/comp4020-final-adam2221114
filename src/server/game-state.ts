// Pure world/zombie/building shapes and the little math the game loop needs.
// No persistence here, no networking — just "where is this thing now".
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
  lastAttackAt: number; // ms, GameLoop's own monotonic clock (never reset)
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
// Where zombies stop once the wall is gone — right up against the base.
export const BASE_ATTACK_RANGE = 40;
// Where zombies stop while the wall still has HP — must be further out than
// BASE_ATTACK_RANGE (and is what the wall ring is drawn at client-side), or
// a zombie would visually sit inside the wall instead of outside it.
export const WALL_RING_RADIUS = 60;
// How close the player has to be to the base to open the upgrade menu (X).
export const BASE_INTERACT_RANGE = 80;
export const BASE_MAX_HP = 100; // also persistence.ts's default — single source of truth
export const ZOMBIE_SPEED = 40; // units/second
export const ZOMBIE_ATTACK_DAMAGE = 5; // applies to whichever of wall/base is currently absorbing hits
export const ZOMBIE_ATTACK_INTERVAL_MS = 1000;
export const ZOMBIE_MAX_HP = 90;
export const DAY_VICTORY = 28; // completing this day ends the round in victory
export const PLAYER_MAX_HP = 100;
export const PLAYER_SPEED = 150; // units/second
export const PLAYER_START_POS: Vec2 = { x: MAP_SIZE / 2, y: MAP_SIZE / 2 + 60 };

export const PISTOL_DAMAGE = 30; // 3 shots kill a ZOMBIE_MAX_HP zombie
export const PISTOL_RANGE = 600;
export const PISTOL_CONE_HALF_ANGLE = 0.15; // radians, ~8.6 degrees either side of aimAngle

export const XP_PER_KILL = 50;

// Every wall level's numbers in one place, as asked — nothing about wall HP
// or cost lives anywhere else. cost is what it takes to REACH that level
// from the one below (build from 0, or upgrade from the previous level); a
// level with cost: null isn't buyable yet (no price decided) — the interact
// menu simply won't offer it. spikeDamage is the level-2+ reflect effect:
// every time an attacking zombie hits the wall, it takes this much damage
// back. Destroying the wall always drops it back to level 0 (see GameLoop's
// comment on why) — getting back to level 2 means paying for 1 and 2 again.
export interface WallLevelConfig {
  maxHp: number;
  cost: number | null;
  spikeDamage: number;
}

export const WALL_LEVELS: Record<number, WallLevelConfig> = {
  1: { maxHp: 30, cost: 100, spikeDamage: 0 },
  2: { maxHp: 80, cost: 300, spikeDamage: 5 },
  3: { maxHp: 150, cost: null, spikeDamage: 5 }, // reachable in principle, not priced yet
};
export const WALL_MAX_LEVEL = 3;

// Fixed, single placement near the base — no picking a spot, no multiple
// turrets this round.
export const TURRET_POS: Vec2 = { x: BASE_POS.x + 60, y: BASE_POS.y - 60 };

// Same one-table-for-the-numbers approach as the wall. Only level 1 is
// priced and only level 1 is reachable right now — level 2/3 costs (and any
// stat changes beyond level 1's) are the user's call, not invented here.
export interface TurretLevelConfig {
  maxHp: number;
  damage: number;
  range: number;
  fireIntervalMs: number;
  cost: number | null;
}

export const TURRET_LEVELS: Record<number, TurretLevelConfig> = {
  1: { maxHp: 50, damage: 10, range: 300, fireIntervalMs: 2500, cost: 200 },
  2: { maxHp: 50, damage: 10, range: 300, fireIntervalMs: 2500, cost: null }, // not decided yet
  3: { maxHp: 50, damage: 10, range: 300, fireIntervalMs: 2500, cost: null }, // not decided yet
};

// How many zombies day N has in total. A day only ends once every one of
// them has spawned AND been killed — see GameLoop's own comment on why this
// replaced the old fixed-duration timer. Simple linear growth, not the full
// 28-day balance pass: that's later work, this just has to be mechanically
// correct (day 1 = 3, day 2 = 9, day 3 = 15, ...).
export function zombiesForDay(day: number): number {
  return 3 + (day - 1) * 6;
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

export function distance(a: Vec2, b: Vec2): number {
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

// Same "nearest in range" shape as resolveShot, but no aim cone — the turret
// auto-targets, it doesn't get aimed.
export function findNearestZombieInRange(origin: Vec2, range: number, zombies: readonly Zombie[]): Zombie | undefined {
  let best: Zombie | undefined;
  let bestDist = Infinity;
  for (const z of zombies) {
    const d = distance(origin, z.pos);
    if (d <= range && d < bestDist) {
      best = z;
      bestDist = d;
    }
  }
  return best;
}

// Moves one zombie a dtMs-sized step straight toward the base, or flips it
// into "attacking" once it hits its stop radius. Which radius depends on
// whether the wall is currently up: WALL_RING_RADIUS while it has HP (stop
// outside it, attack it, never cross), BASE_ATTACK_RANGE once it's down
// (there's nothing left to stop at further out). Re-evaluated every tick, so
// a zombie already holding at the wall ring resumes moving in the moment the
// wall actually breaks — no separate "wall just fell" transition needed. No
// pathfinding — there's nothing to path around yet, and the brief's own call
// to keep this simple holds here.
export function stepZombie(z: Zombie, dtMs: number, wallUp: boolean): void {
  const stopRadius = wallUp ? WALL_RING_RADIUS : BASE_ATTACK_RANGE;
  const d = distance(z.pos, BASE_POS);
  if (d <= stopRadius) {
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
