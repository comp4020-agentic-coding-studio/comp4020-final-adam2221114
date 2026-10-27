// Fortress interior decoration (2026-10-24 visual overhaul, round 3). Purely
// cosmetic — same invariant every other file in this directory already
// documents: nothing here is consulted by movement, targeting, placement
// validation, or any other gameplay code. render.ts only ever reads this to
// draw something on top of the baked ground layer and the live entity list.
//
// The user rejected round 2's fortress fix (a real floor texture replacing
// the dark placeholder void) as still "essentially an empty square with
// repetitive flooring and a tiny structure in the middle" — correct: a floor
// texture alone doesn't make an interior read as a defended military
// position. This file is the actual answer: fixed, hand-placed set-dressing
// INSIDE the wall's interior footprint (sandbag emplacements, ammo crates,
// a floodlight tower, barbed coils, scorch/supply detail) that reads as a
// garrisoned base rather than a courtyard.
//
// No vehicle/military/barricade sprite exists in any licensed pack already
// vendored in this repo (assets/LPC/base-assets is a fantasy/medieval tile
// set — checked rock/chests/cabinets/dungeon/castle sheets while planning
// this file; none fit a modern military base) and this sandbox still has no
// outbound network access (DNS resolution fails for every external host,
// confirmed again this round), so — same "no sprite in the pack is shaped
// like this, so draw it" precedent as turrets/the base door/giant-boss
// zombies — every decoration below is hand-built procedural Canvas art, not
// a sprite crop.
//
// Positions are fixed and hand-placed (not randomised/clustered like
// terrain.ts's outdoor props) because the fortress interior is small
// (WALL_INTERIOR_HALF_EXTENT ~100 units around the base) and every piece
// needs to read as deliberately placed defensive gear, not scattered debris
// — and because they must never block the gate path, the turret build ring,
// or the base interact range (checked by eye against those constants below;
// render.ts/main.ts own the actual numbers, this file only positions around
// them for the correct visual read).
import { BASE_INTERACT_RANGE, BASE_POS } from "./defense-config.ts";
import { WALL_GATE_WIDTH, WALL_INTERIOR_HALF_EXTENT } from "./obstacles.ts";

export interface FortressDecor {
  x: number;
  y: number;
  kind: "sandbag" | "crate-stack" | "light-tower" | "wire-coil" | "barrier";
  rotation: number;
  seed: number;
}

// Hand-placed, not procedurally scattered — every position below was chosen
// to read as a defended perimeter without ever sitting in the gate path
// (south, within WALL_GATE_WIDTH/2 of BASE_POS.x) or inside
// BASE_INTERACT_RANGE (so the "[X] Base Menu" prompt's own circle stays
// visually clear). Diagonal corners get sandbag+crate pairs (a defended
// firing position); the two light towers flank the gate itself, since
// that's the one approach a defender actually needs lit.
const INTERIOR_REACH = WALL_INTERIOR_HALF_EXTENT - 14; // stay off the inner wall face
export const FORTRESS_DECOR: FortressDecor[] = [
  // NW corner firing position.
  { x: BASE_POS.x - INTERIOR_REACH, y: BASE_POS.y - INTERIOR_REACH + 6, kind: "sandbag", rotation: Math.PI * 0.25, seed: 1 },
  { x: BASE_POS.x - INTERIOR_REACH + 20, y: BASE_POS.y - INTERIOR_REACH + 22, kind: "crate-stack", rotation: 0, seed: 2 },
  // NE corner firing position.
  { x: BASE_POS.x + INTERIOR_REACH, y: BASE_POS.y - INTERIOR_REACH + 6, kind: "sandbag", rotation: -Math.PI * 0.25, seed: 3 },
  { x: BASE_POS.x + INTERIOR_REACH - 20, y: BASE_POS.y - INTERIOR_REACH + 22, kind: "crate-stack", rotation: 0, seed: 4 },
  // SW corner, away from the gate — barbed wire coil + crates (supply nook).
  { x: BASE_POS.x - INTERIOR_REACH, y: BASE_POS.y + INTERIOR_REACH - 18, kind: "wire-coil", rotation: 0, seed: 5 },
  { x: BASE_POS.x - INTERIOR_REACH + 18, y: BASE_POS.y + INTERIOR_REACH - 6, kind: "crate-stack", rotation: Math.PI * 0.08, seed: 6 },
  // SE corner, mirrored.
  { x: BASE_POS.x + INTERIOR_REACH, y: BASE_POS.y + INTERIOR_REACH - 18, kind: "sandbag", rotation: Math.PI * 0.75, seed: 7 },
  // Gate-flanking floodlight towers — the one approach that actually needs
  // lighting, positioned just clear of WALL_GATE_WIDTH's own opening so
  // neither tower's base visually sits in the gate gap.
  { x: BASE_POS.x - WALL_GATE_WIDTH / 2 - 16, y: BASE_POS.y + INTERIOR_REACH - 2, kind: "light-tower", rotation: 0, seed: 8 },
  { x: BASE_POS.x + WALL_GATE_WIDTH / 2 + 16, y: BASE_POS.y + INTERIOR_REACH - 2, kind: "light-tower", rotation: 0, seed: 9 },
  // A low concrete barrier pair flanking the base itself, just outside
  // BASE_INTERACT_RANGE so the interact prompt's own dashed ring (render.ts)
  // stays visually unobstructed.
  { x: BASE_POS.x - BASE_INTERACT_RANGE - 14, y: BASE_POS.y - 8, kind: "barrier", rotation: Math.PI / 2, seed: 10 },
  { x: BASE_POS.x + BASE_INTERACT_RANGE + 14, y: BASE_POS.y - 8, kind: "barrier", rotation: Math.PI / 2, seed: 11 },
];

function pseudo(seed: number, i: number): number {
  const v = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

// A single hessian sandbag — a squat, lumpy rounded rect with a seam line
// and a couple of tonal creases, repeated in a short row so it reads as a
// stacked emplacement rather than one bag.
function drawSandbagRow(ctx: CanvasRenderingContext2D, seed: number): void {
  const bagW = 13;
  const bagH = 8;
  const colors = ["#8a7d5e", "#7d7154", "#8f8366"];
  for (let i = -1; i <= 1; i++) {
    const jitter = (pseudo(seed, i + 10) - 0.5) * 2;
    ctx.save();
    ctx.translate(i * (bagW - 2), jitter);
    ctx.fillStyle = colors[(i + 1) % colors.length];
    ctx.beginPath();
    ctx.ellipse(0, 0, bagW / 2, bagH / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(40, 34, 20, 0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-bagW / 2 + 2, 0);
    ctx.lineTo(bagW / 2 - 2, 0);
    ctx.stroke();
    ctx.restore();
  }
  // A second, shorter row behind/above for stacked height.
  for (let i = -1; i <= 0; i++) {
    ctx.save();
    ctx.translate(i * (bagW - 2) + bagW / 2 - 1, -bagH * 0.55);
    ctx.fillStyle = colors[(i + 2) % colors.length];
    ctx.beginPath();
    ctx.ellipse(0, 0, bagW / 2, bagH / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// A stack of olive-drab ammo/supply crates — flat shapes + a stencilled
// cross accent (reads as "military supply" without needing real text).
function drawCrateStack(ctx: CanvasRenderingContext2D): void {
  const size = 16;
  // Bottom-left crate.
  ctx.fillStyle = "#4a5636";
  ctx.fillRect(-size * 0.55, -size * 0.1, size * 0.5, size * 0.5);
  ctx.strokeStyle = "#2e3620";
  ctx.lineWidth = 1;
  ctx.strokeRect(-size * 0.55, -size * 0.1, size * 0.5, size * 0.5);
  // Bottom-right crate, slightly forward.
  ctx.fillStyle = "#54613e";
  ctx.fillRect(size * 0.02, -size * 0.05, size * 0.52, size * 0.52);
  ctx.strokeRect(size * 0.02, -size * 0.05, size * 0.52, size * 0.52);
  // Top crate, centred over the pair.
  ctx.fillStyle = "#3f4a2c";
  ctx.fillRect(-size * 0.28, -size * 0.5, size * 0.56, size * 0.42);
  ctx.strokeRect(-size * 0.28, -size * 0.5, size * 0.56, size * 0.42);
  ctx.strokeStyle = "rgba(220, 210, 180, 0.55)";
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.46);
  ctx.lineTo(0, -size * 0.12);
  ctx.moveTo(-size * 0.22, -size * 0.29);
  ctx.lineTo(size * 0.22, -size * 0.29);
  ctx.stroke();
}

// A floodlight on a scaffold pole — casts a static cone-shaped glow baked
// straight into the terrain layer (cheap: drawn once, not per frame) so the
// gate approach actually reads as lit ground, not just a lit prop.
function drawLightTower(ctx: CanvasRenderingContext2D, facingInward: number): void {
  // Static ground glow, drawn first so the pole/head sit on top of it.
  ctx.save();
  const glow = ctx.createRadialGradient(0, 0, 2, 0, 0, 46);
  glow.addColorStop(0, "rgba(255, 244, 200, 0.22)");
  glow.addColorStop(1, "rgba(255, 244, 200, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, 46, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Scaffold pole base (a small X-braced footing, reads as "built", not a
  // bare stick).
  ctx.strokeStyle = "#3a3a3e";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-5, 4);
  ctx.lineTo(5, -4);
  ctx.moveTo(-5, -4);
  ctx.lineTo(5, 4);
  ctx.stroke();
  // Pole.
  ctx.fillStyle = "#4a4a4e";
  ctx.fillRect(-1.5, -26, 3, 30);
  // Lamp head, angled slightly toward the gate centre.
  ctx.save();
  ctx.translate(0, -26);
  ctx.rotate(facingInward * 0.3);
  ctx.fillStyle = "#2c2c30";
  ctx.beginPath();
  ctx.ellipse(0, -2, 6, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff4c8";
  ctx.beginPath();
  ctx.arc(0, -2, 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Coiled barbed wire — a tight zig-zag loop, unmistakably "keep out" without
// needing fine enough resolution to draw individual barbs.
function drawWireCoil(ctx: CanvasRenderingContext2D): void {
  ctx.strokeStyle = "#5a5a52";
  ctx.lineWidth = 1.5;
  for (let ring = 0; ring < 3; ring++) {
    const r = 5 + ring * 3;
    ctx.beginPath();
    const turns = 10;
    for (let i = 0; i <= turns; i++) {
      const a = (i / turns) * Math.PI * 2;
      const jag = i % 2 === 0 ? 1 : -1;
      const x = Math.cos(a) * (r + jag * 1.2);
      const y = Math.sin(a) * (r + jag * 1.2) * 0.55 - ring * 1.5;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

// A low concrete traffic/blast barrier — a simple chamfered block with
// warning-stripe paint, the kind of thing that reads as "defended perimeter
// furniture" without being a full vehicle (no vehicle sprite exists in any
// licensed pack available — see this file's header comment).
function drawBarrier(ctx: CanvasRenderingContext2D): void {
  const w = 34;
  const h = 10;
  ctx.fillStyle = "#7a7a72";
  ctx.beginPath();
  ctx.moveTo(-w / 2, h / 2);
  ctx.lineTo(-w / 2 + 4, -h / 2);
  ctx.lineTo(w / 2 - 4, -h / 2);
  ctx.lineTo(w / 2, h / 2);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#3e3e38";
  ctx.lineWidth = 1;
  ctx.stroke();
  // Warning stripes.
  ctx.fillStyle = "#c9a227";
  for (let i = -1; i <= 1; i++) {
    ctx.fillRect(i * 9 - 2, -h / 2 + 1, 4, h - 2);
  }
}

// Baked once into the static terrain layer (same call site as
// renderFortressCourtyardFloor/renderGroundMarks in render.ts) — these never
// move or change state, so drawing them per-frame would be pure waste.
export function renderFortressDecor(ctx: CanvasRenderingContext2D, bakePxPerUnit: number): void {
  for (const d of FORTRESS_DECOR) {
    ctx.save();
    ctx.translate(d.x * bakePxPerUnit, d.y * bakePxPerUnit);
    ctx.scale(bakePxPerUnit, bakePxPerUnit);
    ctx.rotate(d.rotation);
    // A soft contact shadow under every piece, same light-direction
    // convention every other shadow in this project uses (down-right).
    ctx.save();
    ctx.rotate(-d.rotation);
    ctx.fillStyle = "rgba(10, 10, 8, 0.3)";
    ctx.beginPath();
    ctx.ellipse(2, 5, 13, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (d.kind === "sandbag") drawSandbagRow(ctx, d.seed);
    else if (d.kind === "crate-stack") drawCrateStack(ctx);
    else if (d.kind === "light-tower") drawLightTower(ctx, d.x < BASE_POS.x ? 1 : -1);
    else if (d.kind === "wire-coil") drawWireCoil(ctx);
    else drawBarrier(ctx);
    ctx.restore();
  }
}
