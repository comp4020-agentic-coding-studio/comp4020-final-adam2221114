import type { StateMessage } from "./protocol.ts";

// Must match src/server/game-state.ts's MAP_SIZE/BASE_POS/BASE_ATTACK_RANGE —
// duplicated for the same reason protocol.ts is (see that file's comment):
// plain constants, not logic, and not worth a shared build for.
const WORLD_SIZE = 1000;
const BASE_POS = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
const BASE_ATTACK_RANGE = 40;

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

  // Wall: appears once wallUnlocked flips true. State only — no HP, no
  // collision, no repair logic lives here or anywhere else this step.
  if (state.wallUnlocked) {
    ctx.strokeStyle = "#9aa0a6";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(base.x, base.y, scale * BASE_ATTACK_RANGE + 12, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Base
  ctx.fillStyle = "#4477cc";
  ctx.beginPath();
  ctx.arc(base.x, base.y, 18, 0, Math.PI * 2);
  ctx.fill();

  // Zombies
  ctx.fillStyle = "#4caf50";
  for (const z of state.zombies) {
    const p = toScreen(z.x, z.y);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.fill();
  }

  // Player
  const player = toScreen(state.player.x, state.player.y);
  ctx.fillStyle = "#ffcc00";
  ctx.beginPath();
  ctx.arc(player.x, player.y, 10, 0, Math.PI * 2);
  ctx.fill();

  // Aim direction — a short line from the player along the client's own
  // current aim angle. A UI cue for what the next shot would target, not a
  // game decision: the server resolves the actual hit independently.
  const aimLength = 26;
  ctx.strokeStyle = "#ffcc00";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(player.x, player.y);
  ctx.lineTo(player.x + Math.cos(aimAngle) * aimLength, player.y + Math.sin(aimAngle) * aimLength);
  ctx.stroke();
}
