import type Database from "better-sqlite3";
import type { PersistedState } from "./persisted-state.ts";
import { DEFAULT_PROGRESS, loadPlayerRecord, savePlayerRecord, type PlayerRecord, type Progress, type TurretRecord } from "./persistence.ts";
import type { GamePhase, InteractAction, StateMessage, TurretAction } from "./protocol.ts";
import {
  BASE_ATTACK_RANGE,
  BASE_INTERACT_RANGE,
  BASE_POS,
  CHARACTER_COUNT,
  DAILY_HEAL_AMOUNT,
  DAY_INTRO_MS,
  DAY_VICTORY,
  DISPLAY_NAME_MAX_LENGTH,
  DOWNED_DURATION_MS,
  FIELD_REVIVE_HP,
  FIELD_REVIVE_INVULN_MS,
  MAX_PLAYERS,
  MAX_TURRETS,
  MEDKIT_COST,
  MEDKIT_DURATION_MS,
  MEDKIT_HEAL,
  MEDKIT_MAX,
  MELEE_RANGE,
  PAID_RESURRECT_HP,
  PAID_RESURRECT_INVULN_MS,
  PISTOL_DAMAGE,
  PLAYER_MAX_HP,
  PLAYER_START_OFFSETS,
  PLAYER_START_POS,
  REVIVE_HOLD_MS,
  REVIVE_RANGE,
  TURRET_BUILD_RADIUS,
  TURRET_INTERACT_RANGE,
  TURRET_LEVELS,
  TURRET_MAX_LEVEL,
  TURRET_MIN_SEPARATION,
  WALL_LEVELS,
  WALL_MAX_LEVEL,
  WALL_PULSE_RADIUS,
  XP_PER_KILL,
  ZOMBIE_TYPES,
  advanceZombie,
  batchSpawnAngles,
  buildSpawnQueue,
  distance,
  findNearestZombiesInRange,
  movePlayer,
  randomBatchSize,
  resolveShot,
  resurrectCostForDay,
  spawnPositionAtAngle,
  spawnTierForDay,
  spawnZombie,
  totalZombiesForDay,
  waveForDay,
  type InputState,
  type Player,
  type SpawnTier,
  type Vec2,
  type Zombie,
  type ZombieType,
} from "./game-state.ts";
import { assertMapIsFullyConnected, overlapsAnyBuilding, overlapsWallRect, wallRectsForPlayers } from "./obstacles.ts";

// Why an action returns a result instead of just logging and no-op'ing: with
// several sockets, the loser of a simultaneous race (build/upgrade/repair/
// placement/medkit/resurrection — anything that spends shared XP or touches
// shared build state) needs to be told so, not just silently ignored. See
// the Crit 9 ADR on simultaneous build conflicts — this generalizes that
// same mechanism to every action Crit 10 adds.
export type ActionResult = { ok: true } | { ok: false; reason: string };
const OK: ActionResult = { ok: true };
function reject(reason: string): ActionResult {
  console.log(`rejected: ${reason}`);
  return { ok: false, reason };
}

const TICK_MS = 50; // 20Hz

// What phase a process boots into, given what was last persisted. A stored
// "running" never means "really resume" — it only ever means the previous
// process stopped (crash, SIGKILL, `flyctl machine restart`, a redeploy)
// while a round was live, with no chance to pause cleanly first.
const STARTUP_PHASE: Record<GamePhase, GamePhase> = {
  waiting: "waiting",
  paused: "paused",
  running: "paused",
  game_over: "game_over",
  victory: "victory",
};

interface TurretRuntime {
  lastFiredAt: number;
  target: Zombie | undefined;
  shotsFired: number;
}

interface ReviveState {
  targetId: string;
  startedAt: number;
}

// What "the start of this day" looked like, captured once per day
// (#beginNewDay) and restored by retryDay() after a Game Over. Deliberately
// in-memory only, not SQLite — see retryDay()'s own comment, and this
// class's constructor comment, on what that costs across a process restart.
interface DaySnapshot {
  sharedXp: number;
  baseHp: number;
  wallLevel: number;
  wallHp: number;
  wallMaxHp: number;
  turrets: TurretRecord[];
  players: Map<string, { hp: number; status: Player["status"]; medkits: number }>;
}

// Server-authoritative, in-memory tick loop. Player/zombie positions, turret
// fire-cooldowns/targets, revive-hold progress, and this day's spawn queue
// live only here; day/baseHp/sharedXp/wallLevel/wallHp/turrets go through
// PersistedState (periodic dirty-flush, with an explicit flush() for
// "worth not losing" moments — build/upgrade/repair/destroy, day change).
// Player identity (hp/status/medkits) is written straight through
// PersistedPlayers' write-through functions instead — see persistence.ts's
// file comment on why that's a different persistence shape from Progress.
export class GameLoop {
  readonly #progress: PersistedState;
  readonly #db: Database.Database;
  readonly #zombies: Zombie[] = [];
  // Keyed by the browser-persistent id the client supplies on connect
  // (ws-server.ts) — no accounts, but now a stable identity across
  // reconnects, unlike Crit 9's purely ephemeral per-socket id.
  readonly #players = new Map<string, Player>();
  readonly #inputs = new Map<string, InputState>();
  readonly #turretRuntime = new Map<string, TurretRuntime>();
  readonly #reviveProgress = new Map<string, ReviveState>();
  #phase: GamePhase = "waiting";
  #clockMs = 0; // monotonic; every cooldown/timer in this class is measured against this, never wall-clock
  #spawnTimerMs = 0;
  #spawnTier: SpawnTier = spawnTierForDay(1);
  #spawnQueue: ZombieType[] = [];
  #spawnedZombies = 0;
  #killedZombies = 0;
  #totalZombiesForDay: number;
  #dayIntroUntilMs = 0;
  #wallPulseLastFiredAt = -Infinity;
  #daySnapshot: DaySnapshot;
  #timer: ReturnType<typeof setInterval> | undefined;
  #turretIdCounter = 0;

  constructor(progress: PersistedState, db: Database.Database) {
    // Crit 11 map-visual pass: a one-time startup check that the hand-placed
    // BUILDINGS layout (obstacles.ts) never seals off a region a zombie
    // could spawn in from ever reaching the base — fails loudly at boot
    // instead of silently stranding zombies if a future edit gets this
    // wrong. Cheap (one BFS over a ~1,600-cell grid), so unconditional.
    assertMapIsFullyConnected();
    this.#progress = progress;
    this.#db = db;
    const stored = progress.get();
    this.#totalZombiesForDay = totalZombiesForDay(stored.day);
    this.#phase = STARTUP_PHASE[stored.phase];
    if (this.#phase !== stored.phase) {
      this.#progress.update({ phase: this.#phase });
      this.#progress.flush();
      console.log(`startup: stored phase was "${stored.phase}", starting as "${this.#phase}" instead`);
    } else {
      console.log(`startup: phase = "${this.#phase}"`);
    }
    for (const t of stored.turrets) {
      this.#turretRuntime.set(t.id, { lastFiredAt: -Infinity, target: undefined, shotsFired: 0 });
    }
    // Best available "day start" to retry back to across a restart: the
    // state as it was actually loaded. Real per-player day-start values
    // aren't known yet (players reconnect after this constructor runs), so
    // retryDay() falls back to "keep whatever medkits they currently have"
    // for anyone not in this map — see its own comment.
    this.#daySnapshot = {
      sharedXp: stored.sharedXp,
      baseHp: stored.baseHp,
      wallLevel: stored.wallLevel,
      wallHp: stored.wallHp,
      wallMaxHp: stored.wallMaxHp,
      turrets: stored.turrets.map((t) => ({ ...t })),
      players: new Map(),
    };
    if (this.#phase === "paused") {
      // A round was mid-day when the process last stopped. Rebuild this
      // day's spawn queue so spawning can resume once a player clicks
      // Resume — deliberately #resetDayCombatState, NOT #beginNewDay: that
      // would re-grant the daily heal and overwrite the real day-start
      // snapshot above on every single restart, which the brief explicitly
      // says must never be exploitable via reconnecting or retrying.
      this.#resetDayCombatState(stored.day);
    }
  }

  // Loads (or creates) this identity's durable record and adds it to the
  // live world. Returns false (adds nothing) once MAX_PLAYERS are already
  // connected — ws-server.ts turns that into a "full" message.
  addPlayer(id: string): boolean {
    if (this.#players.size >= MAX_PLAYERS) return false;
    const taken = new Set([...this.#players.values()].map((p) => p.colorIndex));
    let colorIndex = 0;
    while (taken.has(colorIndex)) colorIndex++;
    const offset = PLAYER_START_OFFSETS[colorIndex] ?? { x: 0, y: 0 };

    const record = loadPlayerRecord(this.#db, id);
    const player: Player = {
      id,
      colorIndex,
      characterIndex: record?.characterIndex ?? -1,
      displayName: record?.displayName ?? "",
      pos: { x: PLAYER_START_POS.x + offset.x, y: PLAYER_START_POS.y + offset.y },
      hp: record?.hp ?? PLAYER_MAX_HP,
      maxHp: record?.maxHp ?? PLAYER_MAX_HP,
      status: record?.status ?? "alive",
      downedAt: -Infinity,
      diedAt: -Infinity,
      invulnerableUntil: -Infinity,
      medkits: record?.medkits ?? 0,
      healingSince: null,
    };
    this.#players.set(id, player);
    this.#inputs.set(id, { up: false, down: false, left: false, right: false, aimAngle: 0, reviving: false });
    if (!record) this.#persistPlayer(player); // brand new identity: seed a row now so a quick reconnect finds it
    console.log(`player ${id} joined (slot ${colorIndex}, status ${player.status}, ${this.#players.size}/${MAX_PLAYERS})`);
    return true;
  }

  removePlayer(id: string): void {
    this.#players.delete(id);
    this.#inputs.delete(id);
    this.#reviveProgress.delete(id);
    console.log(`player ${id} left (${this.#players.size}/${MAX_PLAYERS} remain)`);
    this.#checkAllIncapacitated();
  }

  isConnected(id: string): boolean {
    return this.#players.has(id);
  }

  playerCount(): number {
    return this.#players.size;
  }

  #persistPlayer(player: Player): void {
    const record: PlayerRecord = {
      id: player.id,
      hp: player.hp,
      maxHp: player.maxHp,
      status: player.status,
      medkits: player.medkits,
      characterIndex: player.characterIndex,
      displayName: player.displayName,
    };
    savePlayerRecord(this.#db, record);
  }

  // Validates and applies a player's choice of character sheet + display
  // name (the select-character overlay, shown while characterIndex is -1).
  // No phase gate: must work during "waiting" (the whole point), and is
  // harmless during "running" too (a late joiner confirming, or an existing
  // player changing their mind). Re-sending this for an already-confirmed
  // player is how they'd change their pick — their OWN current characterIndex
  // never blocks their own re-pick (see the uniqueness check below).
  selectCharacter(id: string, characterIndex: number, displayName: string): ActionResult {
    const player = this.#players.get(id);
    if (!player) return reject("not a connected player");
    if (!Number.isInteger(characterIndex) || characterIndex < 0 || characterIndex >= CHARACTER_COUNT) {
      return reject(`characterIndex must be an integer in [0, ${CHARACTER_COUNT})`);
    }
    const trimmedName = displayName.trim();
    if (trimmedName.length === 0) return reject("name cannot be empty");
    if (trimmedName.length > DISPLAY_NAME_MAX_LENGTH) return reject(`name must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`);

    for (const other of this.#players.values()) {
      if (other.id !== id && other.characterIndex === characterIndex) {
        return reject("that character is already taken");
      }
    }

    player.characterIndex = characterIndex;
    player.displayName = trimmedName;
    this.#persistPlayer(player);
    console.log(`player ${id} selected character ${characterIndex} ("${trimmedName}")`);
    return OK;
  }

  #nextTurretId(): string {
    this.#turretIdCounter++;
    return `t${this.#clockMs}-${this.#turretIdCounter}`;
  }

  // "start" and "resume" are the same edge: waiting/paused -> running. Only
  // the FIRST (waiting->running) is a genuine day start — resuming after a
  // pause continues the same day already in progress.
  play(): void {
    if (this.#phase === "waiting") {
      this.#phase = "running";
      this.#progress.update({ phase: "running" });
      this.#progress.flush();
      this.#beginNewDay(this.#progress.get().day);
      console.log("phase -> running");
    } else if (this.#phase === "paused") {
      this.#phase = "running";
      this.#progress.update({ phase: "running" });
      this.#progress.flush();
      console.log("phase -> running");
    }
  }

  pause(): void {
    if (this.#phase === "running") {
      this.#phase = "paused";
      this.#progress.update({ phase: "paused" });
      this.#progress.flush();
      console.log("phase -> paused");
    }
  }

  // Full reset to Day 1 defaults, from any phase — unlike retryDay(), which
  // only rewinds to the CURRENT day's start. Deliberately does NOT touch
  // characterIndex/displayName: those are identity preferences (which
  // character/name a player chose), not run progress, same as colorIndex
  // is already never reset here.
  restart(): void {
    this.#zombies.length = 0;
    this.#reviveProgress.clear();
    this.#turretRuntime.clear();
    for (const player of this.#players.values()) {
      const offset = PLAYER_START_OFFSETS[player.colorIndex] ?? { x: 0, y: 0 };
      player.pos = { x: PLAYER_START_POS.x + offset.x, y: PLAYER_START_POS.y + offset.y };
      player.hp = PLAYER_MAX_HP;
      player.maxHp = PLAYER_MAX_HP;
      player.status = "alive";
      player.downedAt = -Infinity;
      player.diedAt = -Infinity;
      player.invulnerableUntil = -Infinity;
      player.medkits = 0;
      player.healingSince = null;
      this.#persistPlayer(player);
    }
    this.#progress.update({ ...DEFAULT_PROGRESS });
    this.#progress.flush();
    this.#totalZombiesForDay = totalZombiesForDay(DEFAULT_PROGRESS.day);
    this.#daySnapshot = {
      sharedXp: DEFAULT_PROGRESS.sharedXp,
      baseHp: DEFAULT_PROGRESS.baseHp,
      wallLevel: DEFAULT_PROGRESS.wallLevel,
      wallHp: DEFAULT_PROGRESS.wallHp,
      wallMaxHp: DEFAULT_PROGRESS.wallMaxHp,
      turrets: [],
      players: new Map(),
    };
    this.#phase = "waiting";
    console.log("restart: round reset to Day 1 defaults, phase -> waiting");
  }

  // Rewinds to THIS DAY's start snapshot (sharedXp/baseHp/wall/turrets, and
  // every known player back to alive/full HP with their day-start medkit
  // count) and replays the same day's wave — day itself is untouched. Only
  // valid after a Game Over; XP/damage/kills from the failed attempt are not
  // preserved (they were never written back into the snapshot).
  // Also deliberately does NOT touch characterIndex/displayName — the
  // DaySnapshot below never carried either field, same "identity
  // preference, not run progress" reasoning as restart() above.
  retryDay(): ActionResult {
    if (this.#phase !== "game_over") return reject("can only retry the day after a game over");

    const snap = this.#daySnapshot;
    this.#progress.update({
      sharedXp: snap.sharedXp,
      baseHp: snap.baseHp,
      wallLevel: snap.wallLevel,
      wallHp: snap.wallHp,
      wallMaxHp: snap.wallMaxHp,
      turrets: snap.turrets.map((t) => ({ ...t })),
      phase: "waiting",
    });
    this.#progress.flush();

    this.#turretRuntime.clear();
    for (const t of snap.turrets) this.#turretRuntime.set(t.id, { lastFiredAt: -Infinity, target: undefined, shotsFired: 0 });

    this.#zombies.length = 0;
    this.#reviveProgress.clear();

    for (const player of this.#players.values()) {
      const saved = snap.players.get(player.id);
      player.status = "alive";
      player.hp = player.maxHp;
      player.downedAt = -Infinity;
      player.diedAt = -Infinity;
      player.invulnerableUntil = -Infinity;
      player.healingSince = null;
      // A player who joined mid-attempt has no day-start snapshot entry —
      // fall back to leaving their current medkit count alone rather than
      // guessing.
      if (saved) player.medkits = saved.medkits;
      this.#persistPlayer(player);
    }

    this.#phase = "waiting";
    console.log(`retry_day: restored day ${this.#progress.get().day}'s start snapshot`);
    return OK;
  }

  setInput(id: string, input: InputState): void {
    if (!this.#inputs.has(id)) return;
    this.#inputs.set(id, input);
  }

  shoot(id: string): void {
    if (this.#phase !== "running") return;
    const player = this.#players.get(id);
    const input = this.#inputs.get(id);
    if (!player || !input) return;
    if (player.characterIndex < 0) return; // hasn't confirmed a character yet
    if (player.status !== "alive" || player.healingSince !== null) return; // can't shoot downed/dead, or mid-medkit
    const target = resolveShot(player.pos, input.aimAngle, this.#zombies);
    if (!target) return;
    target.hp -= PISTOL_DAMAGE;
    if (target.hp <= 0) this.#killZombie(target, `player ${id} shot`);
  }

  // The base X-menu's actions: build/upgrade the wall, pay to resurrect a
  // dead teammate, or buy a medkit. Turret upgrade/repair are NOT here —
  // see turretInteract(), a separate, turret-targeted message, per the
  // brief's explicit "do not allow turret upgrades/repairs from the base".
  interact(id: string, action: InteractAction): ActionResult {
    if (this.#phase !== "running") return reject("round is not running");
    const player = this.#players.get(id);
    if (!player || player.status !== "alive") return reject("not a connected, alive player");
    if (player.characterIndex < 0) return reject("select a character first");
    if (distance(player.pos, BASE_POS) > BASE_INTERACT_RANGE) return reject("too far from the base");

    const progress = this.#progress.get();
    switch (action) {
      case "build_wall":
        return this.#buildWall(progress);
      case "upgrade_wall":
        return this.#upgradeWall(progress);
      case "revive_dead":
        return this.#reviveDead(progress);
      case "buy_medkit":
        return this.#buyMedkit(progress, player);
    }
  }

  placeTurret(id: string, x: number, y: number): ActionResult {
    if (this.#phase !== "running") return reject("round is not running");
    const player = this.#players.get(id);
    if (!player || player.status !== "alive") return reject("not a connected, alive player");
    if (player.characterIndex < 0) return reject("select a character first");
    if (distance(player.pos, BASE_POS) > BASE_INTERACT_RANGE) return reject("too far from the base");

    const progress = this.#progress.get();
    if (progress.turrets.length >= MAX_TURRETS) return reject(`already at the maximum of ${MAX_TURRETS} turrets`);
    const config = TURRET_LEVELS[1];
    if (progress.sharedXp < config.cost) return reject(`need ${config.cost} XP, have ${progress.sharedXp}`);

    const spot: Vec2 = { x, y };
    const d = distance(spot, BASE_POS);
    if (d < BASE_ATTACK_RANGE || d > TURRET_BUILD_RADIUS) {
      return reject(`(${x}, ${y}) is outside the allowed ring (${BASE_ATTACK_RANGE}-${TURRET_BUILD_RADIUS} from base)`);
    }
    // A turret can't legally stand inside a solid building. In practice
    // BUILDINGS all sit outside TURRET_BUILD_RADIUS (obstacles.ts's own
    // comment), so this never actually rejects anything today — kept as an
    // explicit, independently-checked invariant rather than an implicit
    // one, same reasoning as every other "the server re-validates even what
    // looks geometrically impossible" rule here. The wall, once built, DOES
    // genuinely overlap part of the turret ring (its half-extent is 116,
    // inside TURRET_BUILD_RADIUS=150), so this check is what actually
    // rejects an in-wall spot once a wall stands.
    if (overlapsAnyBuilding(spot) || overlapsWallRect(spot, wallRectsForPlayers(progress.wallLevel))) {
      return reject(`(${x}, ${y}) overlaps a building or the wall`);
    }
    for (const t of progress.turrets) {
      if (distance(spot, { x: t.x, y: t.y }) < TURRET_MIN_SEPARATION) {
        return reject(`too close to an existing turret (minimum ${TURRET_MIN_SEPARATION} units apart)`);
      }
    }

    const newTurret: TurretRecord = { id: this.#nextTurretId(), level: 1, hp: config.maxHp, maxHp: config.maxHp, x, y };
    this.#progress.update({ sharedXp: progress.sharedXp - config.cost, turrets: [...progress.turrets, newTurret] });
    this.#progress.flush();
    this.#turretRuntime.set(newTurret.id, { lastFiredAt: -Infinity, target: undefined, shotsFired: 0 });
    console.log(`built turret ${newTurret.id} (level 1) at (${x.toFixed(0)}, ${y.toFixed(0)}) (-${config.cost} XP)`);
    return OK;
  }

  // The turret X-menu's actions: upgrade or repair ONE specific turret,
  // identified by id, with its own independent level/HP/cooldown — distinct
  // from interact() because there's no longer exactly one implicit turret.
  turretInteract(id: string, turretId: string, action: TurretAction): ActionResult {
    if (this.#phase !== "running") return reject("round is not running");
    const player = this.#players.get(id);
    if (!player || player.status !== "alive") return reject("not a connected, alive player");
    if (player.characterIndex < 0) return reject("select a character first");

    const progress = this.#progress.get();
    const turret = progress.turrets.find((t) => t.id === turretId);
    if (!turret) return reject("no such turret");
    if (distance(player.pos, { x: turret.x, y: turret.y }) > TURRET_INTERACT_RANGE) return reject("too far from that turret");

    return action === "upgrade" ? this.#upgradeTurret(progress, turret) : this.#repairTurret(progress, turret);
  }

  #upgradeTurret(progress: Readonly<Progress>, turret: TurretRecord): ActionResult {
    if (turret.level >= TURRET_MAX_LEVEL) return reject("already at max level");
    const nextLevel = turret.level + 1;
    const config = TURRET_LEVELS[nextLevel];
    if (progress.sharedXp < config.cost) return reject(`need ${config.cost} XP, have ${progress.sharedXp}`);

    const turrets = progress.turrets.map((t) => (t.id === turret.id ? { ...t, level: nextLevel, maxHp: config.maxHp, hp: config.maxHp } : t));
    this.#progress.update({ sharedXp: progress.sharedXp - config.cost, turrets });
    this.#progress.flush();
    console.log(`turret ${turret.id} upgraded to level ${nextLevel} (-${config.cost} XP)`);
    return OK;
  }

  #repairTurret(progress: Readonly<Progress>, turret: TurretRecord): ActionResult {
    if (turret.hp >= turret.maxHp) return reject("already at full health");
    const config = TURRET_LEVELS[turret.level];
    if (progress.sharedXp < config.repairCost) return reject(`need ${config.repairCost} XP, have ${progress.sharedXp}`);

    const turrets = progress.turrets.map((t) => (t.id === turret.id ? { ...t, hp: t.maxHp } : t));
    this.#progress.update({ sharedXp: progress.sharedXp - config.repairCost, turrets });
    this.#progress.flush();
    console.log(`turret ${turret.id} repaired to full (-${config.repairCost} XP)`);
    return OK;
  }

  #buildWall(progress: Readonly<Progress>): ActionResult {
    if (progress.wallLevel !== 0) return reject("a wall already stands");
    const config = WALL_LEVELS[1];
    if (progress.sharedXp < config.cost) return reject(`need ${config.cost} XP, have ${progress.sharedXp}`);
    this.#progress.update({ sharedXp: progress.sharedXp - config.cost, wallLevel: 1, wallHp: config.maxHp, wallMaxHp: config.maxHp });
    this.#progress.flush();
    console.log(`built wall level 1 (-${config.cost} XP)`);
    return OK;
  }

  #upgradeWall(progress: Readonly<Progress>): ActionResult {
    if (progress.wallLevel === 0) return reject("no wall to upgrade — build one first");
    const nextLevel = progress.wallLevel + 1;
    const config = WALL_LEVELS[nextLevel];
    if (progress.wallLevel >= WALL_MAX_LEVEL || !config) return reject("no further upgrade available");
    if (progress.sharedXp < config.cost) return reject(`need ${config.cost} XP, have ${progress.sharedXp}`);
    this.#progress.update({ sharedXp: progress.sharedXp - config.cost, wallLevel: nextLevel, wallMaxHp: config.maxHp, wallHp: config.maxHp });
    this.#progress.flush();
    console.log(`upgraded wall to level ${nextLevel} (-${config.cost} XP)`);
    return OK;
  }

  #reviveDead(progress: Readonly<Progress>): ActionResult {
    let earliest: Player | undefined;
    for (const p of this.#players.values()) {
      if (p.status !== "dead") continue;
      if (!earliest || p.diedAt < earliest.diedAt) earliest = p;
    }
    if (!earliest) return reject("no dead teammate to revive");
    const cost = resurrectCostForDay(progress.day);
    if (progress.sharedXp < cost) return reject(`need ${cost} XP, have ${progress.sharedXp}`);

    this.#progress.update({ sharedXp: progress.sharedXp - cost });
    this.#progress.flush();
    const now = this.#clockMs;
    earliest.status = "alive";
    earliest.hp = PAID_RESURRECT_HP;
    earliest.invulnerableUntil = now + PAID_RESURRECT_INVULN_MS;
    this.#persistPlayer(earliest);
    console.log(`player ${earliest.id} resurrected for ${cost} XP`);
    return OK;
  }

  #buyMedkit(progress: Readonly<Progress>, buyer: Player): ActionResult {
    if (buyer.medkits >= MEDKIT_MAX) return reject(`already carrying the max of ${MEDKIT_MAX} medkits`);
    if (progress.sharedXp < MEDKIT_COST) return reject(`need ${MEDKIT_COST} XP, have ${progress.sharedXp}`);

    this.#progress.update({ sharedXp: progress.sharedXp - MEDKIT_COST });
    this.#progress.flush();
    buyer.medkits += 1;
    this.#persistPlayer(buyer);
    console.log(`player ${buyer.id} bought a medkit (${buyer.medkits}/${MEDKIT_MAX}) (-${MEDKIT_COST} XP)`);
    return OK;
  }

  // Press H: starts a 2-second heal if eligible. Completion (and the HP
  // gain + medkit consumption) happens in #updateHealing() once the
  // duration elapses uninterrupted — see #damagePlayer for the interrupt.
  useMedkit(id: string): ActionResult {
    if (this.#phase !== "running") return reject("round is not running");
    const player = this.#players.get(id);
    if (!player || player.status !== "alive") return reject("not a connected, alive player");
    if (player.characterIndex < 0) return reject("select a character first");
    if (player.healingSince !== null) return reject("already healing");
    if (player.medkits <= 0) return reject("no medkits");
    if (player.hp >= player.maxHp) return reject("already at full health");

    player.healingSince = this.#clockMs;
    console.log(`player ${id} starts using a medkit`);
    return OK;
  }

  // Applies damage to a player, respecting invulnerability and interrupting
  // (not consuming) an in-progress medkit heal. The one place anything in
  // this class is allowed to lower a player's HP.
  #damagePlayer(player: Player, amount: number, now: number): void {
    if (player.status !== "alive") return;
    if (now < player.invulnerableUntil) return;
    if (player.healingSince !== null) player.healingSince = null; // interrupted, medkit not consumed
    player.hp = Math.max(0, player.hp - amount);
    if (player.hp <= 0) {
      player.status = "downed";
      player.downedAt = now;
      console.log(`player ${player.id} is downed`);
    }
    this.#persistPlayer(player);
    if (player.status === "downed") this.#checkAllIncapacitated();
  }

  // Removes a dead zombie, counts the kill, awards XP, and — for a giant —
  // damages every alive player within its explosion radius. Shared by every
  // kill source (player shot, turret, wall spikes/pulse) so bookkeeping stays
  // in one place.
  #killZombie(zombie: Zombie, source: string): void {
    this.#zombies.splice(this.#zombies.indexOf(zombie), 1);
    this.#killedZombies++;
    console.log(`zombie ${zombie.id} (${zombie.type}) died (${source}) (${this.#killedZombies}/${this.#totalZombiesForDay})`);
    this.#addSharedXp(XP_PER_KILL);

    const cfg = ZOMBIE_TYPES[zombie.type];
    if (cfg.explodesOnDeath) {
      const now = this.#clockMs;
      for (const player of this.#players.values()) {
        if (player.status !== "alive") continue;
        if (distance(player.pos, zombie.pos) <= cfg.explosionRadius) this.#damagePlayer(player, cfg.explosionDamage, now);
      }
      console.log(`zombie ${zombie.id} explodes on death: ${cfg.explosionDamage} dmg within ${cfg.explosionRadius}`);
    }

    for (const runtime of this.#turretRuntime.values()) {
      if (runtime.target === zombie) runtime.target = undefined;
    }
    this.#checkWaveComplete();
  }

  #addSharedXp(amount: number): void {
    const before = this.#progress.get().sharedXp;
    this.#progress.update({ sharedXp: before + amount });
  }

  #checkWaveComplete(): void {
    const allSpawned = this.#spawnQueue.length === 0;
    const noneLeft = this.#zombies.length === 0;
    const allKilled = this.#killedZombies === this.#totalZombiesForDay;
    if (!(allSpawned && noneLeft && allKilled)) return;

    const completedDay = this.#progress.get().day;
    if (completedDay >= DAY_VICTORY) {
      this.#phase = "victory";
      this.#progress.update({ phase: "victory" });
      this.#progress.flush();
      console.log(`day ${completedDay} complete: phase -> victory`);
      return;
    }

    const nextDay = completedDay + 1;
    this.#progress.update({ day: nextDay });
    this.#progress.flush();
    this.#beginNewDay(nextDay);
  }

  // Everything needed for a day's zombies to spawn correctly — safe (and
  // necessary) to redo after ANY process restart mid-day, since none of this
  // grants anything. See #beginNewDay for the genuinely once-per-day parts.
  #resetDayCombatState(day: number): void {
    this.#spawnQueue = buildSpawnQueue(day);
    this.#totalZombiesForDay = totalZombiesForDay(day);
    this.#spawnedZombies = 0;
    this.#killedZombies = 0;
    this.#spawnTimerMs = 0;
    this.#spawnTier = spawnTierForDay(day);
    this.#wallPulseLastFiredAt = this.#clockMs;
  }

  // Only called on a GENUINE new day: the very first "Start" click (Day 1)
  // and a natural day-clear advance. Grants the daily heal and recaptures
  // the retry-day snapshot — deliberately never called on a mid-day resume
  // or process restart (#resetDayCombatState covers those), so neither can
  // be exploited into free healing or a reset XP ledger.
  #beginNewDay(day: number): void {
    this.#resetDayCombatState(day);
    this.#dayIntroUntilMs = this.#clockMs + DAY_INTRO_MS;

    const now = this.#clockMs;
    for (const player of this.#players.values()) {
      if (player.status === "alive") {
        player.hp = Math.min(player.maxHp, player.hp + DAILY_HEAL_AMOUNT);
        this.#persistPlayer(player);
      }
    }

    const progress = this.#progress.get();
    this.#daySnapshot = {
      sharedXp: progress.sharedXp,
      baseHp: progress.baseHp,
      wallLevel: progress.wallLevel,
      wallHp: progress.wallHp,
      wallMaxHp: progress.wallMaxHp,
      turrets: progress.turrets.map((t) => ({ ...t })),
      players: new Map([...this.#players.entries()].map(([id, p]) => [id, { hp: p.hp, status: p.status, medkits: p.medkits }])),
    };
    console.log(`day ${day} begins: ${this.#totalZombiesForDay} zombies scheduled, ${DAY_INTRO_MS}ms intro, daily heal applied`);
  }

  #checkAllIncapacitated(): void {
    if (this.#phase !== "running") return;
    if (this.#players.size === 0) return; // an empty session is the disconnect/pause path's job, not a loss
    const allDown = [...this.#players.values()].every((p) => p.status !== "alive");
    if (allDown) {
      this.#phase = "game_over";
      this.#progress.update({ phase: "game_over" });
      this.#progress.flush();
      console.log("every connected player is downed or dead: phase -> game_over");
    }
  }

  // Read-only view for the WS layer to broadcast. Never mutates anything.
  getSnapshot(): StateMessage {
    const progress = this.#progress.get();
    const now = this.#clockMs;
    return {
      type: "state",
      phase: this.#phase,
      day: progress.day,
      baseHp: progress.baseHp,
      baseMaxHp: progress.baseMaxHp,
      sharedXp: progress.sharedXp,
      wallLevel: progress.wallLevel,
      wallHp: progress.wallHp,
      wallMaxHp: progress.wallMaxHp,
      dayIntroRemainingMs: Math.max(0, this.#dayIntroUntilMs - now),
      killedZombies: this.#killedZombies,
      totalZombiesForDay: this.#totalZombiesForDay,
      // Read-only lookup against the fixed WAVE_TABLE for this day — not
      // this.#spawnQueue (which shrinks as the day empties it) and not a new
      // stored field, so there's nothing new to get out of sync. Lets the
      // client show what a day actually contains (composition HUD, "new
      // enemy" intro popups) without guessing from which zombies happen to
      // have spawned yet.
      dayWaveComposition: waveForDay(progress.day),
      players: [...this.#players.values()].map((p) => ({
        id: p.id,
        colorIndex: p.colorIndex,
        characterIndex: p.characterIndex,
        displayName: p.displayName,
        x: p.pos.x,
        y: p.pos.y,
        hp: p.hp,
        maxHp: p.maxHp,
        status: p.status,
        downedRemainingMs: p.status === "downed" ? Math.max(0, DOWNED_DURATION_MS - (now - p.downedAt)) : 0,
        medkits: p.medkits,
        healing: p.healingSince !== null,
        invulnerable: now < p.invulnerableUntil,
      })),
      zombies: this.#zombies.map((z) => ({
        id: z.id,
        type: z.type,
        x: z.pos.x,
        y: z.pos.y,
        hp: z.hp,
        maxHp: z.maxHp,
        attacking: z.attacking,
        attacksLanded: z.attacksLanded,
        lastHitKind: z.lastHitKind,
        lastHitTargetId: z.lastHitTargetId,
      })),
      turrets: progress.turrets.map((t) => {
        const runtime = this.#turretRuntime.get(t.id);
        return {
          id: t.id,
          level: t.level,
          hp: t.hp,
          maxHp: t.maxHp,
          x: t.x,
          y: t.y,
          target: runtime?.target ? { x: runtime.target.pos.x, y: runtime.target.pos.y } : null,
          shotsFired: runtime?.shotsFired ?? 0,
        };
      }),
      reviveProgress: [...this.#reviveProgress.entries()].map(([reviverId, prog]) => ({
        reviverId,
        targetId: prog.targetId,
        remainingMs: Math.max(0, REVIVE_HOLD_MS - (now - prog.startedAt)),
      })),
    };
  }

  start(): void {
    this.#timer = setInterval(() => this.#tick(TICK_MS), TICK_MS);
    console.log(`game loop started: day ${this.#progress.get().day}`);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  #tick(dtMs: number): void {
    if (this.#phase !== "running") return;
    this.#clockMs += dtMs;
    const wallLevel = this.#progress.get().wallLevel;
    for (const [id, player] of this.#players) {
      if (player.status !== "alive") continue;
      const input = this.#inputs.get(id);
      if (input) movePlayer(player, input, dtMs, wallLevel);
    }
    this.#updateRevives();
    this.#updateHealing();
    this.#updateDownedTimers();
    this.#maybeSpawn(dtMs);
    this.#updateZombies();
    this.#updateTurrets();
    this.#updateWallPulse();
  }

  // One hold-E-for-3-seconds field revive in progress per reviver. Not
  // sticky across losing the conditions (letting go of E, moving out of
  // range, or the target already being revived/gone) — progress resets.
  #updateRevives(): void {
    const now = this.#clockMs;
    for (const [reviverId, input] of this.#inputs) {
      const reviver = this.#players.get(reviverId);
      if (!reviver || reviver.status !== "alive" || !input.reviving) {
        this.#reviveProgress.delete(reviverId);
        continue;
      }
      let target: Player | undefined;
      let bestD = REVIVE_RANGE;
      for (const p of this.#players.values()) {
        if (p.status !== "downed") continue;
        const d = distance(reviver.pos, p.pos);
        if (d <= bestD) {
          target = p;
          bestD = d;
        }
      }
      if (!target) {
        this.#reviveProgress.delete(reviverId);
        continue;
      }
      const prog = this.#reviveProgress.get(reviverId);
      if (!prog || prog.targetId !== target.id) {
        this.#reviveProgress.set(reviverId, { targetId: target.id, startedAt: now });
        continue;
      }
      if (now - prog.startedAt >= REVIVE_HOLD_MS) {
        target.status = "alive";
        target.hp = FIELD_REVIVE_HP;
        target.invulnerableUntil = now + FIELD_REVIVE_INVULN_MS;
        this.#persistPlayer(target);
        this.#reviveProgress.delete(reviverId);
        console.log(`player ${target.id} field-revived by ${reviverId}`);
      }
    }
  }

  #updateHealing(): void {
    const now = this.#clockMs;
    for (const player of this.#players.values()) {
      if (player.healingSince === null) continue;
      if (now - player.healingSince >= MEDKIT_DURATION_MS) {
        player.hp = Math.min(player.maxHp, player.hp + MEDKIT_HEAL);
        player.medkits -= 1;
        player.healingSince = null;
        this.#persistPlayer(player);
        console.log(`player ${player.id} medkit heal complete: hp -> ${player.hp}, medkits -> ${player.medkits}`);
      }
    }
  }

  #updateDownedTimers(): void {
    const now = this.#clockMs;
    for (const player of this.#players.values()) {
      if (player.status === "downed" && now - player.downedAt >= DOWNED_DURATION_MS) {
        player.status = "dead";
        player.diedAt = now;
        this.#persistPlayer(player);
        console.log(`player ${player.id} died (downed timer expired)`);
      }
    }
    this.#checkAllIncapacitated();
  }

  // Spawns this day's pre-built queue (buildSpawnQueue — still owns the
  // actual totals/type composition/boss-last ordering, untouched here) in
  // simultaneous batches at a fixed per-day-range interval (spawnTierForDay)
  // instead of one zombie at a time. Held entirely during the day-intro
  // countdown — zombies don't spawn until it finishes, though players can
  // already move/build/interact.
  #maybeSpawn(dtMs: number): void {
    if (this.#clockMs < this.#dayIntroUntilMs) return;
    if (this.#spawnQueue.length === 0) return;
    this.#spawnTimerMs += dtMs;
    if (this.#spawnTimerMs < this.#spawnTier.intervalMs) return;
    this.#spawnTimerMs -= this.#spawnTier.intervalMs;

    // Capped to whatever's left so the final batch of a day never
    // over-spawns past the day's real total.
    const count = Math.min(randomBatchSize(this.#spawnTier), this.#spawnQueue.length);
    const angles = batchSpawnAngles(count);
    const players = [...this.#players.values()];
    const day = this.#progress.get().day;
    const spawnedIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const type = this.#spawnQueue.shift()!;
      const pos = spawnPositionAtAngle(angles[i], players);
      const z = spawnZombie(type, day, pos);
      this.#zombies.push(z);
      this.#spawnedZombies++;
      spawnedIds.push(z.id);
    }
    console.log(`horde batch: ${count} zombies spawned around the perimeter (${this.#spawnedZombies}/${this.#totalZombiesForDay}) [${spawnedIds.join(", ")}]`);
  }

  #updateZombies(): void {
    const now = this.#clockMs;
    const progress = this.#progress.get();
    const wallLevel = progress.wallHp > 0 ? progress.wallLevel : 0;
    const players = [...this.#players.values()];
    for (const z of this.#zombies) {
      advanceZombie(z, TICK_MS, players, wallLevel);
      if (z.attacking && now - z.lastAttackAt >= ZOMBIE_TYPES[z.type].attackIntervalMs) {
        z.lastAttackAt = now;
        this.#applyZombieHit(z);
      }
    }
  }

  #applyZombieHit(zombie: Zombie): void {
    const now = this.#clockMs;
    const cfg = ZOMBIE_TYPES[zombie.type];

    // Turrets are physical obstacles: a GROUND zombie that ends up within
    // melee range of a live turret fights it instead of its "real" target —
    // not otherwise specified by the brief, but the only way turret HP/
    // repair means anything (a documented assumption, see PROCESS.md).
    // Flying zombies ignore turrets the same way they ignore the wall.
    if (!cfg.ranged) {
      const progress = this.#progress.get();
      const nearTurret = progress.turrets.find((t) => t.hp > 0 && distance(zombie.pos, { x: t.x, y: t.y }) <= MELEE_RANGE);
      if (nearTurret) {
        const hp = Math.max(0, nearTurret.hp - cfg.damage);
        const destroyed = hp <= 0;
        const turrets = destroyed
          ? progress.turrets.filter((t) => t.id !== nearTurret.id)
          : progress.turrets.map((t) => (t.id === nearTurret.id ? { ...t, hp } : t));
        this.#progress.update({ turrets });
        zombie.attacksLanded++;
        zombie.lastHitKind = "turret";
        zombie.lastHitTargetId = nearTurret.id;
        if (destroyed) {
          this.#turretRuntime.delete(nearTurret.id);
          this.#progress.flush();
          console.log(`turret ${nearTurret.id} destroyed, slot freed`);
        } else {
          console.log(`zombie ${zombie.id} hits turret ${nearTurret.id}: hp ${nearTurret.hp} -> ${hp}`);
        }
        return;
      }
    }

    if (zombie.attackTarget.kind === "player") {
      const player = this.#players.get(zombie.attackTarget.playerId);
      if (player) {
        zombie.attacksLanded++;
        zombie.lastHitKind = "player";
        zombie.lastHitTargetId = player.id;
        this.#damagePlayer(player, cfg.damage, now);
      }
      return;
    }

    // Structure target: a flying zombie bypasses the wall entirely ("may
    // attack over walls") and always hits the base directly; a ground
    // zombie hits whichever of wall/base is currently absorbing hits.
    const progress = this.#progress.get();
    if (!cfg.ranged && progress.wallHp > 0) {
      const reduction = WALL_LEVELS[progress.wallLevel]?.damageReductionPercent ?? 0;
      const dmg = Math.max(0, Math.round(cfg.damage * (1 - reduction)));
      const wallHp = Math.max(0, progress.wallHp - dmg);
      const destroyed = wallHp <= 0;
      this.#progress.update({ wallHp, ...(destroyed ? { wallLevel: 0, wallMaxHp: 0 } : {}) });
      zombie.attacksLanded++;
      zombie.lastHitKind = "wall";
      zombie.lastHitTargetId = null;
      console.log(`zombie ${zombie.id} hits the wall: wallHp ${progress.wallHp} -> ${wallHp}`);
      if (destroyed) {
        this.#progress.flush();
        console.log("wall destroyed: wallLevel -> 0, the base is exposed");
      }
      const spikeDamage = WALL_LEVELS[progress.wallLevel]?.spikeDamage ?? 0;
      if (spikeDamage > 0) {
        zombie.hp -= spikeDamage;
        if (zombie.hp <= 0) this.#killZombie(zombie, "wall spikes");
      }
      return;
    }

    const baseHp = Math.max(0, progress.baseHp - cfg.damage);
    this.#progress.update({ baseHp });
    zombie.attacksLanded++;
    zombie.lastHitKind = "base";
    zombie.lastHitTargetId = null;
    console.log(`zombie ${zombie.id} hits the base: baseHp ${progress.baseHp} -> ${baseHp}`);
    if (baseHp <= 0) {
      this.#phase = "game_over";
      this.#progress.update({ phase: "game_over" });
      this.#progress.flush();
      console.log("base destroyed: phase -> game_over");
    }
  }

  // Every turret fires independently, each on its own cooldown, at the
  // nearest `multiTargetCount` zombies within its own range (this project's
  // hitscan-only architecture's approximation of "attacks 2 targets" /
  // "pierce up to N" — see TurretLevelConfig's own comment). Level 5's
  // splash then adds reduced damage to anything else near the primary hit.
  #updateTurrets(): void {
    const now = this.#clockMs;
    const progress = this.#progress.get();
    for (const turret of progress.turrets) {
      if (turret.hp <= 0) continue;
      const runtime = this.#turretRuntime.get(turret.id);
      if (!runtime) continue;
      const config = TURRET_LEVELS[turret.level];
      const origin: Vec2 = { x: turret.x, y: turret.y };
      const targets = findNearestZombiesInRange(origin, config.range, config.multiTargetCount, this.#zombies);
      runtime.target = targets[0];
      if (targets.length === 0) continue;
      if (now - runtime.lastFiredAt < config.fireIntervalMs) continue;

      runtime.lastFiredAt = now;
      runtime.shotsFired++;
      for (const target of targets) {
        target.hp -= config.damage;
        if (target.hp <= 0) this.#killZombie(target, `turret ${turret.id}`);
      }
      if (config.splashRadius > 0) {
        const primary = targets[0];
        const splashDamage = config.damage * config.splashDamagePercent;
        for (const z of [...this.#zombies]) {
          if (targets.includes(z)) continue; // already took full damage above
          if (distance(z.pos, primary.pos) <= config.splashRadius) {
            z.hp -= splashDamage;
            if (z.hp <= 0) this.#killZombie(z, `turret ${turret.id} splash`);
          }
        }
      }
    }
  }

  // Level 2 wall's periodic AOE pulse — levels 3+ use an on-hit spike
  // reflect instead (handled inline in #applyZombieHit).
  #updateWallPulse(): void {
    const progress = this.#progress.get();
    if (progress.wallLevel !== 2 || progress.wallHp <= 0) return;
    const config = WALL_LEVELS[2];
    if (this.#clockMs - this.#wallPulseLastFiredAt < config.pulseIntervalMs) return;
    this.#wallPulseLastFiredAt = this.#clockMs;

    for (const z of [...this.#zombies]) {
      if (distance(z.pos, BASE_POS) > WALL_PULSE_RADIUS) continue;
      z.hp -= config.pulseDamage;
      if (z.hp <= 0) this.#killZombie(z, "wall pulse");
    }
  }
}
