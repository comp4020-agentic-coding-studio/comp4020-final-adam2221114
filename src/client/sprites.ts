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

// --- Decorative props ---
export const PROP_IMAGES = {
  tree: loadImage("/sprites/lpc/props/tree.png"),
  bush: loadImage("/sprites/lpc/props/bush.png"),
  barrel: loadImage("/sprites/lpc/props/barrel.png"),
  chest: loadImage("/sprites/lpc/props/chest.png"),
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

// --- Per-wall-level textures (2026-11-02 wall visual redesign) — five
// genuinely distinct materials (wood barricade -> reinforced wood -> stone ->
// reinforced concrete -> armoured fortress-grade), not a colour/thickness
// reskin of one tile. Each level ships two hand-varied crops (A/B) of the
// same material so a long wall run reads as built from distinct sections
// instead of one tile stamped repeatedly — render.ts's renderWallSegment
// picks between them per-segment the same way renderBuilding already picks
// per-building damage variants (a position hash, not per-frame randomness).
// Sourcing/licensing: see sprites/lpc/NOTES.md's "Wall levels" entry.
export type WallTileVariant = "a" | "b";
const WALL_LEVEL_TILE_SHEETS: Record<number, Record<WallTileVariant, HTMLImageElement>> = {
  1: { a: loadImage("/sprites/lpc/fortress/wall-level-1-a.png"), b: loadImage("/sprites/lpc/fortress/wall-level-1-b.png") },
  2: { a: loadImage("/sprites/lpc/fortress/wall-level-2-a.png"), b: loadImage("/sprites/lpc/fortress/wall-level-2-b.png") },
  3: { a: loadImage("/sprites/lpc/fortress/wall-level-3-a.png"), b: loadImage("/sprites/lpc/fortress/wall-level-3-b.png") },
  4: { a: loadImage("/sprites/lpc/fortress/wall-level-4-a.png"), b: loadImage("/sprites/lpc/fortress/wall-level-4-b.png") },
  5: { a: loadImage("/sprites/lpc/fortress/wall-level-5-a.png"), b: loadImage("/sprites/lpc/fortress/wall-level-5-b.png") },
};

export function wallLevelTile(level: number, variant: WallTileVariant): HTMLImageElement {
  const sheets = WALL_LEVEL_TILE_SHEETS[level] ?? WALL_LEVEL_TILE_SHEETS[1];
  return sheets[variant];
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
