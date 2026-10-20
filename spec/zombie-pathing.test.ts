import { describe, it, expect } from "vitest";
import { advanceZombie, spawnZombie, BASE_POS, BASE_ATTACK_RANGE, distance, type Vec2 } from "../src/server/game-state.ts";
import { BUILDINGS } from "../src/server/obstacles.ts";

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
      advanceZombie(zombie, 50, [], false); // wall down: nothing but the building itself can block it
      if (distance(zombie.pos, BASE_POS) <= BASE_ATTACK_RANGE || zombie.attacking) {
        reached = true;
        break;
      }
    }
    expect(reached).toBe(true);
  });
});
