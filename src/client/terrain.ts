// Decorative terrain props: fixed, deterministic positions scattered around
// the map. Purely cosmetic — per the redesign brief, these must never become
// gameplay obstacles, so nothing here is consulted by movement, targeting,
// placement validation, or any other gameplay code; render.ts only ever
// reads this to draw something on top of the ground layer. Deterministic
// (a tiny seeded PRNG, not Math.random()) so the scatter is identical on
// every load rather than reshuffling on each refresh.
import { BASE_POS, WORLD_SIZE } from "./defense-config.ts";

export type PropType = "tree" | "bush" | "bench" | "dumpster" | "crate" | "barrel";

export interface Prop {
  x: number;
  y: number;
  type: PropType;
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

// Kept clear of the base/wall/turret-build area so decoration never visually
// crowds the actual play space around the base.
const KEEP_CLEAR_RADIUS = 220;

function buildProps(): Prop[] {
  const rand = seededRandom(20261008);
  const props: Prop[] = [];
  const types: PropType[] = ["tree", "tree", "tree", "bush", "bush", "bench", "dumpster", "crate", "barrel"];
  const targetCount = 48;
  let attempts = 0;
  while (props.length < targetCount && attempts < targetCount * 20) {
    attempts++;
    const x = rand() * WORLD_SIZE;
    const y = rand() * WORLD_SIZE;
    if (Math.hypot(x - BASE_POS.x, y - BASE_POS.y) < KEEP_CLEAR_RADIUS) continue;
    const type = types[Math.floor(rand() * types.length)];
    props.push({ x, y, type });
  }
  return props;
}

export const DECORATIVE_PROPS: Prop[] = buildProps();
