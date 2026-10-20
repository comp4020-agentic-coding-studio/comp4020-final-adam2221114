// Client-side prediction for the LOCAL player only. Remote entities
// (zombies, and any future remote players in crit 9) keep using snapshot
// interpolation (interpolate.ts) — this is deliberately the one exception,
// since the local player's own input is the one thing this client knows
// about instantly, without waiting on a round trip.
//
// Movement math (speed, diagonal normalization, map clamping, and — Crit 11
// — building collision) mirrors src/server/game-state.ts's movePlayer()/
// PLAYER_SPEED/MAP_SIZE/resolveMove exactly — duplicated for the same
// build-separation reason as protocol.ts (see its comment). If the two drift
// apart, prediction stops matching the server and reconciliation corrections
// stop being rare.
import { resolveMove } from "./obstacles.ts";

interface Vec2 {
  x: number;
  y: number;
}

interface MoveState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

const WORLD_SIZE = 1000;
const PLAYER_SPEED = 150; // units/second
const PLAYER_START_POS: Vec2 = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 + 60 };

// Below this, a reconciliation error is just timer/float noise — not worth
// animating a correction for.
const SMALL_ERROR_THRESHOLD = 1.5;
// Above this, it isn't latency wobble — something discontinuous happened
// (restart, resuming after a pause, the first snapshot after connecting) —
// so snap instantly rather than visibly sliding the character across the map.
const LARGE_ERROR_THRESHOLD = 80;
const CORRECTION_DECAY_MS = 120;

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class LocalPlayerPrediction {
  // The "real" dead-reckoned position: advanced only by local input, and
  // always corrected to exact server truth on every reconciliation. The
  // client never gets the final say on this — only on how it's displayed.
  #pos: Vec2 = { ...PLAYER_START_POS };
  // A display-only correction that starts at "how far the old displayed
  // position was from the position #pos was just corrected to", then decays
  // to zero — so a reconciliation reads as a quick settle, never a pop.
  #offset: Vec2 = { x: 0, y: 0 };
  #offsetStartedAt = 0;

  // Advances the dead-reckoned position by whatever's currently held. Call
  // once per animation frame with the real elapsed time since the last
  // call — this never waits for a server snapshot.
  tick(move: MoveState, dtMs: number): void {
    let dx = 0;
    let dy = 0;
    if (move.up) dy -= 1;
    if (move.down) dy += 1;
    if (move.left) dx -= 1;
    if (move.right) dx += 1;
    if (dx === 0 && dy === 0) return;

    const len = Math.hypot(dx, dy); // normalizes diagonal speed to match axis speed
    const step = (PLAYER_SPEED * dtMs) / 1000;
    const desired: Vec2 = {
      x: clamp(this.#pos.x + (dx / len) * step, 0, WORLD_SIZE),
      y: clamp(this.#pos.y + (dy / len) * step, 0, WORLD_SIZE),
    };
    this.#pos = resolveMove(this.#pos, desired);
  }

  // Called whenever a new authoritative player position arrives. #pos is
  // always corrected to match exactly — small or large error alike — so
  // prediction can never drift from the server indefinitely; the only
  // difference is whether that correction is hidden behind a quick decaying
  // visual offset (small error) or applied outright (large error, where
  // smoothing across that much distance would look like a worse glitch, not
  // a better one).
  reconcile(serverPos: Vec2, now: number): void {
    const error = distance(this.#pos, serverPos);

    if (error > LARGE_ERROR_THRESHOLD) {
      this.#pos = { ...serverPos };
      this.#offset = { x: 0, y: 0 };
      return;
    }

    if (error > SMALL_ERROR_THRESHOLD) {
      const oldDisplay = this.getDisplayPos(now);
      this.#pos = { ...serverPos };
      this.#offset = { x: oldDisplay.x - this.#pos.x, y: oldDisplay.y - this.#pos.y };
      this.#offsetStartedAt = now;
    }
    // else: negligible — leave #pos and any in-progress decay alone.
  }

  // What to actually draw: the dead-reckoned position plus whatever's left
  // of the decaying correction offset.
  getDisplayPos(now: number): Vec2 {
    const t = clamp((now - this.#offsetStartedAt) / CORRECTION_DECAY_MS, 0, 1);
    return {
      x: this.#pos.x + lerp(this.#offset.x, 0, t),
      y: this.#pos.y + lerp(this.#offset.y, 0, t),
    };
  }
}
