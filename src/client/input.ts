import type { ClientMessage } from "./protocol.ts";

export interface MoveState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

// Reads keyboard + mouse and sends what the server asked for (input/shoot).
// Never moves anything locally and never decides a hit — position, HP, XP
// all come back from the server's own state broadcast. getAimAngle() and
// getMouseWorldPos() are exposed only so the renderer can draw local cues
// (aim line, crosshair, the oriented character); neither is a game decision.
//
// screenToWorld is injected rather than this class owning a camera.ts
// Camera itself (feature/3d-migration) — the 2D client passes camera.ts's
// own screenToWorld bound to its 2D orthographic Camera, the 3D prototype
// (src/client/three/scene.ts) passes its ground-plane raycast version —
// same {x, y} world-space contract either way, so this class needs no
// knowledge of which renderer is driving it.
export class InputController {
  readonly #canvas: HTMLCanvasElement;
  readonly #screenToWorld: (canvasX: number, canvasY: number) => { x: number; y: number };
  readonly #send: (msg: ClientMessage) => void;
  readonly #getPlayerPos: () => { x: number; y: number };
  readonly #onShoot: (origin: { x: number; y: number }, aimAngle: number) => void;
  // Raw WASD/arrow state as physically pressed. For the 2D client this
  // already IS wire-protocol up/down/left/right (the 2D camera has no
  // rotation, so "screen up" and "world up" coincide). For the 3D client
  // (fixed 45°-azimuth isometric camera) it is screen-relative intent only
  // — #moveKeyRemap below converts it to the wire shape before it's ever
  // read by getMoveState() or sent, so prediction.ts and the wire message
  // always see the same already-remapped values (see
  // src/client/three/isometric-input.ts).
  readonly #keys = { up: false, down: false, left: false, right: false, reviving: false };
  readonly #moveKeyRemap: (raw: MoveState) => MoveState;
  #mouseWorldPos: { x: number; y: number } | undefined;

  constructor(opts: {
    canvas: HTMLCanvasElement;
    screenToWorld: (canvasX: number, canvasY: number) => { x: number; y: number };
    send: (msg: ClientMessage) => void;
    getPlayerPos: () => { x: number; y: number };
    onShoot?: (origin: { x: number; y: number }, aimAngle: number) => void;
    moveKeyRemap?: (raw: MoveState) => MoveState;
  }) {
    this.#canvas = opts.canvas;
    this.#screenToWorld = opts.screenToWorld;
    this.#send = opts.send;
    this.#getPlayerPos = opts.getPlayerPos;
    this.#onShoot = opts.onShoot ?? (() => {});
    this.#moveKeyRemap = opts.moveKeyRemap ?? ((raw) => raw);

    window.addEventListener("keydown", (e) => this.#onKey(e.key, true));
    window.addEventListener("keyup", (e) => this.#onKey(e.key, false));
    this.#canvas.addEventListener("mousemove", (e) => this.#onMouseMove(e));
    this.#canvas.addEventListener("click", () => this.#onClick());

    // A key physically held when the window loses focus (alt-tab, clicking
    // devtools, switching browser tabs) can have its matching keyup delivered
    // to a DIFFERENT window — or never delivered at all — so without this the
    // held direction gets stuck "on" forever (this was Bug 4: "character
    // keeps moving up with no way to stop it" — reproduced by holding W,
    // switching focus away, then back, then releasing W: the up movement
    // continued straight through that keyup). Clearing all held state on
    // blur, and again defensively when visibility changes (covers tab-switch
    // cases some browsers fire without an accompanying window blur), means a
    // stuck key can survive at most until the next focus loss, not the rest
    // of the session.
    window.addEventListener("blur", () => this.#clearHeldKeys());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.#clearHeldKeys();
    });

    // Held-key state and aim angle change continuously; sending on an
    // interval (rather than wiring every single keydown/mousemove to its own
    // send) keeps this simple. 50ms matches the server's own 20Hz tick, so a
    // held key shows up server-side within one tick instead of lagging
    // noticeably behind the new, much faster simulation.
    setInterval(() => this.#sendInput(), 50);
  }

  // Recomputed from the latest mouse position and the CURRENT player
  // position every time this is called, not cached from whenever the mouse
  // last moved — the player now moves every animation frame (prediction), so
  // a cached angle would visibly drift off the mouse while walking without
  // touching it.
  getAimAngle(): number {
    if (!this.#mouseWorldPos) return 0;
    const player = this.#getPlayerPos();
    return Math.atan2(this.#mouseWorldPos.y - player.y, this.#mouseWorldPos.x - player.x);
  }

  getMoveState(): MoveState {
    return this.#moveKeyRemap({ up: this.#keys.up, down: this.#keys.down, left: this.#keys.left, right: this.#keys.right });
  }

  // Whether E is currently held — the continuous hold-to-revive input,
  // polled the same way the move keys are rather than sent as a one-shot
  // message, since "hold for 3 seconds" is exactly the move keys' shape.
  isReviving(): boolean {
    return this.#keys.reviving;
  }

  // undefined until the first mousemove — nothing to draw a crosshair at yet.
  getMouseWorldPos(): { x: number; y: number } | undefined {
    return this.#mouseWorldPos;
  }

  #clearHeldKeys(): void {
    this.#keys.up = false;
    this.#keys.down = false;
    this.#keys.left = false;
    this.#keys.right = false;
    this.#keys.reviving = false;
  }

  #onKey(key: string, down: boolean): void {
    switch (key.toLowerCase()) {
      case "w":
      case "arrowup":
        this.#keys.up = down;
        break;
      case "s":
      case "arrowdown":
        this.#keys.down = down;
        break;
      case "a":
      case "arrowleft":
        this.#keys.left = down;
        break;
      case "d":
      case "arrowright":
        this.#keys.right = down;
        break;
      case "e":
        this.#keys.reviving = down;
        break;
    }
  }

  #onMouseMove(e: MouseEvent): void {
    const rect = this.#canvas.getBoundingClientRect();
    // getBoundingClientRect() is in CSS pixels, which can differ from the
    // canvas's own backing-store width/height if CSS ever scales it — divide
    // out that ratio before converting through the camera, whose origin/
    // scale are expressed in backing-store pixels (canvas.width/height).
    // Computed per axis (not one shared ratio) since the canvas now fills
    // the whole, possibly non-square, window — width and height can scale
    // differently.
    const cssToBackingX = this.#canvas.width / rect.width;
    const cssToBackingY = this.#canvas.height / rect.height;
    const canvasX = (e.clientX - rect.left) * cssToBackingX;
    const canvasY = (e.clientY - rect.top) * cssToBackingY;
    this.#mouseWorldPos = this.#screenToWorld(canvasX, canvasY);
  }

  #onClick(): void {
    this.#send({ type: "shoot" });
    // Fired immediately on click rather than waiting for the server's next
    // broadcast to confirm — the hit is resolved server-side regardless; this
    // is purely so the tracer/muzzle-flash feel instant.
    this.#onShoot(this.#getPlayerPos(), this.getAimAngle());
  }

  #sendInput(): void {
    this.#send({ type: "input", move: this.getMoveState(), aimAngle: this.getAimAngle(), reviving: this.#keys.reviving });
  }
}
