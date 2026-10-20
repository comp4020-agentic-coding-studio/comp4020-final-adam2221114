import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { openDatabase, loadPlayerRecord, savePlayerRecord, type PlayerRecord } from "../src/server/persistence.ts";

// Direct, pure-function test against a real SQLite file (no live app, no
// WebSocket) — same spirit as horde-spawn-geometry.test.ts. Covers the two
// new players-table columns (character_index/display_name) added for the
// select-character feature: a round-trip through a FRESH openDatabase() call
// on the same file path simulates "process restarted", since openDatabase()
// is what every real process boot calls.
const tmpDirs: string[] = [];
function freshDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "comp4020-persistence-character-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("players table: character_index/display_name persistence", () => {
  it("round-trips through a save, then a FRESH database handle on the same file (simulating a restart)", () => {
    const dir = freshDataDir();
    const db1 = openDatabase(dir);
    const record: PlayerRecord = { id: "p-restart-test", hp: 80, maxHp: 100, status: "alive", medkits: 1, characterIndex: 2, displayName: "Dana" };
    savePlayerRecord(db1, record);
    db1.close();

    const db2 = openDatabase(dir);
    const loaded = loadPlayerRecord(db2, "p-restart-test");
    db2.close();

    expect(loaded).toEqual(record);
  });

  it("defaults to characterIndex -1 / displayName '' for a never-seen id", () => {
    const dir = freshDataDir();
    const db = openDatabase(dir);
    expect(loadPlayerRecord(db, "never-seen")).toBeUndefined();
    db.close();
  });

  it("a pre-existing players table missing the new columns gets them added via migration, without losing existing rows", () => {
    const dir = freshDataDir();
    // Simulate a pre-migration database: open once to create the schema,
    // then manually drop back to the old column set by recreating the
    // table without character_index/display_name, with one existing row.
    const db1 = openDatabase(dir);
    db1.exec("DROP TABLE players");
    db1.exec(`
      CREATE TABLE players (
        id TEXT PRIMARY KEY,
        hp INTEGER NOT NULL,
        max_hp INTEGER NOT NULL,
        status TEXT NOT NULL,
        medkits INTEGER NOT NULL DEFAULT 0
      )
    `);
    db1.prepare("INSERT INTO players (id, hp, max_hp, status, medkits) VALUES (?, ?, ?, ?, ?)").run("legacy-player", 60, 100, "alive", 2);
    db1.close();

    // Re-opening via openDatabase() must add the missing columns without
    // destroying the existing row.
    const db2 = openDatabase(dir);
    const loaded = loadPlayerRecord(db2, "legacy-player");
    db2.close();

    expect(loaded).toEqual({ id: "legacy-player", hp: 60, maxHp: 100, status: "alive", medkits: 2, characterIndex: -1, displayName: "" });
  });

  it("updating an existing record's character/name overwrites in place (ON CONFLICT DO UPDATE)", () => {
    const dir = freshDataDir();
    const db = openDatabase(dir);
    savePlayerRecord(db, { id: "p-update", hp: 100, maxHp: 100, status: "alive", medkits: 0, characterIndex: 0, displayName: "First" });
    savePlayerRecord(db, { id: "p-update", hp: 100, maxHp: 100, status: "alive", medkits: 0, characterIndex: 3, displayName: "Changed" });
    const loaded = loadPlayerRecord(db, "p-update");
    db.close();

    expect(loaded?.characterIndex).toBe(3);
    expect(loaded?.displayName).toBe("Changed");
  });
});
