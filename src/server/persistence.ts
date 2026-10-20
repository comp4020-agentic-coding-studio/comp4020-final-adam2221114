import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { BASE_MAX_HP } from "./game-state.ts";
import type { GamePhase } from "./protocol.ts";

// What this project persists: current day, base HP, shared XP, the wall's
// level/HP, every turret's own independent record, and — new for Crit 10 —
// every known player's durable identity (hp/status/medkits/colour), keyed by
// the browser-persistent id the client supplies on connect. Live positions,
// zombies, turret fire-cooldowns/targets, and downed/invulnerability/healing
// TIMERS stay in memory only and are rebuilt on restart — see PersistedState
// and GameLoop for why (CLAUDE.md's persistence rules already exclude
// per-frame/transient state; a restored "downed" player gets a fresh 45s
// timer rather than trying to resume a wall-clock across a process restart
// whose own monotonic clock resets to 0 — the same STARTUP_PHASE spirit
// GameLoop already applies to "running").
export interface Progress {
  day: number;
  baseHp: number;
  baseMaxHp: number;
  sharedXp: number;
  wallLevel: number; // 0 = no wall
  wallHp: number;
  wallMaxHp: number;
  turrets: TurretRecord[];
  phase: GamePhase;
}

export interface TurretRecord {
  id: string;
  level: number;
  hp: number;
  maxHp: number;
  x: number;
  y: number;
}

// colorIndex is deliberately NOT part of this record — it's a per-connection
// rendering convenience (which of 4 colours to draw someone in), reassigned
// fresh from whoever is CURRENTLY connected each time, same as Crit 9.
// Persisting it against identity would wrongly exhaust the 4 colour slots
// across everyone who's ever played, not just who's online at once.
//
// characterIndex/displayName are the opposite case, deliberately: a
// player's own durable CHOICE of which character sheet and name to use,
// made once via the select-character overlay and meant to survive
// reconnects — unlike colorIndex, nothing about this needs to be re-derived
// fresh from who's currently connected. -1/"" means "never chosen yet" (a
// brand new identity, or one that disconnected before confirming).
export interface PlayerRecord {
  id: string;
  hp: number;
  maxHp: number;
  status: "alive" | "downed" | "dead";
  medkits: number;
  characterIndex: number;
  displayName: string;
}

export const DEFAULT_PROGRESS: Progress = {
  day: 1,
  baseHp: BASE_MAX_HP,
  baseMaxHp: BASE_MAX_HP,
  sharedXp: 0,
  wallLevel: 0,
  wallHp: 0,
  wallMaxHp: 0,
  turrets: [],
  phase: "waiting",
};

interface GameStateRow {
  current_day: number;
  base_hp: number;
  base_max_hp: number;
  shared_xp: number;
  wall_level: number;
  wall_hp: number;
  wall_max_hp: number;
  phase: string;
  // Legacy Crit-9 single-turret columns — read once, at migration time, by
  // the one-turret-table seeding step in openDatabase(). Never written again.
  turret_level: number;
  turret_hp: number;
  turret_max_hp: number;
  turret_built: number;
  turret_x: number;
  turret_y: number;
}

interface TurretRow {
  id: string;
  level: number;
  hp: number;
  max_hp: number;
  x: number;
  y: number;
}

interface PlayerRow {
  id: string;
  hp: number;
  max_hp: number;
  status: string;
  medkits: number;
  character_index: number;
  display_name: string;
}

export function defaultDataDir(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), "data");
}

// Columns a pre-existing data/game.db might be missing on the single-row
// game_state table, each with the DDL to add it.
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
  { column: "phase", ddl: "ALTER TABLE game_state ADD COLUMN phase TEXT NOT NULL DEFAULT 'waiting'" },
];

// Crit 10: the single-turret scalar columns above are superseded by a real
// `turrets` table (one row per turret — up to MAX_TURRETS, each with its own
// id/level/hp/position), and a `players` table for durable per-identity state
// (hp/status/medkits/colour — never position, never timers; see the file
// comment). Both are created alongside game_state, never replacing it.
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
      phase TEXT NOT NULL DEFAULT 'waiting',
      updated_at TEXT NOT NULL
    )
  `);

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
         phase, updated_at
       )
       VALUES (
         1, @day, @baseHp, @baseMaxHp, @sharedXp,
         @wallLevel, @wallHp, @wallMaxHp,
         1, 0, 0, 0, 0, 0,
         @phase, @updatedAt
       )`,
    ).run({ ...DEFAULT_PROGRESS, updatedAt: new Date().toISOString() });
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS turrets (
      id TEXT PRIMARY KEY,
      level INTEGER NOT NULL,
      hp INTEGER NOT NULL,
      max_hp INTEGER NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      hp INTEGER NOT NULL,
      max_hp INTEGER NOT NULL,
      status TEXT NOT NULL,
      medkits INTEGER NOT NULL DEFAULT 0,
      character_index INTEGER NOT NULL DEFAULT -1,
      display_name TEXT NOT NULL DEFAULT ''
    )
  `);

  // Columns a pre-existing data/game.db's players table might be missing —
  // same guarded-ALTER pattern as game_state's MIGRATIONS above, so an
  // existing players row survives rather than being dropped/recreated.
  const playerColumns = db.prepare("PRAGMA table_info(players)").all() as Array<{ name: string }>;
  const playerColumnNames = new Set(playerColumns.map((c) => c.name));
  if (!playerColumnNames.has("character_index")) {
    db.exec("ALTER TABLE players ADD COLUMN character_index INTEGER NOT NULL DEFAULT -1");
  }
  if (!playerColumnNames.has("display_name")) {
    db.exec("ALTER TABLE players ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
  }

  // One-time migration: a save from before Crit 10 has its one turret
  // sitting in game_state's legacy scalar columns. Seed the new `turrets`
  // table from it so existing progress survives the upgrade — only runs
  // once (guarded by "turrets table is still empty"), and only does anything
  // if that old save actually had a turret built.
  const turretCount = (db.prepare("SELECT COUNT(*) AS n FROM turrets").get() as { n: number }).n;
  if (turretCount === 0) {
    const legacy = db.prepare("SELECT turret_built, turret_level, turret_hp, turret_max_hp, turret_x, turret_y FROM game_state WHERE id = 1").get() as
      | Pick<GameStateRow, "turret_built" | "turret_level" | "turret_hp" | "turret_max_hp" | "turret_x" | "turret_y">
      | undefined;
    if (legacy && legacy.turret_built === 1) {
      db.prepare("INSERT INTO turrets (id, level, hp, max_hp, x, y) VALUES (@id, @level, @hp, @maxHp, @x, @y)").run({
        id: "legacy-turret",
        level: legacy.turret_level,
        hp: legacy.turret_hp,
        maxHp: legacy.turret_max_hp,
        x: legacy.turret_x,
        y: legacy.turret_y,
      });
      console.log("migrated Crit 9's single turret into the new turrets table as 'legacy-turret'");
    }
  }

  return db;
}

export function loadState(db: Database.Database): Progress {
  const row = db
    .prepare(
      `SELECT current_day, base_hp, base_max_hp, shared_xp,
              wall_level, wall_hp, wall_max_hp, phase
       FROM game_state WHERE id = 1`,
    )
    .get() as Omit<GameStateRow, "turret_level" | "turret_hp" | "turret_max_hp" | "turret_built" | "turret_x" | "turret_y"> | undefined;
  if (!row) {
    throw new Error("game_state row missing — openDatabase should have inserted the default row");
  }
  const turretRows = db.prepare("SELECT id, level, hp, max_hp, x, y FROM turrets").all() as TurretRow[];
  return {
    day: row.current_day,
    baseHp: row.base_hp,
    baseMaxHp: row.base_max_hp,
    sharedXp: row.shared_xp,
    wallLevel: row.wall_level,
    wallHp: row.wall_hp,
    wallMaxHp: row.wall_max_hp,
    turrets: turretRows.map((t) => ({ id: t.id, level: t.level, hp: t.hp, maxHp: t.max_hp, x: t.x, y: t.y })),
    phase: row.phase as GamePhase,
  };
}

export function saveState(db: Database.Database, state: Progress): void {
  const tx = db.transaction((s: Progress) => {
    db.prepare(
      `UPDATE game_state
       SET current_day = @day, base_hp = @baseHp, base_max_hp = @baseMaxHp, shared_xp = @sharedXp,
           wall_level = @wallLevel, wall_hp = @wallHp, wall_max_hp = @wallMaxHp,
           phase = @phase, updated_at = @updatedAt
       WHERE id = 1`,
    ).run({ ...s, updatedAt: new Date().toISOString() });

    // Turret count is always small (<= MAX_TURRETS) — replace-all on every
    // save is simple and correct rather than diffing inserts/updates/deletes.
    db.prepare("DELETE FROM turrets").run();
    const insertTurret = db.prepare("INSERT INTO turrets (id, level, hp, max_hp, x, y) VALUES (@id, @level, @hp, @maxHp, @x, @y)");
    for (const t of s.turrets) insertTurret.run(t);
  });
  tx(state);
}

// Players are durable per-identity profiles (Crit 10's browser-persistent
// id), written through immediately on every meaningful status change rather
// than going through PersistedState's periodic dirty-flush — status/hp
// changes are relatively infrequent (on a hit, not every tick) and each is
// worth not losing, the same judgment call already applied to a build/upgrade
// or a day change.
export function loadPlayerRecord(db: Database.Database, id: string): PlayerRecord | undefined {
  const row = db.prepare("SELECT id, hp, max_hp, status, medkits, character_index, display_name FROM players WHERE id = ?").get(id) as PlayerRow | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    hp: row.hp,
    maxHp: row.max_hp,
    status: row.status as PlayerRecord["status"],
    medkits: row.medkits,
    characterIndex: row.character_index,
    displayName: row.display_name,
  };
}

export function savePlayerRecord(db: Database.Database, record: PlayerRecord): void {
  db.prepare(
    `INSERT INTO players (id, hp, max_hp, status, medkits, character_index, display_name)
     VALUES (@id, @hp, @maxHp, @status, @medkits, @characterIndex, @displayName)
     ON CONFLICT(id) DO UPDATE SET
       hp = excluded.hp,
       max_hp = excluded.max_hp,
       status = excluded.status,
       medkits = excluded.medkits,
       character_index = excluded.character_index,
       display_name = excluded.display_name`,
  ).run(record);
}
