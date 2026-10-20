// Pure world/zombie/building/player shapes and the math the game loop needs.
// No persistence here, no networking — just "where is this thing now, and
// what does it do." Numbers are the values from the Crit 10 design brief,
// not an arbitrary placeholder pass; where the brief didn't specify a value
// (wall pulse radius, turret splash radius, melee/aggro ranges, boss
// damage/speed, etc.) a reasonable default was chosen and is called out in
// the comment next to it — see PROCESS.md for the full list of assumptions.
import { flowDirectionAt, isWithinWallInterior, lineOfSightClear, nearestRectDistance, resolveMove, wallRectsForPlayers, wallRectsForZombies } from "./obstacles.ts";

export interface Vec2 {
  x: number;
  y: number;
}

export type ZombieType = "normal" | "flying" | "giant" | "boss";

export interface ZombieTypeConfig {
  hp: number; // boss's own hp here is just a fallback; BOSS_HP_BY_DAY overrides per spawn
  damage: number;
  attackIntervalMs: number;
  speedMultiplier: number; // applied to ZOMBIE_SPEED
  ranged: boolean; // true = flying: attacks from range, ignores the wall entirely
  attackRange: number; // melee contact distance, or ranged attack distance
  explodesOnDeath: boolean;
  explosionRadius: number;
  explosionDamage: number;
}

// Melee contact distance for normal/giant/boss. Not specified by the brief;
// a close, deliberate contact range (smaller than the wall ring) so "melee"
// reads as melee. Exported: game-loop.ts also uses it to decide when a
// ground zombie is close enough to a turret to attack that instead (see its
// own comment on why turrets need to be physical obstacles).
export const MELEE_RANGE = 30;
// Flying zombies "do not need to approach into melee range" — this is how
// far out they stop and fire from. Not specified; chosen to sit comfortably
// inside PISTOL_RANGE so a player can still shoot one down before it's in
// their own face, but well outside melee distance.
const FLYING_ATTACK_RANGE = 220;

export const ZOMBIE_TYPES: Record<ZombieType, ZombieTypeConfig> = {
  normal: { hp: 100, damage: 10, attackIntervalMs: 1000, speedMultiplier: 1.0, ranged: false, attackRange: MELEE_RANGE, explodesOnDeath: false, explosionRadius: 0, explosionDamage: 0 },
  flying: { hp: 50, damage: 20, attackIntervalMs: 2000, speedMultiplier: 1.3, ranged: true, attackRange: FLYING_ATTACK_RANGE, explodesOnDeath: false, explosionRadius: 0, explosionDamage: 0 },
  // Explosion radius not specified; chosen just past the wall ring so a
  // giant dying at the wall still threatens anyone standing at the base menu.
  giant: { hp: 300, damage: 10, attackIntervalMs: 2000, speedMultiplier: 0.6, ranged: false, attackRange: MELEE_RANGE, explodesOnDeath: true, explosionRadius: 70, explosionDamage: 10 },
  // Boss damage/interval/speed are not in the brief ("basic melee attacks
  // initially... keep extensible") — flat across all four bosses, only HP
  // differs (BOSS_HP_BY_DAY). Slow and hits moderately hard, consistent with
  // "basic melee" rather than inventing a kit.
  boss: { hp: 500, damage: 25, attackIntervalMs: 1200, speedMultiplier: 0.5, ranged: false, attackRange: MELEE_RANGE, explodesOnDeath: false, explosionRadius: 0, explosionDamage: 0 },
};

export const BOSS_HP_BY_DAY: Record<number, number> = { 5: 500, 10: 1000, 20: 2000, 28: 5000 };

// How close a zombie needs to be to a living player before it switches from
// heading for the base to hunting that player instead. Not specified by the
// brief; a mid-range value so players moving in the open get noticed without
// every zombie on the map beelining for whoever logged in first.
export const AGGRO_RADIUS = 200;

export interface Zombie {
  id: string;
  type: ZombieType;
  pos: Vec2;
  hp: number;
  maxHp: number;
  attacking: boolean;
  // What "attacking" actually hits once the attack-interval fires — resolved
  // fresh every tick in advanceZombie, since a zombie's target can change
  // tick to tick (a chased player goes down, or a wall falls).
  attackTarget: { kind: "player"; playerId: string } | { kind: "structure" };
  lastAttackAt: number; // ms, GameLoop's own monotonic clock (never reset)
  // Visual-sync bookkeeping for the client (see protocol.ts's ZombieSnapshot
  // comment): attacksLanded increments exactly once per real landed hit,
  // set alongside lastHitKind/lastHitTargetId in GameLoop#applyZombieHit —
  // never touched anywhere else, never affects damage/cooldown logic.
  attacksLanded: number;
  lastHitKind: "player" | "turret" | "wall" | "base" | null;
  lastHitTargetId: string | null;
}

export type PlayerStatus = "alive" | "downed" | "dead";

export interface Player {
  id: string;
  colorIndex: number;
  // Which of the 4 character sheets this player chose (durable, via
  // selectCharacter) — -1 means "hasn't chosen yet". Unlike colorIndex
  // (a live-connection slot, never persisted), this is the player's own
  // deliberate, persisted preference and is NEVER reassigned by the
  // server itself.
  characterIndex: number;
  displayName: string;
  pos: Vec2;
  hp: number;
  maxHp: number;
  status: PlayerStatus;
  downedAt: number; // clockMs the downed timer started; meaningless unless status === "downed"
  diedAt: number; // clockMs status flipped to "dead" — used to pick "the teammate who died first" for paid resurrection
  invulnerableUntil: number; // clockMs; damage is ignored while clockMs < this
  medkits: number; // 0..MEDKIT_MAX, per-player inventory bought with shared XP
  healingSince: number | null; // clockMs a medkit use began, or null if not currently healing
}

// Crit 9/10: up to 4 simultaneous players, matching README's "2-4 friends"
// scope. Each gets the next free colour slot / start offset below, so they
// don't spawn stacked on top of each other.
export const MAX_PLAYERS = 4;
// How many character sheets a player can choose from (sprites.ts's
// PLAYER_SHEETS) — kept here, not imported from the client, since the
// server's own selectCharacter() needs this range independently of any
// client art.
export const CHARACTER_COUNT = 4;
export const DISPLAY_NAME_MAX_LENGTH = 20;
export const PLAYER_START_OFFSETS: Vec2[] = [
  { x: 0, y: 0 },
  { x: 30, y: 0 },
  { x: -30, y: 0 },
  { x: 0, y: 30 },
];

// What WASD + the held keys (+ the revive hold) look like once decoded.
// aimAngle is radians, atan2 convention (0 = facing +x), set by the client
// from its own mouse position relative to the player. `reviving` mirrors the
// move keys' continuous-while-held shape — holding E, not a one-shot message.
export interface InputState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  aimAngle: number;
  reviving: boolean;
}

export const MAP_SIZE = 1000;
export const BASE_POS: Vec2 = { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
// Where ground zombies stop once the wall is gone — right up against the base.
export const BASE_ATTACK_RANGE = 40;
// How close a player has to be to the base / to a turret to open its X-menu.
export const BASE_INTERACT_RANGE = 80;
export const TURRET_INTERACT_RANGE = 80;
export const BASE_MAX_HP = 100;
export const ZOMBIE_SPEED = 40; // units/second, before a type's own speedMultiplier
export const ZOMBIE_ATTACK_INTERVAL_MS = 1000; // kept for reference; per-type intervals live in ZOMBIE_TYPES now
export const DAY_VICTORY = 28; // completing this day ends the round in victory
export const PLAYER_MAX_HP = 100;
export const PLAYER_SPEED = 150; // units/second
export const PLAYER_START_POS: Vec2 = { x: MAP_SIZE / 2, y: MAP_SIZE / 2 + 60 };

export const PISTOL_DAMAGE = 30;
export const PISTOL_RANGE = 600;
export const PISTOL_CONE_HALF_ANGLE = 0.15; // radians, ~8.6 degrees either side of aimAngle

export const XP_PER_KILL = 50;

// --- Player HP: downed, dead, revive, medkits -------------------------------

// How close another player must be to hold-revive a downed teammate. Not
// specified; a close, deliberate contact distance (same order as melee).
export const REVIVE_RANGE = 40;
export const REVIVE_HOLD_MS = 3000;
export const DOWNED_DURATION_MS = 45000;
export const FIELD_REVIVE_HP = 50;
export const FIELD_REVIVE_INVULN_MS = 2000;
export const PAID_RESURRECT_HP = 100;
export const PAID_RESURRECT_INVULN_MS = 3000;
export const DAILY_HEAL_AMOUNT = 30;
export const DAY_INTRO_MS = 5000;

export const MEDKIT_COST = 100;
export const MEDKIT_HEAL = 50;
export const MEDKIT_MAX = 2;
export const MEDKIT_DURATION_MS = 2000;

export function resurrectCostForDay(day: number): number {
  if (day <= 5) return 100;
  if (day <= 10) return 200;
  if (day <= 15) return 400;
  if (day <= 20) return 600;
  return 1000;
}

// --- Wall: 5 levels ----------------------------------------------------------
//
// Every wall level's numbers in one place. cost is what it takes to REACH
// that level from the one below (build from 0, or upgrade from the previous
// level). A level's ABILITY shape changed from the 3-level design: level 2 is
// now a periodic AOE pulse (not an on-hit reflect), levels 3+ are an on-hit
// spike reflect, level 5 adds flat damage reduction on top. Destroying the
// wall always drops it back to level 0 — a rebuild starts over at level 1.
export interface WallLevelConfig {
  maxHp: number;
  cost: number;
  pulseDamage: number; // level 2 only
  pulseIntervalMs: number; // level 2 only
  spikeDamage: number; // levels 3+
  damageReductionPercent: number; // level 5 only (0..1)
}

export const WALL_LEVELS: Record<number, WallLevelConfig> = {
  1: { maxHp: 50, cost: 100, pulseDamage: 0, pulseIntervalMs: 0, spikeDamage: 0, damageReductionPercent: 0 },
  2: { maxHp: 80, cost: 300, pulseDamage: 25, pulseIntervalMs: 3000, spikeDamage: 0, damageReductionPercent: 0 },
  3: { maxHp: 120, cost: 900, pulseDamage: 0, pulseIntervalMs: 0, spikeDamage: 35, damageReductionPercent: 0 },
  4: { maxHp: 200, cost: 1800, pulseDamage: 0, pulseIntervalMs: 0, spikeDamage: 50, damageReductionPercent: 0 },
  5: { maxHp: 250, cost: 3500, pulseDamage: 0, pulseIntervalMs: 0, spikeDamage: 50, damageReductionPercent: 0.2 },
};
export const WALL_MAX_LEVEL = 5;
// How far level 2's periodic pulse reaches from the base. Not specified;
// bigger than the wall ring so it's a meaningfully different ability from
// the later levels' on-hit spikes, not just the same thing on a timer.
export const WALL_PULSE_RADIUS = 110;

// --- Turrets: up to 4 independent, 5 levels each ----------------------------

// Where a turret is allowed to go: an annulus around the base (outer
// TURRET_BUILD_RADIUS, inner BASE_ATTACK_RANGE — the base's own footprint).
export const TURRET_BUILD_RADIUS = 150;
export const MAX_TURRETS = 4;
// Minimum distance between two turrets. Not specified by the brief; a small
// separation so 4 turrets can't be placed fully overlapping each other.
export const TURRET_MIN_SEPARATION = 40;

// multiTargetCount: how many of the nearest in-range zombies one shot hits —
// this project's hitscan-only architecture (CLAUDE.md: "use hitscan rather
// than networked bullet physics") has no projectile/line entity to pierce
// along, so "pierce up to N" and "attacks 2 targets" are both implemented the
// same way: one shot simultaneously hits the N nearest zombies in range, each
// taking full damage. splashRadius/splashDamagePercent (level 5 only) is a
// separate, position-based AOE around the single primary target instead.
export interface TurretLevelConfig {
  maxHp: number;
  damage: number;
  fireIntervalMs: number;
  range: number;
  cost: number;
  repairCost: number;
  multiTargetCount: number;
  splashRadius: number;
  splashDamagePercent: number; // 0..1
}

// Splash radius not specified; a modest blast radius around the primary hit.
const TURRET_SPLASH_RADIUS = 70;

export const TURRET_LEVELS: Record<number, TurretLevelConfig> = {
  1: { maxHp: 100, damage: 30, fireIntervalMs: 2500, range: 150, cost: 150, repairCost: 75, multiTargetCount: 1, splashRadius: 0, splashDamagePercent: 0 },
  2: { maxHp: 150, damage: 50, fireIntervalMs: 2200, range: 180, cost: 400, repairCost: 200, multiTargetCount: 2, splashRadius: 0, splashDamagePercent: 0 },
  3: { maxHp: 250, damage: 80, fireIntervalMs: 2000, range: 210, cost: 1000, repairCost: 500, multiTargetCount: 3, splashRadius: 0, splashDamagePercent: 0 },
  4: { maxHp: 400, damage: 120, fireIntervalMs: 1800, range: 250, cost: 2200, repairCost: 1100, multiTargetCount: 4, splashRadius: 0, splashDamagePercent: 0 },
  5: { maxHp: 600, damage: 200, fireIntervalMs: 1500, range: 300, cost: 4000, repairCost: 2000, multiTargetCount: 1, splashRadius: TURRET_SPLASH_RADIUS, splashDamagePercent: 0.5 },
};
export const TURRET_MAX_LEVEL = 5;

// --- 28-day wave table --------------------------------------------------------

export interface DayWave {
  normal: number;
  flying: number;
  giant: number;
  boss: number; // 0 or 1
}

export const WAVE_TABLE: Record<number, DayWave> = {
  1: { normal: 10, flying: 0, giant: 0, boss: 0 },
  2: { normal: 15, flying: 0, giant: 0, boss: 0 },
  3: { normal: 20, flying: 5, giant: 0, boss: 0 },
  4: { normal: 25, flying: 8, giant: 2, boss: 0 },
  5: { normal: 30, flying: 10, giant: 4, boss: 1 },
  6: { normal: 35, flying: 15, giant: 5, boss: 0 },
  7: { normal: 40, flying: 20, giant: 5, boss: 0 },
  8: { normal: 45, flying: 25, giant: 10, boss: 0 },
  9: { normal: 50, flying: 30, giant: 10, boss: 0 },
  10: { normal: 55, flying: 30, giant: 14, boss: 1 },
  11: { normal: 60, flying: 35, giant: 15, boss: 0 },
  12: { normal: 65, flying: 40, giant: 20, boss: 0 },
  13: { normal: 70, flying: 45, giant: 20, boss: 0 },
  14: { normal: 75, flying: 50, giant: 25, boss: 0 },
  15: { normal: 80, flying: 55, giant: 25, boss: 0 },
  16: { normal: 85, flying: 60, giant: 30, boss: 0 },
  17: { normal: 90, flying: 65, giant: 30, boss: 0 },
  18: { normal: 95, flying: 70, giant: 35, boss: 0 },
  19: { normal: 100, flying: 75, giant: 35, boss: 0 },
  20: { normal: 110, flying: 80, giant: 39, boss: 1 },
  21: { normal: 115, flying: 85, giant: 40, boss: 0 },
  22: { normal: 120, flying: 90, giant: 45, boss: 0 },
  23: { normal: 125, flying: 95, giant: 45, boss: 0 },
  24: { normal: 130, flying: 100, giant: 50, boss: 0 },
  25: { normal: 140, flying: 105, giant: 55, boss: 0 },
  26: { normal: 150, flying: 110, giant: 60, boss: 0 },
  27: { normal: 160, flying: 120, giant: 65, boss: 0 },
  28: { normal: 170, flying: 130, giant: 70, boss: 1 },
};

export function waveForDay(day: number): DayWave {
  return WAVE_TABLE[day] ?? WAVE_TABLE[DAY_VICTORY];
}

export function totalZombiesForDay(day: number): number {
  const w = waveForDay(day);
  return w.normal + w.flying + w.giant + w.boss;
}

// Builds this day's full spawn order: every zombie it owes, normal/flying/
// giant shuffled together so types interleave instead of arriving in three
// separate blocks, with the boss (if any) always appended last — a day
// climaxes with its boss, not an arbitrary shuffled position.
export function buildSpawnQueue(day: number): ZombieType[] {
  const w = waveForDay(day);
  const queue: ZombieType[] = [];
  for (let i = 0; i < w.normal; i++) queue.push("normal");
  for (let i = 0; i < w.flying; i++) queue.push("flying");
  for (let i = 0; i < w.giant; i++) queue.push("giant");
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }
  for (let i = 0; i < w.boss; i++) queue.push("boss");
  return queue;
}

// --- Horde spawning: simultaneous batches, full 360° around the base ------
//
// Replaces the old "one zombie every adaptive interval" pacing. Named,
// per-day-range batch sizes/intervals (exact numbers requested, not a
// formula) — every zombie in a batch spawns in the same server tick, not
// trickled in one at a time.
export interface SpawnTier {
  minBatch: number;
  maxBatch: number;
  intervalMs: number;
}

export function spawnTierForDay(day: number): SpawnTier {
  if (day <= 2) return { minBatch: 4, maxBatch: 5, intervalMs: 6000 };
  if (day <= 5) return { minBatch: 5, maxBatch: 7, intervalMs: 5000 };
  if (day <= 10) return { minBatch: 7, maxBatch: 10, intervalMs: 4000 };
  return { minBatch: 8, maxBatch: 10, intervalMs: 3000 };
}

export function randomBatchSize(tier: SpawnTier): number {
  return tier.minBatch + Math.floor(Math.random() * (tier.maxBatch - tier.minBatch + 1));
}

let nextZombieId = 1;

// A ray from the map's exact centre (always BASE_POS — see MAP_SIZE/BASE_POS
// above) at this angle, projected out to wherever it first crosses the
// square map boundary. Every angle in [0, 2π) maps to a real point on the
// perimeter, corners included — a continuous 360° spawn ring, not a choice
// among four fixed sides or points. (The old system did already vary
// continuously along whichever side it picked, but picked that side from
// just 4 — this removes the 4-way branch entirely.)
export function perimeterPositionAtAngle(angleRad: number): Vec2 {
  const half = MAP_SIZE / 2;
  const dx = Math.cos(angleRad);
  const dy = Math.sin(angleRad);
  // Scales the direction so the larger axis component reaches exactly
  // half the map size — i.e. the point where the ray first leaves the
  // square, since dx²+dy²=1 guarantees max(|dx|,|dy|) is never 0.
  const scale = half / Math.max(Math.abs(dx), Math.abs(dy));
  return {
    x: clamp(half + dx * scale, 0, MAP_SIZE),
    y: clamp(half + dy * scale, 0, MAP_SIZE),
  };
}

// Enough sectors for the largest possible batch (10 — see spawnTierForDay)
// to each land in its own unique 36° slice of the circle, in shuffled
// (not always-clockwise-from-0) order — a batch's zombies spread across
// different angular sectors instead of each independently rolling an angle
// that could land them all on one side of the map.
const SPAWN_SECTORS = 10;

export function batchSpawnAngles(count: number): number[] {
  const order = Array.from({ length: SPAWN_SECTORS }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const sectorSize = (Math.PI * 2) / SPAWN_SECTORS;
  const angles: number[] = [];
  for (let i = 0; i < count; i++) {
    const sector = order[i % SPAWN_SECTORS];
    angles.push(sector * sectorSize + Math.random() * sectorSize);
  }
  return angles;
}

// Structures (base/wall/turrets) all sit well inside TURRET_BUILD_RADIUS of
// the map's exact centre — nowhere near the boundary a spawn point always
// lands on — so they can never be spawned on top of; only a PLAYER, who can
// walk anywhere including near an edge, needs an explicit check here.
const SPAWN_PLAYER_CLEARANCE = 60;

export function spawnPositionAtAngle(angleRad: number, players: readonly Player[]): Vec2 {
  let angle = angleRad;
  let pos = perimeterPositionAtAngle(angle);
  for (
    let attempt = 0;
    attempt < SPAWN_SECTORS && players.some((p) => p.status === "alive" && distance(pos, p.pos) < SPAWN_PLAYER_CLEARANCE);
    attempt++
  ) {
    angle += (Math.PI * 2) / SPAWN_SECTORS;
    pos = perimeterPositionAtAngle(angle);
  }
  return pos;
}

export function spawnZombie(type: ZombieType, day: number, pos: Vec2): Zombie {
  const hp = type === "boss" ? (BOSS_HP_BY_DAY[day] ?? ZOMBIE_TYPES.boss.hp) : ZOMBIE_TYPES[type].hp;
  return {
    id: `z${nextZombieId++}`,
    type,
    pos,
    hp,
    maxHp: hp,
    attacking: false,
    attackTarget: { kind: "structure" },
    lastAttackAt: -Infinity,
    attacksLanded: 0,
    lastHitKind: null,
    lastHitTargetId: null,
  };
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

// Continuous WASD movement: whatever's held moves the player this tick, at a
// fixed speed, clamped to the map. No acceleration/friction. Callers only
// invoke this for "alive" players — downed/dead players don't move.
//
// Crit 11 map-visual pass: the desired destination is resolved against
// obstacles.ts's buildings with axis-separated collision (resolveMove) —
// this is what gives sliding along a wall for free instead of a glancing
// touch freezing movement entirely. Authoritative: the server is the only
// place this actually happens; the client's prediction.ts mirrors the same
// resolveMove purely for responsiveness, and gets corrected by this if it
// ever disagrees (same reconciliation path every other prediction error
// already takes).
export function movePlayer(player: Player, input: InputState, dtMs: number, wallLevel: number): void {
  let dx = 0;
  let dy = 0;
  if (input.up) dy -= 1;
  if (input.down) dy += 1;
  if (input.left) dx -= 1;
  if (input.right) dx += 1;
  if (dx === 0 && dy === 0) return;

  const len = Math.hypot(dx, dy);
  const step = (PLAYER_SPEED * dtMs) / 1000;
  const desired: Vec2 = {
    x: clamp(player.pos.x + (dx / len) * step, 0, MAP_SIZE),
    y: clamp(player.pos.y + (dy / len) * step, 0, MAP_SIZE),
  };
  player.pos = resolveMove(player.pos, desired, wallRectsForPlayers(wallLevel));
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

// Instant hit resolution: no bullet entity, no travel time. Among zombies
// within range and inside the aim cone, the nearest one takes the hit.
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

// Generalized turret targeting: the `count` nearest zombies within range, no
// aim cone (turrets auto-target). count=1 is the old single-target behaviour;
// higher counts are how level 2+'s "attacks N targets" / "pierce up to N" are
// implemented (see TurretLevelConfig's own comment on why).
export function findNearestZombiesInRange(origin: Vec2, range: number, count: number, zombies: readonly Zombie[]): Zombie[] {
  return zombies
    .map((z) => ({ z, d: distance(origin, z.pos) }))
    .filter((e) => e.d <= range)
    .sort((a, b) => a.d - b.d)
    .slice(0, count)
    .map((e) => e.z);
}

// Picks what a zombie is currently hunting: the nearest ALIVE player within
// AGGRO_RADIUS, or the base if none is close enough. Re-evaluated every tick
// (not sticky) so a zombie reroutes promptly once its target goes down, dies,
// or simply runs far enough away.
export function pickTarget(zombiePos: Vec2, players: readonly Player[]): { pos: Vec2; isPlayer: boolean; playerId: string | null } {
  let best: Player | undefined;
  let bestDist = AGGRO_RADIUS;
  for (const p of players) {
    if (p.status !== "alive") continue;
    const d = distance(zombiePos, p.pos);
    if (d <= bestDist) {
      best = p;
      bestDist = d;
    }
  }
  if (best) return { pos: best.pos, isPlayer: true, playerId: best.id };
  return { pos: BASE_POS, isPlayer: false, playerId: null };
}

// Moves one zombie a dtMs-sized step toward whatever it's currently hunting
// (pickTarget), or flips it into "attacking" once in range. Ground zombies
// (ranged: false) can never cross an intact wall to reach anything inside
// it — including a player who made it inside through the gate — and fall
// back to attacking the wall/base instead, exactly like this game always
// did. Flying zombies ignore the wall entirely ("may attack over walls"):
// they always go straight for the real target.
//
// wallLevel drives wallRectsForZombies (obstacles.ts), the all-sides-solid,
// NO-gate shape a ground zombie sees — deliberately different from the
// player-facing gated shape resolveMove uses for movePlayer, so a zombie
// can never walk in through where a player's gate is (see obstacles.ts's
// own comment on this asymmetry). Collision against these rects reuses the
// exact same resolveMove axis-separated slide used for player movement and
// static buildings — one shared collision function, not a parallel copy.
export function advanceZombie(z: Zombie, dtMs: number, players: readonly Player[], wallLevel: number): void {
  const cfg = ZOMBIE_TYPES[z.type];
  const target = pickTarget(z.pos, players);
  const zombieWallRects = cfg.ranged ? [] : wallRectsForZombies(wallLevel);

  let aimPos = target.pos;
  let attackTarget: Zombie["attackTarget"] = target.isPlayer && target.playerId ? { kind: "player", playerId: target.playerId } : { kind: "structure" };

  // The real target (base, or a player who made it inside through the
  // gate) is behind an intact wall — redirect to the base and stop at the
  // wall itself rather than reaching straight through it.
  const blockedByWall = zombieWallRects.length > 0 && isWithinWallInterior(target.pos);
  if (blockedByWall) {
    aimPos = BASE_POS;
    attackTarget = { kind: "structure" };
  }

  // "Close enough to attack" differs by shape: a rectangle's nearest edge
  // for the wall, a plain point distance for everything else (an exposed
  // player, or the base once the wall's down).
  const closeEnoughToAttack = blockedByWall
    ? nearestRectDistance(z.pos, zombieWallRects) <= MELEE_RANGE
    : distance(z.pos, aimPos) <= (target.isPlayer ? cfg.attackRange : BASE_ATTACK_RANGE);

  if (closeEnoughToAttack) {
    z.attacking = true;
    z.attackTarget = attackTarget;
    return;
  }
  z.attacking = false;
  const step = (ZOMBIE_SPEED * cfg.speedMultiplier * dtMs) / 1000;

  // Crit 11 map-visual pass: buildings are solid for GROUND zombies only —
  // flying zombies already ignore the wall entirely ("may attack over
  // walls") and ignore buildings the same way, for the same reason (nothing
  // in the brief says a flier respects ground obstacles). When a ground
  // zombie's direct line to aimPos is clear, behaviour here is byte-for-byte
  // what it always was (a direct lerp). When it's blocked by a building,
  // step along the precomputed flow field toward the base instead — an
  // explicit approximation when the real target is a player rather than the
  // base (CLAUDE.md: "a static, precomputed flow field toward the base", not
  // a per-target route), acceptable since the brief only requires zombies
  // reliably reach the base, not take an optimal path to a moving player.
  // The wall is NOT part of the flow field (it's live state, not a fixed
  // obstacle — see obstacles.ts's own comment on why); a zombie routing
  // around it instead slides along it via the same resolveMove collision
  // every other obstacle already uses, same as how players round a corner.
  const useFlowField = !cfg.ranged && !lineOfSightClear(z.pos, aimPos);
  let nextPos: Vec2;
  if (useFlowField) {
    const dir = flowDirectionAt(z.pos);
    nextPos = { x: z.pos.x + dir.x * step, y: z.pos.y + dir.y * step };
  } else {
    const d = distance(z.pos, aimPos) || 1;
    const ratio = Math.min(step / d, 1);
    nextPos = {
      x: z.pos.x + (aimPos.x - z.pos.x) * ratio,
      y: z.pos.y + (aimPos.y - z.pos.y) * ratio,
    };
  }
  // Final safety clamp: never let a ground zombie's resolved step actually
  // end up inside a building or the wall, whichever path produced it
  // (direct lerp can still clip a corner; the flow field is cell-coarse,
  // not exact).
  if (!cfg.ranged) {
    nextPos = resolveMove(z.pos, nextPos, zombieWallRects);
  }
  z.pos = nextPos;
}
