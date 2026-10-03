import type { StateMessage } from "./protocol.ts";

// Display-only smoothing: the server ticks (and moves player/zombies) at 5Hz,
// but renders at ~60fps via requestAnimationFrame. Rather than guess at
// motion, this reconstructs it — the server itself moves each entity a
// straight-line step per tick with no acceleration, so linearly interpolating
// between the last two snapshots over real elapsed time reproduces the true
// path, not an approximation of it.
//
// Returns a new StateMessage with player/zombie positions interpolated;
// every other field (day, baseHp, phase, ...) is copied from `curr` as-is —
// numbers like that don't benefit from smoothing, and nothing here is fed
// back into any outgoing message or mutates real state.
export function interpolateState(
  prev: StateMessage | undefined,
  prevAt: number,
  curr: StateMessage,
  currAt: number,
  now: number,
): StateMessage {
  if (!prev || currAt <= prevAt) return curr;

  const span = currAt - prevAt;
  const t = Math.min(Math.max((now - prevAt) / span, 0), 1);

  const prevZombies = new Map(prev.zombies.map((z) => [z.id, z]));
  const zombies = curr.zombies.map((z) => {
    const p = prevZombies.get(z.id);
    if (!p) return z; // just spawned this tick — nothing to interpolate from, snap in
    return { ...z, x: lerp(p.x, z.x, t), y: lerp(p.y, z.y, t) };
  });

  return {
    ...curr,
    player: {
      ...curr.player,
      x: lerp(prev.player.x, curr.player.x, t),
      y: lerp(prev.player.y, curr.player.y, t),
    },
    zombies,
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
