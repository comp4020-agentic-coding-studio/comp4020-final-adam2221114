// Decorative terrain: fixed, deterministic positions scattered around the
// map. Purely cosmetic — per the redesign brief, none of this is consulted
// by movement, targeting, placement validation, or any other gameplay code
// (buildings, NOT props, are what's solid — see obstacles.ts); render.ts
// only ever reads this to draw something on top of the ground layer.
// Deterministic (a tiny seeded PRNG, not Math.random()) so the layout is
// identical on every load rather than reshuffling on each refresh.
//
// Crit 11 map-visual pass: the prop palette switched from the CraftPix set
// (tree/bush/bench/dumpster/crate/barrel/fencePanel) to the LPC set actually
// available (tree/bush/barrel/chest — see sprites/lpc/NOTES.md); the
// clustering/zoning logic below is otherwise UNCHANGED from the original
// map-redesign pass (see PROCESS.md's own entry on it) — it already reads
// well and this pass is a re-skin of what each cluster is MADE of, not a
// redesign of where clusters go. The battlefield is still organised into
// three concentric zones around the base — a kept-clear inner ring (the
// turret-build area, visually a fortified pad in render.ts), a mid "combat
// zone" with clustered debris/thickets, and a sparser, more damaged outer
// "danger zone" the player never needs to visit but sees zombies come from.
// Props are grouped into believable CLUSTERS (a few props placed near one
// shared centre) instead of independently scattered points, specifically to
// avoid the "random copy-paste scatter" look. Clusters are ALSO kept clear
// of every building footprint (obstacles.ts's BUILDINGS), so decoration
// never visually overlaps a solid structure.
import { BASE_POS, WORLD_SIZE } from "./defense-config.ts";
import { overlapsAnyBuilding } from "./obstacles.ts";

// "wreck" added in round 3 of the visual overhaul (request #3: "abandoned
// vehicles" — nothing in this project's licensed asset library, CraftPix or
// LPC, contains a vehicle sprite, and this sandbox has no outbound network
// access to source one, so it's hand-drawn procedural Canvas art, same
// precedent as turrets/the base door/giant-boss zombies/fortress-decor.ts).
// Deliberately placed ON/NEAR roads (see buildClusters below) rather than in
// the same off-road clusters as barrels/chests — an abandoned car makes
// sense blocking a street, not sitting in a field.
//
// "rock"/"ruin"/"broken-column" added 2026-11-06 (user asked for the map's
// visual style to move toward a reference crossroads-town image, scoped to
// terrain dressing + building exteriors only — roads stay curved and the
// wall's interior decor stays as-is, see PROCESS.md). All three are real
// licensed sprite crops (sprites/lpc/NOTES.md) — "rock" from
// base-assets/tiles/rock.png, "ruin"/"broken-column" from the LPC castle
// sheet's arched-window and baluster-post art, reused here as scattered
// ruined-structure debris rather than an intact building. "stump" has no
// matching licensed sprite in any pack vendored in this repo (treetop.png/
// trunk.png are a standing canopy and a standing trunk base, not a cut
// stump — checked while sourcing this change), so it's hand-drawn
// procedural Canvas art, same "no sprite fits, so draw it" precedent as
// wreck/turrets/the base door.
export type PropType = "tree" | "bush" | "barrel" | "chest" | "wreck" | "rock" | "stump" | "ruin" | "broken-column";

export interface Prop {
  x: number;
  y: number;
  type: PropType;
  rotation: number; // radians — kept for any future prop that benefits from varied facing; unused by the current LPC prop set
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

// --- Road network -----------------------------------------------------------
//
// A hand-authored network of CURVED paths, not a straight ruler-cross: one
// stone-paved, multi-segment arm runs from the base out to each of the four
// map edges, each curving a different way so the result reads as a real
// town's streets rather than a programmatically-stamped intersection.
// obstacles.ts's BUILDINGS sit in the four angular GAPS between these arms
// (verified clear by construction — see its own comment), so "roads form a
// sensible connected network" means a real, deliberate path a player can
// trace end to end, not a coincidence of the prop scatter. Purely cosmetic
// (same as every other terrain.ts export): render.ts reads this only to
// choose which ground tile to paint (with a soft dither band at the edge,
// not a hard cutoff — see render.ts's own comment); nothing about where a
// zombie or player can walk depends on it (that's obstacles.ts's job).
export const ROAD_HALF_WIDTH = 40;

interface Vec2 {
  x: number;
  y: number;
}

// Each arm is a short polyline (base -> ... -> a map edge), deliberately
// NOT mirror-symmetric with any other arm.
const ROAD_ARMS: Vec2[][] = [
  [{ x: 500, y: 500 }, { x: 430, y: 350 }, { x: 380, y: 150 }, { x: 420, y: 0 }], // north, bows west
  [{ x: 500, y: 500 }, { x: 580, y: 650 }, { x: 630, y: 850 }, { x: 580, y: 1000 }], // south, bows east
  [{ x: 500, y: 500 }, { x: 650, y: 430 }, { x: 850, y: 380 }, { x: 1000, y: 420 }], // east, bows north
  [{ x: 500, y: 500 }, { x: 350, y: 570 }, { x: 150, y: 620 }, { x: 0, y: 580 }], // west, bows south
];

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = a.x + t * dx;
  const py = a.y + t * dy;
  return Math.hypot(p.x - px, p.y - py);
}

// Distance from a point to the nearest point on the whole road network —
// exported (not just a boolean) so render.ts can build a soft dither band
// at the edge instead of a hard on/off cutoff.
export function distanceToRoad(worldX: number, worldY: number): number {
  let best = Infinity;
  for (const arm of ROAD_ARMS) {
    for (let i = 0; i < arm.length - 1; i++) {
      const d = distToSegment({ x: worldX, y: worldY }, arm[i], arm[i + 1]);
      if (d < best) best = d;
    }
  }
  return best;
}

export function isOnRoad(worldX: number, worldY: number): boolean {
  return distanceToRoad(worldX, worldY) <= ROAD_HALF_WIDTH;
}

// Kept clear of the base/wall/turret-build area (TURRET_BUILD_RADIUS is 128
// — see defense-config.ts) so decoration never visually crowds the actual
// play space, with real margin to spare. 220 -> 187 in the 2026-11-06
// footprint shrink, scaled with TURRET_BUILD_RADIUS so the margin between
// them stays proportional.
export const PROPS_CLEAR_RADIUS = 187;
// Beyond this, the "mid combat zone" gives way to the sparser "outer danger
// zone" — roughly halfway to the map's own edge from the base.
export const OUTER_ZONE_RADIUS = 400;

interface ClusterTemplate {
  props: PropType[];
  spread: number; // how far each prop can land from the cluster's own centre
}

// Believable groupings, not an arbitrary bag of props per point — a supply
// cache is barrels/chests near each other, a thicket is trees-and-bushes,
// and so on. Picked per cluster by weighted roll (clusterTemplates below),
// not a flat random choice per individual prop.
const SUPPLY_CACHE: ClusterTemplate = { props: ["barrel", "chest", "barrel"], spread: 26 };
const SCRAP_HEAP: ClusterTemplate = { props: ["barrel", "barrel"], spread: 18 };
const THICKET: ClusterTemplate = { props: ["tree", "tree", "bush", "bush", "bush"], spread: 38 };
const LONE_TREE: ClusterTemplate = { props: ["tree"], spread: 0 };
// Added 2026-11-06 (map-style pass — see PROCESS.md): a cleared patch where
// trees used to stand (stump + a loose rock or two) and a small collapsed
// structure (a ruin's arched wall remnant flanked by a couple of broken
// columns), reusing the same "believable grouping, not a random bag" rule
// every other template here already follows.
const ROCKY_CLEARING: ClusterTemplate = { props: ["stump", "rock", "rock"], spread: 22 };
const RUIN_SITE: ClusterTemplate = { props: ["ruin", "broken-column", "broken-column"], spread: 30 };

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
      if (overlapsAnyBuilding({ x, y })) continue; // Crit 11: never let decoration sit inside a solid building
      if (isOnRoad(x, y)) continue; // Crit 11: never let decoration sit on a road tile either
      props.push({ x, y, type, rotation: rand() * Math.PI * 2 });
    }
  };

  // Mid combat zone: denser, more varied clustering — this is the main
  // fighting area, so clusters read as cover/obstruction history rather
  // than a decorative backdrop.
  const midTemplates = [SUPPLY_CACHE, SCRAP_HEAP, THICKET];
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
  // weighted toward scrap/supply remnants rather than green thickets, with
  // some lone trees breaking up the emptiness instead of further clusters.
  const outerTemplates = [SCRAP_HEAP, SUPPLY_CACHE];
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

  // Rocky clearings (mid zone) and ruin sites (outer zone), placed as a
  // fixed count rather than folded into the weighted template rolls above —
  // a weighted roll risks these two new types never actually appearing on a
  // given seed (verified: they didn't, on this project's actual seed, before
  // this change), and the user explicitly asked for rock/ruin/column
  // decoration to exist on the map, not to exist only probabilistically.
  const rockyClearingCount = 5;
  attempts = 0;
  placed = 0;
  while (placed < rockyClearingCount && attempts < rockyClearingCount * 25) {
    attempts++;
    const angle = rand() * Math.PI * 2;
    const dist = PROPS_CLEAR_RADIUS + rand() * (OUTER_ZONE_RADIUS - PROPS_CLEAR_RADIUS);
    const cx = BASE_POS.x + Math.cos(angle) * dist;
    const cy = BASE_POS.y + Math.sin(angle) * dist;
    if (cx < 40 || cx > WORLD_SIZE - 40 || cy < 40 || cy > WORLD_SIZE - 40) continue;
    placeCluster(ROCKY_CLEARING, cx, cy);
    placed++;
  }
  const ruinSiteCount = 4;
  attempts = 0;
  placed = 0;
  while (placed < ruinSiteCount && attempts < ruinSiteCount * 25) {
    attempts++;
    const angle = rand() * Math.PI * 2;
    const maxDist = Math.hypot(WORLD_SIZE, WORLD_SIZE) / 2;
    const dist = OUTER_ZONE_RADIUS + rand() * (maxDist - OUTER_ZONE_RADIUS);
    const cx = BASE_POS.x + Math.cos(angle) * dist;
    const cy = BASE_POS.y + Math.sin(angle) * dist;
    if (cx < 30 || cx > WORLD_SIZE - 30 || cy < 30 || cy > WORLD_SIZE - 30) continue;
    placeCluster(RUIN_SITE, cx, cy);
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

  // Abandoned vehicle wrecks, placed ALONG the road network (picking a
  // random point on a random road arm's polyline, then offsetting across the
  // road's own half-width) rather than in the off-road prop clusters above —
  // request #3's "abandoned vehicles" reads as environmental storytelling
  // only if they're sitting where a vehicle would actually have been: on the
  // road, blocking it. Kept outside PROPS_CLEAR_RADIUS the same way every
  // other prop is, so none ever crowd the fortress/turret-build area.
  const wreckCount = 8;
  attempts = 0;
  placed = 0;
  while (placed < wreckCount && attempts < wreckCount * 30) {
    attempts++;
    const arm = ROAD_ARMS[Math.floor(rand() * ROAD_ARMS.length)];
    const segIdx = Math.floor(rand() * (arm.length - 1));
    const a = arm[segIdx];
    const b = arm[segIdx + 1];
    const t = rand();
    const px = a.x + (b.x - a.x) * t;
    const py = a.y + (b.y - a.y) * t;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    // Perpendicular offset across the road, biased toward one shoulder
    // rather than dead-centre (a wreck blocking HALF the road reads better
    // than one sitting exactly on the centreline).
    const perpX = -dy / len;
    const perpY = dx / len;
    const offset = (rand() < 0.5 ? -1 : 1) * (ROAD_HALF_WIDTH * 0.35 + rand() * ROAD_HALF_WIDTH * 0.3);
    const x = px + perpX * offset;
    const y = py + perpY * offset;
    if (Math.hypot(x - BASE_POS.x, y - BASE_POS.y) < PROPS_CLEAR_RADIUS) continue;
    if (x < 20 || x > WORLD_SIZE - 20 || y < 20 || y > WORLD_SIZE - 20) continue;
    if (overlapsAnyBuilding({ x, y })) continue;
    // Face roughly along the road direction, not a random angle — a wreck
    // pointed perpendicular to its own road reads as a placement mistake.
    props.push({ x, y, type: "wreck", rotation: Math.atan2(dy, dx) + (rand() < 0.5 ? 0 : Math.PI) });
    placed++;
  }

  return props;
}

// 2026-11-08 map-visual pass: the new AI-generated map background
// (sprites.ts's MAP_BACKGROUND_IMAGE) already paints its own trees, rocks,
// car wrecks, and rubble directly into the ground art at fixed positions.
// Drawing buildClusters()'s procedural LPC prop scatter on top of it would
// duplicate objects already visible in the PNG (explicitly out of scope for
// that pass) and would visually clash (blocky pixel-art crops over painted/
// semi-realistic art). buildClusters() itself is left intact, unused, rather
// than deleted, in case a future pass reintroduces a non-overlapping prop
// layer (e.g. clutter placed only in areas the background doesn't already
// decorate).
export const DECORATIVE_PROPS: Prop[] = [];

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
