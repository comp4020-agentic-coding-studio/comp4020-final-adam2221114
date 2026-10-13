import { inject, it, expect } from "vitest";
import { WebSocket } from "ws";

// End-to-end regression test for the 360° horde spawning system
// (game-state.ts's spawnTierForDay/batchSpawnAngles/perimeterPositionAtAngle,
// wired up in game-loop.ts's #maybeSpawn). spec/horde-spawn-geometry.test.ts
// already exhaustively checks the pure geometry/tier functions in isolation;
// this file's job is only to confirm the live server actually uses them the
// way CLAUDE.md/the task requires: zombies appear in simultaneous batches
// (not one at a time), batches are spaced by the day-1 tier's 6000ms
// interval, the day's fixed total (10, from WAVE_TABLE day 1) is respected
// exactly, and real spawn positions land on the map boundary across more
// than one edge per batch — not clustered on one side.
//
// Same shared-live-app convention as wall-ring-protection.test.ts: restarts
// to a known baseline on the way in and out.
const baseUrl = inject("baseUrl");
const wsUrl = (): string => `${baseUrl.replace(/^http/, "ws")}/ws`;

interface ServerMsg {
  type: string;
  [key: string]: unknown;
}

interface ZombieSnap {
  id: string;
  x: number;
  y: number;
}

interface StateMsg extends ServerMsg {
  type: "state";
  phase: string;
  day: number;
  dayIntroRemainingMs: number;
  totalZombiesForDay: number;
  zombies: ZombieSnap[];
}

const MAP_SIZE = 1000;
// A spawned zombie can have moved for up to one full 50ms server tick (plus
// test-side polling slack) by the time this test's poll loop first observes
// it in a state broadcast — normal zombie speed is 40 units/s, so one tick
// is ~2 units; this tolerance is generous against that, not tight.
const EPS = 8;

function connect(playerId: string): Promise<{ ws: WebSocket; messages: ServerMsg[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl()}?playerId=${encodeURIComponent(playerId)}`);
    const messages: ServerMsg[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    ws.on("open", () => resolve({ ws, messages }));
    ws.on("error", reject);
  });
}

function waitForMatch(messages: ServerMsg[], pred: (m: ServerMsg) => boolean, timeoutMs: number): Promise<ServerMsg> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = messages.find(pred);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) return reject(new Error("timeout waiting for a matching message"));
      setTimeout(check, 20);
    };
    check();
  });
}

function edgeOf(p: ZombieSnap): string {
  if (Math.abs(p.y) < EPS) return "top";
  if (Math.abs(p.y - MAP_SIZE) < EPS) return "bottom";
  if (Math.abs(p.x) < EPS) return "left";
  if (Math.abs(p.x - MAP_SIZE) < EPS) return "right";
  return "neither"; // asserted against below — should never happen
}

it(
  "spawns day 1's zombies in simultaneous perimeter batches, 6s apart, totalling exactly the day's quota",
  async () => {
    const id = `spec-horde-${Date.now()}`;
    const conn = await connect(id);
    const send = (msg: unknown): void => conn.ws.send(JSON.stringify(msg));

    try {
      await waitForMatch(conn.messages, (m) => m.type === "welcome", 5000);

      send({ type: "restart" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      send({ type: "start" });
      await waitForMatch(conn.messages, (m) => m.type === "state" && (m as StateMsg).phase === "running", 5000);

      // Record, for every zombie id ever seen, the wall-clock time it first
      // appeared and its spawn position — enough to reconstruct batches
      // without needing to touch server internals.
      const firstSeenAt = new Map<string, number>();
      const firstSeenPos = new Map<string, ZombieSnap>();
      let dayTotal = 0;

      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 45000;
        let seenIndex = 0;
        const check = (): void => {
          for (; seenIndex < conn.messages.length; seenIndex++) {
            const m = conn.messages[seenIndex];
            if (m.type !== "state") continue;
            const s = m as StateMsg;
            dayTotal = s.totalZombiesForDay;
            for (const z of s.zombies) {
              if (!firstSeenAt.has(z.id)) {
                firstSeenAt.set(z.id, Date.now());
                firstSeenPos.set(z.id, z);
              }
            }
          }
          if (firstSeenAt.size >= dayTotal && dayTotal > 0) return resolve();
          if (Date.now() > deadline) return reject(new Error(`timed out: only saw ${firstSeenAt.size}/${dayTotal} zombies spawn`));
          setTimeout(check, 20);
        };
        check();
      });

      expect(dayTotal).toBe(10); // WAVE_TABLE day 1: 10 normal, 0 of anything else

      // Reconstruct batches: zombies whose first-seen timestamps fall within
      // 300ms of each other spawned in (for test purposes) the same batch —
      // real batches land in the exact same 50ms server tick, so this is a
      // generous bound against test-side scheduling jitter, not a loose one.
      const sorted = [...firstSeenAt.entries()].sort((a, b) => a[1] - b[1]);
      const batches: string[][] = [];
      for (const [zid, t] of sorted) {
        const last = batches[batches.length - 1];
        if (last) {
          const lastT = firstSeenAt.get(last[0])!;
          if (t - lastT < 300) {
            last.push(zid);
            continue;
          }
        }
        batches.push([zid]);
      }

      // Simultaneity: every batch but possibly the very last totals the
      // day-1 tier's batch size (4-5); the last is capped to whatever
      // remains of the day's 10-zombie quota. None exceed the tier's max.
      let remaining = dayTotal;
      for (let i = 0; i < batches.length; i++) {
        const size = batches[i].length;
        remaining -= size;
        expect(size).toBeLessThanOrEqual(5);
        if (i < batches.length - 1) {
          expect(size).toBeGreaterThanOrEqual(4);
        }
      }
      expect(remaining).toBe(0);
      // At least one real batch of >1 zombies proves zombies spawn together,
      // not trickled in one at a time (the old adaptive-interval system).
      expect(Math.max(...batches.map((b) => b.length))).toBeGreaterThanOrEqual(4);

      // Batch pacing: gaps between batch start times should track the day-1
      // tier's 6000ms interval (generous tolerance for test/network jitter
      // and the day-intro delay before the first batch).
      for (let i = 1; i < batches.length; i++) {
        const gap = firstSeenAt.get(batches[i][0])! - firstSeenAt.get(batches[i - 1][0])!;
        expect(gap).toBeGreaterThan(4500);
        expect(gap).toBeLessThan(9000); // 6000ms tier interval + generous test-poll/scheduler slack
      }

      // Perimeter geometry, live: every spawned zombie actually landed on
      // the map boundary, and any batch of >= 3 touched more than one edge
      // (sector-based spread, not a cluster on one side — see
      // horde-spawn-geometry.test.ts for why this is geometrically
      // guaranteed, not just statistically likely).
      for (const [, pos] of firstSeenPos) {
        expect(edgeOf(pos)).not.toBe("neither");
      }
      for (const batch of batches) {
        if (batch.length < 3) continue;
        const edges = new Set(batch.map((zid) => edgeOf(firstSeenPos.get(zid)!)));
        expect(edges.size, `batch ${JSON.stringify(batch)} only touched edges ${[...edges]}`).toBeGreaterThan(1);
      }
    } finally {
      send({ type: "restart" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      conn.ws.close();
    }
  },
  60000,
);
