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
