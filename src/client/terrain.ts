// Decorative terrain: fixed, deterministic positions scattered around the
// map. Purely cosmetic — per the redesign brief, none of this is consulted
// by movement, targeting, placement validation, or any other gameplay code;
// render.ts only ever reads this to draw something on top of the ground
// layer. Deterministic (a tiny seeded PRNG, not Math.random()) so the
// layout is identical on every load rather than reshuffling on each refresh.
//
// Map-redesign pass (see PROCESS.md): the battlefield is organised into
// three concentric zones around the base — a kept-clear inner ring (the
// turret-build area, visually a fortified pad in render.ts), a mid "combat
// zone" with clustered debris/barricades, and a sparser, more damaged outer
// "danger zone" the player never needs to visit but sees zombies come from.
// Props are grouped into believable CLUSTERS (a few props placed near one
// shared centre) instead of independently scattered points, specifically to
// avoid the "random copy-paste scatter" look.
import { BASE_POS, WORLD_SIZE } from "./defense-config.ts";

export type PropType = "tree" | "bush" | "bench" | "dumpster" | "crate" | "barrel" | "fencePanel";

export interface Prop {
  x: number;
  y: number;
  type: PropType;
  rotation: number; // radians — mainly for fencePanel, so a barricade remnant doesn't all face the same way
}

export type GroundMarkKind = "crack" | "scorch" | "blood" | "patch";

export interface GroundMark {
  x: number;
  y: number;
  kind: GroundMarkKind;
  scale: number;
  rotation: number;
  seed: number;
}

// mulberry32 — small, fast, deterministic.
function seededRandom(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Kept clear of the base/wall/turret-build area (TURRET_BUILD_RADIUS is 150
// — see defense-config.ts) so decoration never visually crowds the actual
// play space, with real margin to spare.
export const PROPS_CLEAR_RADIUS = 220;
// Beyond this, the "mid combat zone" gives way to the sparser "outer danger
// zone" — roughly halfway to the map's own edge from the base.
export const OUTER_ZONE_RADIUS = 400;

interface ClusterTemplate {
  props: PropType[];
  spread: number; // how far each prop can land from the cluster's own centre
}

// Believable groupings, not an arbitrary bag of props per point — a debris
// pile is crates/barrels/a dumpster near each other, a barricade remnant is
// a short broken run of fence panels, a thicket is trees-and-bushes, and so
// on. Picked per cluster by weighted roll (clusterTemplates below), not a
// flat random choice per individual prop.
const DEBRIS_PILE: ClusterTemplate = { props: ["crate", "barrel", "crate", "dumpster"], spread: 28 };
const SCRAP_HEAP: ClusterTemplate = { props: ["barrel", "barrel", "crate"], spread: 20 };
const BARRICADE_REMNANT: ClusterTemplate = { props: ["fencePanel", "fencePanel", "crate"], spread: 32 };
const THICKET: ClusterTemplate = { props: ["tree", "tree", "bush", "bush", "bush"], spread: 38 };
const ROADSIDE_REST: ClusterTemplate = { props: ["bench", "barrel", "crate"], spread: 24 };
const LONE_TREE: ClusterTemplate = { props: ["tree"], spread: 0 };

function buildClusters(): Prop[] {
  const rand = seededRandom(20261008);
  const props: Prop[] = [];

  const placeCluster = (template: ClusterTemplate, cx: number, cy: number): void => {
    for (const type of template.props) {
      const angle = rand() * Math.PI * 2;
      const dist = template.spread > 0 ? rand() * template.spread : 0;
      const x = cx + Math.cos(angle) * dist;
      const y = cy + Math.sin(angle) * dist;
      if (Math.hypot(x - BASE_POS.x, y - BASE_POS.y) < PROPS_CLEAR_RADIUS) continue;
      if (x < 10 || x > WORLD_SIZE - 10 || y < 10 || y > WORLD_SIZE - 10) continue;
      props.push({ x, y, type, rotation: rand() * Math.PI * 2 });
    }
  };

  // Mid combat zone: denser, more varied clustering — this is the main
  // fighting area, so clusters read as cover/obstruction history rather
  // than a decorative backdrop.
  const midTemplates = [DEBRIS_PILE, SCRAP_HEAP, BARRICADE_REMNANT, THICKET, ROADSIDE_REST];
  const midClusterCount = 16;
  let attempts = 0;
  let placed = 0;
  while (placed < midClusterCount && attempts < midClusterCount * 25) {
    attempts++;
    const angle = rand() * Math.PI * 2;
    const dist = PROPS_CLEAR_RADIUS + rand() * (OUTER_ZONE_RADIUS - PROPS_CLEAR_RADIUS);
    const cx = BASE_POS.x + Math.cos(angle) * dist;
    const cy = BASE_POS.y + Math.sin(angle) * dist;
    if (cx < 40 || cx > WORLD_SIZE - 40 || cy < 40 || cy > WORLD_SIZE - 40) continue;
    const template = midTemplates[Math.floor(rand() * midTemplates.length)];
    placeCluster(template, cx, cy);
    placed++;
  }

  // Outer danger zone: sparser and more hostile-feeling — fewer clusters,
  // weighted toward the abandoned/broken kind (barricades, scrap) rather
  // than green thickets, with some lone trees breaking up the emptiness
  // instead of further clusters.
  const outerTemplates = [BARRICADE_REMNANT, SCRAP_HEAP, DEBRIS_PILE];
  const outerClusterCount = 9;
  attempts = 0;
  placed = 0;
  while (placed < outerClusterCount && attempts < outerClusterCount * 25) {
    attempts++;
    const angle = rand() * Math.PI * 2;
    const maxDist = Math.hypot(WORLD_SIZE, WORLD_SIZE) / 2;
    const dist = OUTER_ZONE_RADIUS + rand() * (maxDist - OUTER_ZONE_RADIUS);
    const cx = BASE_POS.x + Math.cos(angle) * dist;
    const cy = BASE_POS.y + Math.sin(angle) * dist;
    if (cx < 30 || cx > WORLD_SIZE - 30 || cy < 30 || cy > WORLD_SIZE - 30) continue;
    const template = outerTemplates[Math.floor(rand() * outerTemplates.length)];
    placeCluster(template, cx, cy);
    placed++;
  }
  const loneTreeCount = 10;
  attempts = 0;
  placed = 0;
  while (placed < loneTreeCount && attempts < loneTreeCount * 20) {
    attempts++;
    const x = rand() * WORLD_SIZE;
    const y = rand() * WORLD_SIZE;
    const d = Math.hypot(x - BASE_POS.x, y - BASE_POS.y);
    if (d < OUTER_ZONE_RADIUS || x < 10 || x > WORLD_SIZE - 10 || y < 10 || y > WORLD_SIZE - 10) continue;
    placeCluster(LONE_TREE, x, y);
    placed++;
  }

  return props;
}

export const DECORATIVE_PROPS: Prop[] = buildClusters();

// Ground-level marks baked into the static terrain layer (render.ts) —
// cracks, scorch marks, blood stains, and dark damage patches. None of
// these are sprites; they're small procedural shapes, since this project
// already prefers drawing a thing over forcing in an asset that doesn't
// exist for it. Weighted the same way as the prop clusters: none in the
// kept-clear base zone, moderate in the mid zone, heaviest in the outer
// zone — the ground itself should look more fought-over the further out
// you look, toward where zombies actually come from.
function buildGroundMarks(): GroundMark[] {
  const rand = seededRandom(913015);
  const marks: GroundMark[] = [];
  const maxDist = Math.hypot(WORLD_SIZE, WORLD_SIZE) / 2;

  const place = (kind: GroundMarkKind, count: number, zoneMin: number, zoneMax: number, scaleMin: number, scaleMax: number): void => {
    let attempts = 0;
    let placed = 0;
    while (placed < count && attempts < count * 20) {
      attempts++;
      const x = rand() * WORLD_SIZE;
      const y = rand() * WORLD_SIZE;
      const d = Math.hypot(x - BASE_POS.x, y - BASE_POS.y);
      if (d < zoneMin || d > zoneMax) continue;
      marks.push({ x, y, kind, scale: scaleMin + rand() * (scaleMax - scaleMin), rotation: rand() * Math.PI * 2, seed: Math.floor(rand() * 1e6) });
      placed++;
    }
  };

  place("patch", 14, PROPS_CLEAR_RADIUS, OUTER_ZONE_RADIUS, 18, 34);
  place("patch", 16, OUTER_ZONE_RADIUS, maxDist, 20, 40);
  place("crack", 10, PROPS_CLEAR_RADIUS, OUTER_ZONE_RADIUS, 24, 46);
  place("crack", 14, OUTER_ZONE_RADIUS, maxDist, 28, 54);
  place("scorch", 5, PROPS_CLEAR_RADIUS, OUTER_ZONE_RADIUS, 14, 22);
  place("scorch", 6, OUTER_ZONE_RADIUS, maxDist, 16, 26);
  place("blood", 6, PROPS_CLEAR_RADIUS, OUTER_ZONE_RADIUS, 8, 14);
  place("blood", 8, OUTER_ZONE_RADIUS, maxDist, 9, 16);

  return marks;
}

export const GROUND_MARKS: GroundMark[] = buildGroundMarks();
