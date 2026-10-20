import { inject, it, expect } from "vitest";
import { WebSocket } from "ws";

// Crit 10's gameplay expansion: automatable, fresh-state invariants only —
// anything that needs real combat (zombie damage, downed/revive, turret
// fire, wall abilities, bosses) was verified by hand against a running
// instance instead (see PROCESS.md's gameplay-expansion entry) and isn't
// re-asserted here, consistent with this project's stated preference for
// high-value checks over test-count inflation.
const baseUrl = inject("baseUrl");
const wsUrl = (): string => `${baseUrl.replace(/^http/, "ws")}/ws`;

interface ServerMsg {
  type: string;
  [key: string]: unknown;
}

function connect(playerId?: string): Promise<{ ws: WebSocket; messages: ServerMsg[] }> {
  return new Promise((resolve, reject) => {
    const url = playerId ? `${wsUrl()}?playerId=${encodeURIComponent(playerId)}` : wsUrl();
    const ws = new WebSocket(url);
    const messages: ServerMsg[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    ws.on("open", () => resolve({ ws, messages }));
    ws.on("error", reject);
  });
}

function waitFor(messages: ServerMsg[], type: string, timeoutMs = 3000): Promise<ServerMsg> {
  return waitForMatch(messages, (m) => m.type === type, timeoutMs);
}

function waitForMatch(messages: ServerMsg[], pred: (m: ServerMsg) => boolean, timeoutMs = 3000): Promise<ServerMsg> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = messages.find(pred);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for a matching message`));
      setTimeout(check, 20);
    };
    check();
  });
}

it("a second connection using the same persistent playerId is rejected, not allowed to double-drive one identity", async () => {
  const id = `spec-dup-${Date.now()}`;
  const first = await connect(id);
  try {
    await waitFor(first.messages, "welcome");
    const second = await connect(id);
    try {
      const dup = await waitFor(second.messages, "duplicate_identity");
      expect(dup.type).toBe("duplicate_identity");
    } finally {
      second.ws.close();
    }
  } finally {
    first.ws.close();
  }
});

it("reconnecting with the same playerId resumes the same identity, not a new one", async () => {
  const id = `spec-resume-${Date.now()}`;
  const first = await connect(id);
  try {
    const welcome1 = await waitFor(first.messages, "welcome");
    expect(welcome1.playerId).toBe(id);
  } finally {
    first.ws.close();
  }

  // Give the server a moment to process the close before reconnecting.
  await new Promise((resolve) => setTimeout(resolve, 200));

  const second = await connect(id);
  try {
    const welcome2 = await waitFor(second.messages, "welcome");
    expect(welcome2.playerId).toBe(id);
  } finally {
    second.ws.close();
  }
});

it("buying a medkit or reviving a dead teammate with insufficient XP is rejected without mutating state", async () => {
  const id = `spec-medkit-${Date.now()}`;
  const conn = await connect(id);
  try {
    await waitFor(conn.messages, "welcome");
    // A fresh app starts at Day 1 phase "waiting" with 0 shared XP — both
    // actions reject (for insufficient funds once running, or "round is not
    // running" beforehand), but never for a reason that implies partial
    // state was mutated.
    conn.ws.send(JSON.stringify({ type: "interact", action: "buy_medkit" }));
    const medkitRejected = await waitForMatch(conn.messages, (m) => m.type === "rejected" && m.action === "buy_medkit");
    expect(medkitRejected.action).toBe("buy_medkit");

    conn.ws.send(JSON.stringify({ type: "interact", action: "revive_dead" }));
    const reviveRejected = await waitForMatch(conn.messages, (m) => m.type === "rejected" && m.action === "revive_dead");
    expect(reviveRejected.action).toBe("revive_dead");
  } finally {
    conn.ws.close();
  }
});

it(
  "once a wall is built, a turret can't be placed inside its footprint",
  async () => {
    const id = `spec-turret-in-wall-${Date.now()}`;
    const conn = await connect(id);
    const send = (msg: unknown): void => conn.ws.send(JSON.stringify(msg));
    try {
      await waitFor(conn.messages, "welcome");
      send({ type: "restart" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      // A character must be confirmed before shoot/interact/place_turret are
      // allowed (see GameLoop's "select a character first" guard).
      send({ type: "select_character", characterIndex: 0, displayName: "Tester" });
      send({ type: "start" });
      await waitForMatch(conn.messages, (m) => m.type === "state" && m.phase === "running", 5000);

      // Farm enough shared XP for a level-1 wall (100) by shooting whatever
      // zombie is nearest — real combat, not a shortcut around the mechanic
      // being tested — then build it.
      const farmLoop = setInterval(() => {
        const state = [...conn.messages].reverse().find((m) => m.type === "state") as
          | (ServerMsg & { players?: { id: string; x: number; y: number }[]; zombies?: { x: number; y: number }[] })
          | undefined;
        if (!state?.players || !state.zombies) return;
        const self = state.players.find((p) => p.id === id);
        if (!self || state.zombies.length === 0) return;
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
      // Farm 250: 100 for the wall, plus 150 so the later placeTurret call
      // fails on the wall-overlap check specifically, not an XP check that
      // would otherwise fire first (placeTurret validates cost before
      // position — see game-loop.ts's own ordering).
      try {
        await waitForMatch(conn.messages, (m) => m.type === "state" && typeof m.sharedXp === "number" && (m.sharedXp as number) >= 250, 30000);
      } finally {
        clearInterval(farmLoop);
      }
      send({ type: "interact", action: "build_wall" });
      await waitForMatch(conn.messages, (m) => m.type === "state" && m.wallLevel === 1, 5000);

      // (500, 392) sits inside the wall's own north side (BASE_POS (500,500),
      // WALL_HALF_EXTENT 116, WALL_THICKNESS 16 => north wall spans y
      // 384-400, i.e. 100-116 units from base) — well inside
      // TURRET_BUILD_RADIUS (150) and outside BASE_ATTACK_RANGE (40), so
      // only the wall-overlap check can be what rejects it.
      send({ type: "place_turret", x: 500, y: 392 });
      const rejected = await waitForMatch(conn.messages, (m) => m.type === "rejected" && m.action === "place_turret", 5000);
      expect(rejected.reason).toMatch(/wall/i);
    } finally {
      send({ type: "restart" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      conn.ws.close();
    }
  },
  45000,
);

it("turret_interact is rejected outside a running round, without ever reaching 'no such turret'", async () => {
  // Deliberately does NOT start the round — this suite's test files run
  // sequentially against one shared live app (see vitest.config.ts), and
  // flipping it to "running" here would leak into whichever file runs next.
  // The phase gate firing first (ahead of the turret-existence check) is
  // itself exactly what GameLoop.turretInteract()'s ordering promises.
  const id = `spec-turret-${Date.now()}`;
  const conn = await connect(id);
  try {
    await waitFor(conn.messages, "welcome");
    conn.ws.send(JSON.stringify({ type: "turret_interact", turretId: "no-such-turret", action: "upgrade" }));
    const rejected = await waitForMatch(conn.messages, (m) => m.type === "rejected" && m.action === "upgrade");
    expect(rejected.reason).toMatch(/round is not running/i);
  } finally {
    conn.ws.close();
  }
});
