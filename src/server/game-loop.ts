import type { PersistedState } from "./persisted-state.ts";
import type { StateMessage } from "./protocol.ts";
import {
  DAY_DURATION_MS,
  LEVEL_UP_THRESHOLDS,
  PISTOL_DAMAGE,
  PLAYER_MAX_HP,
  PLAYER_START_POS,
  XP_PER_KILL,
  ZOMBIE_ATTACK_DAMAGE,
  ZOMBIE_ATTACK_INTERVAL_MS,
  movePlayer,
  resolveShot,
  spawnZombie,
  spawnsForDay,
  stepZombie,
  type InputState,
  type Player,
  type Zombie,
} from "./game-state.ts";

const TICK_MS = 200;

// Server-authoritative, in-memory tick loop. Zombie/player positions and HP
// live only here — day/baseHp/baseLevel/sharedXp are the only things that go
// through PersistedState, and only day-change and level-up flush directly;
// everything else goes through the dirty-state path.
//
// Step 4: WASD moves the player (continuous, driven by stored input) and
// shoot() resolves a shot instantly against it. Still no real client view,
// no walls/turret logic, no second player — those are Step 5/final/crit 9.
export class GameLoop {
  readonly #progress: PersistedState;
  readonly #zombies: Zombie[] = [];
  readonly #player: Player = { pos: { ...PLAYER_START_POS }, hp: PLAYER_MAX_HP };
  #input: InputState = { up: false, down: false, left: false, right: false, aimAngle: 0 };
  #dayElapsedMs = 0;
  #spawnedThisDay = 0;
  #spawnTargetThisDay: number;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(progress: PersistedState) {
    this.#progress = progress;
    this.#spawnTargetThisDay = spawnsForDay(progress.get().day);
  }

  // Replaces the stored input wholesale — the client sends its full held-key
  // state and current aim angle on every "input" message, so there's nothing
  // to merge. Applied on the next tick, not immediately.
  setInput(input: InputState): void {
    this.#input = input;
  }

  // One shot, resolved instantly against whatever input is currently stored.
  // No bullet entity, no queue — this runs synchronously the moment the
  // "shoot" message arrives, ahead of the next tick if one's close.
  shoot(): void {
    const target = resolveShot(this.#player.pos, this.#input.aimAngle, this.#zombies);
    if (!target) {
      console.log("shoot: no zombie in range/cone");
      return;
    }
    target.hp -= PISTOL_DAMAGE;
    console.log(`shoot: hit ${target.id}, hp -> ${target.hp}`);
    if (target.hp <= 0) {
      this.#zombies.splice(this.#zombies.indexOf(target), 1);
      console.log(`zombie ${target.id} died`);
      this.#awardXp(XP_PER_KILL);
    }
  }

  // Shared XP always marks dirty (periodic save picks it up); a level-up
  // crossed in the same award flushes immediately after, same as day change.
  #awardXp(amount: number): void {
    const before = this.#progress.get();
    const sharedXp = before.sharedXp + amount;
    let baseLevel = before.baseLevel;
    while (LEVEL_UP_THRESHOLDS[baseLevel] !== undefined && sharedXp >= LEVEL_UP_THRESHOLDS[baseLevel]) {
      baseLevel++;
    }
    this.#progress.update({ sharedXp, baseLevel });
    const leveledUp = baseLevel > before.baseLevel;
    console.log(
      `sharedXp ${before.sharedXp} -> ${sharedXp}` +
        (leveledUp ? `, baseLevel ${before.baseLevel} -> ${baseLevel} (wall unlocked)` : ""),
    );
    if (leveledUp) this.#progress.flush(); // level-up flushes immediately, like day change
  }

  // Read-only view for the WS layer to broadcast. Never mutates anything —
  // the only writers of game state are shoot() and the tick loop itself.
  getSnapshot(): StateMessage {
    const progress = this.#progress.get();
    return {
      type: "state",
      day: progress.day,
      baseHp: progress.baseHp,
      baseMaxHp: progress.baseMaxHp,
      baseLevel: progress.baseLevel,
      sharedXp: progress.sharedXp,
      wallUnlocked: progress.baseLevel >= 1,
      player: { x: this.#player.pos.x, y: this.#player.pos.y, hp: this.#player.hp },
      zombies: this.#zombies.map((z) => ({ id: z.id, x: z.pos.x, y: z.pos.y, hp: z.hp })),
    };
  }

  start(): void {
    this.#timer = setInterval(() => this.#tick(TICK_MS), TICK_MS);
    console.log(
      `game loop started: day ${this.#progress.get().day}, ${this.#spawnTargetThisDay} zombies scheduled today`,
    );
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  #tick(dtMs: number): void {
    movePlayer(this.#player, this.#input, dtMs);
    this.#maybeSpawn();
    this.#updateZombies();
    this.#advanceDay(dtMs);
  }

  // This day's zombies are spread evenly across it rather than dumped at
  // once, so "zombies keep coming" is visible throughout the day, not just
  // at its start.
  #maybeSpawn(): void {
    if (this.#spawnedThisDay >= this.#spawnTargetThisDay) return;
    const spawnEveryMs = DAY_DURATION_MS / this.#spawnTargetThisDay;
    const due = Math.min(Math.floor(this.#dayElapsedMs / spawnEveryMs), this.#spawnTargetThisDay);
    while (this.#spawnedThisDay < due) {
      const z = spawnZombie();
      this.#zombies.push(z);
      this.#spawnedThisDay++;
      console.log(`zombie ${z.id} spawned at (${z.pos.x.toFixed(0)}, ${z.pos.y.toFixed(0)})`);
    }
  }

  #updateZombies(): void {
    const now = this.#dayElapsedMs;
    for (const z of this.#zombies) {
      stepZombie(z, TICK_MS);
      if (z.attacking && now - z.lastAttackAt >= ZOMBIE_ATTACK_INTERVAL_MS) {
        z.lastAttackAt = now;
        const before = this.#progress.get().baseHp;
        const baseHp = Math.max(0, before - ZOMBIE_ATTACK_DAMAGE);
        this.#progress.update({ baseHp });
        console.log(`zombie ${z.id} hits the base: baseHp ${before} -> ${baseHp}`);
      }
    }
  }

  // Zombies don't carry over between days — they're in-memory only, and a
  // new day starting a fresh wave is simpler than reconciling leftovers. Not
  // the full 28-day curve: just "a bit more each day" (spawnsForDay).
  #advanceDay(dtMs: number): void {
    this.#dayElapsedMs += dtMs;
    if (this.#dayElapsedMs < DAY_DURATION_MS) return;

    this.#dayElapsedMs = 0;
    this.#zombies.length = 0;
    this.#spawnedThisDay = 0;

    const nextDay = this.#progress.get().day + 1;
    this.#progress.update({ day: nextDay });
    this.#progress.flush(); // day change flushes immediately, ahead of the timer
    this.#spawnTargetThisDay = spawnsForDay(nextDay);
    console.log(`day ${nextDay} begins: ${this.#spawnTargetThisDay} zombies scheduled`);
  }
}
