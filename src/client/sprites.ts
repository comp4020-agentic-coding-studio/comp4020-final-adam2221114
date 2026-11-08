// Sprite atlas + asset loading for the Crit 11 LPC (Liberated Pixel Cup)
// visual-migration pass — curated crops under src/client/sprites/lpc/
// (served by index.ts's serveSprite — the full originals stay untouched
// under assets/LPC/, see this directory's own NOTES.md for sourcing/
// licensing). Pure data/loading here; render.ts does the actual drawing.
//
// Unlike the CraftPix sheet it replaces (4 frames, no facing direction —
// render.ts flipped a single sheet horizontally via ctx.scale), every LPC
// character/zombie sheet here is genuinely 4-directional (its own up/left/
// down/right rows), so DirectionalSheet below is keyed by Direction rather
// than a single SpriteSheet.
import type { ZombieType } from "./protocol.ts";

export interface SpriteSheet {
  image: HTMLImageElement;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
}

export type Direction = "up" | "down" | "left" | "right";
export type DirectionalSheet = Record<Direction, SpriteSheet>;

function loadImage(src: string): HTMLImageElement {
  const img = new Image();
  img.src = src;
  return img;
}

// True once an image has actually decoded — callers must check this before
// drawImage (a not-yet-loaded <img> has naturalWidth 0 and draws nothing,
// which is fine, but checking explicitly avoids relying on that silently).
export function isReady(img: HTMLImageElement): boolean {
  return img.complete && img.naturalWidth > 0;
}

// Picks a cardinal Direction from a continuous movement/facing vector —
// whichever axis has the larger magnitude wins, ties default to the
// previous direction (passed in) so a perfectly diagonal input doesn't
// flicker between two directions every frame.
export function directionFromVector(dx: number, dy: number, fallback: Direction): Direction {
  if (dx === 0 && dy === 0) return fallback;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

function directionalWalkSheet(dir: string, prefix: string, frameCount: number): DirectionalSheet {
  const sheet = (direction: Direction): SpriteSheet => ({
    image: loadImage(`/sprites/lpc/${dir}/${prefix}-${direction}.png`),
    frameWidth: 64,
    frameHeight: 64,
    frameCount,
  });
  return { up: sheet("up"), down: sheet("down"), left: sheet("left"), right: sheet("right") };
}

// --- Players: 4 visually distinct character sheets (not a palette-swap),
// one per colorIndex slot — see render.ts's REMOTE_PLAYER_COLORS/
// LOCAL_PLAYER_COLOR ordering, which this mirrors. ---
export const PLAYER_SHEETS: readonly DirectionalSheet[] = [
  directionalWalkSheet("players/soldier-grey", "soldier-grey-walk", 9),
  directionalWalkSheet("players/soldier-gold", "soldier-gold-walk", 9),
  directionalWalkSheet("players/sara-teal", "sara-teal-walk", 9),
  directionalWalkSheet("players/princess-blue", "princess-blue-walk", 9),
];

// --- Zombies: normal/boss share this one sheet — the pack has no sprite
// shaped like a "normal survivor-zombie"/"boss" monster, so (same documented
// choice the CraftPix sheet this replaces already made) boss is told apart
// by render-time scale/tint only, not distinct art. Giant has its own real
// directional art now — see GIANT_SHEETS below. ---
export type SpritedZombieType = Extract<ZombieType, "normal">;
const ZOMBIE_WALK: DirectionalSheet = directionalWalkSheet("zombies", "zombie-walk", 9);
const ZOMBIE_ATTACK: DirectionalSheet = directionalWalkSheet("zombies", "zombie-attack", 6);
export const ZOMBIE_DEAD: SpriteSheet = { image: loadImage("/sprites/lpc/zombies/zombie-dead.png"), frameWidth: 64, frameHeight: 64, frameCount: 6 };

export function zombieWalkSheet(_type: SpritedZombieType, dir: Direction): SpriteSheet {
  return ZOMBIE_WALK[dir];
}
export function zombieAttackSheet(_type: SpritedZombieType, dir: Direction): SpriteSheet {
  return ZOMBIE_ATTACK[dir];
}

// --- Giant: real directional LPC pixel art (2026-11-04 rebuild — replaces
// an earlier cutout-limb-rig built by rotating single static poses, which
// read as stylistically inconsistent with the rest of this project's LPC
// cast and didn't hold up under review). Built from two genuinely-licensed
// LPC sources (see sprites/zombies/giant-directional/NOTES.md for full
// provenance/attribution):
//   - dalonedrau's "LPC Barbarian Sprite Base" (muscular headless body) +
//     ElizaWy's "[LPC] Muscular Swing Animation" (slash/attack body),
//     packaged headless by Baŝto's "[LPC] modular bodies and heads".
//   - Stephen Challener (Redshrike)'s LPC ogre head, from the same pack,
//     composited onto the body using the pack's OWN per-frame head-offset
//     data (lpc-shell-tools' walkcycle.map.csv/slash.map.csv) — real
//     measured alignment, not eyeballed placement.
// Every direction (up/left/down/right) is a genuine multi-frame sequence
// off this real art: 9-frame walk with true alternating-leg contact poses,
// 6-frame slash/attack with wind-up -> swing -> recovery. Left and right
// are the LPC-standard shared leftward-facing row (see render.ts's existing
// `ctx.scale(face.dir === "left" ? -1 : 1, 1)`, the same mirroring already
// applied to every other LPC zombie/player sheet in this project — never a
// front-facing mirror substitute). Recoloured from the source's warm ogre
// skin tone to this project's own sick-green giant-zombie identity (a
// hue-preserving-shading remap, not a flat tint) to match the procedural
// giant/the rest of the zombie cast, with red eyes replacing the source's
// blue. No hurt/death rig exists for any direction (the source has no
// matching full head-pose set for those states) — every direction falls
// back to the original procedural hit-flash/topple (monsters.ts) for
// hurt/death, an explicit, honestly-scoped choice, not an oversight.
export type GiantAnim = "idle" | "walk" | "attack";
export interface GiantDirectionalSheets {
  idle: DirectionalSheet;
  walk: DirectionalSheet;
  attack: DirectionalSheet;
}
function giantSheet(dir: string, anim: string, frameCount: number): SpriteSheet {
  return { image: loadImage(`/sprites/zombies/giant-directional/${dir}-${anim}.png`), frameWidth: 64, frameHeight: 64, frameCount };
}
export const GIANT_SHEETS: GiantDirectionalSheets = {
  idle: {
    down: giantSheet("down", "idle", 4),
    up: giantSheet("up", "idle", 4),
    left: giantSheet("left", "idle", 4),
    right: giantSheet("right", "idle", 4),
  },
  walk: {
    down: giantSheet("down", "walk", 9),
    up: giantSheet("up", "walk", 9),
    left: giantSheet("left", "walk", 9),
    right: giantSheet("right", "walk", 9),
  },
  attack: {
    down: giantSheet("down", "attack", 6),
    up: giantSheet("up", "attack", 6),
    left: giantSheet("left", "attack", 6),
    right: giantSheet("right", "attack", 6),
  },
};

export function giantSheetFor(anim: GiantAnim, dir: Direction): SpriteSheet {
  return GIANT_SHEETS[anim][dir];
}

// --- Flying zombie: a real sprite now exists (LPC's bat monster) — this
// reverses the earlier documented choice in render.ts/PROCESS.md ("no CC0/
// CC-BY-SA flying-creature sprite sheet matching this project's frame
// conventions exists"), which was true when written but is now stale since
// one does. Down-facing wingbeat only (3 frames); render.ts still flips it
// horizontally by facing, same as every other zombie sheet. ---
export const FLYING_SHEET: SpriteSheet = { image: loadImage("/sprites/lpc/flying/bat-flight.png"), frameWidth: 32, frameHeight: 32, frameCount: 3 };

// --- Terrain fills (32x32, tileable) ---
export const TERRAIN_TILE_SIZE = 32;
export const GRASS_TILE = loadImage("/sprites/lpc/terrain/grass.png");
export const GRASS_LIGHT_TILE = loadImage("/sprites/lpc/terrain/grass-light.png");
export const ROAD_TILE = loadImage("/sprites/lpc/terrain/road.png");
export const ROAD_LIGHT_TILE = loadImage("/sprites/lpc/terrain/road-light.png");

// --- Buildings (32x32 fill tiles, tiled across each obstacle rectangle) ---
export const BUILDING_BRICK_TILE = loadImage("/sprites/lpc/buildings/building-brick.png");
export const BUILDING_STONE_TILE = loadImage("/sprites/lpc/buildings/building-stone.png");
// Red-tile roof fill (2026-11-06 cottage-style rebuild — see NOTES.md),
// plus a door/window crop composited once per building onto its street-
// facing (south) side so each footprint reads as an actual cottage facade
// rather than a flat tiled rectangle with a colour-band "roof".
export const BUILDING_ROOF_TILE = loadImage("/sprites/lpc/buildings/building-roof.png");
export const BUILDING_DOOR_IMAGE = loadImage("/sprites/lpc/buildings/building-door.png");
export const BUILDING_WINDOW_IMAGE = loadImage("/sprites/lpc/buildings/building-window.png");

// --- Decorative props ---
export const PROP_IMAGES = {
  tree: loadImage("/sprites/lpc/props/tree.png"),
  bush: loadImage("/sprites/lpc/props/bush.png"),
  barrel: loadImage("/sprites/lpc/props/barrel.png"),
  chest: loadImage("/sprites/lpc/props/chest.png"),
  rock: loadImage("/sprites/lpc/props/rock.png"),
  ruin: loadImage("/sprites/lpc/props/ruin.png"),
  "broken-column": loadImage("/sprites/lpc/props/broken-column.png"),
} as const;

// --- The purchasable Wall's own tiles (obstacles.ts's wallRectsForPlayers)
// and the base's courtyard floor. floorPad has no art and stays
// sprite-swappable the same way — isReady() (same helper every other tile in
// this file already uses) returns false until a real PNG is dropped in, and
// render.ts's drawing functions already have the established "real tile if
// ready, else a clearly-labelled placeholder" branch every other asset in
// this project uses (see renderBuilding's own tile ? ... : fillStyle
// pattern). No corner-tower or gate-post slots — towers are cut entirely
// from this design, and the gate is drawn as open space (render.ts's
// traceWallPerimeter), not a tile.
export const FORTRESS_TILES = {
  floorPad: loadImage("/sprites/lpc/fortress/floor-pad.png"),
} as const;

// --- Per-wall-level artwork (2026-11-08 replacement) — five user-supplied
// AI-generated panel images (one per WALL_LEVELS tier), replacing both the
// tile fill above and wall-render.ts's procedural Canvas renderer. Not LPC/
// CC0 sourced — kept out of sprites/lpc/ for that reason, same precedent as
// sprites/base/base-structure.png. See sprites/wall-ai-gen/NOTES.md for full
// provenance/licensing and the exact processing applied (bounding-box crop
// only — no redraw of the source pixels). wall-render.ts's
// renderWallImageLevel draws each one directly with drawImage, not tiled.
const WALL_LEVEL_IMAGES: Record<number, HTMLImageElement> = {
  1: loadImage("/sprites/wall-ai-gen/wall-level-1.png"),
  2: loadImage("/sprites/wall-ai-gen/wall-level-2.png"),
  3: loadImage("/sprites/wall-ai-gen/wall-level-3.png"),
  4: loadImage("/sprites/wall-ai-gen/wall-level-4.png"),
  5: loadImage("/sprites/wall-ai-gen/wall-level-5.png"),
};

export function wallLevelImage(level: number): HTMLImageElement {
  return WALL_LEVEL_IMAGES[level] ?? WALL_LEVEL_IMAGES[1];
}

// --- The base structure's own artwork — a user-supplied painted sci-fi
// command-post illustration (not LPC/CC0, kept out of sprites/lpc/ for that
// reason), background removed and cropped to its own silhouette bounding
// box. Briefly replaced 2026-11-04 to 2026-11-05 with a composited LPC
// pixel-art keep after the user asked for an LPC-styled rebuild, then
// reverted at the user's explicit request back to this sci-fi art; see
// sprites/base/NOTES.md for the full history/provenance. render.ts draws
// this scaled-to-fit over BASE_FOOTPRINT.
export const BASE_STRUCTURE_IMAGE = loadImage("/sprites/base/base-structure.png");
export function baseStructureAspect(): number {
  return isReady(BASE_STRUCTURE_IMAGE) ? BASE_STRUCTURE_IMAGE.naturalWidth / BASE_STRUCTURE_IMAGE.naturalHeight : 1;
}

// --- Map background (2026-11-08 map-visual pass) — a single user-supplied
// AI-generated top-down painting of the whole 1000x1000 world (crossroads
// town: grass, 4 roads meeting at a central plaza, 4 ruined buildings, car
// wrecks/crates/trees scattered throughout), drawn directly as the terrain
// layer's base image instead of the old procedural tile-stamped ground (see
// render.ts's buildTerrainLayer). Not LPC/CC0, kept out of sprites/lpc/ for
// that reason, same precedent as sprites/base/base-structure.png and
// sprites/wall-ai-gen/*. See sprites/map-ai-gen/NOTES.md for full
// provenance/licensing and the exact cleanup applied (residue/inpainting
// only — no redraw of the source art). The image is square and is always
// drawn scaled to fill the full WORLD_SIZE x WORLD_SIZE world, so its
// naturalWidth/Height ratio is not consulted anywhere (unlike
// baseStructureAspect/wall images, which can be non-square).
export const MAP_BACKGROUND_IMAGE = loadImage("/sprites/map-ai-gen/map-background.png");

// --- Ruin building cutouts (2026-11-08) — the same four ruined structures
// already painted into MAP_BACKGROUND_IMAGE, re-cut as individual alpha-
// cutout sprites (background grass erased) so render.ts's renderBuilding can
// draw each one directly over its own TOWN_BUILDINGS rect, Y-sorted against
// zombies/players, instead of redrawing it with the old procedural tile/
// door/window building art. Keyed by compass quadrant, matching
// obstacles.ts's TOWN_BUILDINGS ordering/comments (NW, NE, SW, SE). See
// sprites/map-ai-gen/NOTES.md for provenance/licensing.
export const RUIN_BUILDING_IMAGES = {
  nw: loadImage("/sprites/map-ai-gen/ruin-nw-cutout.png"),
  ne: loadImage("/sprites/map-ai-gen/ruin-ne-cutout.png"),
  sw: loadImage("/sprites/map-ai-gen/ruin-sw-cutout.png"),
  se: loadImage("/sprites/map-ai-gen/ruin-se-cutout.png"),
} as const;
export type RuinQuadrant = keyof typeof RUIN_BUILDING_IMAGES;

// --- Car wreck cutouts (2026-11-08) — two of the painted car wrecks visible
// in MAP_BACKGROUND_IMAGE, re-cut as alpha cutouts purely so render.ts CAN
// draw them as ordinary Y-sorted decorative props if ever needed; currently
// they are left baked into the background image itself (not drawn
// separately) since they already read correctly as part of the static
// ground art and have no collision (car wrecks are decorative, same as
// every other DECORATIVE_PROPS wreck). Exported for completeness/future use,
// not currently referenced by render.ts.
export const CAR_WRECK_IMAGES = {
  ne: loadImage("/sprites/map-ai-gen/car-ne-cutout.png"),
  sw: loadImage("/sprites/map-ai-gen/car-sw-cutout.png"),
} as const;

// --- Courtyard floor tile (2026-11-08) — a small tileable flagstone crop
// sampled directly from MAP_BACKGROUND_IMAGE's own plaza pavement, replacing
// FORTRESS_TILES.floorPad (an LPC pixel tile that read as a stylistic
// mismatch once laid over the new painted/semi-realistic map art — a
// cartoony blue-grey tile next to photoreal stone). Drawn the same tiled way
// the old floorPad was (renderFortressCourtyardFloor in render.ts), just
// with this sample instead, so the base's interior courtyard floor matches
// the plaza stone already visible everywhere else on the map.
export const COURTYARD_FLOOR_TILE = loadImage("/sprites/map-ai-gen/courtyard-floor.png");

// --- Base menu icons + fortress-interior infrastructure art (2026-11-08 base
// redesign) — cropped/cutout from the user's two uploaded reference images,
// see sprites/base-ai-gen/NOTES.md for provenance/processing. Kept as a
// separate small icon set from UI_ICON_NAMES/uiIconUrl below rather than
// extending that list, since these only replace icons inside the base/turret
// X-menu specifically — the HUD keeps the original flat Kenney-style icons
// everywhere else, which wasn't part of this request. ---
export const BASE_MENU_ICON_NAMES = ["fortress", "wall", "turret", "medkit", "xp"] as const;
export type BaseMenuIconName = (typeof BASE_MENU_ICON_NAMES)[number];

export function baseMenuIconUrl(name: BaseMenuIconName): string {
  return `/sprites/base-ai-gen/icon-${name}.png`;
}

// Fixed-position fortress-interior decoration art (fortress-decor.ts) —
// replaces the previous procedural Canvas-drawn sandbag/crate/light-tower/
// wire-coil/barrier shapes with real cropped sprite artwork. Deliberately
// EXCLUDES any wall/barrier-shaped crop from the source image — the game's
// own separate 5-level Wall (sprites/wall-ai-gen/) is the only wall art path;
// see fortress-decor.ts's own comment.
export const FORTRESS_INFRA_IMAGES = {
  dish: loadImage("/sprites/base-ai-gen/dish.png"),
  mast: loadImage("/sprites/base-ai-gen/mast.png"),
  elecpanel: loadImage("/sprites/base-ai-gen/elecpanel.png"),
  genpanel: loadImage("/sprites/base-ai-gen/genpanel.png"),
  floodlight: loadImage("/sprites/base-ai-gen/floodlight.png"),
  medcrate: loadImage("/sprites/base-ai-gen/medcrate.png"),
  supplySw: loadImage("/sprites/base-ai-gen/supply-sw.png"),
  barrels: loadImage("/sprites/base-ai-gen/barrels.png"),
} as const;

// --- Turret level artwork (2026-11-02 turret visual redesign) — five
// user-supplied top-down turret designs (not LPC/CC0, see
// sprites/turrets/NOTES.md for provenance/processing), each split into a
// non-rotating base layer and a separately-rotating weapon layer so
// render.ts can rotate only the weapon toward the current target instead of
// the whole turret. ---
export interface TurretSprite {
  base: HTMLImageElement;
  weapon: HTMLImageElement;
}
const TURRET_SPRITES: Record<number, TurretSprite> = {
  1: { base: loadImage("/sprites/turrets/turret-lv1-base.png"), weapon: loadImage("/sprites/turrets/turret-lv1-weapon.png") },
  2: { base: loadImage("/sprites/turrets/turret-lv2-base.png"), weapon: loadImage("/sprites/turrets/turret-lv2-weapon.png") },
  3: { base: loadImage("/sprites/turrets/turret-lv3-base.png"), weapon: loadImage("/sprites/turrets/turret-lv3-weapon.png") },
  4: { base: loadImage("/sprites/turrets/turret-lv4-base.png"), weapon: loadImage("/sprites/turrets/turret-lv4-weapon.png") },
  5: { base: loadImage("/sprites/turrets/turret-lv5-base.png"), weapon: loadImage("/sprites/turrets/turret-lv5-weapon.png") },
};
export function turretSprite(level: number): TurretSprite {
  return TURRET_SPRITES[level] ?? TURRET_SPRITES[1];
}

// --- UI icons + panel chrome: src/client/sprites/ui/ (Kenney CC0) ---
// Unaffected by the Crit 11 LPC pass — see sprites/lpc/NOTES.md.
// "calendar", "hazard" (2026-11-05 top HUD bar redesign) and "play"/"pause"/
// "menu" (2026-11-05 sketch-layout redesign) are hand-drawn additions, not
// from the Kenney packs — this project never vendored the full 1-bit-pack
// source sheet (only its LICENSE.txt, see assets/ui-kenney/NOTES.md), and a
// fresh attempt to re-fetch it for this pass failed the same way the
// calendar/hazard pass's attempt did (JS-SPA page, no zip ever observed).
// The one OpenGameArt biohazard-styled icon found (opengameart.org/content/
// zombie-ui-pack, CC-BY 3.0) was already rejected for hazard.png as a style
// mismatch (flat modern icon vs this project's blocky 1-bit look) — the same
// reasoning applies to a generic play/pause/hamburger icon, so these are
// drawn fresh rather than sourced. Drawn at the exact same 16x16, bg
// #472d3c / fg #cfc6b8 convention as every Kenney-sourced icon here so
// they're visually indistinguishable in the HUD — see
// assets/ui-kenney/NOTES.md for the full icon provenance table.
export const UI_ICON_NAMES = ["heart", "medkit", "skull", "shield", "coin", "house", "trophy", "calendar", "hazard", "play", "pause", "menu"] as const;
export type UiIconName = (typeof UI_ICON_NAMES)[number];

export function uiIconUrl(name: UiIconName): string {
  return `/sprites/ui/icons/${name}.png`;
}
