import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { BASE_MAX_HP } from "./game-state.ts";

// The only thing this project persists this week: current day, base HP/level
// and shared XP. Everything else (player position, zombie positions) stays
// in memory and is rebuilt on restart — see PersistedState below for why.
export interface Progress {
  day: number;
  baseHp: number;
  baseMaxHp: number;
  baseLevel: number;
  sharedXp: number;
}

// Exported so GameLoop.restart() resets to exactly this, rather than a second
// hand-copied set of numbers that could drift from the real defaults.
export const DEFAULT_PROGRESS: Progress = {
  day: 1,
  baseHp: BASE_MAX_HP,
  baseMaxHp: BASE_MAX_HP,
  baseLevel: 0,
  sharedXp: 0,
};

interface GameStateRow {
  current_day: number;
  base_hp: number;
  base_max_hp: number;
  base_level: number;
  shared_xp: number;
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
      updated_at TEXT NOT NULL
    )
  `);

  const existing = db.prepare("SELECT 1 FROM game_state WHERE id = 1").get();
  if (!existing) {
    db.prepare(
      `INSERT INTO game_state (id, current_day, base_hp, base_max_hp, base_level, shared_xp, updated_at)
       VALUES (1, @day, @baseHp, @baseMaxHp, @baseLevel, @sharedXp, @updatedAt)`,
    ).run({ ...DEFAULT_PROGRESS, updatedAt: new Date().toISOString() });
  }

  return db;
}

export function loadState(db: Database.Database): Progress {
  const row = db
    .prepare(
      "SELECT current_day, base_hp, base_max_hp, base_level, shared_xp FROM game_state WHERE id = 1",
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
  };
}

export function saveState(db: Database.Database, state: Progress): void {
  db.prepare(
    `UPDATE game_state
     SET current_day = @day, base_hp = @baseHp, base_max_hp = @baseMaxHp,
         base_level = @baseLevel, shared_xp = @sharedXp, updated_at = @updatedAt
     WHERE id = 1`,
  ).run({ ...state, updatedAt: new Date().toISOString() });
}
