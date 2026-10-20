import { describe, it, expect } from "vitest";
import { assertMapIsFullyConnected } from "../src/server/obstacles.ts";

// obstacles.ts's BUILDINGS layout is hand-placed, not generated — this is
// the one-time startup self-check (also run unconditionally from GameLoop's
// constructor) re-asserted here as a regular test, so a future edit to
// BUILDINGS that accidentally seals off a region fails CI, not just "the
// deployed app throws on boot."
describe("assertMapIsFullyConnected", () => {
  it("never throws for the current BUILDINGS layout — every free cell can reach the base", () => {
    expect(() => assertMapIsFullyConnected()).not.toThrow();
  });
});
