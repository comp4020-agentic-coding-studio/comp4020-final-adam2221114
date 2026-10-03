import type Database from "better-sqlite3";
import { loadState, saveState, type Progress } from "./persistence.ts";

// Dirty-state + periodic save: gameplay mutates the in-memory copy freely
// (every zombie tick would otherwise mean a write), and a timer flushes to
// SQLite only when something has actually changed since the last save. Day
// change, level-up and shutdown call flush() directly instead of waiting for
// the timer, since those are the moments worth not losing to a crash.
const SAVE_INTERVAL_MS = 3000; // within the agreed 2-5s window

export class PersistedState {
  readonly #db: Database.Database;
  #state: Progress;
  #dirty = false;
  #timer: ReturnType<typeof setInterval>;

  constructor(db: Database.Database) {
    this.#db = db;
    this.#state = loadState(db);
    this.#timer = setInterval(() => {
      if (this.#dirty) this.flush();
    }, SAVE_INTERVAL_MS);
  }

  get(): Readonly<Progress> {
    return this.#state;
  }

  // Merges a partial update into the in-memory state and marks it dirty.
  // Does not touch SQLite — that's the periodic timer's job, or an explicit
  // flush() for the moments that need one.
  update(patch: Partial<Progress>): void {
    this.#state = { ...this.#state, ...patch };
    this.#dirty = true;
  }

  flush(): void {
    saveState(this.#db, this.#state);
    this.#dirty = false;
  }

  // Stops the periodic timer. Callers still own calling flush() first if an
  // unsaved change should survive.
  stop(): void {
    clearInterval(this.#timer);
  }
}
