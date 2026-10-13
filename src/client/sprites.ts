// Sprite atlas + asset loading for the CraftPix "Zombie Survival" pixel-art
// pack (curated subset under src/client/sprites/, served by index.ts's
// serveSprite — the full original pack stays untouched in assets/, see
// PROCESS.md's visual-redesign entry). Pure data/loading here; render.ts
// does the actual drawing.
//
// The pack has no "giant"/"boss" shaped sprite either — both reuse
// palette-swapped reskins of the same civilian-zombie character, told apart
// from "normal" by render-time scale/tint only (a documented choice, not a
// missing feature). Flying zombies used to do the same, but a reskinned
// humanoid read as "the same zombie" rather than a distinct airborne threat
// (see PROCESS.md's zombie-visual-identity entry) — flying is now drawn
// procedurally in render.ts instead, the same reasoning this project already
// applies to the player character and turrets ("no sprite in the pack is
// shaped like this, so draw it instead of forcing a mismatched one in").
import type { ZombieType } from "./protocol.ts";

export interface SpriteSheet {
  image: HTMLImageElement;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
}

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

type ZombieAnimState = "idle" | "walk" | "attack" | "dead";

function zombieSheets(dir: string): Record<ZombieAnimState, SpriteSheet> {
  return {
    idle: { image: loadImage(`/sprites/zombies/${dir}/idle.png`), frameWidth: 32, frameHeight: 32, frameCount: 4 },
    walk: { image: loadImage(`/sprites/zombies/${dir}/walk.png`), frameWidth: 32, frameHeight: 32, frameCount: 4 },
    attack: { image: loadImage(`/sprites/zombies/${dir}/attack.png`), frameWidth: 32, frameHeight: 32, frameCount: 4 },
    dead: { image: loadImage(`/sprites/zombies/${dir}/dead.png`), frameWidth: 32, frameHeight: 32, frameCount: 2 },
  };
}

// normal<-Enimies_1 (light shirt), boss<-Enimies_3 (dark suit, drawn largest
// + tinted), giant<-Enimies_4 (navy shirt, drawn oversized) — picked for
// visual variety only, neither "means" its role by its art. Flying has no
// entry here: render.ts draws it procedurally (see the file comment above),
// so there's nothing to preload for it.
export type SpritedZombieType = Exclude<ZombieType, "flying">;
export const ZOMBIE_SHEETS: Record<SpritedZombieType, Record<ZombieAnimState, SpriteSheet>> = {
  normal: zombieSheets("normal"),
  giant: zombieSheets("giant"),
  boss: zombieSheets("boss"),
};

export const TILESET = loadImage("/sprites/tileset.png");

// --- City_Tileset/PSD/Tile.png regions (16px grid). Located by rendering
// the sheet through a labelled-grid overlay and visually confirming each
// crop — see PROCESS.md's visual-redesign entry — not guessed from the
// unscaled thumbnail alone. ---
export const TILE_SIZE = 16;
export const TILESET_REGIONS = {
  pavement: [
    { sx: 16, sy: 176 },
    { sx: 32, sy: 176 },
    { sx: 48, sy: 176 },
  ],
  pavementAlt: { sx: 64, sy: 240 },
  // Map-redesign additions (same already-licensed sheet, previously-
  // uncatalogued tiles — see PROCESS.md's map-redesign entry): stained/
  // cracked variants for the mid combat zone, and a heavily-cracked dark
  // variant for damaged patches further out. No new asset files.
  pavementCracked: [
    { sx: 16, sy: 240 },
    { sx: 32, sy: 240 },
    { sx: 16, sy: 256 },
  ],
  pavementDamaged: { sx: 80, sy: 256 },
  tree: { sx: 256, sy: 64, sw: 32, sh: 48 },
  bush: { sx: 64, sy: 160, sw: 64, sh: 64 },
  fencePanel: { sx: 256, sy: 160, sw: 32, sh: 32 },
  dumpster: { sx: 208, sy: 176, sw: 32, sh: 16 },
  bench: { sx: 240, sy: 128, sw: 32, sh: 16 },
  crate: { sx: 192, sy: 192, sw: 16, sh: 16 },
  barrel: { sx: 208, sy: 192, sw: 16, sh: 16 },
  buildingDoor: { sx: 192, sy: 96, sw: 32, sh: 32 },
  vaultDoor: { sx: 144, sy: 96, sw: 32, sh: 32 },
  roofBrick: { sx: 256, sy: 32, sw: 48, sh: 48 },
} as const;

// --- UI icons + panel chrome: src/client/sprites/ui/ ---
//
// Replaces the former CraftPix-derived ui.png atlas. CraftPix's free-tier
// license explicitly forbids redistributing the art source files, which
// conflicts with this course's public-repo workflow (flagged, unresolved —
// see PROCESS.md's visual-redesign entry); these icons/panels instead come
// from two Kenney.nl packs released CC0 (public domain, redistribution of
// the original files explicitly permitted). Full sourcing, pack URLs, and
// the exact tile coordinates each icon was cropped from are documented in
// assets/ui-kenney/NOTES.md. Individual files rather than an atlas — no
// pixel-coordinate bookkeeping needed for a handful of icons.
export const UI_ICON_NAMES = ["heart", "medkit", "skull", "shield", "coin", "house", "trophy"] as const;
export type UiIconName = (typeof UI_ICON_NAMES)[number];

export function uiIconUrl(name: UiIconName): string {
  return `/sprites/ui/icons/${name}.png`;
}
