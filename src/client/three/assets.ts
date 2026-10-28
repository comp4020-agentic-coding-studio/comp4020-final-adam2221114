// Phase 3+ (feature/3d-migration): GLTF asset loading/caching for the 3D
// client. All models under assets/3d/ are vendored, CC0/MIT-licensed real
// 3D assets — see assets/3d/NOTES.md for source/licence/attribution per
// model. Served straight from assets/3d/ by src/server/index.ts's
// serveModelAsset, the same "read fresh from source, no dist/ build step"
// approach serveSprite already uses for the 2D client's PNGs.
//
// Caching: each URL is fetched/parsed via GLTFLoader exactly once (gltfCache
// below); every spawned instance (a second player, a tenth zombie) is a
// SkeletonUtils.clone of the cached original — a plain Object3D.clone()
// would share one skeleton across every instance and break independent
// animation per instance (confirmed by gobkit's own manifest notes, and
// matches Three.js's own documented skinned-mesh cloning caveat).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";

export interface LoadedModel {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

const loader = new GLTFLoader();
const gltfCache = new Map<string, Promise<LoadedModel>>();

// Loads (once per url, cached) and returns the ORIGINAL scene graph —
// callers that spawn more than one instance must clone it themselves via
// cloneModel below; this function's own returned .scene must never be added
// to more than one place in the Three.js scene graph at once.
export function loadModel(url: string): Promise<LoadedModel> {
  let pending = gltfCache.get(url);
  if (!pending) {
    pending = loader.loadAsync(url).then((gltf) => ({ scene: gltf.scene, animations: gltf.animations }));
    gltfCache.set(url, pending);
  }
  return pending;
}

// Skeleton-aware clone — required for any model with a skin/animation (every
// model this project uses). Animations are NOT cloned (clips are immutable
// data, shared freely across every instance's own AnimationMixer).
export function cloneModel(model: LoadedModel): THREE.Group {
  return cloneSkeleton(model.scene) as THREE.Group;
}

// Preloads a list of model URLs in parallel — callers await this once at
// startup so the first real spawn of each type doesn't stall on a cold
// network fetch mid-frame.
export function preloadModels(urls: readonly string[]): Promise<LoadedModel[]> {
  return Promise.all(urls.map((u) => loadModel(u)));
}
