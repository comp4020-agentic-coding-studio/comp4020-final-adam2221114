// Mirrors src/server/game-state.ts's WALL_LEVELS/TURRET_LEVELS/positions —
// duplicated for the same build-separation reason as protocol.ts (see its
// comment). Both render.ts (drawing) and main.ts (menu cost labels) import
// from here instead of each keeping their own copy.

export interface Vec2 {
  x: number;
  y: number;
}

export const WORLD_SIZE = 1000;
export const BASE_POS: Vec2 = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
export const BASE_ATTACK_RANGE = 40;
export const WALL_PULSE_RADIUS = 110;
export const BASE_INTERACT_RANGE = 80;
export const TURRET_INTERACT_RANGE = 80;
export const TURRET_BUILD_RADIUS = 150;
export const TURRET_MIN_SEPARATION = 40;
export const MAX_TURRETS = 4;
export const REVIVE_RANGE = 40;

export interface WallLevelConfig {
  maxHp: number;
  cost: number;
  pulseDamage: number;
  pulseIntervalMs: number;
  spikeDamage: number;
  damageReductionPercent: number;
}

export const WALL_LEVELS: Record<number, WallLevelConfig> = {
  1: { maxHp: 50, cost: 100, pulseDamage: 0, pulseIntervalMs: 0, spikeDamage: 0, damageReductionPercent: 0 },
  2: { maxHp: 80, cost: 300, pulseDamage: 25, pulseIntervalMs: 3000, spikeDamage: 0, damageReductionPercent: 0 },
  3: { maxHp: 120, cost: 900, pulseDamage: 0, pulseIntervalMs: 0, spikeDamage: 35, damageReductionPercent: 0 },
  4: { maxHp: 200, cost: 1800, pulseDamage: 0, pulseIntervalMs: 0, spikeDamage: 50, damageReductionPercent: 0 },
  5: { maxHp: 250, cost: 3500, pulseDamage: 0, pulseIntervalMs: 0, spikeDamage: 50, damageReductionPercent: 0.2 },
};
export const WALL_MAX_LEVEL = 5;

export interface TurretLevelConfig {
  maxHp: number;
  damage: number;
  fireIntervalMs: number;
  range: number;
  cost: number;
  repairCost: number;
  multiTargetCount: number;
  splashRadius: number;
  splashDamagePercent: number;
}

export const TURRET_LEVELS: Record<number, TurretLevelConfig> = {
  1: { maxHp: 100, damage: 30, fireIntervalMs: 2500, range: 150, cost: 150, repairCost: 75, multiTargetCount: 1, splashRadius: 0, splashDamagePercent: 0 },
  2: { maxHp: 150, damage: 50, fireIntervalMs: 2200, range: 180, cost: 400, repairCost: 200, multiTargetCount: 2, splashRadius: 0, splashDamagePercent: 0 },
  3: { maxHp: 250, damage: 80, fireIntervalMs: 2000, range: 210, cost: 1000, repairCost: 500, multiTargetCount: 3, splashRadius: 0, splashDamagePercent: 0 },
  4: { maxHp: 400, damage: 120, fireIntervalMs: 1800, range: 250, cost: 2200, repairCost: 1100, multiTargetCount: 4, splashRadius: 0, splashDamagePercent: 0 },
  5: { maxHp: 600, damage: 200, fireIntervalMs: 1500, range: 300, cost: 4000, repairCost: 2000, multiTargetCount: 1, splashRadius: 70, splashDamagePercent: 0.5 },
};
export const TURRET_MAX_LEVEL = 5;

export function resurrectCostForDay(day: number): number {
  if (day <= 5) return 100;
  if (day <= 10) return 200;
  if (day <= 15) return 400;
  if (day <= 20) return 600;
  return 1000;
}

export const MEDKIT_COST = 100;
export const MEDKIT_MAX = 2;
