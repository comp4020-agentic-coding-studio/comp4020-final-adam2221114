// Phase 4 (feature/3d-migration): distinct animated 3D zombie models
// replacing Phase 2's single placeholder box — one real, CC0, rigged model
// per ZombieType (see assets/3d/NOTES.md for source/licence per model):
//   normal -> WardPatient (bandaged hospital-patient figure)
//   flying -> Bat (small flying creature, hovers above the ground plane)
//   giant  -> BloodironJuggernaut (oversized horned ogre with a club)
//   boss   -> OrcWarbandChampion (armoured horned orc with an axe)
// Each ships idle/attack/dead(+walk for Bat) clips from its own pack,
// matching this project's server-authoritative "type drives visuals"
// invariant from CLAUDE.md (ZombieSnapshot.hp/maxHp/type is what the UI/
// renderer must read, never a client guess).
import * as THREE from "three";
import { cloneModel, loadModel, type LoadedModel } from "./assets.ts";
import type { ZombieSnapshot, ZombieType } from "../protocol.ts";

const MODEL_URLS: Record<ZombieType, string> = {
  normal: "/assets/3d/zombies/normal-wardpatient.glb",
  flying: "/assets/3d/zombies/flying-bat.glb",
  giant: "/assets/3d/zombies/giant-juggernaut.glb",
  boss: "/assets/3d/zombies/boss-warchampion.glb",
};

// Base on-screen size (world units, model height) per type before the
// render-config scale multiplier below — WardPatient/Juggernaut/
// WarChampion are all the same gobkit humanoid proportions, so their
// relative size difference comes entirely from TYPE_SCALE, matching the 2D
// client's own ZOMBIE_RENDER scale-factor approach (render.ts).
const BASE_HEIGHT_WORLD_UNITS = 42;

// Mirrors the 2D client's ZOMBIE_RENDER scale factors (render.ts) so a
// giant/boss reads exactly as oversized in 3D as it already does in 2D —
// not a new, uncoordinated set of numbers.
const TYPE_SCALE: Record<ZombieType, number> = { normal: 1.0, flying: 0.75, giant: 1.6, boss: 1.9 };
const HOVER_HEIGHT: Record<ZombieType, number> = { normal: 0, flying: 60, giant: 0, boss: 0 };

const ATTACK_CLIP_MS = 400;
const HIT_FLASH_MS = 180;

const cachedModels = new Map<ZombieType, Promise<LoadedModel>>();
function modelFor(type: ZombieType): Promise<LoadedModel> {
  let pending = cachedModels.get(type);
  if (!pending) {
    pending = loadModel(MODEL_URLS[type]);
    cachedModels.set(type, pending);
  }
  return pending;
}

export interface ZombieModel {
  root: THREE.Group;
  type: ZombieType;
  mixer: THREE.AnimationMixer;
  update: (snapshot: ZombieSnapshot, facingAngle: number, lungeStartedAt: number | undefined, now: number) => void;
  dispose: () => void;
}

export async function createZombieModel(type: ZombieType): Promise<ZombieModel> {
  const base = await modelFor(type);
  const root = cloneModel(base);

  // precise=true (skinning-aware per-vertex) PLUS an explicit
  // updateMatrixWorld(true) first — both required, see character.ts's
  // createPlayerModel for the full explanation of why Box3.setFromObject's
  // own traversal order alone isn't enough for a freshly cloned SkinnedMesh
  // whose skeleton bones are sibling nodes, not descendants.
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root, true);
  const size = new THREE.Vector3();
  box.getSize(size);
  const scale = (BASE_HEIGHT_WORLD_UNITS * TYPE_SCALE[type]) / Math.max(size.y, 0.001);
  const pivot = new THREE.Group();
  root.scale.setScalar(scale);
  root.position.set(-box.getCenter(new THREE.Vector3()).x * scale, -box.min.y * scale, -box.getCenter(new THREE.Vector3()).z * scale);
  pivot.add(root);

  // Each mesh gets its own CLONED material (not shared with the cached base
  // model or other instances) so this instance's hit-flash emissive tint
  // never bleeds into any other zombie using the same cached glTF.
  const emissiveMaterials: THREE.MeshStandardMaterial[] = [];
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      const owned = materials.map((mat) => {
        if (!(mat instanceof THREE.MeshStandardMaterial)) return mat;
        const clone = mat.clone();
        clone.emissive = new THREE.Color(0x000000);
        emissiveMaterials.push(clone);
        return clone;
      });
      obj.material = Array.isArray(obj.material) ? owned : owned[0];
    }
  });

  const mixer = new THREE.AnimationMixer(root);
  // Pack clip names are inconsistently cased across sources (Rifleman-style
  // packs use "Idle"/"Attack"/"Death"; the Bat's animal-pack clips use
  // lowercase "idle"/"attack"/"dead" — see assets/3d/NOTES.md) — try both
  // forms so every type's actual clip is found regardless of which pack it
  // came from.
  const clip = (...names: string[]): THREE.AnimationClip | undefined => {
    for (const name of names) {
      const found = THREE.AnimationClip.findByName(base.animations, name);
      if (found) return found;
    }
    return undefined;
  };
  const action = (c: THREE.AnimationClip | undefined): THREE.AnimationAction | undefined => (c ? mixer.clipAction(c) : undefined);
  const idleAction = action(clip("Idle", "idle"));
  const walkAction = action(clip("Walk", "walk"));
  const attackAction = action(clip("Attack", "attack"));
  const deadAction = action(clip("Death", "dead"));
  if (attackAction) {
    attackAction.setLoop(THREE.LoopOnce, 1);
    attackAction.clampWhenFinished = true;
  }
  if (deadAction) {
    deadAction.setLoop(THREE.LoopOnce, 1);
    deadAction.clampWhenFinished = true;
  }

  // Bat ships a dedicated "walk" clip for locomotion; every other type's
  // pack only has idle/attack/dead (per the Gobkit manifest's own notes —
  // see assets/3d/NOTES.md), so those types use idle as their locomotion
  // loop too (a shambling idle reads fine as a zombie's gait; there is no
  // Walk clip available to prefer).
  const locomotion = walkAction ?? idleAction;
  let current: THREE.AnimationAction | undefined;
  if (locomotion) {
    locomotion.play();
    current = locomotion;
  }
  let deadPlaying = false;

  function update(snapshot: ZombieSnapshot, facingAngle: number, lungeStartedAt: number | undefined, now: number): void {
    pivot.rotation.y = -facingAngle - Math.PI / 2; // same world->Three.js yaw convention as character.ts; source packs are also authored facing +Z
    pivot.position.x = snapshot.x;
    pivot.position.z = snapshot.y;
    pivot.position.y = HOVER_HEIGHT[type] + (type === "flying" ? Math.sin(now / 260) * 4 : 0); // a gentle bob for the flying type, matching the 2D renderer's own hover wobble

    if (snapshot.hp <= 0) {
      if (!deadPlaying && deadAction) {
        deadPlaying = true;
        current?.fadeOut(0.15);
        deadAction.reset().fadeIn(0.15).play();
        current = deadAction;
      }
      return;
    }

    if (current !== locomotion && locomotion) {
      locomotion.reset().fadeIn(0.15).play();
      current?.fadeOut(0.15);
      current = locomotion;
    }

    const lunging = lungeStartedAt !== undefined && now - lungeStartedAt < ATTACK_CLIP_MS;
    if (lunging && attackAction && !attackAction.isRunning()) attackAction.reset().play();

    // A brief red emissive flash reads as "just took damage" even without a
    // dedicated hit-reaction clip in every pack — driven by the SAME
    // attacksLanded/hp-diff discipline render.ts's 2D impact effects use
    // (the caller passes lungeStartedAt only when a real server-confirmed
    // event happened), not a guess.
    const flashing = lungeStartedAt !== undefined && now - lungeStartedAt < HIT_FLASH_MS;
    const emissiveStrength = flashing ? 1 - (now - lungeStartedAt!) / HIT_FLASH_MS : 0;
    for (const mat of emissiveMaterials) mat.emissive.setRGB(emissiveStrength * 0.6, 0, 0);
  }

  function dispose(): void {
    mixer.stopAllAction();
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
      }
    });
    for (const mat of emissiveMaterials) mat.dispose();
  }

  return { root: pivot, type, mixer, update, dispose };
}
