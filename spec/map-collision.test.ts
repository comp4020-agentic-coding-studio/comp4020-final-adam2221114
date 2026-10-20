import { describe, it, expect } from "vitest";
import { movePlayer, advanceZombie, spawnZombie, BASE_POS, type Player, type InputState, type Vec2 } from "../src/server/game-state.ts";
import { BUILDINGS, overlapsAnyBuilding } from "../src/server/obstacles.ts";

// Unit-tests obstacles.ts's building collision purely through game-state.ts's
// public movePlayer/advanceZombie — same pure-function style as
// horde-spawn-geometry.test.ts (no live app, no WebSocket).

function fakePlayer(x: number, y: number): Player {
  return {
    id: "p1",
    colorIndex: 0,
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

function moveInput(overrides: Partial<InputState>): InputState {
  return { up: false, down: false, left: false, right: false, aimAngle: 0, reviving: false, ...overrides };
}

describe("movePlayer vs. buildings", () => {
  it("never lets a player end up inside a building when walking straight at one", () => {
    const b = BUILDINGS[0];
    const start: Vec2 = { x: b.x - 60, y: b.y + b.h / 2 };
    const player = fakePlayer(start.x, start.y);
    // Walk straight toward/through the building for a long time — far more
    // ticks than needed to cross its footprint at PLAYER_SPEED, so if
    // collision were missing this would clearly tunnel through.
    for (let i = 0; i < 400; i++) {
      movePlayer(player, moveInput({ right: true }), 50);
    }
    expect(overlapsAnyBuilding(player.pos)).toBe(false);
  });

  it("slides along a building instead of fully stopping on a glancing diagonal approach", () => {
    const b = BUILDINGS[0];
    const start: Vec2 = { x: b.x - 60, y: b.y - 5 }; // just above the building's top edge
    const player = fakePlayer(start.x, start.y);
    // Moving right+down: the X component should still advance (sliding)
    // even once the Y component would carry it into the building.
    for (let i = 0; i < 60; i++) {
      movePlayer(player, moveInput({ right: true, down: true }), 50);
    }
    expect(player.pos.x).toBeGreaterThan(start.x + 10); // real horizontal progress was made
    expect(overlapsAnyBuilding(player.pos)).toBe(false);
  });
});

describe("advanceZombie vs. buildings", () => {
  it("never lets a GROUND zombie end up inside a building while approaching the base", () => {
    const b = BUILDINGS[0];
    // Spawn a ground zombie on the far side of this building from the base.
    const away = { x: BASE_POS.x - b.x, y: BASE_POS.y - b.y };
    const len = Math.hypot(away.x, away.y) || 1;
    const spawnPos: Vec2 = { x: b.x + b.w / 2 - (away.x / len) * (b.w + 80), y: b.y + b.h / 2 - (away.y / len) * (b.h + 80) };
    const zombie = spawnZombie("normal", 1, spawnPos);
    for (let i = 0; i < 2000; i++) {
      advanceZombie(zombie, 50, [], true);
      expect(overlapsAnyBuilding(zombie.pos)).toBe(false);
    }
  });
});
