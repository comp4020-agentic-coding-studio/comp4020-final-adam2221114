// Sprite atlas + asset loading for the CraftPix "Zombie Survival" pixel-art
// pack (curated subset under src/client/sprites/, served by index.ts's
// serveSprite — the full original pack stays untouched in assets/, see
// PROCESS.md's visual-redesign entry). Pure data/loading here; render.ts
// does the actual drawing.
//
// The pack has no "flying"/"giant"/"boss" shaped sprite — all four Enemies_N
// sets are palette-swapped reskins of the same civilian-zombie character.
// Normal/flying/giant/boss are told apart by render-time scale, tint and
// (for flying) a hover motion, not by distinct art — a documented choice,
// not a missing feature.
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

// normal<-Enimies_1 (light shirt), flying<-Enimies_2 (red shirt, drawn
// hovering), boss<-Enimies_3 (dark suit, drawn largest + tinted), giant<-
// Enimies_4 (navy shirt, drawn oversized). Picked for visual variety only —
// none of the four "means" its role by its art.
export const ZOMBIE_SHEETS: Record<ZombieType, Record<ZombieAnimState, SpriteSheet>> = {
  normal: zombieSheets("normal"),
  flying: zombieSheets("flying"),
  giant: zombieSheets("giant"),
  boss: zombieSheets("boss"),
};

export const TILESET = loadImage("/sprites/tileset.png");
export const UI_SHEET = loadImage("/sprites/ui.png");

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

// --- UI.png regions (16px grid) ---
export const UI_REGIONS = {
  heart: { sx: 208, sy: 160, sw: 16, sh: 16 },
  medkit: { sx: 16, sy: 144, sw: 16, sh: 16 },
  skull: { sx: 64, sy: 144, sw: 16, sh: 16 },
  shield: { sx: 96, sy: 144, sw: 16, sh: 16 },
  star: { sx: 80, sy: 144, sw: 16, sh: 16 },
  house: { sx: 48, sy: 176, sw: 16, sh: 16 },
  // 9-slice-able panel background (plain, border baked in) — big block
  // variant, large enough to scale down cleanly for HUD/menu panels.
  panel: { sx: 80, sy: 80, sw: 48, sh: 48 },
} as const;
