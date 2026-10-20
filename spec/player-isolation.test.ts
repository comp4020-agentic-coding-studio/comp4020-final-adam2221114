import { inject, it, expect } from "vitest";
import { WebSocket } from "ws";

// Crit 10's core multiplayer security property: a connection's identity
// comes ONLY from the WebSocket it arrived on (ws-server.ts's own `id`,
// bound once at connection time from the playerId query param — see
// extractPlayerId — and closed over for every message that socket ever
// sends), never from anything inside a message's own JSON body. Every
// GameLoop method that mutates a player (selectCharacter, useMedkit,
// interact, placeTurret, turretInteract, shoot) takes that closed-over `id`
// as its own first argument; none of them read an id/playerId/targetId
// field out of the parsed message (grep src/server/ws-server.ts for
// `msg.id`/`msg.playerId`/`msg.targetId` — there are none). This suite
// proves that in both directions: a forged id field (a) does not redirect
// who gets mutated, and (b) leaves the real player with that id completely
// untouched, byte-for-byte.
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
  hp: number;
  maxHp: number;
  status: string;
  medkits: number;
}

function connect(playerId: string): Promise<{ ws: WebSocket; messages: ServerMsg[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl()}?playerId=${encodeURIComponent(playerId)}`);
    const messages: ServerMsg[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    ws.on("open", () => resolve({ ws, messages }));
    ws.on("error", reject);
  });
}

function waitFor(messages: ServerMsg[], type: string, timeoutMs = 3000): Promise<ServerMsg> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = messages.find((m) => m.type === type);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for "${type}"`));
      setTimeout(check, 20);
    };
    check();
  });
}

function latestState(messages: ServerMsg[]): ServerMsg | undefined {
  return messages.filter((m) => m.type === "state").at(-1);
}

function findSelf(state: ServerMsg | undefined, id: string): PlayerSnap | undefined {
  return (state?.players as PlayerSnap[] | undefined)?.find((p) => p.id === id);
}

it("a select_character message carrying a forged id/playerId field mutates the SENDER's own record, not the forged target's", async () => {
  const idA = `spec-isolation-a-${Date.now()}`;
  const idB = `spec-isolation-b-${Date.now()}`;
  const a = await connect(idA);
  const b = await connect(idB);
  try {
    await waitFor(a.messages, "welcome");
    await waitFor(b.messages, "welcome");

    // Neither has picked a character yet. A sends a pick for itself but
    // labels the message body with B's id, as if trying to redirect the
    // mutation onto B instead of itself.
    a.ws.send(JSON.stringify({ type: "select_character", characterIndex: 2, displayName: "Hacked", id: idB, playerId: idB }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const state = latestState([...a.messages, ...b.messages]);
    const aSelf = findSelf(state, idA);
    const bSelf = findSelf(state, idB);

    // The connection that sent the message (A) is the one actually
    // mutated — the forged id field had no effect on who the request was
    // attributed to.
    expect(aSelf?.characterIndex, "the sender's own pick should have applied").toBe(2);
    expect(aSelf?.displayName).toBe("Hacked");

    // B, the forged target, is completely untouched.
    expect(bSelf?.characterIndex, "a forged id must not let A mutate B's character choice").toBe(-1);
    expect(bSelf?.displayName).toBe("");
  } finally {
    a.ws.close();
    b.ws.close();
  }
});

it("use_medkit and interact messages carrying another player's id never mutate that player's hp/medkits/status", async () => {
  const idA = `spec-isolation-med-a-${Date.now()}`;
  const idB = `spec-isolation-med-b-${Date.now()}`;
  const a = await connect(idA);
  const b = await connect(idB);
  try {
    await waitFor(a.messages, "welcome");
    await waitFor(b.messages, "welcome");

    a.ws.send(JSON.stringify({ type: "select_character", characterIndex: 0, displayName: "A" }));
    b.ws.send(JSON.stringify({ type: "select_character", characterIndex: 1, displayName: "B" }));
    await new Promise((resolve) => setTimeout(resolve, 150));

    const before = findSelf(latestState(b.messages), idB);
    expect(before, "B should be present in state before the attack").toBeDefined();

    // A sends a batch of state-mutating requests, each carrying B's id in
    // every plausible field name an attacker might guess the server reads
    // identity from.
    const forgedAttempts = [
      { type: "use_medkit", id: idB, playerId: idB, targetId: idB },
      { type: "interact", action: "buy_medkit", id: idB, playerId: idB },
      { type: "interact", action: "revive_dead", id: idB, playerId: idB },
      { type: "shoot", id: idB, playerId: idB },
    ];
    for (const msg of forgedAttempts) a.ws.send(JSON.stringify(msg));
    await new Promise((resolve) => setTimeout(resolve, 300));

    const after = findSelf(latestState(b.messages), idB);
    expect(after, "B should still be present in state after A's forged-id attempts").toBeDefined();
    expect(after).toEqual(before);
  } finally {
    a.ws.close();
    b.ws.close();
  }
});
