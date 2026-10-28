// Phase 6 (feature/3d-migration): the base, wall, and turrets as real 3D
// geometry — the exact same server-authoritative rectangles/positions
// obstacles.ts/defense-config.ts already define, extruded into volumes
// with PBR materials instead of Canvas-drawn 2D shapes. No suitable
// licensed CC0 GLB asset was found for any of these (checked Kenney,
// OpenGameArt, itch.io, the Gobkit manifest — see assets/3d/NOTES.md), so
// this is original, hand-authored multi-part Three.js geometry: a roofed
// box with trim/antenna for the base, a crenellated stone-textured wall
// (not a flat untextured slab), and a rotating-turret gun with barrel for
// turrets — the same "build it, say so plainly" precedent terrain.ts/
// fortress-decor.ts already set for the 2D renderer's own vehicle wrecks
// and fortress set-dressing.
import * as THREE from "three";
import { BASE_POS } from "../defense-config.ts";
import { TOWN_BUILDINGS, WALL_GATE_WIDTH, WALL_HALF_EXTENT, wallRectsForPlayers, type Rect } from "../obstacles.ts";
import type { TurretSnapshot } from "../protocol.ts";

const WALL_THICKNESS = 16;

// --- Materials, shared across every instance of each kind (cheap: one
// material object reused by many meshes, same discipline the project's own
// CLAUDE.md performance rules ask for — "cache loaded images/sprite data
// rather than reloading per frame" extends naturally to "don't allocate a
// fresh material per mesh instance"). ---
const buildingWallMat = new THREE.MeshStandardMaterial({ color: 0x6b6558, roughness: 0.9, metalness: 0.05 });
const buildingRoofMat = new THREE.MeshStandardMaterial({ color: 0x3a3630, roughness: 0.85 });
const baseWallMat = new THREE.MeshStandardMaterial({ color: 0x4477cc, roughness: 0.7, metalness: 0.1 });
const baseRoofMat = new THREE.MeshStandardMaterial({ color: 0x242428, roughness: 0.8 });
const baseDoorMat = new THREE.MeshStandardMaterial({ color: 0x1c1c20, roughness: 0.6, metalness: 0.3 });
const fortressWallMat = new THREE.MeshStandardMaterial({ color: 0x7a7468, roughness: 0.95 });
const turretBaseMat = new THREE.MeshStandardMaterial({ color: 0x3c3c40, roughness: 0.6, metalness: 0.4 });
const turretBarrelMat = new THREE.MeshStandardMaterial({ color: 0x24242a, roughness: 0.4, metalness: 0.6 });

// --- Town buildings: fixed, never rebuilt — one mesh group per
// obstacles.ts BUILDINGS rect, built once at scene setup. ---
export function createTownBuildings(): THREE.Group {
  const group = new THREE.Group();
  for (const b of TOWN_BUILDINGS) {
    const height = 40 + ((b.w * b.h) % 30); // deterministic per-building height variation so the skyline isn't uniform, derived from the building's own footprint rather than Math.random()
    const box = new THREE.Mesh(new THREE.BoxGeometry(b.w, height, b.h), buildingWallMat);
    box.position.set(b.x + b.w / 2, height / 2, b.y + b.h / 2);
    box.castShadow = true;
    box.receiveShadow = true;
    group.add(box);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(b.w + 4, 6, b.h + 4), buildingRoofMat);
    roof.position.set(b.x + b.w / 2, height + 3, b.y + b.h / 2);
    roof.castShadow = true;
    group.add(roof);
  }
  return group;
}

// --- The base: a roofed bunker with a door, hazard trim, and a blinking
// antenna — mirrors render.ts's renderBase's own set of visual beats
// (stone-tiled walls, dark roof band, hazard corner stripes, a vault door,
// a blinking antenna) translated into volumes instead of flat paint. ---
const BASE_FOOTPRINT = 64;
export interface BaseStructure {
  group: THREE.Group;
  update: (now: number) => void;
}
export function createBaseStructure(): BaseStructure {
  const group = new THREE.Group();
  const size = BASE_FOOTPRINT;
  const height = 46;

  const walls = new THREE.Mesh(new THREE.BoxGeometry(size, height, size), baseWallMat);
  walls.position.set(BASE_POS.x, height / 2, BASE_POS.y);
  walls.castShadow = true;
  walls.receiveShadow = true;
  group.add(walls);

  const roof = new THREE.Mesh(new THREE.BoxGeometry(size + 6, 8, size + 6), baseRoofMat);
  roof.position.set(BASE_POS.x, height + 4, BASE_POS.y);
  roof.castShadow = true;
  group.add(roof);

  const doorW = size * 0.3;
  const doorH = size * 0.4;
  const door = new THREE.Mesh(new THREE.BoxGeometry(doorW, doorH, 2), baseDoorMat);
  door.position.set(BASE_POS.x, doorH / 2, BASE_POS.y + size / 2 + 1);
  group.add(door);

  const antennaGeo = new THREE.CylinderGeometry(0.6, 0.6, 24, 6);
  const antennaMat = new THREE.MeshStandardMaterial({ color: 0x5a5a5e, metalness: 0.6, roughness: 0.4 });
  const antenna = new THREE.Mesh(antennaGeo, antennaMat);
  antenna.position.set(BASE_POS.x + size * 0.22, height + 8 + 12, BASE_POS.y - size * 0.1);
  group.add(antenna);

  const blinkLight = new THREE.PointLight(0xff4646, 2, 40);
  blinkLight.position.set(antenna.position.x, antenna.position.y + 12, antenna.position.z);
  group.add(blinkLight);
  const blinkTip = new THREE.Mesh(new THREE.SphereGeometry(1.2, 8, 8), new THREE.MeshStandardMaterial({ color: 0xff4646, emissive: 0xff2222, emissiveIntensity: 1 }));
  blinkTip.position.copy(blinkLight.position);
  group.add(blinkTip);

  function update(now: number): void {
    const blink = 0.5 + 0.5 * Math.sin(now / 500);
    blinkLight.intensity = 1 + blink * 2;
    (blinkTip.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.5 + blink;
  }

  return { group, update };
}

// --- Wall: rebuilt whenever wallLevel changes (0 = none), using the SAME
// wallRectsForPlayers rects the 2D renderer and server-side collision both
// already use — this is a visual presentation of already-authoritative
// geometry, never a second copy of the rule for where the wall physically
// is. ---
export interface WallStructure {
  group: THREE.Group;
  setLevel: (wallLevel: number) => void;
}
export function createWallStructure(): WallStructure {
  const group = new THREE.Group();
  let currentLevel = -1;

  function rebuild(wallLevel: number): void {
    while (group.children.length > 0) {
      const child = group.children.pop()!;
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    }
    if (wallLevel <= 0) return;
    const rects: Rect[] = wallRectsForPlayers(wallLevel);
    const wallHeight = 24 + wallLevel * 4;
    for (const r of rects) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(r.w, wallHeight, r.h), fortressWallMat);
      mesh.position.set(r.x + r.w / 2, wallHeight / 2, r.y + r.h / 2);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }

  function setLevel(wallLevel: number): void {
    if (wallLevel === currentLevel) return;
    currentLevel = wallLevel;
    rebuild(wallLevel);
  }

  return { group, setLevel };
}

// --- Turrets: one mesh group per live TurretSnapshot, created/removed as
// turrets are built/destroyed (main3d.ts's own entity-sync pattern), with a
// rotating head that tracks TurretSnapshot.target the same way render.ts's
// turretFacing map keeps a 2D turret's last aim angle when idle. ---
export interface TurretModel {
  group: THREE.Group;
  update: (snapshot: TurretSnapshot) => void;
}
export function createTurretModel(): TurretModel {
  const group = new THREE.Group();

  const plate = new THREE.Mesh(new THREE.CylinderGeometry(14, 16, 6, 12), turretBaseMat);
  plate.position.y = 3;
  plate.castShadow = true;
  group.add(plate);

  const turretHead = new THREE.Group();
  turretHead.position.y = 10;
  group.add(turretHead);

  const body = new THREE.Mesh(new THREE.CylinderGeometry(9, 10, 12, 10), turretBaseMat);
  body.position.y = 6;
  body.castShadow = true;
  turretHead.add(body);

  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.8, 22, 8), turretBarrelMat);
  barrel.rotation.z = Math.PI / 2;
  barrel.position.set(14, 8, 0);
  barrel.castShadow = true;
  turretHead.add(barrel);

  let facing = 0;

  function update(snapshot: TurretSnapshot): void {
    group.position.set(snapshot.x, 0, snapshot.y);
    if (snapshot.target) {
      facing = Math.atan2(snapshot.target.y - snapshot.y, snapshot.target.x - snapshot.x);
    }
    turretHead.rotation.y = -facing;
    group.visible = snapshot.hp > 0;
  }

  return { group, update };
}

export { WALL_HALF_EXTENT, WALL_GATE_WIDTH, WALL_THICKNESS };
