// Phase 5 (feature/3d-migration): the ground plane — grass colour with a
// painted road network (terrain.ts's existing ROAD_ARMS/distanceToRoad, the
// SAME data the 2D renderer already uses to decide where roads are) baked
// into a canvas texture at scene setup. A baked texture (not per-tile
// geometry) because the road network is purely cosmetic (terrain.ts's own
// header comment: "nothing about where a zombie or player can walk depends
// on it") and a flat textured plane is the cheapest way to show it at full
// map resolution without thousands of extra draw calls.
import * as THREE from "three";
import { WORLD_SIZE } from "../defense-config.ts";
import { distanceToRoad, ROAD_HALF_WIDTH } from "../terrain.ts";

const TEXTURE_SIZE = 1024; // world units map 1:1.024 onto texture pixels — plenty for a ground-plane colour wash, not meant to hold fine detail

function bakeGroundTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#3a4a2a";
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  const img = ctx.getImageData(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  const px = img.data;
  const scale = WORLD_SIZE / TEXTURE_SIZE;
  const roadColor = { r: 0x5a, g: 0x52, b: 0x44 };
  const grassColor = { r: 0x3a, g: 0x4a, b: 0x2a };
  for (let ty = 0; ty < TEXTURE_SIZE; ty++) {
    for (let tx = 0; tx < TEXTURE_SIZE; tx++) {
      const worldX = tx * scale;
      const worldY = ty * scale;
      const roadDist = distanceToRoad(worldX, worldY) - ROAD_HALF_WIDTH;
      // Soft dither band at the road edge, same spirit as the 2D renderer's
      // own soft-edge comment (render.ts line ~117) rather than a hard cutoff.
      const t = Math.max(0, Math.min(1, 1 - roadDist / 12));
      const idx = (ty * TEXTURE_SIZE + tx) * 4;
      px[idx] = grassColor.r + (roadColor.r - grassColor.r) * t;
      px[idx + 1] = grassColor.g + (roadColor.g - grassColor.g) * t;
      px[idx + 2] = grassColor.b + (roadColor.b - grassColor.b) * t;
      px[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createGround(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE);
  const mat = new THREE.MeshStandardMaterial({ map: bakeGroundTexture(), roughness: 1 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(WORLD_SIZE / 2, 0, WORLD_SIZE / 2);
  mesh.receiveShadow = true;
  return mesh;
}
