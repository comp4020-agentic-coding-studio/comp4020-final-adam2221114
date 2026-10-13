// Multiplies RGB by a factor (alpha untouched) — used to pre-darken Kenney's
// CC0 panel textures toward this project's "dark grey / muted" palette.
// CC0 explicitly permits derivative/modified versions (unlike the CraftPix
// pack this replaces, whose license forbade "a slightly modified version of
// the art" — see assets/ui-kenney/NOTES.md), so shipping a darkened derived
// PNG alongside the untouched original is fine here.
const { PNG } = require("pngjs");
const fs = require("fs");
const [, , inPath, outPath, factorArg] = process.argv;
const factor = Number(factorArg ?? 0.55);
const src = PNG.sync.read(fs.readFileSync(inPath));
for (let i = 0; i < src.data.length; i += 4) {
  src.data[i] = Math.round(src.data[i] * factor);
  src.data[i + 1] = Math.round(src.data[i + 1] * factor);
  src.data[i + 2] = Math.round(src.data[i + 2] * factor);
}
fs.writeFileSync(outPath, PNG.sync.write(src));
console.log(`wrote ${outPath} (factor ${factor})`);
