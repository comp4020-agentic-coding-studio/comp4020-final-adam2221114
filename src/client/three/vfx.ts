// Phase 7 (feature/3d-migration): combat VFX in 3D — bullet tracers, muzzle
// flashes, explosions, and hit sparks. Exactly like the 2D client's own
// render.ts effects (Bullet/ShotEffect/ImpactEffect/DamageNumber), every
// effect here is triggered ONLY by main3d.ts diffing real server-
// authoritative fields across snapshots (PlayerSnapshot.shotsFired,
// ZombieSnapshot.attacksLanded/hp, TurretSnapshot.shotsFired) — never a
// local guess at whether something happened. The server has already
// resolved hit/damage before any of these particles exist; this module is
// purely a presentation of an already-decided event (CLAUDE.md's 3D
// migration rules: "a 3D projectile mesh is a presentation of an
// already-resolved server hit, never a physics simulation that could
// disagree with it").
import * as THREE from "three";

const tracerMat = new THREE.MeshBasicMaterial({ color: 0xfff4c0, transparent: true });
const muzzleFlashMat = new THREE.SpriteMaterial({ color: 0xffd98a, transparent: true, depthWrite: false });
const impactSparkMat = new THREE.SpriteMaterial({ color: 0xffffff, transparent: true, depthWrite: false });
const explosionMat = new THREE.SpriteMaterial({ color: 0xff8a3c, transparent: true, depthWrite: false });
const hoverTextCanvas = document.createElement("canvas");

export const BULLET_TRAVEL_MS = 90;
export const TRACER_LIFETIME_MS = 130;
export const EXPLOSION_EFFECT_MS = 500;
export const IMPACT_EFFECT_MS = 240;
export const PROJECTILE_TRAVEL_MS = 300;
export const DAMAGE_NUMBER_MS = 850;

export interface Bullet3D {
  from: THREE.Vector3;
  to: THREE.Vector3;
  firedAt: number;
}

export interface ZombieProjectile3D {
  from: THREE.Vector3;
  to: THREE.Vector3;
  firedAt: number;
}

export interface ImpactEffect3D {
  pos: THREE.Vector3;
  kind: "melee" | "explosion";
  startedAt: number;
}

export interface DamageNumber3D {
  pos: THREE.Vector3;
  amount: number;
  spawnedAt: number;
}

// A single reusable cylinder mesh per active bullet — created on demand,
// disposed when the bullet's travel completes. Pooling isn't worth the
// complexity at this project's scale (a handful of concurrent shots, same
// order of magnitude as the 2D client's own `bullets` array).
export class VfxLayer {
  readonly group = new THREE.Group();
  #bulletMeshes = new Map<Bullet3D, THREE.Mesh>();
  #projectileMeshes = new Map<ZombieProjectile3D, THREE.Mesh>();
  #impactSprites = new Map<ImpactEffect3D, THREE.Sprite>();
  #damageSprites = new Map<DamageNumber3D, THREE.Sprite>();

  spawnMuzzleFlash(pos: THREE.Vector3): void {
    const sprite = new THREE.Sprite(muzzleFlashMat.clone());
    sprite.scale.setScalar(14);
    sprite.position.copy(pos);
    this.group.add(sprite);
    const start = performance.now();
    const tick = (): void => {
      const age = performance.now() - start;
      if (age > 90) {
        this.group.remove(sprite);
        sprite.material.dispose();
        return;
      }
      sprite.material.opacity = 1 - age / 90;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  addBullet(b: Bullet3D): void {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 1, 6), tracerMat.clone());
    mesh.rotation.x = Math.PI / 2;
    this.group.add(mesh);
    this.#bulletMeshes.set(b, mesh);
    this.spawnMuzzleFlash(b.from);
  }

  addProjectile(p: ZombieProjectile3D): void {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(2, 8, 8), new THREE.MeshBasicMaterial({ color: 0x8aff5c }));
    this.group.add(mesh);
    this.#projectileMeshes.set(p, mesh);
  }

  addImpact(e: ImpactEffect3D): void {
    const mat = (e.kind === "explosion" ? explosionMat : impactSparkMat).clone();
    const sprite = new THREE.Sprite(mat);
    sprite.scale.setScalar(e.kind === "explosion" ? 60 : 10);
    sprite.position.copy(e.pos).add(new THREE.Vector3(0, 10, 0));
    this.group.add(sprite);
    this.#impactSprites.set(e, sprite);
  }

  addDamageNumber(d: DamageNumber3D): void {
    const canvas = hoverTextCanvas;
    canvas.width = 64;
    canvas.height = 32;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = "bold 20px monospace";
    ctx.fillStyle = "#ff5c5c";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`-${d.amount}`, canvas.width / 2, canvas.height / 2);
    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
    sprite.scale.set(20, 10, 1);
    sprite.position.copy(d.pos).add(new THREE.Vector3(0, 40, 0));
    this.group.add(sprite);
    this.#damageSprites.set(d, sprite);
  }

  // Called once per frame — updates every live effect's transform/opacity
  // from its own elapsed time and removes anything whose lifetime expired.
  update(now: number): void {
    for (const [b, mesh] of this.#bulletMeshes) {
      const age = now - b.firedAt;
      if (age > BULLET_TRAVEL_MS) {
        this.group.remove(mesh);
        mesh.geometry.dispose();
        this.#bulletMeshes.delete(b);
        continue;
      }
      const t = Math.min(1, age / BULLET_TRAVEL_MS);
      const pos = b.from.clone().lerp(b.to, t);
      mesh.position.copy(pos);
      mesh.lookAt(b.to);
      mesh.rotateX(Math.PI / 2);
      const dist = b.from.distanceTo(b.to);
      mesh.scale.set(1, dist * 0.08, 1);
    }

    for (const [p, mesh] of this.#projectileMeshes) {
      const age = now - p.firedAt;
      if (age > PROJECTILE_TRAVEL_MS) {
        this.group.remove(mesh);
        mesh.geometry.dispose();
        this.#projectileMeshes.delete(p);
        continue;
      }
      const t = Math.min(1, age / PROJECTILE_TRAVEL_MS);
      mesh.position.copy(p.from.clone().lerp(p.to, t));
    }

    for (const [e, sprite] of this.#impactSprites) {
      const age = now - e.startedAt;
      const duration = e.kind === "explosion" ? EXPLOSION_EFFECT_MS : IMPACT_EFFECT_MS;
      if (age < 0) continue;
      if (age > duration) {
        this.group.remove(sprite);
        sprite.material.dispose();
        this.#impactSprites.delete(e);
        continue;
      }
      const t = age / duration;
      sprite.material.opacity = 1 - t;
      const growTo = e.kind === "explosion" ? 60 * (1 + t * 1.2) : 10;
      sprite.scale.setScalar(growTo);
    }

    for (const [d, sprite] of this.#damageSprites) {
      const age = now - d.spawnedAt;
      if (age > DAMAGE_NUMBER_MS) {
        this.group.remove(sprite);
        sprite.material.map?.dispose();
        sprite.material.dispose();
        this.#damageSprites.delete(d);
        continue;
      }
      const t = age / DAMAGE_NUMBER_MS;
      sprite.material.opacity = 1 - t;
      sprite.position.y = d.pos.y + 40 + t * 20;
    }
  }
}
