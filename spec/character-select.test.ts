import { inject, it, expect } from "vitest";
import { WebSocket } from "ws";

// The select-character overlay (shown while a player's characterIndex is
// -1): one of 4 character slots, taken by whichever CURRENTLY CONNECTED
// player already has it (never by a disconnected identity's old persisted
// record — see game-loop.ts's selectCharacter(), which only checks
// this.#players, the live connection map), plus a free-text display name.
const baseUrl = inject("baseUrl");
const wsUrl = (): string => `${baseUrl.replace(/^http/, "ws")}/ws`;

interface ServerMsg {
  type: string;
  [key: string]: unknown;
}

interface PlayerSnap {
  id: string;
  characterIndex: number;
  displayName: string;
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
      if (Date.now() - start > timeoutMs) return reject(new Error("timeout waiting for a matching message"));
      setTimeout(check, 20);
    };
    check();
  });
}

function findSelf(state: ServerMsg, id: string): PlayerSnap | undefined {
  return (state.players as PlayerSnap[] | undefined)?.find((p) => p.id === id);
}

it("selecting an already-taken, currently-connected slot is rejected; a different slot then succeeds", async () => {
  const a = await connect(`spec-charsel-a-${Date.now()}`);
  const b = await connect(`spec-charsel-b-${Date.now()}`);
  try {
    await waitFor(a.messages, "welcome");
    await waitFor(b.messages, "welcome");

    // A broadcast happens every 50ms; 150ms is comfortably past the next
    // one, so A's pick is guaranteed visible before B's conflicting attempt.
    a.ws.send(JSON.stringify({ type: "select_character", characterIndex: 0, displayName: "Alpha" }));
    await new Promise((resolve) => setTimeout(resolve, 150));

    b.ws.send(JSON.stringify({ type: "select_character", characterIndex: 0, displayName: "Bravo" }));
    const rejected = await waitForMatch(b.messages, (m) => m.type === "rejected" && m.action === "select_character", 3000);
    expect(rejected.reason).toMatch(/already taken/i);

    b.ws.send(JSON.stringify({ type: "select_character", characterIndex: 1, displayName: "Bravo" }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const state = b.messages.filter((m) => m.type === "state").at(-1);
    expect(state, "no state broadcast received").toBeDefined();
    const bId = (b.messages.find((m) => m.type === "welcome")?.playerId as string) ?? "";
    const bSelf = findSelf(state!, bId);
    expect(bSelf?.characterIndex).toBe(1);
    expect(bSelf?.displayName).toBe("Bravo");
  } finally {
    a.ws.close();
    b.ws.close();
  }
});

it("a slot frees immediately on disconnect — a different identity can take it right away", async () => {
  const a = await connect(`spec-charsel-free-a-${Date.now()}`);
  try {
    await waitFor(a.messages, "welcome");
    a.ws.send(JSON.stringify({ type: "select_character", characterIndex: 2, displayName: "Gone" }));
    await new Promise((resolve) => setTimeout(resolve, 150));
  } finally {
    a.ws.close();
  }

  // Give the server a moment to process the close.
  await new Promise((resolve) => setTimeout(resolve, 200));

  const b = await connect(`spec-charsel-free-b-${Date.now()}`);
  try {
    await waitFor(b.messages, "welcome");
    b.ws.send(JSON.stringify({ type: "select_character", characterIndex: 2, displayName: "Replacement" }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const state = b.messages.filter((m) => m.type === "state").at(-1);
    const bIdWelcome = b.messages.find((m) => m.type === "welcome");
    const bId = bIdWelcome?.playerId as string;
    const bSelf = findSelf(state!, bId);
    expect(bSelf?.characterIndex, "slot 2 should have been free immediately after A disconnected").toBe(2);
  } finally {
    b.ws.close();
  }
});

it("reconnecting with the same playerId resumes the chosen character/name automatically", async () => {
  const id = `spec-charsel-resume-${Date.now()}`;
  const first = await connect(id);
  try {
    await waitFor(first.messages, "welcome");
    first.ws.send(JSON.stringify({ type: "select_character", characterIndex: 3, displayName: "Dana" }));
    await new Promise((resolve) => setTimeout(resolve, 150));
  } finally {
    first.ws.close();
  }

  await new Promise((resolve) => setTimeout(resolve, 200));

  const second = await connect(id);
  try {
    const state = await waitFor(second.messages, "state");
    const self = findSelf(state, id);
    expect(self?.characterIndex, "character should resume without resending select_character").toBe(3);
    expect(self?.displayName).toBe("Dana");
  } finally {
    second.ws.close();
  }
});

it("empty or oversized display names are rejected without mutating state", async () => {
  const id = `spec-charsel-name-${Date.now()}`;
  const conn = await connect(id);
  try {
    await waitFor(conn.messages, "welcome");

    conn.ws.send(JSON.stringify({ type: "select_character", characterIndex: 0, displayName: "   " }));
    const emptyRejected = await waitForMatch(conn.messages, (m) => m.type === "rejected" && m.action === "select_character", 3000);
    expect(emptyRejected.reason).toMatch(/empty/i);

    conn.ws.send(JSON.stringify({ type: "select_character", characterIndex: 0, displayName: "x".repeat(50) }));
    const longRejected = await waitForMatch(
      conn.messages,
      (m) => m.type === "rejected" && m.action === "select_character" && m.reason !== emptyRejected.reason,
      3000,
    );
    expect(longRejected.reason).toMatch(/at most/i);

    // A valid follow-up succeeds — the two rejected attempts left no
    // corrupted state (e.g. a partially-set characterIndex) behind.
    conn.ws.send(JSON.stringify({ type: "select_character", characterIndex: 0, displayName: "Valid Name" }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const state = conn.messages.filter((m) => m.type === "state").at(-1);
    const self = findSelf(state!, id);
    expect(self?.characterIndex).toBe(0);
    expect(self?.displayName).toBe("Valid Name");
  } finally {
    conn.ws.close();
  }
});

it("two connections racing to pick the same slot resolve one-wins/one-rejected", async () => {
  const a = await connect(`spec-charsel-race-a-${Date.now()}`);
  const b = await connect(`spec-charsel-race-b-${Date.now()}`);
  try {
    await waitFor(a.messages, "welcome");
    await waitFor(b.messages, "welcome");

    a.ws.send(JSON.stringify({ type: "select_character", characterIndex: 1, displayName: "RaceA" }));
    b.ws.send(JSON.stringify({ type: "select_character", characterIndex: 1, displayName: "RaceB" }));

    await new Promise((resolve) => setTimeout(resolve, 150));

    const aRejected = a.messages.find((m) => m.type === "rejected" && m.action === "select_character");
    const bRejected = b.messages.find((m) => m.type === "rejected" && m.action === "select_character");
    // Exactly one of the two was rejected — the server's single-threaded
    // per-message processing means whichever arrives second sees the
    // first's already-applied pick and loses the race deterministically.
    expect([aRejected, bRejected].filter(Boolean)).toHaveLength(1);
  } finally {
    a.ws.close();
    b.ws.close();
  }
});

it("an unconfirmed player (never sent select_character) is rejected from gameplay actions even while running", async () => {
  const confirmed = await connect(`spec-charsel-unconf-confirmed-${Date.now()}`);
  const unconfirmed = await connect(`spec-charsel-unconf-${Date.now()}`);
  const send = (conn: { ws: WebSocket }, msg: unknown): void => conn.ws.send(JSON.stringify(msg));
  try {
    await waitFor(confirmed.messages, "welcome");
    await waitFor(unconfirmed.messages, "welcome");

    send(confirmed, { type: "restart" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    send(confirmed, { type: "select_character", characterIndex: 0, displayName: "Confirmed" });
    send(confirmed, { type: "start" });
    await waitForMatch(confirmed.messages, (m) => m.type === "state" && m.phase === "running", 5000);

    send(unconfirmed, { type: "interact", action: "buy_medkit" });
    const rejected = await waitForMatch(unconfirmed.messages, (m) => m.type === "rejected" && m.action === "buy_medkit", 3000);
    expect(rejected.reason).toMatch(/select a character/i);
  } finally {
    send(confirmed, { type: "restart" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    confirmed.ws.close();
    unconfirmed.ws.close();
  }
});
