// Phase 5 (feature/3d-migration): the map's decorative environment in 3D —
// trees/bushes (real CC0 GLB meshes from Gobkit's Nature Kit) and abandoned
// vehicle wrecks (Kenney's MIT-licensed truck model) at the EXACT SAME
// positions terrain.ts's existing DECORATIVE_PROPS already computes for the
// 2D renderer — this file only changes what gets drawn at each position,
// never where. See assets/3d/NOTES.md for source/licence per model.
import * as THREE from "three";
import { cloneModel, loadModel, type LoadedModel } from "./assets.ts";
import { DECORATIVE_PROPS, type PropType } from "../terrain.ts";

const MODEL_URLS: Partial<Record<PropType, string[]>> = {
  tree: ["/assets/3d/environment/TreeHigh001.glb", "/assets/3d/environment/TreeHigh002.glb", "/assets/3d/environment/TreeMed001.glb"],
  bush: ["/assets/3d/environment/Bush001.glb", "/assets/3d/environment/Bush002.glb"],
  wreck: ["/assets/3d/vehicles/truck-red.glb"],
};
// barrel/chest have no matching Nature Kit model (it's trees/rocks/terrain
// only — see assets/3d/NOTES.md) — represented as simple original geometry
// below (createCrateMesh), consistent with structures.ts's "no licensed
// asset found, say so, build it" precedent rather than silently reusing a
// mismatched tree mesh for a supply crate.

const crateMat = new THREE.MeshStandardMaterial({ color: 0x5a4a32, roughness: 0.85 });
function createCrateMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), crateMat);
  mesh.position.y = 5;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
const barrelMat = new THREE.MeshStandardMaterial({ color: 0x4a5a3a, roughness: 0.6, metalness: 0.3 });
function createBarrelMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 12, 10), barrelMat);
  mesh.position.y = 6;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

async function loadVariants(urls: string[]): Promise<LoadedModel[]> {
  return Promise.all(urls.map((u) => loadModel(u)));
}

export async function createEnvironmentProps(): Promise<THREE.Group> {
  const group = new THREE.Group();

  const [treeVariants, bushVariants, wreckVariants] = await Promise.all([
    loadVariants(MODEL_URLS.tree!),
    loadVariants(MODEL_URLS.bush!),
    loadVariants(MODEL_URLS.wreck!),
  ]);

  // Deterministic per-prop variant selection (not Math.random()) so the
  // scene layout is identical on every load, matching terrain.ts's own
  // seededRandom discipline for the underlying position data.
  const pick = <T,>(variants: T[], seed: number): T => variants[Math.floor(seed) % variants.length];

  let propIndex = 0;
  for (const prop of DECORATIVE_PROPS) {
    propIndex++;
    let node: THREE.Object3D | undefined;
    let scale = 1;
    if (prop.type === "tree") {
      node = cloneModel(pick(treeVariants, propIndex));
      scale = 14;
    } else if (prop.type === "bush") {
      node = cloneModel(pick(bushVariants, propIndex));
      scale = 8;
    } else if (prop.type === "wreck") {
      node = cloneModel(pick(wreckVariants, propIndex));
      scale = 1;
    } else if (prop.type === "barrel") {
      node = createBarrelMesh();
    } else if (prop.type === "chest") {
      node = createCrateMesh();
    }
    if (!node) continue;

    if (scale !== 1) {
      // Nature Kit models are tiny (sub-1-unit native scale); normalize by
      // bounding box like character.ts/zombie.ts do, but with a fixed
      // target scale factor rather than a target world height (trees vary
      // a lot in natural proportion; a fixed multiplier reads better than
      // forcing every tree to the exact same height).
      const box = new THREE.Box3().setFromObject(node);
      const size = new THREE.Vector3();
      box.getSize(size);
      const norm = scale / Math.max(size.y, 0.001);
      node.scale.setScalar(norm);
      const center = box.getCenter(new THREE.Vector3());
      node.position.set(-center.x * norm, -box.min.y * norm, -center.z * norm);
    }

    const pivot = new THREE.Group();
    pivot.add(node);
    pivot.position.set(prop.x, 0, prop.y);
    pivot.rotation.y = -prop.rotation;
    node.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });
    group.add(pivot);
  }

  return group;
}
