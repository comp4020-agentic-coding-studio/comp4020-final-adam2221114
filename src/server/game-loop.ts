import type { PersistedState } from "./persisted-state.ts";
import { DEFAULT_PROGRESS, type Progress } from "./persistence.ts";
import type { GamePhase, InteractAction, StateMessage } from "./protocol.ts";
import {
  BASE_ATTACK_RANGE,
  BASE_INTERACT_RANGE,
  BASE_POS,
  DAY_VICTORY,
  MAX_PLAYERS,
  PISTOL_DAMAGE,
  PLAYER_MAX_HP,
  PLAYER_START_OFFSETS,
  PLAYER_START_POS,
  TURRET_BUILD_RADIUS,
  TURRET_LEVELS,
  WALL_LEVELS,
  WALL_MAX_LEVEL,
  XP_PER_KILL,
  ZOMBIE_ATTACK_DAMAGE,
  ZOMBIE_ATTACK_INTERVAL_MS,
  distance,
  findNearestZombieInRange,
  movePlayer,
  resolveShot,
  spawnZombie,
  stepZombie,
  zombiesForDay,
  type InputState,
  type Player,
  type Vec2,
  type Zombie,
} from "./game-state.ts";

// Why an action returns a result instead of just logging and no-op'ing (as
// Crit 8's single-player version did): with several sockets, the loser of a
// simultaneous build/upgrade/placement race needs to be told so, not just
// silently ignored — see the Crit 9 ADR on simultaneous build conflicts.
export type ActionResult = { ok: true } | { ok: false; reason: string };
const OK: ActionResult = { ok: true };
function reject(reason: string): ActionResult {
  console.log(`rejected: ${reason}`);
  return { ok: false, reason };
}

// How often a new zombie spawns while this day's quota isn't met yet. Not
// tied to a day "duration" any more — see the class comment on why that's
// gone. A placeholder pace, not the balance pass.
const SPAWN_INTERVAL_MS = 2000;

// 20Hz: fine-grained enough that client-side prediction rarely needs more
// than a tiny, barely-visible correction. Nothing in the tick body changed —
// every interval here (attack cadence, day duration, spawn spacing) is
// expressed in absolute ms, so running it 4x more often doesn't change any
// gameplay rule, just the granularity it's checked at.
const TICK_MS = 50;

// What phase a process boots into, given what was last persisted. A stored
// "running" never means "really resume" — it only ever means the previous
// process stopped (crash, SIGKILL, `flyctl machine restart`, a redeploy)
// while a round was live, with no chance to pause cleanly first. Mapping it
// to "paused" here, unconditionally, on every boot, is what makes correctness
// NOT depend on SIGTERM/shutdown having run: even a hard kill leaves the game
// safe to resume manually next time, because the boot-time read is the one
// place that decides, not whatever happened (or didn't) on the way out.
const STARTUP_PHASE: Record<GamePhase, GamePhase> = {
  waiting: "waiting",
  paused: "paused",
  running: "paused",
  game_over: "game_over",
  victory: "victory",
};

// Server-authoritative, in-memory tick loop. Zombie/player positions, the
// turret's current target and its fire timer live only here —
// day/baseHp/sharedXp/wallLevel/wallHp/turret* are the only things that go
// through PersistedState, and only day-change, a build/upgrade, and wall/
// base destruction flush directly; everything else goes through the
// dirty-state path.
//
// Day progression is wave-clear, not a timer: a day ends only once every one
// of its zombies has spawned AND been killed (#checkWaveComplete, called
// right after a kill — spawning alone can never make that condition newly
// true, so there's nothing to check on the tick's own schedule). There's no
// more "day duration"; #spawnTimerMs just paces how often a new zombie joins
// the day's remaining quota.
//
// Defences are now something the player actively buys with shared XP via
// interact() (build/upgrade wall) or placeTurret() (the turret, which also
// needs a position) — the X-menu — not something that appears on its own:
// there is no more auto-wall-at-100-XP. The wall physically blocks zombies
// while it has HP (stepZombie stops them at the wall's ring instead of the
// base's); losing it drops wallLevel back to 0, so a rebuild always starts
// over at level 1 regardless of what it was before. The turret goes
// wherever the player placed it (turretX/turretY) — one per round, picked
// once, no moving it afterwards.
//
// Playability polish: a round phase gates the tick (waiting/paused/game_over/
// victory all freeze zombies, spawning, day and the player — only "running"
// ticks). restart() is the only thing that resets day/baseHp/sharedXp/
// wallLevel/turret* themselves — every other phase transition leaves them
// exactly as persisted.
//
// Disconnect-pause fix: phase IS persisted now (reversing the earlier
// decision), so the game can be paused the instant the last client
// disconnects and have that stick even through a crash or a machine restart.
// The constructor never trusts a stored phase as-is, though — see
// STARTUP_PHASE above. Every transition below (play/pause/restart, and the
// game_over/victory edges) updates and flushes progress.phase immediately,
// the same "worth not losing" treatment a build or a day change already
// gets, so correctness never depends on the periodic save timer or on
// SIGTERM having a chance to run.
export class GameLoop {
  readonly #progress: PersistedState;
  readonly #zombies: Zombie[] = [];
  // Keyed by the ephemeral per-connection id ws-server.ts assigns on
  // connect/disconnect — no accounts, nothing durable (CLAUDE.md's
  // persistence rules already exclude per-frame player state).
  readonly #players = new Map<string, Player>();
  readonly #inputs = new Map<string, InputState>();
  #phase: GamePhase = "waiting";
  #clockMs = 0; // monotonic; attack/fire-cooldown timestamps for zombies and the turret
  #spawnTimerMs = 0;
  #spawnedZombies = 0;
  #killedZombies = 0;
  #totalZombiesForDay: number;
  // Turret firing state — not persisted (GameLoop's own comment explains
  // why): both reset to "idle" on every boot, which is fine, since they're
  // only ever a few seconds of cooldown, not progress worth keeping.
  #turretLastFiredAt = -Infinity;
  #turretTarget: Zombie | undefined;
  #turretShotsFired = 0;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(progress: PersistedState) {
    this.#progress = progress;
    const stored = progress.get();
    this.#totalZombiesForDay = zombiesForDay(stored.day);
    this.#phase = STARTUP_PHASE[stored.phase];
    if (this.#phase !== stored.phase) {
      // Correct the stored value on disk immediately, not just in memory —
      // so a second crash before any real transition still boots safely.
      this.#progress.update({ phase: this.#phase });
      this.#progress.flush();
      console.log(`startup: stored phase was "${stored.phase}", starting as "${this.#phase}" instead`);
    } else {
      console.log(`startup: phase = "${this.#phase}"`);
    }
  }

  // Assigns the next free colour slot / start offset to a newly connected
  // socket. Returns false (and adds nothing) once MAX_PLAYERS are already
  // in — ws-server.ts turns that into a "full" message and closes the
  // socket instead of calling this at all past that point.
  addPlayer(id: string): boolean {
    if (this.#players.size >= MAX_PLAYERS) return false;
    const taken = new Set([...this.#players.values()].map((p) => p.colorIndex));
    let colorIndex = 0;
    while (taken.has(colorIndex)) colorIndex++;
    const offset = PLAYER_START_OFFSETS[colorIndex] ?? { x: 0, y: 0 };
    this.#players.set(id, {
      id,
      colorIndex,
      pos: { x: PLAYER_START_POS.x + offset.x, y: PLAYER_START_POS.y + offset.y },
      hp: PLAYER_MAX_HP,
    });
    this.#inputs.set(id, { up: false, down: false, left: false, right: false, aimAngle: 0 });
    console.log(`player ${id} joined (slot ${colorIndex}, ${this.#players.size}/${MAX_PLAYERS})`);
    return true;
  }

  removePlayer(id: string): void {
    this.#players.delete(id);
    this.#inputs.delete(id);
    console.log(`player ${id} left (${this.#players.size}/${MAX_PLAYERS} remain)`);
  }

  playerCount(): number {
    return this.#players.size;
  }

  // "start" and "resume" are the same edge: waiting/paused -> running. A
  // concluded round (game_over/victory) can't be resumed this way — only
  // restart() gets out of those.
  play(): void {
    if (this.#phase === "waiting" || this.#phase === "paused") {
      this.#phase = "running";
      this.#progress.update({ phase: "running" });
      this.#progress.flush();
      console.log(`phase -> running`);
    }
  }

  // Also the disconnect handler's own fix: ws-server calls this unconditionally
  // whenever the active connection closes (including a plain refresh replacing
  // it a moment later), and this no-ops unless a round was actually running —
  // so it's always safe to call, never something that needs its own guard.
  pause(): void {
    if (this.#phase === "running") {
      this.#phase = "paused";
      this.#progress.update({ phase: "paused" });
      this.#progress.flush();
      console.log("phase -> paused");
    }
  }

  // Resets this round to its defaults from any phase, and lands back at
  // "waiting" — the same state a fresh boot would show, so there's exactly
  // one way into "running" (play()) regardless of how you got to "waiting".
  // Flushes immediately: a deliberate reset is as worth not losing as a
  // build/upgrade or day change.
  restart(): void {
    this.#zombies.length = 0;
    this.#spawnedZombies = 0;
    this.#killedZombies = 0;
    this.#spawnTimerMs = 0;
    this.#turretLastFiredAt = -Infinity;
    this.#turretTarget = undefined;
    for (const player of this.#players.values()) {
      const offset = PLAYER_START_OFFSETS[player.colorIndex] ?? { x: 0, y: 0 };
      player.pos = { x: PLAYER_START_POS.x + offset.x, y: PLAYER_START_POS.y + offset.y };
      player.hp = PLAYER_MAX_HP;
    }
    this.#progress.update({ ...DEFAULT_PROGRESS });
    this.#progress.flush();
    this.#totalZombiesForDay = zombiesForDay(DEFAULT_PROGRESS.day);
    this.#phase = "waiting";
    console.log("restart: round reset to defaults, phase -> waiting");
  }

  // Replaces one player's stored input wholesale — the client sends its full
  // held-key state and current aim angle on every "input" message, so
  // there's nothing to merge. Applied on the next tick, not immediately. A
  // no-op if the id isn't a currently connected player (e.g. a stray message
  // arriving the instant after disconnect).
  setInput(id: string, input: InputState): void {
    if (!this.#inputs.has(id)) return;
    this.#inputs.set(id, input);
  }

  // One shot, resolved instantly against whatever input that player's socket
  // last sent. No bullet entity, no queue — this runs synchronously the
  // moment the "shoot" message arrives, ahead of the next tick if one's
  // close. A no-op outside "running" — no pre-start plinking, no shooting
  // through a pause.
  shoot(id: string): void {
    if (this.#phase !== "running") return;
    const player = this.#players.get(id);
    const input = this.#inputs.get(id);
    if (!player || !input) return;
    const target = resolveShot(player.pos, input.aimAngle, this.#zombies);
    if (!target) {
      console.log(`shoot(${id}): no zombie in range/cone`);
      return;
    }
    target.hp -= PISTOL_DAMAGE;
    console.log(`shoot(${id}): hit ${target.id}, hp -> ${target.hp}`);
    if (target.hp <= 0) this.#killZombie(target, `player ${id} shot`);
  }

  // The X-menu's actions. Every check the brief calls for happens here,
  // server-side, regardless of what the client thinks is true: range against
  // the server's own player position, XP against the server's own balance,
  // and the current building state. A failed check mutates nothing and
  // returns why — Crit 9's simultaneous-build-conflicts ADR: whichever
  // request this (single-threaded) server processes first wins and mutates
  // state; every request after it re-reads that already-updated state and is
  // rejected here, with a reason relayed back to just that caller.
  interact(id: string, action: InteractAction): ActionResult {
    if (this.#phase !== "running") return reject("round is not running");
    const player = this.#players.get(id);
    if (!player) return reject("not a connected player");
    if (distance(player.pos, BASE_POS) > BASE_INTERACT_RANGE) {
      return reject("too far from the base");
    }

    const progress = this.#progress.get();
    switch (action) {
      case "build_wall":
        return this.#buildWall(progress);
      case "upgrade_wall":
        return this.#upgradeWall(progress);
    }
  }

  // The follow-up to picking "Build Turret" from the menu: the client enters
  // placement mode on its own (no message sent yet) and only sends this once
  // the player clicks a spot it judged valid. Every check here re-runs
  // independently of that client-side judgement — phase, range-to-base (the
  // same check interact() uses), "not already built" (one turret this
  // round), cost, and whether (x, y) itself actually falls inside the
  // allowed ring. The client never gets the final say on where it ends up.
  placeTurret(id: string, x: number, y: number): ActionResult {
    if (this.#phase !== "running") return reject("round is not running");
    const player = this.#players.get(id);
    if (!player) return reject("not a connected player");
    if (distance(player.pos, BASE_POS) > BASE_INTERACT_RANGE) {
      return reject("too far from the base");
    }
    const progress = this.#progress.get();
    if (progress.turretBuilt) {
      return reject("turret already built");
    }
    const config = TURRET_LEVELS[1];
    if (config.cost === null) {
      return reject("turret not priced yet");
    }
    if (progress.sharedXp < config.cost) {
      return reject(`need ${config.cost} XP, have ${progress.sharedXp}`);
    }
    const spot: Vec2 = { x, y };
    const d = distance(spot, BASE_POS);
    if (d < BASE_ATTACK_RANGE || d > TURRET_BUILD_RADIUS) {
      return reject(`(${x}, ${y}) is outside the allowed ring (${BASE_ATTACK_RANGE}-${TURRET_BUILD_RADIUS} from base)`);
    }

    this.#progress.update({
      sharedXp: progress.sharedXp - config.cost,
      turretBuilt: true,
      turretLevel: 1,
      turretHp: config.maxHp,
      turretMaxHp: config.maxHp,
      turretX: x,
      turretY: y,
    });
    this.#progress.flush();
    console.log(`built turret level 1 at (${x.toFixed(0)}, ${y.toFixed(0)}) (-${config.cost} XP)`);
    return OK;
  }

  #buildWall(progress: Readonly<Progress>): ActionResult {
    if (progress.wallLevel !== 0) {
      return reject("a wall already stands");
    }
    const config = WALL_LEVELS[1];
    if (progress.sharedXp < config.cost!) {
      return reject(`need ${config.cost} XP, have ${progress.sharedXp}`);
    }
    this.#progress.update({
      sharedXp: progress.sharedXp - config.cost!,
      wallLevel: 1,
      wallHp: config.maxHp,
      wallMaxHp: config.maxHp,
    });
    this.#progress.flush();
    console.log(`built wall level 1 (-${config.cost} XP)`);
    return OK;
  }

  #upgradeWall(progress: Readonly<Progress>): ActionResult {
    const nextLevel = progress.wallLevel + 1;
    const config = WALL_LEVELS[nextLevel];
    if (progress.wallLevel === 0) {
      return reject("no wall to upgrade — build one first");
    }
    if (progress.wallLevel >= WALL_MAX_LEVEL || !config || config.cost === null) {
      return reject("no further priced upgrade available");
    }
    if (progress.sharedXp < config.cost) {
      return reject(`need ${config.cost} XP, have ${progress.sharedXp}`);
    }
    this.#progress.update({
      sharedXp: progress.sharedXp - config.cost,
      wallLevel: nextLevel,
      wallMaxHp: config.maxHp,
      wallHp: config.maxHp, // upgrading restores to the new level's full HP
    });
    this.#progress.flush();
    console.log(`upgraded wall to level ${nextLevel} (-${config.cost} XP)`);
    return OK;
  }

  // Removes a dead zombie, counts the kill towards this day's wave, and
  // awards XP — shared by every kill source (player shot, wall spikes,
  // turret), so all three stay in sync with the same bookkeeping.
  #killZombie(zombie: Zombie, source: string): void {
    this.#zombies.splice(this.#zombies.indexOf(zombie), 1);
    if (this.#turretTarget === zombie) this.#turretTarget = undefined;
    this.#killedZombies++;
    console.log(`zombie ${zombie.id} died (${source}) (${this.#killedZombies}/${this.#totalZombiesForDay})`);
    this.#addSharedXp(XP_PER_KILL);
    // Spawning can only ever make "all killed" harder to reach, never
    // trigger it — a kill is the only event that can newly satisfy the
    // wave-complete condition, so that's the only place it needs checking.
    this.#checkWaveComplete();
  }

  // Shared XP is now purely a spendable resource (no more auto baseLevel/
  // wall-unlock) — just add it and mark dirty, same as any other change.
  #addSharedXp(amount: number): void {
    const before = this.#progress.get().sharedXp;
    const sharedXp = before + amount;
    this.#progress.update({ sharedXp });
    console.log(`sharedXp ${before} -> ${sharedXp}`);
  }

  // The only way "all of this day's zombies are spawned and dead" becomes
  // true is a kill (see #killZombie), so this only ever needs calling from
  // there.
  #checkWaveComplete(): void {
    const allSpawned = this.#spawnedZombies === this.#totalZombiesForDay;
    const noneLeft = this.#zombies.length === 0;
    const allKilled = this.#killedZombies === this.#totalZombiesForDay;
    if (!(allSpawned && noneLeft && allKilled)) return;

    const completedDay = this.#progress.get().day;
    if (completedDay >= DAY_VICTORY) {
      this.#phase = "victory";
      this.#progress.update({ phase: "victory" });
      this.#progress.flush();
      console.log(`day ${completedDay} complete: phase -> victory`);
      return; // frozen at the victorious day, not advanced past it
    }

    const nextDay = completedDay + 1;
    this.#killedZombies = 0;
    this.#spawnedZombies = 0;
    this.#spawnTimerMs = 0;
    this.#totalZombiesForDay = zombiesForDay(nextDay);
    this.#progress.update({ day: nextDay });
    this.#progress.flush(); // day change flushes immediately, ahead of the timer
    console.log(`day ${nextDay} begins: ${this.#totalZombiesForDay} zombies scheduled`);
  }

  // Read-only view for the WS layer to broadcast. Never mutates anything —
  // the only writers of game state are shoot(), interact() and the tick loop
  // itself.
  getSnapshot(): StateMessage {
    const progress = this.#progress.get();
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
      turretLevel: progress.turretLevel,
      turretHp: progress.turretHp,
      turretMaxHp: progress.turretMaxHp,
      turretBuilt: progress.turretBuilt,
      turretX: progress.turretX,
      turretY: progress.turretY,
      turretTarget: this.#turretTarget ? { x: this.#turretTarget.pos.x, y: this.#turretTarget.pos.y } : null,
      turretShotsFired: this.#turretShotsFired,
      killedZombies: this.#killedZombies,
      totalZombiesForDay: this.#totalZombiesForDay,
      players: [...this.#players.values()].map((p) => ({
        id: p.id,
        colorIndex: p.colorIndex,
        x: p.pos.x,
        y: p.pos.y,
        hp: p.hp,
      })),
      zombies: this.#zombies.map((z) => ({ id: z.id, x: z.pos.x, y: z.pos.y, hp: z.hp })),
    };
  }

  start(): void {
    this.#timer = setInterval(() => this.#tick(TICK_MS), TICK_MS);
    console.log(
      `game loop started: day ${this.#progress.get().day}, ${this.#totalZombiesForDay} zombies this wave`,
    );
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  #tick(dtMs: number): void {
    // waiting/paused/game_over/victory: everything freezes, player included —
    // "paused 时 game loop 停止推进" is simplest as one gate, not a per-system one.
    if (this.#phase !== "running") return;
    this.#clockMs += dtMs;
    for (const [id, player] of this.#players) {
      const input = this.#inputs.get(id);
      if (input) movePlayer(player, input, dtMs);
    }
    this.#maybeSpawn(dtMs);
    this.#updateZombies();
    this.#updateTurret();
  }

  // Paces spawning at a fixed interval until this day's quota is fully
  // spawned — no longer tied to a day "duration" (there isn't one), just a
  // steady drip so the whole quota doesn't appear at once.
  #maybeSpawn(dtMs: number): void {
    if (this.#spawnedZombies >= this.#totalZombiesForDay) return;
    this.#spawnTimerMs += dtMs;
    if (this.#spawnTimerMs < SPAWN_INTERVAL_MS) return;
    this.#spawnTimerMs -= SPAWN_INTERVAL_MS; // keep the remainder so the cadence doesn't drift

    const z = spawnZombie();
    this.#zombies.push(z);
    this.#spawnedZombies++;
    console.log(
      `zombie ${z.id} spawned at (${z.pos.x.toFixed(0)}, ${z.pos.y.toFixed(0)}) (${this.#spawnedZombies}/${this.#totalZombiesForDay})`,
    );
  }

  // Wall first, base second: while wallHp > 0, stepZombie stops every zombie
  // at the wall's ring instead of the base — they physically cannot reach
  // the base at all, let alone attack it. Only once the wall is at 0 does a
  // zombie's stop radius shrink to the base's own, and only then does damage
  // reach baseHp.
  #updateZombies(): void {
    const now = this.#clockMs;
    const progress = this.#progress.get();
    const wallUp = progress.wallHp > 0;
    for (const z of this.#zombies) {
      stepZombie(z, TICK_MS, wallUp);
      if (z.attacking && now - z.lastAttackAt >= ZOMBIE_ATTACK_INTERVAL_MS) {
        z.lastAttackAt = now;
        this.#applyZombieHit(z);
      }
    }
  }

  #applyZombieHit(zombie: Zombie): void {
    const progress = this.#progress.get();
    if (progress.wallHp > 0) {
      const wallHp = Math.max(0, progress.wallHp - ZOMBIE_ATTACK_DAMAGE);
      const destroyed = wallHp <= 0;
      this.#progress.update({
        wallHp,
        // Destruction always drops the level back to 0 — a rebuild starts
        // over at level 1, never free-upgrades back to whatever it was.
        ...(destroyed ? { wallLevel: 0, wallMaxHp: 0 } : {}),
      });
      console.log(`zombie ${zombie.id} hits the wall: wallHp ${progress.wallHp} -> ${wallHp}`);
      if (destroyed) {
        this.#progress.flush(); // the wall falling is worth not losing, same as a build/upgrade
        console.log("wall destroyed: wallLevel -> 0, the base is exposed");
      }

      // Level 2+ spikes: every attack the wall takes also hurts the zombie
      // making it, on the same cadence as the attack itself.
      const spikeDamage = WALL_LEVELS[progress.wallLevel]?.spikeDamage ?? 0;
      if (spikeDamage > 0) {
        zombie.hp -= spikeDamage;
        console.log(`wall spikes hit ${zombie.id} back for ${spikeDamage}, hp -> ${zombie.hp}`);
        if (zombie.hp <= 0) this.#killZombie(zombie, "wall spikes");
      }
      return;
    }

    const baseHp = Math.max(0, progress.baseHp - ZOMBIE_ATTACK_DAMAGE);
    this.#progress.update({ baseHp });
    console.log(`zombie ${zombie.id} hits the base: baseHp ${progress.baseHp} -> ${baseHp}`);
    if (baseHp <= 0) {
      this.#phase = "game_over";
      this.#progress.update({ phase: "game_over" });
      this.#progress.flush();
      console.log("base destroyed: phase -> game_over");
    }
  }

  // Fully automatic: finds the nearest zombie in range, fires on its own
  // cadence, no player input involved. Same instant-hit approach as the
  // player's own shot — no bullet entity, no network-simulated projectile.
  #updateTurret(): void {
    const progress = this.#progress.get();
    if (!progress.turretBuilt || progress.turretHp <= 0) {
      this.#turretTarget = undefined;
      return;
    }
    const config = TURRET_LEVELS[progress.turretLevel];
    const turretPos: Vec2 = { x: progress.turretX, y: progress.turretY };
    this.#turretTarget = findNearestZombieInRange(turretPos, config.range, this.#zombies);
    if (!this.#turretTarget) return;
    if (this.#clockMs - this.#turretLastFiredAt < config.fireIntervalMs) return;

    this.#turretLastFiredAt = this.#clockMs;
    this.#turretShotsFired++;
    const target = this.#turretTarget;
    target.hp -= config.damage;
    console.log(`turret hits ${target.id}, hp -> ${target.hp}`);
    if (target.hp <= 0) this.#killZombie(target, "turret");
  }
}
