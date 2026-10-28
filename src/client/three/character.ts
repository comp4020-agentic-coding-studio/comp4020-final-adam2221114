// Phase 3 (feature/3d-migration): the real 3D player character — a rigged,
// animated humanoid (assets/3d/characters/rifleman.glb, CC0 — see
// assets/3d/NOTES.md) replacing Phase 2's placeholder box. The model
// already holds a real rifle as part of its single skinned mesh (confirmed
// by inspecting the glTF: all 13 joint nodes, including both arms, are
// driven by every animation clip, and the weapon geometry has no separate
// node of its own to re-attach) — so "correct hand attachment" and "must
// not look like a rectangular placeholder" are satisfied by the asset
// itself, not by a hand-tuned offset bolted onto a primitive.
//
// Animation state machine: server-authoritative PlayerSnapshot drives which
// clip plays (never a local guess at gameplay state) — alive+moving ->
// Walk/Run, alive+still -> Idle, status === "downed"/"dead" -> a held pose
// on Death's last frame (no separate "downed" clip exists in the source
// pack; Death's final frame already reads as "collapsed", which is exactly
// what a downed/dead player should look like), a recent shot -> Attack
// layered as a one-shot on top of the locomotion state, recent damage ->
// Hit layered the same way. Facing (which way the model turns to) comes
// from the SAME source the 2D renderer already uses: aimAngle for the
// local player (live input), movement-delta-derived facing for everyone
// else (no aimAngle field on remote PlayerSnapshot — see protocol.ts).
import * as THREE from "three";
import { cloneModel, loadModel, type LoadedModel } from "./assets.ts";
import type { PlayerSnapshot } from "../protocol.ts";

const RIFLEMAN_URL = "/assets/3d/characters/rifleman.glb";

// Per-character-slot colour tints (matches the 2D client's REMOTE_PLAYER_COLORS/
// LOCAL_PLAYER_COLOR in main.ts) applied as a material colour multiply on the
// model's body material — the cheapest way to give 4 roster slots a visually
// distinct skin from one shared mesh, same spirit as the 2D client reusing one
// LPC sheet per character slot with a palette swap.
const CHARACTER_TINTS = [0xffcc00, 0xff6666, 0x66b2ff, 0x66ff99];

const WALK_SPEED_THRESHOLD = 10; // world units/sec — below this, Idle; see updatePose
const RUN_SPEED_THRESHOLD = 120; // world units/sec — above this, Run instead of Walk
const ATTACK_CLIP_MS = 350; // one-shot Attack layer duration, roughly matching WEAPON_RECOIL_MS's visual snap in the 2D client
const HIT_CLIP_MS = 300;

export interface PlayerModel {
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  update: (dtMs: number, snapshot: PlayerSnapshot, facingAngle: number, speed: number, lastShotAt: number | undefined, lastHitAt: number | undefined, now: number) => void;
  dispose: () => void;
}

let cachedBase: Promise<LoadedModel> | undefined;
function baseModel(): Promise<LoadedModel> {
  if (!cachedBase) cachedBase = loadModel(RIFLEMAN_URL);
  return cachedBase;
}

// Rifleman.glb's own scale puts the model at roughly 1.7 world-height units
// (confirmed via bounding-box inspection during asset research) — the 2D
// client's player draw size is ~48 world units tall (scene.ts's old
// placeholder box). This scale factor brings the model to match that same
// on-screen size convention so zombies/buildings/props built at 2D-derived
// world coordinates read at a consistent relative scale.
const MODEL_HEIGHT_WORLD_UNITS = 48;

export async function createPlayerModel(colorIndex: number): Promise<PlayerModel> {
  const base = await baseModel();
  const root = cloneModel(base);

  // Normalize the vendored model's own arbitrary export scale/pivot to this
  // project's world units, with feet at y=0 (ground plane) — computed once
  // per instance from the clone's own bounding box, not hand-measured, so
  // this keeps working if the source asset is ever swapped for another pack
  // model with different native proportions.
  //
  // MUST pass precise=true: this model's single mesh is a SkinnedMesh, and
  // Box3.setFromObject's default (imprecise) path reads geometry.boundingBox
  // transformed only by the mesh's own matrixWorld — it does NOT account for
  // bone/skin transforms at all. precise=true uses getVertexPosition
  // per-vertex instead, which for a SkinnedMesh IS skinning-aware — but that
  // in turn reads skeleton.bones[i].matrixWorld directly, and those bones
  // are SIBLINGS of the mesh node in this glTF's hierarchy, not its
  // descendants (confirmed via glTF node inspection: the mesh node has no
  // children; the skeleton root bone lives under a separate sibling node).
  // Box3.setFromObject's own traversal only calls updateWorldMatrix() on
  // each node as it visits it, in child order — so when it reaches the mesh
  // node first, the bones' matrixWorld is still whatever it was BEFORE this
  // call (identity, on a freshly cloned model that was never rendered or
  // explicitly updated), making every skinned vertex resolve near the
  // origin and the computed box collapse to near-zero. That produced a
  // scale of MODEL_HEIGHT_WORLD_UNITS / 0.001 = 48000x too large — the
  // actual root cause of the "dark diagonal gradient" that was covering
  // most of the screen: it was this grossly oversized player mesh filling
  // the frame, not a lighting/shadow/fog issue (see PROCESS.md). Forcing a
  // full updateMatrixWorld(true) up front, independent of Box3's own
  // traversal order, fixes it.
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root, true);
  const size = new THREE.Vector3();
  box.getSize(size);
  const scale = MODEL_HEIGHT_WORLD_UNITS / Math.max(size.y, 0.001);
  const pivot = new THREE.Group();
  root.scale.setScalar(scale);
  root.position.set(-box.getCenter(new THREE.Vector3()).x * scale, -box.min.y * scale, -box.getCenter(new THREE.Vector3()).z * scale);
  pivot.add(root);

  const tint = new THREE.Color(CHARACTER_TINTS[colorIndex % CHARACTER_TINTS.length]);
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of materials) {
        if (mat instanceof THREE.MeshStandardMaterial) {
          // Clone so each instance's tint is independent (cloneModel shares
          // material references across instances by default, same as
          // Three.js's own SkeletonUtils.clone behaviour).
          const owned = mat.clone();
          owned.color.multiply(tint);
          obj.material = Array.isArray(obj.material) ? materials.map((m) => (m === mat ? owned : m)) : owned;
        }
      }
    }
  });

  const mixer = new THREE.AnimationMixer(root);
  const clip = (name: string): THREE.AnimationClip | undefined => THREE.AnimationClip.findByName(base.animations, name) ?? undefined;
  const action = (c: THREE.AnimationClip | undefined): THREE.AnimationAction | undefined => (c ? mixer.clipAction(c) : undefined);
  const actions = {
    idle: action(clip("Idle")),
    walk: action(clip("Walk")),
    run: action(clip("Run")),
    attack: action(clip("Attack")),
    hit: action(clip("Hit")),
    death: action(clip("Death")),
  };
  for (const a of [actions.attack, actions.hit]) {
    if (!a) continue;
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
  }
  if (actions.death) {
    actions.death.setLoop(THREE.LoopOnce, 1);
    actions.death.clampWhenFinished = true;
  }

  let currentLocomotion: THREE.AnimationAction | undefined;
  let overlayUntil = 0;
  let deathPlaying = false;

  const crossTo = (next: THREE.AnimationAction | undefined, durationS = 0.15): void => {
    if (!next || currentLocomotion === next) return;
    next.reset().fadeIn(durationS).play();
    currentLocomotion?.fadeOut(durationS);
    currentLocomotion = next;
  };

  function update(
    _dtMs: number,
    snapshot: PlayerSnapshot,
    facingAngle: number,
    speed: number,
    lastShotAt: number | undefined,
    lastHitAt: number | undefined,
    now: number,
  ): void {
    pivot.rotation.y = -facingAngle - Math.PI / 2; // world angle -> Three.js yaw; -90deg because the source model's rest pose faces +Z (see assets/3d/NOTES.md); matches gobkit's own "authored facing +Z" note
    pivot.position.x = snapshot.x;
    pivot.position.z = snapshot.y;

    const isDown = snapshot.status === "downed" || snapshot.status === "dead";
    if (isDown) {
      if (!deathPlaying && actions.death) {
        deathPlaying = true;
        currentLocomotion?.fadeOut(0.15);
        actions.death.reset().fadeIn(0.15).play();
        currentLocomotion = actions.death;
      }
      return;
    }
    if (deathPlaying) {
      deathPlaying = false;
      currentLocomotion = undefined; // force a fresh crossTo below, out of the death pose
    }

    const locomotion = speed < WALK_SPEED_THRESHOLD ? actions.idle : speed < RUN_SPEED_THRESHOLD ? actions.walk : actions.run;
    crossTo(locomotion);

    // One-shot overlays (Attack/Hit) layered on top via weight blending —
    // triggered purely from monotonic server fields the caller already
    // diffs (shotsFired/hp-drop), same "never guess, only react to a real
    // server-confirmed event" discipline the 2D client's own effect system
    // uses (main.ts's playerLastShotAt/playerFlashUntil).
    if (lastHitAt !== undefined && now - lastHitAt < HIT_CLIP_MS && actions.hit) {
      if (!actions.hit.isRunning()) actions.hit.reset().play();
      overlayUntil = Math.max(overlayUntil, lastHitAt + HIT_CLIP_MS);
    } else if (lastShotAt !== undefined && now - lastShotAt < ATTACK_CLIP_MS && actions.attack) {
      if (!actions.attack.isRunning()) actions.attack.reset().play();
      overlayUntil = Math.max(overlayUntil, lastShotAt + ATTACK_CLIP_MS);
    }
  }

  function dispose(): void {
    mixer.stopAllAction();
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of materials) mat.dispose();
      }
    });
  }

  // Start in Idle immediately so a freshly spawned player doesn't render in
  // bind pose for one frame before the first update() call.
  if (actions.idle) {
    actions.idle.play();
    currentLocomotion = actions.idle;
  }

  return { root: pivot, mixer, update, dispose };
}
