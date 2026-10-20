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

// --- Zombies: normal/giant/boss all share this one sheet — the pack has no
// sprite shaped like a "giant"/"boss" monster, so (same documented choice
// the CraftPix sheet this replaces already made) those two are told apart
// by render-time scale/tint only, not distinct art. ---
export type SpritedZombieType = Exclude<ZombieType, "flying">;
const ZOMBIE_WALK: DirectionalSheet = directionalWalkSheet("zombies", "zombie-walk", 9);
const ZOMBIE_ATTACK: DirectionalSheet = directionalWalkSheet("zombies", "zombie-attack", 6);
export const ZOMBIE_DEAD: SpriteSheet = { image: loadImage("/sprites/lpc/zombies/zombie-dead.png"), frameWidth: 64, frameHeight: 64, frameCount: 6 };

export function zombieWalkSheet(_type: SpritedZombieType, dir: Direction): SpriteSheet {
  return ZOMBIE_WALK[dir];
}
export function zombieAttackSheet(_type: SpritedZombieType, dir: Direction): SpriteSheet {
  return ZOMBIE_ATTACK[dir];
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
// and the base's courtyard floor. wallSegment is a real cropped LPC
// castle-wall tile (sprites/lpc/NOTES.md); floorPad still has no art and
// stays sprite-swappable the same way — isReady() (same helper every other
// tile in this file already uses) returns false until a real PNG is
// dropped in, and render.ts's drawing functions already have the
// established "real tile if ready, else a clearly-labelled placeholder"
// branch every other asset in this project uses (see renderBuilding's own
// tile ? ... : fillStyle pattern). No code change is needed to go from
// placeholder to final art — only adding the PNG file here. No corner-
// tower or gate-post slots — towers are cut entirely from this design, and
// the gate is drawn as open space (render.ts's traceWallPerimeter), not a
// tile.
export const FORTRESS_TILES = {
  wallSegment: loadImage("/sprites/lpc/fortress/wall-segment.png"),
  floorPad: loadImage("/sprites/lpc/fortress/floor-pad.png"),
} as const;

// --- UI icons + panel chrome: src/client/sprites/ui/ (Kenney CC0) ---
// Unaffected by the Crit 11 LPC pass — see sprites/lpc/NOTES.md.
export const UI_ICON_NAMES = ["heart", "medkit", "skull", "shield", "coin", "house", "trophy"] as const;
export type UiIconName = (typeof UI_ICON_NAMES)[number];

export function uiIconUrl(name: UiIconName): string {
  return `/sprites/ui/icons/${name}.png`;
}
