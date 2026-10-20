import { describe, it, expect } from "vitest";
import { movePlayer, advanceZombie, spawnZombie, BASE_POS, type Player, type InputState, type Vec2 } from "../src/server/game-state.ts";
import { BUILDINGS, overlapsAnyBuilding, WALL_HALF_EXTENT, wallRectsForPlayers, wallRectsForZombies } from "../src/server/obstacles.ts";

// Unit-tests obstacles.ts's building collision purely through game-state.ts's
// public movePlayer/advanceZombie — same pure-function style as
// horde-spawn-geometry.test.ts (no live app, no WebSocket).

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
      movePlayer(player, moveInput({ right: true }), 50, 0);
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
      movePlayer(player, moveInput({ right: true, down: true }), 50, 0);
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
    // wallLevel 0: this test is purely about TOWN BUILDING collision, not
    // the wall — see map-collision.test.ts's own "wall" describe block
    // below for wall-specific rectangle collision.
    for (let i = 0; i < 2000; i++) {
      advanceZombie(zombie, 50, [], 0);
      expect(overlapsAnyBuilding(zombie.pos)).toBe(false);
    }
  });
});

// Dynamic wall geometry (obstacles.ts's wallRectsForPlayers/
// wallRectsForZombies): the wall only exists once wallLevel > 0, and
// players/zombies see deliberately different shapes (player side gated,
// zombie side fully solid) — see obstacles.ts's own comment on why.
describe("the dynamic wall (wallLevel-gated, gated for players only)", () => {
  it("wallLevel 0: a player can walk straight through where the wall would be", () => {
    // Approach from due south, same side the wall's south face sits on.
    const player = fakePlayer(BASE_POS.x, BASE_POS.y + WALL_HALF_EXTENT + 40);
    for (let i = 0; i < 100; i++) {
      movePlayer(player, moveInput({ up: true }), 50, 0);
    }
    expect(player.pos.y).toBeLessThan(BASE_POS.y + WALL_HALF_EXTENT - 10); // made it well inside where the wall footprint would be
  });

  it("wallLevel > 0: a player is blocked by the wall's solid east side but passes through the south gate", () => {
    const wallLevel = 1;

    // Solid side: approaching from due east should stop at the wall face,
    // never cross into/through it.
    const eastApproach = fakePlayer(BASE_POS.x + WALL_HALF_EXTENT + 60, BASE_POS.y);
    for (let i = 0; i < 200; i++) {
      movePlayer(eastApproach, moveInput({ left: true }), 50, wallLevel);
    }
    expect(eastApproach.pos.x).toBeGreaterThanOrEqual(BASE_POS.x + WALL_HALF_EXTENT - 1);

    // Gate: approaching from due south (the gate's own x-range) should walk
    // straight through the gate into the courtyard — past where the wall's
    // own (now-passed) south face sits — rather than stopping at it the way
    // the solid east side did above. (It then goes on to stop at the far,
    // solid NORTH face, same as any real player walking straight through a
    // one-sided gate would — this isn't a teleport to the base.)
    const southApproach = fakePlayer(BASE_POS.x, BASE_POS.y + WALL_HALF_EXTENT + 60);
    for (let i = 0; i < 200; i++) {
      movePlayer(southApproach, moveInput({ up: true }), 50, wallLevel);
    }
    expect(southApproach.pos.y).toBeLessThan(BASE_POS.y + WALL_HALF_EXTENT - 30); // well past the gate's own south face
  });

  it("wallLevel > 0: a ground zombie can never reach the base from ANY angle, including the gate side", () => {
    const wallLevel = 1;
    // The key invariant this whole redesign must not break: unlike the
    // player, the zombie-facing shape (wallRectsForZombies) has NO gate —
    // approaching dead-on from the south (where the player's gate is) must
    // still stop the zombie at the wall, never let it through.
    const zombie = spawnZombie("normal", 1, { x: BASE_POS.x, y: BASE_POS.y + WALL_HALF_EXTENT + 60 });
    for (let i = 0; i < 2000; i++) {
      advanceZombie(zombie, 50, [], wallLevel);
      expect(Math.hypot(zombie.pos.x - BASE_POS.x, zombie.pos.y - BASE_POS.y)).toBeGreaterThan(WALL_HALF_EXTENT - 20);
    }
    expect(zombie.attacking).toBe(true); // it should have settled into attacking the wall, not frozen short of it
  });

  it("wallRectsForPlayers/wallRectsForZombies are empty while wallLevel is 0", () => {
    expect(wallRectsForPlayers(0)).toHaveLength(0);
    expect(wallRectsForZombies(0)).toHaveLength(0);
  });
});
