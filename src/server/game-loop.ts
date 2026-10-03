import type { PersistedState } from "./persisted-state.ts";
import { DEFAULT_PROGRESS, type Progress } from "./persistence.ts";
import type { GamePhase, InteractAction, StateMessage } from "./protocol.ts";
import {
  BASE_ATTACK_RANGE,
  BASE_INTERACT_RANGE,
  BASE_POS,
  DAY_VICTORY,
  PISTOL_DAMAGE,
  PLAYER_MAX_HP,
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
// ticks). phase itself is NOT persisted: every process boot starts at
// "waiting" regardless of what day/baseHp/etc were left at, so a stranger
// always gets a deliberate Start moment, and whatever was persisted is just
// what they see on the HUD until they press it. restart() is the only thing
// that resets day/baseHp/sharedXp/wallLevel/turret* themselves — a plain
// boot leaves them exactly as persisted.
export class GameLoop {
  readonly #progress: PersistedState;
  readonly #zombies: Zombie[] = [];
  readonly #player: Player = { pos: { ...PLAYER_START_POS }, hp: PLAYER_MAX_HP };
  #input: InputState = { up: false, down: false, left: false, right: false, aimAngle: 0 };
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
    this.#totalZombiesForDay = zombiesForDay(progress.get().day);
  }

  // "start" and "resume" are the same edge: waiting/paused -> running. A
  // concluded round (game_over/victory) can't be resumed this way — only
  // restart() gets out of those.
  play(): void {
    if (this.#phase === "waiting" || this.#phase === "paused") {
      this.#phase = "running";
      console.log(`phase -> running`);
    }
  }

  pause(): void {
    if (this.#phase === "running") {
      this.#phase = "paused";
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
    this.#player.pos = { ...PLAYER_START_POS };
    this.#player.hp = PLAYER_MAX_HP;
    this.#progress.update({ ...DEFAULT_PROGRESS });
    this.#progress.flush();
    this.#totalZombiesForDay = zombiesForDay(DEFAULT_PROGRESS.day);
    this.#phase = "waiting";
    console.log("restart: round reset to defaults, phase -> waiting");
  }

  // Replaces the stored input wholesale — the client sends its full held-key
  // state and current aim angle on every "input" message, so there's nothing
  // to merge. Applied on the next tick, not immediately.
  setInput(input: InputState): void {
    this.#input = input;
  }

  // One shot, resolved instantly against whatever input is currently stored.
  // No bullet entity, no queue — this runs synchronously the moment the
  // "shoot" message arrives, ahead of the next tick if one's close. A no-op
  // outside "running" — no pre-start plinking, no shooting through a pause.
  shoot(): void {
    if (this.#phase !== "running") return;
    const target = resolveShot(this.#player.pos, this.#input.aimAngle, this.#zombies);
    if (!target) {
      console.log("shoot: no zombie in range/cone");
      return;
    }
    target.hp -= PISTOL_DAMAGE;
    console.log(`shoot: hit ${target.id}, hp -> ${target.hp}`);
    if (target.hp <= 0) this.#killZombie(target, "player shot");
  }

  // The X-menu's actions. Every check the brief calls for happens here,
  // server-side, regardless of what the client thinks is true: range against
  // the server's own player position, XP against the server's own balance,
  // and the current building state. A failed check just logs and returns —
  // no partial effect, no XP spent on a rejected action.
  interact(action: InteractAction): void {
    if (this.#phase !== "running") return;
    if (distance(this.#player.pos, BASE_POS) > BASE_INTERACT_RANGE) {
      console.log(`interact(${action}): player out of range`);
      return;
    }

    const progress = this.#progress.get();
    switch (action) {
      case "build_wall":
        this.#buildWall(progress);
        break;
      case "upgrade_wall":
        this.#upgradeWall(progress);
        break;
    }
  }

  // The follow-up to picking "Build Turret" from the menu: the client enters
  // placement mode on its own (no message sent yet) and only sends this once
  // the player clicks a spot it judged valid. Every check here re-runs
  // independently of that client-side judgement — phase, range-to-base (the
  // same check interact() uses), "not already built" (one turret this
  // round), cost, and whether (x, y) itself actually falls inside the
  // allowed ring. The client never gets the final say on where it ends up.
  placeTurret(x: number, y: number): void {
    if (this.#phase !== "running") return;
    if (distance(this.#player.pos, BASE_POS) > BASE_INTERACT_RANGE) {
      console.log("place_turret: player out of range");
      return;
    }
    const progress = this.#progress.get();
    if (progress.turretBuilt) {
      console.log("place_turret: already built");
      return;
    }
    const config = TURRET_LEVELS[1];
    if (config.cost === null) {
      console.log("place_turret: not priced yet");
      return;
    }
    if (progress.sharedXp < config.cost) {
      console.log(`place_turret: need ${config.cost} XP, have ${progress.sharedXp}`);
      return;
    }
    const spot: Vec2 = { x, y };
    const d = distance(spot, BASE_POS);
    if (d < BASE_ATTACK_RANGE || d > TURRET_BUILD_RADIUS) {
      console.log(`place_turret: (${x}, ${y}) is outside the allowed ring (${BASE_ATTACK_RANGE}-${TURRET_BUILD_RADIUS} from base)`);
      return;
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
  }

  #buildWall(progress: Readonly<Progress>): void {
    if (progress.wallLevel !== 0) {
      console.log("build_wall: a wall already stands (upgrade or wait for it to fall, not rebuild)");
      return;
    }
    const config = WALL_LEVELS[1];
    if (progress.sharedXp < config.cost!) {
      console.log(`build_wall: need ${config.cost} XP, have ${progress.sharedXp}`);
      return;
    }
    this.#progress.update({
      sharedXp: progress.sharedXp - config.cost!,
      wallLevel: 1,
      wallHp: config.maxHp,
      wallMaxHp: config.maxHp,
    });
    this.#progress.flush();
    console.log(`built wall level 1 (-${config.cost} XP)`);
  }

  #upgradeWall(progress: Readonly<Progress>): void {
    const nextLevel = progress.wallLevel + 1;
    const config = WALL_LEVELS[nextLevel];
    if (progress.wallLevel === 0) {
      console.log("upgrade_wall: no wall to upgrade — build one first");
      return;
    }
    if (progress.wallLevel >= WALL_MAX_LEVEL || !config || config.cost === null) {
      console.log("upgrade_wall: no further priced upgrade available");
      return;
    }
    if (progress.sharedXp < config.cost) {
      console.log(`upgrade_wall: need ${config.cost} XP, have ${progress.sharedXp}`);
      return;
    }
    this.#progress.update({
      sharedXp: progress.sharedXp - config.cost,
      wallLevel: nextLevel,
      wallMaxHp: config.maxHp,
      wallHp: config.maxHp, // upgrading restores to the new level's full HP
    });
    this.#progress.flush();
    console.log(`upgraded wall to level ${nextLevel} (-${config.cost} XP)`);
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
      player: { x: this.#player.pos.x, y: this.#player.pos.y, hp: this.#player.hp },
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
    movePlayer(this.#player, this.#input, dtMs);
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
