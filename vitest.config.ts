import { defineConfig } from "vitest/config";

// Every test in spec/ runs against the running app, which spec/global-setup.ts
// finds. Only spec/ runs: a test anywhere else needs adding to `include`.
export default defineConfig({
  test: {
    include: ["spec/**/*.test.ts"],
    globalSetup: ["./spec/global-setup.ts"],
    // All of spec/ targets ONE shared running app instance, not isolated
    // fixtures — Vitest's default of running test FILES in parallel lets two
    // files that each briefly occupy all MAX_PLAYERS WebSocket slots race
    // each other (one file's connections can still be open when another
    // file's "is the game full yet" test starts). Sequential files keep
    // every test's view of the live app's player count honest.
    fileParallelism: false,
  },
});
