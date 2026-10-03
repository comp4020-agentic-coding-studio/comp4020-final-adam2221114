import type { ClientMessage } from "./protocol.ts";

// Reads keyboard + mouse and sends what the server asked for (input/shoot).
// Never moves anything locally and never decides a hit — position, HP, XP
// all come back from the server's own state broadcast. getAimAngle() and
// getMouseWorldPos() are exposed only so the renderer can draw local cues
// (aim line, crosshair, the oriented character); neither is a game decision.
export class InputController {
  readonly #canvas: HTMLCanvasElement;
  readonly #worldSize: number;
  readonly #send: (msg: ClientMessage) => void;
  readonly #getPlayerPos: () => { x: number; y: number };
  readonly #onShoot: (origin: { x: number; y: number }, aimAngle: number) => void;
  readonly #keys = { up: false, down: false, left: false, right: false };
  #mouseWorldPos: { x: number; y: number } | undefined;

  constructor(opts: {
    canvas: HTMLCanvasElement;
    worldSize: number;
    send: (msg: ClientMessage) => void;
    getPlayerPos: () => { x: number; y: number };
    onShoot?: (origin: { x: number; y: number }, aimAngle: number) => void;
  }) {
    this.#canvas = opts.canvas;
    this.#worldSize = opts.worldSize;
    this.#send = opts.send;
    this.#getPlayerPos = opts.getPlayerPos;
    this.#onShoot = opts.onShoot ?? (() => {});

    window.addEventListener("keydown", (e) => this.#onKey(e.key, true));
    window.addEventListener("keyup", (e) => this.#onKey(e.key, false));
    this.#canvas.addEventListener("mousemove", (e) => this.#onMouseMove(e));
    this.#canvas.addEventListener("click", () => this.#onClick());

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

  getMoveState(): { up: boolean; down: boolean; left: boolean; right: boolean } {
    return { ...this.#keys };
  }

  // undefined until the first mousemove — nothing to draw a crosshair at yet.
  getMouseWorldPos(): { x: number; y: number } | undefined {
    return this.#mouseWorldPos;
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
    }
  }

  #onMouseMove(e: MouseEvent): void {
    const rect = this.#canvas.getBoundingClientRect();
    const scale = this.#canvas.width / this.#worldSize;
    this.#mouseWorldPos = {
      x: (e.clientX - rect.left) / scale,
      y: (e.clientY - rect.top) / scale,
    };
  }

  #onClick(): void {
    this.#send({ type: "shoot" });
    // Fired immediately on click rather than waiting for the server's next
    // broadcast to confirm — the hit is resolved server-side regardless; this
    // is purely so the tracer/muzzle-flash feel instant.
    this.#onShoot(this.#getPlayerPos(), this.getAimAngle());
  }

  #sendInput(): void {
    this.#send({ type: "input", move: this.getMoveState(), aimAngle: this.getAimAngle() });
  }
}
