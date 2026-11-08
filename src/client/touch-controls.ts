import type { InputController } from "./input.ts";

// Mobile touch controls: a virtual D-pad, an ATTACK button, drag-to-aim on
// the canvas, and 3 contextual action buttons (menu/revive/medkit). This
// file owns ONLY event wiring — every button here calls straight into
// InputController's existing setDirectionHeld/setReviving/triggerShot/
// setAimWorldPos (the exact same state keyboard/mouse already drive) or a
// callback main.ts already uses for its own keyboard shortcuts (sendInteract/
// sendUseMedkit/the X-menu open logic) — there is no second, parallel
// movement/combat/menu implementation for mobile, per the brief's explicit
// "reuse the existing movement/input pipeline" instruction.
//
// Created and shown ONLY on a device this file itself detects as touch-
// capable (isTouchCapable, below) — never gated on window width, since a
// touch-capable device is touch-capable regardless of how its window is
// currently sized, and a narrow DESKTOP window (mouse + keyboard, just a
// small browser) must never show this overlay. index.html's CSS keys every
// touch-control rule off body.touch-ui, which only this file's constructor
// ever adds.

// Chrome DevTools' device emulation (and real touch hardware) both report a
// coarse primary pointer and touch support — checking both (not just one)
// avoids a false positive on a desktop with a touchscreen monitor but a
// mouse as the actual primary pointer (coarse-pointer alone would wrongly
// show touch controls there) and a false negative on an older mobile
// browser that doesn't support the newer `any-pointer` media query
// (maxTouchPoints alone covers that case).
export function isTouchCapable(): boolean {
  const coarsePrimary = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const hasTouchPoints = navigator.maxTouchPoints > 0;
  return coarsePrimary && hasTouchPoints;
}

// How often a held ATTACK button fires another shot. shoot() has no
// server-side cooldown of its own (desktop just fires once per mouse
// click — "however fast you click"), so holding ATTACK needs its OWN
// deliberately-chosen interval rather than reusing a cooldown that doesn't
// exist; 180ms is a fast-but-deliberate rate a human could plausibly click
// at by hand, chosen so mobile's practical fire rate isn't wildly different
// from a desktop player clicking normally.
const ATTACK_FIRE_INTERVAL_MS = 180;

interface ActionsState {
  // The exact label text main.ts's own [X]-hint would show ("Base Menu" /
  // "Turret Menu") — undefined hides the button entirely (nothing to open
  // right now, mirroring updatePrompt's own hint logic exactly).
  menuLabel: string | undefined;
  canRevive: boolean;
  canUseMedkit: boolean;
}

export class TouchControls {
  readonly #input: InputController;
  readonly #canvas: HTMLCanvasElement;
  readonly #onOpenMenu: () => void;
  readonly #onUseMedkit: () => void;

  readonly #menuBtn: HTMLButtonElement;
  readonly #reviveBtn: HTMLButtonElement;
  readonly #medkitBtn: HTMLButtonElement;

  // Every #bindHold's own "force this button released" callback, collected
  // so #clearAll can reset every held touch control (D-pad, ATTACK, REVIVE)
  // in one pass without a DOM query — see #bindHold's last argument.
  readonly #releaseAllHeld: Array<() => void> = [];

  // The one active aim-drag pointer (undefined when no finger is currently
  // dragging on the canvas) — only ONE pointer ever drives aim at a time;
  // a second finger touching the canvas while the first is still down is
  // ignored rather than fought over, since "which of two simultaneous drags
  // is the real aim" has no sensible answer.
  #aimPointerId: number | undefined;

  constructor(opts: {
    input: InputController;
    canvas: HTMLCanvasElement;
    onOpenMenu: () => void;
    onUseMedkit: () => void;
  }) {
    this.#input = opts.input;
    this.#canvas = opts.canvas;
    this.#onOpenMenu = opts.onOpenMenu;
    this.#onUseMedkit = opts.onUseMedkit;

    document.body.classList.add("touch-ui");

    // --- D-pad: 4 independent hold-buttons, each bound to its own
    // setDirectionHeld call — holding two at once (e.g. up+right) is just
    // two independent booleans becoming true, which InputController's
    // existing getMoveState()/movePlayer's dx/dy/hypot normalisation already
    // turns into correct diagonal movement with no touch-specific code. ---
    const dpad = document.createElement("div");
    dpad.className = "touch-dpad";
    const dirBtn = (cls: string, label: string, dir: "up" | "down" | "left" | "right"): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.className = `touch-dpad-btn ${cls}`;
      btn.textContent = label;
      btn.setAttribute("aria-label", dir);
      this.#bindHold(btn, (held) => this.#input.setDirectionHeld(dir, held));
      dpad.appendChild(btn);
      return btn;
    };
    dirBtn("touch-dpad-up", "▲", "up");
    dirBtn("touch-dpad-left", "◀", "left");
    dirBtn("touch-dpad-down", "▼", "down");
    dirBtn("touch-dpad-right", "▶", "right");
    document.body.appendChild(dpad);

    // --- ATTACK: holding fires repeatedly at ATTACK_FIRE_INTERVAL_MS using
    // whatever the player last aimed at (via the canvas drag below, or
    // straight ahead — angle 0 — if they haven't dragged yet this session,
    // identical to desktop's getAimAngle() returning 0 with no mouse
    // movement yet). Fires once immediately on press too, so a quick tap
    // still shoots rather than requiring a hold to register at all. ---
    const attackBtn = document.createElement("button");
    attackBtn.className = "touch-attack";
    attackBtn.textContent = "ATTACK";
    attackBtn.setAttribute("aria-label", "attack");
    let attackInterval: ReturnType<typeof setInterval> | undefined;
    this.#bindHold(
      attackBtn,
      (held) => {
        if (held) {
          this.#input.triggerShot();
          attackInterval = setInterval(() => this.#input.triggerShot(), ATTACK_FIRE_INTERVAL_MS);
        } else if (attackInterval !== undefined) {
          clearInterval(attackInterval);
          attackInterval = undefined;
        }
      },
    );
    document.body.appendChild(attackBtn);

    // --- Contextual actions: MENU (opens the base/turret X-menu — same
    // nearestTurretInRange/playerInBaseRange decision main.ts's own X key
    // handler already makes, via the onOpenMenu callback) and MEDKIT (one
    // tap = sendUseMedkit(), same as pressing H once) are one-shot taps;
    // REVIVE is a hold (setReviving while held), matching "[Hold E] Revive"'s
    // own hold semantics exactly. All three are hidden by default and only
    // shown by updateActions() below, under the SAME conditions main.ts's
    // updatePrompt() already computes for the keyboard-hint text version. ---
    const actionsRow = document.createElement("div");
    actionsRow.className = "touch-actions";
    this.#menuBtn = document.createElement("button");
    this.#menuBtn.className = "touch-action-btn";
    this.#menuBtn.hidden = true;
    this.#menuBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.#onOpenMenu();
    });
    this.#reviveBtn = document.createElement("button");
    this.#reviveBtn.className = "touch-action-btn";
    this.#reviveBtn.textContent = "HOLD\nREVIVE";
    this.#reviveBtn.hidden = true;
    this.#bindHold(this.#reviveBtn, (held) => this.#input.setReviving(held));
    this.#medkitBtn = document.createElement("button");
    this.#medkitBtn.className = "touch-action-btn";
    this.#medkitBtn.textContent = "MEDKIT";
    this.#medkitBtn.hidden = true;
    this.#medkitBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.#onUseMedkit();
    });
    actionsRow.append(this.#menuBtn, this.#reviveBtn, this.#medkitBtn);
    document.body.appendChild(actionsRow);

    // --- Drag-to-aim on the canvas itself (NOT the ATTACK button) — a
    // touch pointerdown/pointermove anywhere on the canvas sets the aim
    // angle the same way desktop's mousemove does (via InputController's
    // own screenPointToWorld, so it accounts for canvas backing-store
    // scaling/camera pan/zoom identically to desktop), without ALSO firing
    // a shot the way a desktop mouse click does — preventDefault() stops
    // the browser from synthesising a click from this touch, keeping
    // "aim" and "attack" as the two genuinely separate controls the brief
    // asks for (ATTACK is the only path that ever calls triggerShot from
    // touch). The aim angle simply holds at its last value once the finger
    // lifts, same as desktop's aim holding at the mouse's last position. ---
    this.#canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch" || this.#aimPointerId !== undefined) return;
      e.preventDefault();
      this.#aimPointerId = e.pointerId;
      this.#input.setAimWorldPos(this.#input.screenPointToWorld(e.clientX, e.clientY));
    });
    this.#canvas.addEventListener("pointermove", (e) => {
      if (e.pointerId !== this.#aimPointerId) return;
      this.#input.setAimWorldPos(this.#input.screenPointToWorld(e.clientX, e.clientY));
    });
    const releaseAimPointer = (e: PointerEvent): void => {
      if (e.pointerId === this.#aimPointerId) this.#aimPointerId = undefined;
    };
    this.#canvas.addEventListener("pointerup", releaseAimPointer);
    this.#canvas.addEventListener("pointercancel", releaseAimPointer);

    // See #clearAll's own comment for why blur/visibilitychange matter here.
    window.addEventListener("blur", () => this.#clearAll());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.#clearAll();
    });
  }

  // Shows/hides the 3 contextual buttons — called from main.ts's own
  // updatePrompt() with the exact same booleans it already computed for the
  // keyboard-hint text, so touch and desktop can never disagree about when
  // an action is actually available.
  updateActions(state: ActionsState): void {
    this.#menuBtn.hidden = state.menuLabel === undefined;
    this.#menuBtn.textContent = state.menuLabel ?? "";
    this.#reviveBtn.hidden = !state.canRevive;
    this.#medkitBtn.hidden = !state.canUseMedkit;
  }

  // A held-button helper: tracks the Set of pointerIds currently down on
  // THIS element only, so (a) two different buttons each manage their own
  // independent held-state with no shared/global pointerId table to get
  // confused, and (b) the rare case of two fingers both landing on the SAME
  // button still reports "released" only once the LAST of them lifts, not
  // the first — releasing one finger never cancels another's still-active
  // press on a DIFFERENT button, which falls out for free from each
  // button owning its own Set. Also registers this button's own forced-
  // release into #releaseAllHeld, for #clearAll's blur/visibilitychange
  // recovery below.
  #bindHold(el: HTMLButtonElement, onChange: (held: boolean) => void): void {
    const active = new Set<number>();
    const updateVisual = (): void => {
      el.classList.toggle("held", active.size > 0);
    };
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const wasEmpty = active.size === 0;
      active.add(e.pointerId);
      el.setPointerCapture(e.pointerId);
      updateVisual();
      if (wasEmpty) onChange(true);
    });
    const release = (e: PointerEvent): void => {
      if (!active.has(e.pointerId)) return;
      active.delete(e.pointerId);
      updateVisual();
      if (active.size === 0) onChange(false);
    };
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
    this.#releaseAllHeld.push(() => {
      if (active.size === 0) return;
      active.clear();
      updateVisual();
      onChange(false);
    });
  }

  // Window/tab losing focus mid-touch (an OS gesture taking over, a push
  // notification, switching apps) can leave a pointerup/pointercancel
  // undelivered — the same "stuck held key" failure InputController's own
  // blur/visibilitychange handling already guards against for the keyboard.
  // Releasing every #bindHold button (which each already call back into
  // setDirectionHeld/setReviving/the attack interval) covers all of them in
  // one pass, with no separate direct calls needed here.
  #clearAll(): void {
    for (const release of this.#releaseAllHeld) release();
    this.#aimPointerId = undefined;
  }
}
