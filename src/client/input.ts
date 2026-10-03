import type { ClientMessage } from "./protocol.ts";

// Reads keyboard + mouse and sends what the server asked for (input/shoot).
// Never moves anything locally and never decides a hit — position, HP, XP
// all come back from the server's own state broadcast. getAimAngle() is
// exposed only so the renderer can draw a local aim-direction cue; that's a
// UI indicator of what the player is about to do, not a game decision.
export class InputController {
  readonly #canvas: HTMLCanvasElement;
  readonly #worldSize: number;
  readonly #send: (msg: ClientMessage) => void;
  readonly #getPlayerPos: () => { x: number; y: number };
  readonly #keys = { up: false, down: false, left: false, right: false };
  #aimAngle = 0;

  constructor(opts: {
    canvas: HTMLCanvasElement;
    worldSize: number;
    send: (msg: ClientMessage) => void;
    getPlayerPos: () => { x: number; y: number };
  }) {
    this.#canvas = opts.canvas;
    this.#worldSize = opts.worldSize;
    this.#send = opts.send;
    this.#getPlayerPos = opts.getPlayerPos;

    window.addEventListener("keydown", (e) => this.#onKey(e.key, true));
    window.addEventListener("keyup", (e) => this.#onKey(e.key, false));
    this.#canvas.addEventListener("mousemove", (e) => this.#onMouseMove(e));
    this.#canvas.addEventListener("click", () => this.#send({ type: "shoot" }));

    // Held-key state and aim angle change continuously; sending on an
    // interval (rather than wiring every single keydown/mousemove to its own
    // send) keeps this simple and gives the server a steady stream either way.
    setInterval(() => this.#sendInput(), 100);
  }

  getAimAngle(): number {
    return this.#aimAngle;
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
    const mouseWorldX = (e.clientX - rect.left) / scale;
    const mouseWorldY = (e.clientY - rect.top) / scale;
    const player = this.#getPlayerPos();
    this.#aimAngle = Math.atan2(mouseWorldY - player.y, mouseWorldX - player.x);
  }

  #sendInput(): void {
    this.#send({ type: "input", move: { ...this.#keys }, aimAngle: this.#aimAngle });
  }
}
