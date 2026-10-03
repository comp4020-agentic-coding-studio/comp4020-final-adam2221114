import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { BASE_MAX_HP, WALL_MAX_HP } from "./game-state.ts";

// What this project persists: current day, base HP/level, shared XP, and
// (new this round) wall HP — the wall is real combat state now, not just a
// cosmetic flag, so it belongs here alongside base HP. Everything else
// (player position, zombie positions) stays in memory and is rebuilt on
// restart — see PersistedState below for why.
export interface Progress {
  day: number;
  baseHp: number;
  baseMaxHp: number;
  baseLevel: number;
  sharedXp: number;
  wallHp: number;
  wallMaxHp: number;
}

// Exported so GameLoop.restart() resets to exactly this, rather than a second
// hand-copied set of numbers that could drift from the real defaults.
// wallHp starts at 0 — baseLevel starts at 0 too, and the wall doesn't exist
// until baseLevel reaches 1 (GameLoop's awardXp sets wallHp to wallMaxHp the
// moment that happens).
export const DEFAULT_PROGRESS: Progress = {
  day: 1,
  baseHp: BASE_MAX_HP,
  baseMaxHp: BASE_MAX_HP,
  baseLevel: 0,
  sharedXp: 0,
  wallHp: 0,
  wallMaxHp: WALL_MAX_HP,
};

interface GameStateRow {
  current_day: number;
  base_hp: number;
  base_max_hp: number;
  base_level: number;
  shared_xp: number;
  wall_hp: number;
  wall_max_hp: number;
}

export function defaultDataDir(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), "data");
}

// One table, one row (id = 1). Crit 9's players and crit 10's event log are
// separate tables added when those weeks actually need them — not now.
export function openDatabase(dir: string = defaultDataDir()): Database.Database {
  mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "game.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_state (
      id INTEGER PRIMARY KEY,
      current_day INTEGER NOT NULL,
      base_hp INTEGER NOT NULL,
      base_max_hp INTEGER NOT NULL,
      base_level INTEGER NOT NULL,
      shared_xp INTEGER NOT NULL,
      wall_hp INTEGER NOT NULL DEFAULT 0,
      wall_max_hp INTEGER NOT NULL DEFAULT ${WALL_MAX_HP},
      updated_at TEXT NOT NULL
    )
  `);

  // Migration for a data/game.db from before wall_hp existed — CREATE TABLE
  // IF NOT EXISTS doesn't add columns to an already-existing table.
  const columns = db.prepare("PRAGMA table_info(game_state)").all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((c) => c.name));
  if (!columnNames.has("wall_hp")) {
    db.exec("ALTER TABLE game_state ADD COLUMN wall_hp INTEGER NOT NULL DEFAULT 0");
  }
  if (!columnNames.has("wall_max_hp")) {
    db.exec(`ALTER TABLE game_state ADD COLUMN wall_max_hp INTEGER NOT NULL DEFAULT ${WALL_MAX_HP}`);
  }

  const existing = db.prepare("SELECT 1 FROM game_state WHERE id = 1").get();
  if (!existing) {
    db.prepare(
      `INSERT INTO game_state (id, current_day, base_hp, base_max_hp, base_level, shared_xp, wall_hp, wall_max_hp, updated_at)
       VALUES (1, @day, @baseHp, @baseMaxHp, @baseLevel, @sharedXp, @wallHp, @wallMaxHp, @updatedAt)`,
    ).run({ ...DEFAULT_PROGRESS, updatedAt: new Date().toISOString() });
  }

  return db;
}

export function loadState(db: Database.Database): Progress {
  const row = db
    .prepare(
      "SELECT current_day, base_hp, base_max_hp, base_level, shared_xp, wall_hp, wall_max_hp FROM game_state WHERE id = 1",
    )
    .get() as GameStateRow | undefined;
  if (!row) {
    throw new Error("game_state row missing — openDatabase should have inserted the default row");
  }
  return {
    day: row.current_day,
    baseHp: row.base_hp,
    baseMaxHp: row.base_max_hp,
    baseLevel: row.base_level,
    sharedXp: row.shared_xp,
    wallHp: row.wall_hp,
    wallMaxHp: row.wall_max_hp,
  };
}

export function saveState(db: Database.Database, state: Progress): void {
  db.prepare(
    `UPDATE game_state
     SET current_day = @day, base_hp = @baseHp, base_max_hp = @baseMaxHp,
         base_level = @baseLevel, shared_xp = @sharedXp,
         wall_hp = @wallHp, wall_max_hp = @wallMaxHp, updated_at = @updatedAt
     WHERE id = 1`,
  ).run({ ...state, updatedAt: new Date().toISOString() });
}
