import { BASE_POS, TURRET_LEVELS, TURRET_POS, WALL_RING_RADIUS, WORLD_SIZE } from "./defense-config.ts";
import type { StateMessage } from "./protocol.ts";

// Just enough visual distinction per wall level — colour/thickness, plus
// spikes once the level actually has the reflect-damage effect (WALL_LEVELS
// in defense-config.ts says which levels that's true for; this table only
// decides how to draw it, not whether it applies).
const WALL_VISUALS: Record<number, { color: string; lineWidth: number; spikes: boolean }> = {
  1: { color: "#9aa0a6", lineWidth: 4, spikes: false },
  2: { color: "#7fa6c9", lineWidth: 5, spikes: true },
  3: { color: "#c9a0ff", lineWidth: 6, spikes: true },
};

// Plain shapes and colour only — no sprites, no animation, no particles.
// Renders exactly what the server sent; never infers or predicts anything.
export function render(
  ctx: CanvasRenderingContext2D,
  canvasSize: number,
  state: StateMessage,
  aimAngle: number,
): void {
  const scale = canvasSize / WORLD_SIZE;
  const toScreen = (x: number, y: number) => ({ x: x * scale, y: y * scale });

  ctx.fillStyle = "#1c1c1c";
  ctx.fillRect(0, 0, canvasSize, canvasSize);

  // Wayfinding grid — decorative only, not part of the map's logic.
  ctx.strokeStyle = "#2a2a2a";
  ctx.lineWidth = 1;
  for (let i = 1; i < 10; i++) {
    const p = (i / 10) * canvasSize;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, canvasSize);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(canvasSize, p);
    ctx.stroke();
  }

  const base = toScreen(BASE_POS.x, BASE_POS.y);
  const ringRadius = scale * WALL_RING_RADIUS;

  // Wall: present once wallHp > 0 — gone the instant it's destroyed (level
  // drops to 0 server-side, so there's nothing ambiguous about "is it up").
  // Drawn at WALL_RING_RADIUS, the exact radius zombies stop at while it's
  // up — the ring is where the wall physically is, not just a decoration.
  if (state.wallHp > 0 && state.wallLevel > 0) {
    const visual = WALL_VISUALS[state.wallLevel] ?? WALL_VISUALS[1];
    ctx.strokeStyle = visual.color;
    ctx.lineWidth = visual.lineWidth;
    ctx.beginPath();
    ctx.arc(base.x, base.y, ringRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Level 2+: short spikes radiating outward, reading as "touch this and
    // you get hurt" — the reflect-damage effect made visible.
    if (visual.spikes) {
      const spikeCount = 14;
      const spikeLength = 7;
      ctx.lineWidth = 2;
      for (let i = 0; i < spikeCount; i++) {
        const angle = (i / spikeCount) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(base.x + Math.cos(angle) * ringRadius, base.y + Math.sin(angle) * ringRadius);
        ctx.lineTo(
          base.x + Math.cos(angle) * (ringRadius + spikeLength),
          base.y + Math.sin(angle) * (ringRadius + spikeLength),
        );
        ctx.stroke();
      }
    }
  }

  // Base
  ctx.fillStyle = "#4477cc";
  ctx.beginPath();
  ctx.arc(base.x, base.y, 18, 0, Math.PI * 2);
  ctx.fill();

  // Turret: a fixed fixture near the base, drawn whenever it's been built
  // and still has HP. Range shown as a faint circle so the player can see
  // what it actually covers.
  if (state.turretBuilt && state.turretHp > 0) {
    const turretScreen = toScreen(TURRET_POS.x, TURRET_POS.y);
    const range = TURRET_LEVELS[state.turretLevel]?.range ?? TURRET_LEVELS[1].range;

    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(turretScreen.x, turretScreen.y, scale * range, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = "#cc6633";
    ctx.beginPath();
    ctx.arc(turretScreen.x, turretScreen.y, 10, 0, Math.PI * 2);
    ctx.fill();

    // Barrel, pointing at whatever it's currently tracking.
    if (state.turretTarget) {
      const angle = Math.atan2(state.turretTarget.y - TURRET_POS.y, state.turretTarget.x - TURRET_POS.x);
      ctx.strokeStyle = "#cc6633";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(turretScreen.x, turretScreen.y);
      ctx.lineTo(turretScreen.x + Math.cos(angle) * 14, turretScreen.y + Math.sin(angle) * 14);
      ctx.stroke();
    }
  }

  // Zombies
  ctx.fillStyle = "#4caf50";
  for (const z of state.zombies) {
    const p = toScreen(z.x, z.y);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.fill();
  }

  // Player: a simple oriented body/head/gun shape, not a bare dot — rotated
  // to face aimAngle. Flat shapes and colour only, same as everything else
  // here; no sprite sheet, no animation frames.
  const player = toScreen(state.player.x, state.player.y);
  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.rotate(aimAngle);
  ctx.fillStyle = "#ffcc00";
  ctx.beginPath();
  ctx.ellipse(0, 0, 11, 8, 0, 0, Math.PI * 2); // body, facing +x before rotation
  ctx.fill();
  ctx.beginPath();
  ctx.arc(6, 0, 5, 0, Math.PI * 2); // head, offset toward the facing direction
  ctx.fill();
  ctx.fillStyle = "#333";
  ctx.fillRect(8, -2, 15, 4); // gun, extending further forward
  ctx.restore();

  // Aim direction — a short line from the player along the client's own
  // current aim angle. A UI cue for what the next shot would target, not a
  // game decision: the server resolves the actual hit independently.
  const aimLength = 30;
  ctx.strokeStyle = "#ffcc00";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(player.x, player.y);
  ctx.lineTo(player.x + Math.cos(aimAngle) * aimLength, player.y + Math.sin(aimAngle) * aimLength);
  ctx.stroke();
}

// Day + wave progress, top-centre of the canvas. Pure display of what the
// server sent (killedZombies/totalZombiesForDay) — nothing here decides when
// the day advances, that's GameLoop's #checkWaveComplete.
export function renderDayProgress(
  ctx: CanvasRenderingContext2D,
  canvasSize: number,
  day: number,
  killed: number,
  total: number,
): void {
  const centerX = canvasSize / 2;

  ctx.textAlign = "center";
  ctx.fillStyle = "#fff";
  ctx.font = "bold 28px system-ui, sans-serif";
  ctx.fillText(`DAY ${day}`, centerX, 34);

  const barWidth = 220;
  const barHeight = 14;
  const barX = centerX - barWidth / 2;
  const barY = 44;
  const fraction = total > 0 ? killed / total : 0;

  ctx.strokeStyle = "#888";
  ctx.lineWidth = 2;
  ctx.strokeRect(barX, barY, barWidth, barHeight);
  ctx.fillStyle = "#4caf50";
  ctx.fillRect(barX, barY, barWidth * fraction, barHeight);

  ctx.fillStyle = "#fff";
  ctx.font = "14px system-ui, sans-serif";
  ctx.fillText(`${killed} / ${total} ZOMBIES`, centerX, barY + barHeight + 18);

  ctx.textAlign = "left"; // restore the default so later draws aren't surprised
}

// Crosshair at the mouse's own position — separate from the aim line (which
// is anchored to the player). Together they make "where is the gun pointed"
// unambiguous: the line says the angle, this says exactly where the cursor is.
export function renderCrosshair(ctx: CanvasRenderingContext2D, canvasSize: number, mouseWorldPos: { x: number; y: number }): void {
  const scale = canvasSize / WORLD_SIZE;
  const x = mouseWorldPos.x * scale;
  const y = mouseWorldPos.y * scale;
  const inner = 4;
  const outer = 11;
  ctx.strokeStyle = "#ff5555";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - outer, y);
  ctx.lineTo(x - inner, y);
  ctx.moveTo(x + inner, y);
  ctx.lineTo(x + outer, y);
  ctx.moveTo(x, y - outer);
  ctx.lineTo(x, y - inner);
  ctx.moveTo(x, y + inner);
  ctx.lineTo(x, y + outer);
  ctx.stroke();
}

// A fired shot, client-side only: drawn the instant the player clicks (see
// input.ts's onShoot) and gone shortly after. Purely cosmetic — the server
// already resolved the real hit before this ever gets drawn; there is no
// bullet entity, no travel time and nothing here is sent over the wire.
export interface ShotEffect {
  x: number;
  y: number;
  angle: number;
  firedAt: number;
}

export const TRACER_LIFETIME_MS = 130;
const TRACER_LENGTH = 220; // world units — a visual streak length, not the real PISTOL_RANGE

export function renderShotEffects(
  ctx: CanvasRenderingContext2D,
  canvasSize: number,
  effects: readonly ShotEffect[],
  now: number,
): void {
  const scale = canvasSize / WORLD_SIZE;
  for (const e of effects) {
    const age = now - e.firedAt;
    if (age < 0 || age > TRACER_LIFETIME_MS) continue;
    const alpha = 1 - age / TRACER_LIFETIME_MS;

    const x1 = e.x * scale;
    const y1 = e.y * scale;
    const x2 = (e.x + Math.cos(e.angle) * TRACER_LENGTH) * scale;
    const y2 = (e.y + Math.sin(e.angle) * TRACER_LENGTH) * scale;

    ctx.strokeStyle = `rgba(255, 240, 150, ${alpha})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    // Muzzle flash: a small fading circle at the origin.
    ctx.fillStyle = `rgba(255, 220, 120, ${alpha})`;
    ctx.beginPath();
    ctx.arc(x1, y1, 2 + 6 * alpha, 0, Math.PI * 2);
    ctx.fill();
  }
}
