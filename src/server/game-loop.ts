import type { PersistedState } from "./persisted-state.ts";
import { DEFAULT_PROGRESS } from "./persistence.ts";
import type { GamePhase, StateMessage } from "./protocol.ts";
import {
  DAY_VICTORY,
  LEVEL_UP_THRESHOLDS,
  PISTOL_DAMAGE,
  PLAYER_MAX_HP,
  PLAYER_START_POS,
  WALL_MAX_HP,
  XP_PER_KILL,
  ZOMBIE_ATTACK_DAMAGE,
  ZOMBIE_ATTACK_INTERVAL_MS,
  movePlayer,
  resolveShot,
  spawnZombie,
  stepZombie,
  zombiesForDay,
  type InputState,
  type Player,
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

// Server-authoritative, in-memory tick loop. Zombie/player positions and HP
// live only here — day/baseHp/baseLevel/sharedXp/wallHp are the only things
// that go through PersistedState, and only day-change, level-up and wall/
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
// Playability polish: a round phase gates the tick (waiting/paused/game_over/
// victory all freeze zombies, spawning, day and the player — only "running"
// ticks). phase itself is NOT persisted: every process boot starts at
// "waiting" regardless of what day/baseHp/etc were left at, so a stranger
// always gets a deliberate Start moment, and whatever was persisted is just
// what they see on the HUD until they press it. restart() is the only thing
// that resets day/baseHp/baseLevel/sharedXp/wallHp themselves — a plain boot
// leaves them exactly as persisted.
export class GameLoop {
  readonly #progress: PersistedState;
  readonly #zombies: Zombie[] = [];
  readonly #player: Player = { pos: { ...PLAYER_START_POS }, hp: PLAYER_MAX_HP };
  #input: InputState = { up: false, down: false, left: false, right: false, aimAngle: 0 };
  #phase: GamePhase = "waiting";
  #clockMs = 0; // monotonic; only ever used for zombie attack-cooldown timestamps
  #spawnTimerMs = 0;
  #spawnedZombies = 0;
  #killedZombies = 0;
  #totalZombiesForDay: number;
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
  // level-up or day change. DEFAULT_PROGRESS.wallHp is 0 and baseLevel is 0
  // together — the wall doesn't exist again until baseLevel is re-earned.
  restart(): void {
    this.#zombies.length = 0;
    this.#spawnedZombies = 0;
    this.#killedZombies = 0;
    this.#spawnTimerMs = 0;
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
    if (target.hp <= 0) {
      this.#zombies.splice(this.#zombies.indexOf(target), 1);
      this.#killedZombies++;
      console.log(`zombie ${target.id} died (${this.#killedZombies}/${this.#totalZombiesForDay})`);
      this.#awardXp(XP_PER_KILL);
      // Spawning can only ever make "all killed" harder to reach, never
      // trigger it — a kill is the only event that can newly satisfy the
      // wave-complete condition, so that's the only place it needs checking.
      this.#checkWaveComplete();
    }
  }

  // Shared XP always marks dirty (periodic save picks it up); a level-up
  // crossed in the same award flushes immediately after, same as day change.
  // Crossing into baseLevel 1 is also when the wall first exists — it starts
  // at full HP the moment it's unlocked.
  #awardXp(amount: number): void {
    const before = this.#progress.get();
    const sharedXp = before.sharedXp + amount;
    let baseLevel = before.baseLevel;
    while (LEVEL_UP_THRESHOLDS[baseLevel] !== undefined && sharedXp >= LEVEL_UP_THRESHOLDS[baseLevel]) {
      baseLevel++;
    }
    const leveledUp = baseLevel > before.baseLevel;
    const wallJustUnlocked = before.baseLevel < 1 && baseLevel >= 1;
    this.#progress.update({
      sharedXp,
      baseLevel,
      ...(wallJustUnlocked ? { wallHp: WALL_MAX_HP } : {}),
    });
    console.log(
      `sharedXp ${before.sharedXp} -> ${sharedXp}` +
        (leveledUp ? `, baseLevel ${before.baseLevel} -> ${baseLevel}` : "") +
        (wallJustUnlocked ? ` (wall up, wallHp -> ${WALL_MAX_HP})` : ""),
    );
    if (leveledUp) this.#progress.flush(); // level-up flushes immediately, like day change
  }

  // The only way "all of this day's zombies are spawned and dead" becomes
  // true is a kill (see shoot()), so this only ever needs calling from there.
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
  // the only writers of game state are shoot() and the tick loop itself.
  getSnapshot(): StateMessage {
    const progress = this.#progress.get();
    return {
      type: "state",
      phase: this.#phase,
      day: progress.day,
      baseHp: progress.baseHp,
      baseMaxHp: progress.baseMaxHp,
      baseLevel: progress.baseLevel,
      sharedXp: progress.sharedXp,
      wallHp: progress.wallHp,
      wallMaxHp: progress.wallMaxHp,
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

  // Wall first, base second: the wall absorbs every hit while it still has
  // HP, and only once it's at 0 does damage reach the base at all. One
  // undivided wall HP pool this round — no per-segment wall, no repair.
  #updateZombies(): void {
    const now = this.#clockMs;
    for (const z of this.#zombies) {
      stepZombie(z, TICK_MS);
      if (z.attacking && now - z.lastAttackAt >= ZOMBIE_ATTACK_INTERVAL_MS) {
        z.lastAttackAt = now;
        this.#applyZombieHit(z.id);
      }
    }
  }

  #applyZombieHit(zombieId: string): void {
    const progress = this.#progress.get();
    if (progress.wallHp > 0) {
      const wallHp = Math.max(0, progress.wallHp - ZOMBIE_ATTACK_DAMAGE);
      this.#progress.update({ wallHp });
      console.log(`zombie ${zombieId} hits the wall: wallHp ${progress.wallHp} -> ${wallHp}`);
      if (wallHp <= 0) {
        this.#progress.flush(); // the wall falling is worth not losing, same as a level-up
        console.log("wall destroyed: the base is exposed");
      }
      return;
    }

    const baseHp = Math.max(0, progress.baseHp - ZOMBIE_ATTACK_DAMAGE);
    this.#progress.update({ baseHp });
    console.log(`zombie ${zombieId} hits the base: baseHp ${progress.baseHp} -> ${baseHp}`);
    if (baseHp <= 0) {
      this.#phase = "game_over";
      this.#progress.flush();
      console.log("base destroyed: phase -> game_over");
    }
  }
}
