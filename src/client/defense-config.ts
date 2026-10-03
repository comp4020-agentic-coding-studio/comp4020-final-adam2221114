// Mirrors src/server/game-state.ts's WALL_LEVELS/TURRET_LEVELS/positions —
// duplicated for the same build-separation reason as protocol.ts (see its
// comment). Both render.ts (drawing) and main.ts (the X-menu's cost labels)
// import from here instead of each keeping their own copy.

export interface Vec2 {
  x: number;
  y: number;
}

export const WORLD_SIZE = 1000;
export const BASE_POS: Vec2 = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
export const BASE_ATTACK_RANGE = 40;
export const WALL_RING_RADIUS = 60;
export const BASE_INTERACT_RANGE = 80;
export const TURRET_POS: Vec2 = { x: BASE_POS.x + 60, y: BASE_POS.y - 60 };

export interface WallLevelConfig {
  maxHp: number;
  cost: number | null;
  spikeDamage: number;
}

export const WALL_LEVELS: Record<number, WallLevelConfig> = {
  1: { maxHp: 30, cost: 100, spikeDamage: 0 },
  2: { maxHp: 80, cost: 300, spikeDamage: 5 },
  3: { maxHp: 150, cost: null, spikeDamage: 5 },
};
export const WALL_MAX_LEVEL = 3;

export interface TurretLevelConfig {
  maxHp: number;
  damage: number;
  range: number;
  fireIntervalMs: number;
  cost: number | null;
}

export const TURRET_LEVELS: Record<number, TurretLevelConfig> = {
  1: { maxHp: 50, damage: 10, range: 300, fireIntervalMs: 2500, cost: 200 },
  2: { maxHp: 50, damage: 10, range: 300, fireIntervalMs: 2500, cost: null },
  3: { maxHp: 50, damage: 10, range: 300, fireIntervalMs: 2500, cost: null },
};
