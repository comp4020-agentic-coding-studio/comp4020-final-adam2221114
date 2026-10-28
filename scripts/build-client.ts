// Bundles each client entry point (and everything it imports, including the
// "three" npm package for the 3D prototype) into one self-contained
// dist/client/*.js per entry — replacing tsc's old "emit plain ES modules,
// load them straight from node_modules-free relative imports" build now
// that the client depends on a real npm package (three) a browser can't
// resolve as a bare specifier on its own. esbuild does NOT type-check (it
// only transpiles) — `pnpm typecheck` (plain tsc --noEmit against the root
// tsconfig.json) is still the one place type errors are caught; this
// script's only job is producing the runnable browser artifacts.
//
// Entirely local: esbuild bundles three's source straight out of
// node_modules into the output file, so the deployed app never depends on
// an external CDN being reachable (CLAUDE.md's 3D migration rules).
//
// main3d.ts (src/client/three/) is the feature/3d-migration Phase 2+
// prototype, served at a SEPARATE route (/3d) from the proven 2D game
// (main.ts, served at /) — see src/server/index.ts's own comment on why
// these stay two separate bundles rather than one replacing the other.
import * as esbuild from "esbuild";
import { mkdirSync } from "node:fs";

const outdir = "dist/client";
mkdirSync(outdir, { recursive: true });

const watch = process.argv.includes("--watch");

const buildOptions: esbuild.BuildOptions = {
  entryPoints: ["src/client/main.ts", "src/client/three/main3d.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  outdir,
  sourcemap: true,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("esbuild: watching src/client for changes...");
} else {
  await esbuild.build(buildOptions);
}
