// Fortress interior decoration (2026-10-24 visual overhaul round 3; redrawn
// as real sprite artwork 2026-11-08 base redesign). Purely cosmetic — same
// invariant every other file in this directory already documents: nothing
// here is consulted by movement, targeting, placement validation, or any
// other gameplay code. render.ts only ever reads this to draw something on
// top of the baked ground layer and the live entity list. No collision is
// ever added for any of this.
//
// 2026-11-08: replaced the previous procedural Canvas-drawn sandbag/crate/
// light-tower/wire-coil/barrier shapes with real cropped sprite artwork, per
// the user's explicit "I want real, detailed sprite artwork rather than
// simple procedurally drawn geometry" instruction and their two uploaded
// reference images. The art (satellite dishes, a comms mast, electrical/
// generator panels, a floodlight, medical crates, a crate+sandbag cluster, a
// barrel cluster) is cropped/cutout directly from the user's base-
// surroundings reference image — see sprites/base-ai-gen/NOTES.md for exactly
// which region each file comes from and how it was cut out.
//
// Critical, per the user's explicit instruction: the reference image's own
// low perimeter "wall-like" structure is deliberately EXCLUDED from every
// crop used here. This project's separate 5-level upgradeable Wall
// (wall-render.ts, sprites/wall-ai-gen/) is the only wall art path, appearing
// only once wallLevel > 0; nothing in this file ever draws anything that
// could read as a permanently-built defensive wall, and nothing here has
// collision, so wallLevel === 0 still has a fully open, walkable courtyard.
//
// Positions are fixed and hand-placed (not randomised/clustered like
// terrain.ts's outdoor props) because the fortress interior is small
// (WALL_INTERIOR_HALF_EXTENT ~85 units around the base) and every piece
// needs to read as deliberately placed base infrastructure, not scattered
// debris — and because they must never sit in the gate path, inside
// BASE_INTERACT_RANGE's own prompt ring, or anywhere near the courtyard
// CENTER where the base structure itself (render.ts's renderBase,
// BASE_FOOTPRINT) is drawn. Every position below was checked by eye in the
// browser against those constants; render.ts/main.ts own the actual numbers,
// this file only positions around them for the correct visual read.
import { BASE_INTERACT_RANGE, BASE_POS } from "./defense-config.ts";
import { FORTRESS_INFRA_IMAGES } from "./sprites.ts";
import { WALL_GATE_WIDTH, WALL_INTERIOR_HALF_EXTENT } from "./obstacles.ts";

export type FortressDecorKind = "dish" | "mast" | "elecpanel" | "genpanel" | "floodlight" | "medcrate" | "supplySw" | "barrels";

export interface FortressDecor {
  x: number;
  y: number;
  kind: FortressDecorKind;
  /** World-unit width to draw at; height follows the source art's own aspect ratio. */
  width: number;
  /** Mirror horizontally — lets one sprite crop (e.g. a single dish, a single corner cluster) stand in for both left/right placements without a second asset. */
  flip?: boolean;
}

// Stay off the inner wall face, same margin the previous procedural version
// used, so nothing clips through the wall's own interior edge.
const INTERIOR_REACH = WALL_INTERIOR_HALF_EXTENT - 12;
const GATE_HALF = WALL_GATE_WIDTH / 2;

export const FORTRESS_DECOR: FortressDecor[] = [
  // North wall: two satellite dishes at the corners, a comms mast dead
  // centre, flanked by a pair of small electrical/generator panels — all
  // mounted flush against the (gate-free) north wall face, well clear of
  // BASE_INTERACT_RANGE around the base itself.
  { x: BASE_POS.x - INTERIOR_REACH + 16, y: BASE_POS.y - INTERIOR_REACH + 15, kind: "dish", width: 26 },
  { x: BASE_POS.x + INTERIOR_REACH - 16, y: BASE_POS.y - INTERIOR_REACH + 15, kind: "dish", width: 26, flip: true },
  { x: BASE_POS.x - 26, y: BASE_POS.y - INTERIOR_REACH + 7, kind: "elecpanel", width: 16 },
  { x: BASE_POS.x, y: BASE_POS.y - INTERIOR_REACH + 15, kind: "mast", width: 20 },
  { x: BASE_POS.x + 27, y: BASE_POS.y - INTERIOR_REACH + 8, kind: "genpanel", width: 17 },
  // East/west side walls, mid-height — a supply crate cluster on the west, a
  // barrel cluster on the east, both well clear of the gate (south) and the
  // base itself (centre).
  { x: BASE_POS.x - INTERIOR_REACH + 12, y: BASE_POS.y, kind: "medcrate", width: 16 },
  { x: BASE_POS.x + INTERIOR_REACH - 12, y: BASE_POS.y, kind: "barrels", width: 16, flip: true },
  // Gate-flanking floodlights — the one approach that actually needs
  // lighting, positioned clear of WALL_GATE_WIDTH's own opening so neither
  // light's base visually sits in the walkable gate path.
  { x: BASE_POS.x - GATE_HALF - 16, y: BASE_POS.y + INTERIOR_REACH - 10, kind: "floodlight", width: 13 },
  { x: BASE_POS.x + GATE_HALF + 16, y: BASE_POS.y + INTERIOR_REACH - 10, kind: "floodlight", width: 13, flip: true },
  // South corners, away from the gate path — a crate+sandbag supply cluster
  // (mirrored for the opposite corner so one source crop covers both).
  { x: BASE_POS.x - INTERIOR_REACH + 16, y: BASE_POS.y + INTERIOR_REACH - 13, kind: "supplySw", width: 24 },
  { x: BASE_POS.x + INTERIOR_REACH - 16, y: BASE_POS.y + INTERIOR_REACH - 13, kind: "supplySw", width: 24, flip: true },
];

const SPRITE_FOR: Record<FortressDecorKind, HTMLImageElement> = {
  dish: FORTRESS_INFRA_IMAGES.dish,
  mast: FORTRESS_INFRA_IMAGES.mast,
  elecpanel: FORTRESS_INFRA_IMAGES.elecpanel,
  genpanel: FORTRESS_INFRA_IMAGES.genpanel,
  floodlight: FORTRESS_INFRA_IMAGES.floodlight,
  medcrate: FORTRESS_INFRA_IMAGES.medcrate,
  supplySw: FORTRESS_INFRA_IMAGES.supplySw,
  barrels: FORTRESS_INFRA_IMAGES.barrels,
};

// Baked once into the static terrain layer (same call site as
// renderFortressCourtyardFloor/renderGroundMarks in render.ts) — these never
// move or change state, so drawing them per-frame would be pure waste.
export function renderFortressDecor(ctx: CanvasRenderingContext2D, bakePxPerUnit: number): void {
  for (const d of FORTRESS_DECOR) {
    const img = SPRITE_FOR[d.kind];
    if (!img.complete || img.naturalWidth === 0) continue;
    const aspect = img.naturalWidth / img.naturalHeight;
    const drawW = d.width * bakePxPerUnit;
    const drawH = drawW / aspect;
    const cx = d.x * bakePxPerUnit;
    const cy = d.y * bakePxPerUnit;

    ctx.save();
    // A soft contact shadow under every piece, same light-direction
    // convention every other shadow in this project uses (down-right).
    ctx.fillStyle = "rgba(10, 10, 8, 0.3)";
    ctx.beginPath();
    ctx.ellipse(cx + drawW * 0.08, cy + drawH * 0.38, drawW * 0.42, drawH * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.imageSmoothingEnabled = true;
    ctx.translate(cx, cy);
    if (d.flip) ctx.scale(-1, 1);
    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
  }
}
