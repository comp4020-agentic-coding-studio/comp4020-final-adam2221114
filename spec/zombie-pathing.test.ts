import { describe, it, expect } from "vitest";
import { advanceZombie, spawnZombie, BASE_POS, BASE_ATTACK_RANGE, distance, ZOMBIE_TYPES, type Player, type Vec2, type ZombieType } from "../src/server/game-state.ts";
import { BUILDINGS, overlapsAnyBuilding, WALL_HALF_EXTENT } from "../src/server/obstacles.ts";

// Sanity check on the flow-field fallback (CLAUDE.md: "a static, precomputed
// flow field toward the base"), not an exact-path assertion — a ground
// zombie spawned on the far side of a building from the base must still
// reliably reach the base within a generous bounded time, detouring around
// the building rather than getting stuck against it forever.
describe("ground zombie pathing around a building", () => {
  it("reaches base-attack range within a generous bounded time despite a building in its direct line", () => {
    const b = BUILDINGS[0];
    const away = { x: BASE_POS.x - b.x, y: BASE_POS.y - b.y };
    const len = Math.hypot(away.x, away.y) || 1;
    const spawnPos: Vec2 = { x: b.x + b.w / 2 - (away.x / len) * (b.w + 80), y: b.y + b.h / 2 - (away.y / len) * (b.h + 80) };
    const zombie = spawnZombie("normal", 1, spawnPos);

    const maxTicks = 4000; // 50ms/tick * 4000 = 200s of sim time — generous
    let reached = false;
    for (let i = 0; i < maxTicks; i++) {
      advanceZombie(zombie, 50, [], 0); // wallLevel 0: nothing but the building itself can block it
      if (distance(zombie.pos, BASE_POS) <= BASE_ATTACK_RANGE || zombie.attacking) {
        reached = true;
        break;
      }
    }
    expect(reached).toBe(true);
  });
});

// Regression coverage for the real "zombies get stuck against walls and
// buildings" bug reported after the Crit 11 map-visual pass: obstacles.ts's
// flow field stores one direction per 25-unit grid cell (from that cell's
// centre), but COLLISION_MARGIN inflates a building's blocked region past
// its actual edge — so a zombie's exact continuous position, even inside a
// nominally-free cell, could sit close enough to a building that the cell's
// one stored direction was blocked at that precise point. Since neither the
// field nor the zombie's position changed on their own, this produced a
// genuine PERMANENT stuck state (confirmed by an exhaustive scan of every
// free grid cell on the map against the pre-fix code — not mere jitter).
// The fix (advanceZombie's avoidanceStep, game-state.ts) is a local,
// one-tick steering correction off the real nearest-obstacle geometry
// (obstacles.ts's nearestObstaclePoint) with side-commitment hysteresis, NOT
// a new pathfinding search — it never recomputes or replaces the flow
// field, per CLAUDE.md's "no runtime recomputation" invariant.
//
// Helper: run advanceZombie until it starts attacking (or the tick budget
// runs out), tracking every (position, avoidSide) pair seen so a genuine
// infinite loop — the exact failure mode the real bug produced once the
// single-tick freeze was first patched — shows up as a detected cycle
// rather than a silent timeout.
function runUntilAttacking(
  zombie: ReturnType<typeof spawnZombie>,
  players: readonly Player[],
  wallLevel: number,
  maxTicks: number,
): { reached: boolean; cycleDetected: boolean; ticks: number } {
  const seen = new Set<string>();
  for (let i = 0; i < maxTicks; i++) {
    advanceZombie(zombie, 50, players, wallLevel);
    if (zombie.attacking) return { reached: true, cycleDetected: false, ticks: i };
    const key = `${zombie.pos.x.toFixed(1)},${zombie.pos.y.toFixed(1)},${zombie.avoidSide}`;
    if (seen.has(key)) return { reached: false, cycleDetected: true, ticks: i };
    seen.add(key);
  }
  return { reached: false, cycleDetected: false, ticks: maxTicks };
}

function fakePlayer(x: number, y: number): Player {
  return {
    id: "p1",
    colorIndex: 0,
    characterIndex: 0,
    displayName: "Test",
    pos: { x, y },
    hp: 100,
    maxHp: 100,
    status: "alive",
    downedAt: 0,
    diedAt: 0,
    invulnerableUntil: 0,
    medkits: 0,
    healingSince: null,
    shotsFired: 0,
  };
}

describe("zombie obstacle avoidance (regression for the 'stuck against walls/buildings' report)", () => {
  it("a ground zombie with a building directly between it and its target (a player) reaches and attacks it, without looping", () => {
    const b = BUILDINGS[0];
    // Player on the far side of the building from the zombie — so the
    // straight line to the real target (the player, not the base) is
    // blocked, exercising the target.isPlayer branch of advanceZombie.
    const player = fakePlayer(b.x + b.w / 2, b.y + b.h + 60);
    const spawnPos: Vec2 = { x: b.x - 60, y: b.y + b.h / 2 };
    const zombie = spawnZombie("normal", 1, spawnPos);

    const result = runUntilAttacking(zombie, [player], 0, 4000);
    expect(result.cycleDetected).toBe(false);
    expect(result.reached).toBe(true);
    expect(zombie.attackTarget).toEqual({ kind: "player", playerId: player.id });
  });

  it("a ground zombie navigates around a building corner rather than freezing against it", () => {
    // Spawn diagonally offset from a building corner (verified clear of
    // every OTHER building too — several of BUILDINGS' footprints sit close
    // together, so a naive fixed offset can land inside a neighbour) so the
    // shortest line to the base clips the corner rather than a flat face —
    // the geometry most likely to expose a flow-field/avoidance edge case.
    const b = BUILDINGS[0];
    const spawnPos: Vec2 = { x: b.x + b.w + 70, y: b.y - 70 };
    expect(overlapsAnyBuilding(spawnPos)).toBe(false);
    const zombie = spawnZombie("normal", 1, spawnPos);

    const result = runUntilAttacking(zombie, [], 0, 4000);
    expect(result.cycleDetected).toBe(false);
    expect(result.reached).toBe(true);
    // Never actually ends up inside the building while detouring around it.
    expect(overlapsAnyBuilding(zombie.pos)).toBe(false);
  });

  it("multiple zombies navigating around the same obstacle all reach the base independently", () => {
    const b = BUILDINGS[0];
    const away = { x: BASE_POS.x - b.x, y: BASE_POS.y - b.y };
    const len = Math.hypot(away.x, away.y) || 1;
    const centre: Vec2 = { x: b.x + b.w / 2 - (away.x / len) * (b.w + 80), y: b.y + b.h / 2 - (away.y / len) * (b.h + 80) };
    // Eight zombies clustered a few units apart on the far side of the same
    // building — close enough that they share essentially the same
    // obstacle-avoidance geometry, which is what could previously make them
    // interfere with/jitter against each other near a shared corner.
    const zombies = Array.from({ length: 8 }, (_, k) => spawnZombie("normal", 1, { x: centre.x + (k - 4) * 4, y: centre.y + (k % 2 === 0 ? 3 : -3) }));

    const stillGoing = new Set(zombies);
    for (let i = 0; i < 4000 && stillGoing.size > 0; i++) {
      for (const z of stillGoing) {
        advanceZombie(z, 50, [], 0);
        if (z.attacking) stillGoing.delete(z);
      }
    }
    for (const z of zombies) {
      expect(z.attacking).toBe(true);
      expect(overlapsAnyBuilding(z.pos)).toBe(false);
    }
  });

  it("giant and boss zombies (slower speedMultiplier) still navigate a building-blocked approach without getting trapped", () => {
    const b = BUILDINGS[0];
    const away = { x: BASE_POS.x - b.x, y: BASE_POS.y - b.y };
    const len = Math.hypot(away.x, away.y) || 1;
    const spawnPos: Vec2 = { x: b.x + b.w / 2 - (away.x / len) * (b.w + 80), y: b.y + b.h / 2 - (away.y / len) * (b.h + 80) };

    for (const type of ["giant", "boss"] satisfies ZombieType[]) {
      const zombie = spawnZombie(type, 1, spawnPos);
      // A slower speedMultiplier means more ticks to cover the same ground —
      // budget generously rather than assume giant/boss timing.
      const maxTicks = Math.ceil(4000 / ZOMBIE_TYPES[type].speedMultiplier);
      const result = runUntilAttacking(zombie, [], 0, maxTicks);
      expect(result.cycleDetected, `${type} should not loop forever`).toBe(false);
      expect(result.reached, `${type} should reach the base`).toBe(true);
    }
  });

  it("a flying zombie still bypasses a building directly in its path (never detours, never calls into avoidance)", () => {
    const b = BUILDINGS[0];
    const away = { x: BASE_POS.x - b.x, y: BASE_POS.y - b.y };
    const len = Math.hypot(away.x, away.y) || 1;
    const spawnPos: Vec2 = { x: b.x + b.w / 2 - (away.x / len) * (b.w + 80), y: b.y + b.h / 2 - (away.y / len) * (b.h + 80) };
    const zombie = spawnZombie("flying", 1, spawnPos);

    for (let i = 0; i < 400; i++) {
      advanceZombie(zombie, 50, [], 1); // wall built too — fliers ignore it as well
      // A flier takes the direct line the whole time: it should never need
      // the avoidance fallback (avoidSide stays null throughout).
      expect(zombie.avoidSide).toBeNull();
      if (zombie.attacking) break;
    }
    expect(zombie.attacking).toBe(true);
  });

  it("a ground zombie still settles into attacking the destructible wall itself, not stuck short of or past it", () => {
    const spawnPos: Vec2 = { x: BASE_POS.x + 300, y: BASE_POS.y + 200 }; // verified clear of every building (2026-11-08 map-visual pass: TOWN_BUILDINGS replaced with 4 larger ruin footprints, see obstacles.ts)
    expect(overlapsAnyBuilding(spawnPos)).toBe(false);
    for (const type of ["normal", "giant", "boss"] satisfies ZombieType[]) {
      // Spawn well outside the wall, off-axis, so the approach must also
      // clear the wall's own corner geometry before reaching a face.
      const zombie = spawnZombie(type, 1, spawnPos);
      const maxTicks = Math.ceil(4000 / ZOMBIE_TYPES[type].speedMultiplier);
      const result = runUntilAttacking(zombie, [], 2, maxTicks); // wall level 2
      expect(result.cycleDetected, `${type} should not loop forever approaching the wall`).toBe(false);
      expect(result.reached, `${type} should reach and attack the wall`).toBe(true);
      expect(zombie.attackTarget).toEqual({ kind: "structure" });
      // Must have actually stopped AT the wall, not walked through it.
      expect(Math.hypot(zombie.pos.x - BASE_POS.x, zombie.pos.y - BASE_POS.y)).toBeGreaterThan(WALL_HALF_EXTENT - 20);
    }
  });
});
