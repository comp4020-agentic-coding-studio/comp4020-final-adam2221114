import { describe, it, expect } from "vitest";
import {
  MAP_SIZE,
  spawnTierForDay,
  randomBatchSize,
  perimeterPositionAtAngle,
  batchSpawnAngles,
  spawnPositionAtAngle,
  type Player,
} from "../src/server/game-state.ts";

// Unlike every other spec/ file, this one does NOT touch the live app
// (no `inject("baseUrl")`, no WebSocket) — it directly unit-tests the pure
// geometry/tier functions behind the 360° horde spawn system, since "does an
// angle of 2.1 rad land on the real map boundary" is exact math with no
// server-authoritative state involved, and is far more precisely checkable
// this way than by waiting for live RNG to happen to produce a corner case.
// vitest.config.ts's fileParallelism:false + shared global-setup still apply
// (global-setup starts the app for the OTHER files), but nothing here
// depends on that app being up.

describe("spawnTierForDay", () => {
  it("returns the exact tiers requested, by day range", () => {
    expect(spawnTierForDay(1)).toEqual({ minBatch: 4, maxBatch: 5, intervalMs: 6000 });
    expect(spawnTierForDay(2)).toEqual({ minBatch: 4, maxBatch: 5, intervalMs: 6000 });
    expect(spawnTierForDay(3)).toEqual({ minBatch: 5, maxBatch: 7, intervalMs: 5000 });
    expect(spawnTierForDay(5)).toEqual({ minBatch: 5, maxBatch: 7, intervalMs: 5000 });
    expect(spawnTierForDay(6)).toEqual({ minBatch: 7, maxBatch: 10, intervalMs: 4000 });
    expect(spawnTierForDay(10)).toEqual({ minBatch: 7, maxBatch: 10, intervalMs: 4000 });
    expect(spawnTierForDay(11)).toEqual({ minBatch: 8, maxBatch: 10, intervalMs: 3000 });
    expect(spawnTierForDay(28)).toEqual({ minBatch: 8, maxBatch: 10, intervalMs: 3000 });
  });
});

describe("randomBatchSize", () => {
  it("always stays within [minBatch, maxBatch] and can reach both ends", () => {
    const tier = { minBatch: 5, maxBatch: 7, intervalMs: 5000 };
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const n = randomBatchSize(tier);
      expect(n).toBeGreaterThanOrEqual(tier.minBatch);
      expect(n).toBeLessThanOrEqual(tier.maxBatch);
      expect(Number.isInteger(n)).toBe(true);
      seen.add(n);
    }
    expect(seen).toEqual(new Set([5, 6, 7]));
  });
});

const EPS = 1e-6;

function edgeOf(p: { x: number; y: number }): "top" | "bottom" | "left" | "right" {
  if (Math.abs(p.y) < EPS) return "top";
  if (Math.abs(p.y - MAP_SIZE) < EPS) return "bottom";
  if (Math.abs(p.x) < EPS) return "left";
  if (Math.abs(p.x - MAP_SIZE) < EPS) return "right";
  throw new Error(`point not on boundary: ${JSON.stringify(p)}`);
}

describe("perimeterPositionAtAngle", () => {
  it("places every angle exactly on the square map boundary, in bounds", () => {
    for (let i = 0; i < 3600; i++) {
      const angle = (i / 3600) * Math.PI * 2;
      const p = perimeterPositionAtAngle(angle);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(MAP_SIZE);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(MAP_SIZE);
      // on the boundary (within float tolerance) means one coordinate sits at an extreme
      const onBoundary =
        Math.abs(p.x) < EPS || Math.abs(p.x - MAP_SIZE) < EPS || Math.abs(p.y) < EPS || Math.abs(p.y - MAP_SIZE) < EPS;
      expect(onBoundary).toBe(true);
    }
  });

  it("reaches all four corners at the diagonal angles", () => {
    const corner = (a: number, x: number, y: number): void => {
      const p = perimeterPositionAtAngle(a);
      expect(p.x).toBeCloseTo(x, 6);
      expect(p.y).toBeCloseTo(y, 6);
    };
    corner(Math.PI / 4, MAP_SIZE, MAP_SIZE); // down-right
    corner((3 * Math.PI) / 4, 0, MAP_SIZE); // down-left
    corner((5 * Math.PI) / 4, 0, 0); // up-left
    corner((7 * Math.PI) / 4, MAP_SIZE, 0); // up-right
  });

  it("reaches the midpoint of all four edges at the axis angles", () => {
    const half = MAP_SIZE / 2;
    const mid = (a: number, x: number, y: number): void => {
      const p = perimeterPositionAtAngle(a);
      expect(p.x).toBeCloseTo(x, 6);
      expect(p.y).toBeCloseTo(y, 6);
    };
    mid(0, MAP_SIZE, half); // right
    mid(Math.PI / 2, half, MAP_SIZE); // down
    mid(Math.PI, 0, half); // left
    mid((3 * Math.PI) / 2, half, 0); // up
  });

  it("covers every edge with continuously varying positions, not four fixed points", () => {
    const byEdge: Record<string, Set<number>> = { top: new Set(), bottom: new Set(), left: new Set(), right: new Set() };
    for (let i = 0; i < 3600; i++) {
      const angle = (i / 3600) * Math.PI * 2;
      const p = perimeterPositionAtAngle(angle);
      const edge = edgeOf(p);
      const along = edge === "top" || edge === "bottom" ? p.x : p.y;
      byEdge[edge].add(Math.round(along));
    }
    // all four edges get many distinct positions along them, not one fixed point
    for (const edge of ["top", "bottom", "left", "right"]) {
      expect(byEdge[edge].size).toBeGreaterThan(50);
    }
  });
});

describe("batchSpawnAngles", () => {
  it("spreads a full-size batch across distinct angular sectors, never clustering", () => {
    const sectorCount = 10; // matches SPAWN_SECTORS, the largest possible batch (see spawnTierForDay's day 11+ max of 10)
    const sectorSize = (Math.PI * 2) / sectorCount;
    for (let trial = 0; trial < 200; trial++) {
      const angles = batchSpawnAngles(sectorCount);
      expect(angles).toHaveLength(sectorCount);
      const sectors = angles.map((a) => Math.floor(a / sectorSize));
      expect(new Set(sectors).size).toBe(sectorCount); // every zombie lands in its own unique sector
    }
  });

  it("draws a batch's sectors without replacement, so repeats only start once all 10 are used", () => {
    // Batches smaller than SPAWN_SECTORS can legitimately land close together
    // by chance (sector order is shuffled, not spread-maximising), but they
    // must never repeat a sector within one batch, and across many trials
    // the set of sectors used should vary widely (not the same 4 every time).
    const sectorCount = 10;
    const sectorSize = (Math.PI * 2) / sectorCount;
    const firstSectorCounts = new Map<number, number>();
    for (let trial = 0; trial < 300; trial++) {
      const angles = batchSpawnAngles(4);
      const sectors = angles.map((a) => Math.floor(a / sectorSize));
      expect(new Set(sectors).size).toBe(4); // no sector repeated within a batch
      firstSectorCounts.set(sectors[0], (firstSectorCounts.get(sectors[0]) ?? 0) + 1);
    }
    // over 300 trials, the first zombie's sector should cover a good spread
    // of the 10 possible sectors, not cluster on just one or two
    expect(firstSectorCounts.size).toBeGreaterThan(5);
  });

  it("produces angles within [0, 2π)", () => {
    for (let trial = 0; trial < 50; trial++) {
      for (const a of batchSpawnAngles(10)) {
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThan(Math.PI * 2);
      }
    }
  });
});

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
  };
}

describe("spawnPositionAtAngle", () => {
  it("matches perimeterPositionAtAngle when no player is nearby", () => {
    const angle = 1.23;
    expect(spawnPositionAtAngle(angle, [])).toEqual(perimeterPositionAtAngle(angle));
  });

  it("never lands within clearance of an alive player standing right on that spawn point", () => {
    const angle = 0; // right-edge midpoint
    const spot = perimeterPositionAtAngle(angle);
    const player = fakePlayer(spot.x, spot.y);
    const pos = spawnPositionAtAngle(angle, [player]);
    const dist = Math.hypot(pos.x - player.pos.x, pos.y - player.pos.y);
    expect(dist).toBeGreaterThanOrEqual(60);
  });

  it("ignores non-alive players when checking clearance", () => {
    const angle = 0;
    const spot = perimeterPositionAtAngle(angle);
    const downed = fakePlayer(spot.x, spot.y);
    downed.status = "downed";
    expect(spawnPositionAtAngle(angle, [downed])).toEqual(spot);
  });
});
