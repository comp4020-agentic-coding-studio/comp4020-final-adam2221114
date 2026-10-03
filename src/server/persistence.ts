import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { BASE_MAX_HP } from "./game-state.ts";

// What this project persists: current day, base HP, shared XP, and the
// defensive buildings' own level/HP. baseLevel is gone — the old "100 XP
// auto-builds a wall" mechanic it existed for is cancelled this round; XP is
// now just a spendable resource, and the interact menu (GameLoop.interact())
// is the only thing that changes wallLevel/turretBuilt. Player position and
// zombie positions, and anything about the turret's current target, stay in
// memory and are rebuilt on restart — see PersistedState for why.
export interface Progress {
  day: number;
  baseHp: number;
  baseMaxHp: number;
  sharedXp: number;
  wallLevel: number; // 0 = no wall
  wallHp: number;
  wallMaxHp: number;
  turretLevel: number; // no "level 0" for the turret — turretBuilt is the exists/doesn't flag
  turretHp: number;
  turretMaxHp: number;
  turretBuilt: boolean;
  turretX: number; // player-chosen placement (GameLoop.placeTurret) — meaningless while !turretBuilt
  turretY: number;
}

// Exported so GameLoop.restart() resets to exactly this, rather than a second
// hand-copied set of numbers that could drift from the real defaults.
export const DEFAULT_PROGRESS: Progress = {
  day: 1,
  baseHp: BASE_MAX_HP,
  baseMaxHp: BASE_MAX_HP,
  sharedXp: 0,
  wallLevel: 0,
  wallHp: 0,
  wallMaxHp: 0,
  turretLevel: 1,
  turretHp: 0,
  turretMaxHp: 0,
  turretBuilt: false,
  turretX: 0,
  turretY: 0,
};

interface GameStateRow {
  current_day: number;
  base_hp: number;
  base_max_hp: number;
  shared_xp: number;
  wall_level: number;
  wall_hp: number;
  wall_max_hp: number;
  turret_level: number;
  turret_hp: number;
  turret_max_hp: number;
  turret_built: number; // SQLite has no boolean type; 0/1
  turret_x: number;
  turret_y: number;
}

export function defaultDataDir(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), "data");
}

// Columns a pre-existing data/game.db might be missing, each with the DDL to
// add it — CREATE TABLE IF NOT EXISTS doesn't add columns to an
// already-existing table, so a database from an earlier week needs these
// added by hand. Defaults here match DEFAULT_PROGRESS.
const MIGRATIONS: Array<{ column: string; ddl: string }> = [
  { column: "wall_hp", ddl: "ALTER TABLE game_state ADD COLUMN wall_hp INTEGER NOT NULL DEFAULT 0" },
  { column: "wall_max_hp", ddl: "ALTER TABLE game_state ADD COLUMN wall_max_hp INTEGER NOT NULL DEFAULT 0" },
  { column: "wall_level", ddl: "ALTER TABLE game_state ADD COLUMN wall_level INTEGER NOT NULL DEFAULT 0" },
  { column: "turret_level", ddl: "ALTER TABLE game_state ADD COLUMN turret_level INTEGER NOT NULL DEFAULT 1" },
  { column: "turret_hp", ddl: "ALTER TABLE game_state ADD COLUMN turret_hp INTEGER NOT NULL DEFAULT 0" },
  { column: "turret_max_hp", ddl: "ALTER TABLE game_state ADD COLUMN turret_max_hp INTEGER NOT NULL DEFAULT 0" },
  { column: "turret_built", ddl: "ALTER TABLE game_state ADD COLUMN turret_built INTEGER NOT NULL DEFAULT 0" },
  { column: "turret_x", ddl: "ALTER TABLE game_state ADD COLUMN turret_x REAL NOT NULL DEFAULT 0" },
  { column: "turret_y", ddl: "ALTER TABLE game_state ADD COLUMN turret_y REAL NOT NULL DEFAULT 0" },
];

// One table, one row (id = 1). Crit 9's players and crit 10's event log are
// separate tables added when those weeks actually need them — not now.
export function openDatabase(dir: string = defaultDataDir()): Database.Database {
  mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "game.db"));
  db.pragma("journal_mode = WAL");
  // Fresh installs get the current schema directly — base_level never
  // existed here; nothing needs to drop it later.
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_state (
      id INTEGER PRIMARY KEY,
      current_day INTEGER NOT NULL,
      base_hp INTEGER NOT NULL,
      base_max_hp INTEGER NOT NULL,
      shared_xp INTEGER NOT NULL,
      wall_level INTEGER NOT NULL DEFAULT 0,
      wall_hp INTEGER NOT NULL DEFAULT 0,
      wall_max_hp INTEGER NOT NULL DEFAULT 0,
      turret_level INTEGER NOT NULL DEFAULT 1,
      turret_hp INTEGER NOT NULL DEFAULT 0,
      turret_max_hp INTEGER NOT NULL DEFAULT 0,
      turret_built INTEGER NOT NULL DEFAULT 0,
      turret_x REAL NOT NULL DEFAULT 0,
      turret_y REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `);

  // An older data/game.db might still have base_level (from the week that
  // mechanic existed) — it's simply never read or written again, left alone
  // rather than risking a DROP COLUMN. Only ADD what's missing.
  const columns = db.prepare("PRAGMA table_info(game_state)").all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((c) => c.name));
  for (const migration of MIGRATIONS) {
    if (!columnNames.has(migration.column)) db.exec(migration.ddl);
  }

  const existing = db.prepare("SELECT 1 FROM game_state WHERE id = 1").get();
  if (!existing) {
    db.prepare(
      `INSERT INTO game_state (
         id, current_day, base_hp, base_max_hp, shared_xp,
         wall_level, wall_hp, wall_max_hp,
         turret_level, turret_hp, turret_max_hp, turret_built, turret_x, turret_y,
         updated_at
       )
       VALUES (
         1, @day, @baseHp, @baseMaxHp, @sharedXp,
         @wallLevel, @wallHp, @wallMaxHp,
         @turretLevel, @turretHp, @turretMaxHp, @turretBuilt, @turretX, @turretY,
         @updatedAt
       )`,
    ).run({
      ...DEFAULT_PROGRESS,
      turretBuilt: DEFAULT_PROGRESS.turretBuilt ? 1 : 0,
      updatedAt: new Date().toISOString(),
    });
  }

  return db;
}

export function loadState(db: Database.Database): Progress {
  const row = db
    .prepare(
      `SELECT current_day, base_hp, base_max_hp, shared_xp,
              wall_level, wall_hp, wall_max_hp,
              turret_level, turret_hp, turret_max_hp, turret_built, turret_x, turret_y
       FROM game_state WHERE id = 1`,
    )
    .get() as GameStateRow | undefined;
  if (!row) {
    throw new Error("game_state row missing — openDatabase should have inserted the default row");
  }
  return {
    day: row.current_day,
    baseHp: row.base_hp,
    baseMaxHp: row.base_max_hp,
    sharedXp: row.shared_xp,
    wallLevel: row.wall_level,
    wallHp: row.wall_hp,
    wallMaxHp: row.wall_max_hp,
    turretLevel: row.turret_level,
    turretHp: row.turret_hp,
    turretMaxHp: row.turret_max_hp,
    turretBuilt: row.turret_built === 1,
    turretX: row.turret_x,
    turretY: row.turret_y,
  };
}

export function saveState(db: Database.Database, state: Progress): void {
  db.prepare(
    `UPDATE game_state
     SET current_day = @day, base_hp = @baseHp, base_max_hp = @baseMaxHp, shared_xp = @sharedXp,
         wall_level = @wallLevel, wall_hp = @wallHp, wall_max_hp = @wallMaxHp,
         turret_level = @turretLevel, turret_hp = @turretHp, turret_max_hp = @turretMaxHp,
         turret_built = @turretBuilt, turret_x = @turretX, turret_y = @turretY, updated_at = @updatedAt
     WHERE id = 1`,
  ).run({
    ...state,
    turretBuilt: state.turretBuilt ? 1 : 0,
    updatedAt: new Date().toISOString(),
  });
}
