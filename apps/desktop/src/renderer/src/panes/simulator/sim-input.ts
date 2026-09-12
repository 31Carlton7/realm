import { SIM_WS_OPCODE, type SimulatorButton, type SimulatorOrientation, SIMULATOR_BUTTONS } from "@realm/contracts";

/**
 * What Realm sends a simulator, and how.
 *
 * serve-sim's input channel is a WebSocket carrying binary frames of ONE opcode byte followed by
 * UTF-8 JSON. The opcodes are its numbers, not ours (`SIM_WS_OPCODE` in the contract says so), and
 * the shapes below are transcribed from the CLI that speaks them rather than guessed — a gesture
 * with the wrong key names is a tap that silently does nothing, which is the failure mode this whole
 * module exists to avoid.
 *
 * Pure on purpose: the frame builders take no socket, so the encoding can be tested without one.
 */

export const frame = (opcode: number, payload: unknown): Uint8Array => {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const out = new Uint8Array(1 + body.length);
  out[0] = opcode;
  out.set(body, 1);
  return out;
};

/**
 * A point on the picture → the device's own 0..1 coordinates, or null when it is not on the picture.
 *
 * Measured against the PICTURE's rect rather than the pane's, and that is the whole point: with a
 * frame drawn around the screen, the letterbox is no longer the only thing between the pane's edge
 * and the first device pixel — there is a border too. Arithmetic that centred the picture in the
 * pane would be out by the border's thickness, and a tap that lands 12px from the finger is the
 * failure with no visible symptom, because the picture looks perfectly correct.
 *
 * Against the rect, there is nothing to be out BY: whatever the layout did to the picture, its own
 * box is where the device is. `clamped` is for a drag that has left the picture and still has a
 * touch down — it has to keep reporting, or the device is left holding a press nothing lifts.
 */
export function normalizedPoint(
  rect: { left: number; top: number; width: number; height: number },
  client: { clientX: number; clientY: number },
  clamped: boolean,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = (client.clientX - rect.left) / rect.width;
  const y = (client.clientY - rect.top) / rect.height;
  if (clamped) return { x: clamp01(x), y: clamp01(y) };
  return x < 0 || y < 0 || x >= 1 || y >= 1 ? null : { x, y };
}

/** A touch, in NORMALIZED screen coordinates — 0..1 of the device's own screen, which is what the
 *  device speaks. The pane converts from framebuffer pixels; nothing downstream knows about pixels. */
export const gestureFrame = (type: "begin" | "move" | "end", x: number, y: number): Uint8Array =>
  frame(SIM_WS_OPCODE.gesture, { type, x: clamp01(x), y: clamp01(y) });

export const buttonFrame = (button: SimulatorButton): Uint8Array => {
  const hid = SIMULATOR_BUTTONS[button];
  // `home` carries no HID pair at all — the helper maps it itself — and sending one invented for it
  // would be a press of some other button entirely.
  return frame(SIM_WS_OPCODE.button, hid ? { button, ...hid } : { button });
};

export const orientationFrame = (orientation: SimulatorOrientation): Uint8Array =>
  frame(SIM_WS_OPCODE.orientation, { orientation });

export const keyFrame = (type: "down" | "up", usage: number): Uint8Array =>
  frame(SIM_WS_OPCODE.key, { type, usage });

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Left shift, which is what a capital letter and every shifted symbol is made of. */
export const SHIFT_USAGE = 225;

/** The named keys a keyboard sends that are not characters. `e.key` on the left, HID usage on the
 *  right — US keyboard, which is the only layout serve-sim's typing path supports. */
const NAMED: Record<string, number> = {
  Enter: 40, Escape: 41, Backspace: 42, Tab: 43,
  ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82,
  Delete: 76, Home: 74, End: 77, PageUp: 75, PageDown: 78,
};

/** `a`–`z` are 4–29 and `1`–`9` are 30–38 in one run each; `0` sits after `9` rather than before
 *  `1`, which is the one place the HID table stops being arithmetic. */
const PUNCTUATION: Record<string, { usage: number; shift?: true }> = {
  " ": { usage: 44 }, "-": { usage: 45 }, "=": { usage: 46 }, "[": { usage: 47 }, "]": { usage: 48 },
  "\\": { usage: 49 }, ";": { usage: 51 }, "'": { usage: 52 }, "`": { usage: 53 }, ",": { usage: 54 },
  ".": { usage: 55 }, "/": { usage: 56 },
  "_": { usage: 45, shift: true }, "+": { usage: 46, shift: true }, "{": { usage: 47, shift: true },
  "}": { usage: 48, shift: true }, "|": { usage: 49, shift: true }, ":": { usage: 51, shift: true },
  '"': { usage: 52, shift: true }, "~": { usage: 53, shift: true }, "<": { usage: 54, shift: true },
  ">": { usage: 55, shift: true }, "?": { usage: 56, shift: true },
  "!": { usage: 30, shift: true }, "@": { usage: 31, shift: true }, "#": { usage: 32, shift: true },
  "$": { usage: 33, shift: true }, "%": { usage: 34, shift: true }, "^": { usage: 35, shift: true },
  "&": { usage: 36, shift: true }, "*": { usage: 37, shift: true }, "(": { usage: 38, shift: true },
  ")": { usage: 39, shift: true },
};

/**
 * A `KeyboardEvent.key` → the HID usage to send, and whether it needs shift held.
 *
 * Null for anything not on a US keyboard, and the caller must then send nothing: a key that fell
 * through to usage 0 would be a keystroke the device interprets as something else entirely.
 */
export function keyUsage(key: string): { usage: number; shift: boolean } | null {
  if (key in NAMED) return { usage: NAMED[key]!, shift: false };
  if (key.length !== 1) return null;
  const code = key.codePointAt(0)!;
  if (key >= "a" && key <= "z") return { usage: 4 + code - 97, shift: false };
  if (key >= "A" && key <= "Z") return { usage: 4 + code - 65, shift: true };
  if (key >= "1" && key <= "9") return { usage: 30 + code - 49, shift: false };
  if (key === "0") return { usage: 39, shift: false };
  const p = PUNCTUATION[key];
  return p ? { usage: p.usage, shift: p.shift === true } : null;
}

/** The frames one keystroke actually is: shift down, key down, key up, shift up. */
export function keystrokeFrames(key: string): Uint8Array[] {
  const k = keyUsage(key);
  if (!k) return [];
  const out: Uint8Array[] = [];
  if (k.shift) out.push(keyFrame("down", SHIFT_USAGE));
  out.push(keyFrame("down", k.usage), keyFrame("up", k.usage));
  if (k.shift) out.push(keyFrame("up", SHIFT_USAGE));
  return out;
}

/**
 * The socket, with the reconnection a long-lived pane needs.
 *
 * Sends are dropped while the socket is not open rather than queued. A tap is a thing that happened
 * at a moment — replaying one after a reconnect would put a press somewhere the user was no longer
 * looking, which is worse than the tap not landing.
 */
export class SimulatorInput {
  private ws: WebSocket | null = null;
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly url: string, private readonly onOpenChange?: (open: boolean) => void) { this.open(); }

  private open(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => this.onOpenChange?.(true);
    ws.onclose = () => {
      this.onOpenChange?.(false);
      if (this.closed) return;
      // A stream that was killed and restarted keeps the same URL, so a plain retry is the whole
      // recovery. One second, because this is input rather than pixels — nothing is missed by
      // waiting, and a tight loop against a dead daemon is just noise in the console.
      this.retry = setTimeout(() => this.open(), 1_000);
    };
    ws.onerror = () => ws.close();
    this.ws = ws;
  }

  send(f: Uint8Array): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(f);
    return true;
  }

  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
    this.ws = null;
  }
}
