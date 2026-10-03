import type { PersistedState } from "./persisted-state.ts";
import type { StateMessage } from "./protocol.ts";
import {
  DAY_DURATION_MS,
  PLAYER_MAX_HP,
  PLAYER_START_POS,
  ZOMBIE_ATTACK_DAMAGE,
  ZOMBIE_ATTACK_INTERVAL_MS,
  spawnZombie,
  spawnsForDay,
  stepZombie,
  type Player,
  type Zombie,
} from "./game-state.ts";

const TICK_MS = 200;

// Server-authoritative, in-memory, single tick loop. Zombie positions and HP
// live only here — day/baseHp/level/XP are the only things that go through
// PersistedState, and only day-change calls flush() directly; base HP
// changes go through the dirty-state path like everything else.
//
// No networking, no rendering, no player, no walls or turrets this step —
// those are Step 4/5/final, not this one. Logged to the console so the loop
// is observable without either of those.
export class GameLoop {
  readonly #progress: PersistedState;
  readonly #zombies: Zombie[] = [];
  // Static this step — no WASD/shoot until Step 4, so nothing moves or
  // damages it yet. Present so getSnapshot() has a real player to report.
  readonly #player: Player = { pos: { ...PLAYER_START_POS }, hp: PLAYER_MAX_HP };
  #dayElapsedMs = 0;
  #spawnedThisDay = 0;
  #spawnTargetThisDay: number;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(progress: PersistedState) {
    this.#progress = progress;
    this.#spawnTargetThisDay = spawnsForDay(progress.get().day);
  }

  // Read-only view for the WS layer to broadcast. Never mutates anything —
  // the only writer of game state is the tick loop itself.
  getSnapshot(): StateMessage {
    const progress = this.#progress.get();
    return {
      type: "state",
      day: progress.day,
      baseHp: progress.baseHp,
      baseMaxHp: progress.baseMaxHp,
      baseLevel: progress.baseLevel,
      sharedXp: progress.sharedXp,
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
