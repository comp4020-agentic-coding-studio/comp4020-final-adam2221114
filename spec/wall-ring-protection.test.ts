import { inject, it, expect } from "vitest";
import { WebSocket } from "ws";

// Regression test for a real bug: a ground zombie that ticked its distance
// to the base below WALL_RING_RADIUS while approaching (an ordinary part of
// closing in, not a deliberate breach) permanently stopped being treated as
// "outside the ring" and walked the rest of the way to melee range of a
// player standing inside, straight through a fully intact, undamaged wall —
// see src/server/game-state.ts's advanceZombie() and PROCESS.md's entry on
// this fix. This test plays a short real game against the live app (same
// pattern as gameplay-expansion.test.ts) and fails if a player standing at
// the base ever loses HP while the wall still has HP — the one thing
// CLAUDE.md's own invariants promise can never happen.
//
// Like gameplay-expansion.test.ts's turret_interact test, this suite runs
// sequentially against ONE shared live app (vitest.config.ts), so this test
// explicitly restarts to a known baseline on the way in AND the way out —
// never leaving "running"/mid-day state for whichever test file runs next.
const baseUrl = inject("baseUrl");
const wsUrl = (): string => `${baseUrl.replace(/^http/, "ws")}/ws`;

interface ServerMsg {
  type: string;
  [key: string]: unknown;
}

interface PlayerSnap {
  id: string;
  x: number;
  y: number;
  hp: number;
  status: string;
}

interface ZombieSnap {
  id: string;
  x: number;
  y: number;
}

interface StateMsg extends ServerMsg {
  type: "state";
  phase: string;
  sharedXp: number;
  wallLevel: number;
  wallHp: number;
  players: PlayerSnap[];
  zombies: ZombieSnap[];
}

const BASE_POS = { x: 500, y: 500 };
const WALL_RING_RADIUS = 60;

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

function latestState(messages: ServerMsg[]): StateMsg | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === "state") return messages[i] as StateMsg;
  }
  return undefined;
}

it(
  "a ground zombie cannot reach a player standing inside an intact wall's ring, even once it closes within the ring itself",
  async () => {
    const id = `spec-wallring-${Date.now()}`;
    const conn = await connect(id);
    const send = (msg: unknown): void => conn.ws.send(JSON.stringify(msg));

    try {
      await waitForMatch(conn.messages, (m) => m.type === "welcome", 5000);

      // Known baseline regardless of whatever earlier test files (or manual
      // play against this same shared app) left behind.
      send({ type: "restart" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      send({ type: "start" });
      await waitForMatch(conn.messages, (m) => m.type === "state" && (m as StateMsg).phase === "running", 5000);

      // Farm the 2 kills (50 XP each) a level-1 wall costs (100 XP) by
      // shooting whatever zombie is nearest, aiming fresh every tick — real
      // combat, not a shortcut around the mechanic being tested.
      let wallRequested = false;
      const farmLoop = setInterval(() => {
        const state = latestState(conn.messages);
        if (!state) return;
        const self = state.players.find((p) => p.id === id);
        if (!self) return;

        if (!wallRequested && state.sharedXp >= 100 && state.wallLevel === 0) {
          wallRequested = true;
          send({ type: "interact", action: "build_wall" });
        }
        if (state.zombies.length === 0) return;
        let nearest = state.zombies[0];
        let bestD = Infinity;
        for (const z of state.zombies) {
          const d = Math.hypot(z.x - self.x, z.y - self.y);
          if (d < bestD) {
            bestD = d;
            nearest = z;
          }
        }
        const aimAngle = Math.atan2(nearest.y - self.y, nearest.x - self.x);
        send({ type: "input", move: { up: false, down: false, left: false, right: false }, aimAngle, reviving: false });
        if (bestD <= 600) send({ type: "shoot" });
      }, 50);

      try {
        await waitForMatch(conn.messages, (m) => m.type === "state" && (m as StateMsg).wallLevel === 1, 30000);
      } finally {
        clearInterval(farmLoop);
      }

      // Walk from the spawn point (exactly WALL_RING_RADIUS south of the
      // base) well inside the ring, then hold — the exact scenario the bug
      // required: a player standing inside an intact wall's protection.
      let holding = false;
      const moveLoop = setInterval(() => {
        const state = latestState(conn.messages);
        if (!state) return;
        const self = state.players.find((p) => p.id === id);
        if (!self) return;
        const distToBase = Math.hypot(self.x - BASE_POS.x, self.y - BASE_POS.y);
        if (!holding && distToBase > 15) {
          send({ type: "input", move: { up: self.y > BASE_POS.y, down: self.y < BASE_POS.y, left: self.x > BASE_POS.x, right: self.x < BASE_POS.x }, aimAngle: 0, reviving: false });
        } else {
          holding = true;
          send({ type: "input", move: { up: false, down: false, left: false, right: false }, aimAngle: 0, reviving: false });
        }
      }, 50);

      // Watch every incoming state for as long as the wall survives: the
      // player's HP must never drop while wallHp > 0. Also require the wall
      // to actually take damage at some point — otherwise this would pass
      // vacuously because no zombie ever engaged it.
      let violation: string | undefined;
      let wallEverDamaged = false;
      let prevHp: number | undefined;
      let prevWallHp: number | undefined;
      const seenFromIndex = conn.messages.length;

      try {
        await new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 60000;
          const check = (): void => {
            for (let i = seenFromIndex; i < conn.messages.length; i++) {
              const m = conn.messages[i];
              if (m.type !== "state") continue;
              const s = m as StateMsg;
              const self = s.players.find((p) => p.id === id);
              if (!self) continue;

              if (prevWallHp !== undefined && s.wallHp < prevWallHp) wallEverDamaged = true;

              if (s.wallHp > 0 && prevHp !== undefined && self.hp < prevHp) {
                violation = `player hp dropped ${prevHp} -> ${self.hp} while wallHp was ${s.wallHp} (wall still intact) and player was ${Math.hypot(self.x - BASE_POS.x, self.y - BASE_POS.y).toFixed(1)} units from the base (ring radius ${WALL_RING_RADIUS})`;
                return resolve();
              }
              prevHp = self.hp;
              prevWallHp = s.wallHp;

              // Stop early once the wall is gone (it did its job) or the
              // player died (nothing left to protect).
              if (s.wallHp <= 0 || self.status !== "alive") return resolve();
            }
            if (Date.now() > deadline) return reject(new Error("timed out waiting for the wall to be challenged"));
            setTimeout(check, 20);
          };
          check();
        });
      } finally {
        clearInterval(moveLoop);
      }

      expect(violation, violation).toBeUndefined();
      expect(wallEverDamaged, "the wall never took any damage — this test didn't actually exercise the bug").toBe(true);
    } finally {
      // Leave the shared app exactly as other test files expect to find it.
      send({ type: "restart" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      conn.ws.close();
    }
  },
  90000,
);
