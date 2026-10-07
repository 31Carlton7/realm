import { SIM_WS_OPCODE, SIMULATOR_BUTTONS, type SimulatorButton, type SimulatorOrientation } from "./simulator";

/**
 * What Realm sends a simulator, and how.
 *
 * serve-sim's input channel is a WebSocket carrying binary frames of ONE opcode byte followed by
 * UTF-8 JSON. The opcodes are its numbers, not ours (`SIM_WS_OPCODE` says so), and the shapes below
 * are transcribed from the CLI that speaks them rather than guessed — a gesture with the wrong key
 * names is a tap that silently does nothing, which is the failure mode this whole module exists to
 * avoid.
 *
 * Two clients speak it: the simulator pane, from a person's pointer and keyboard, and the
 * `realm-simulator` input tools, from an agent's tool call. They share these builders so the device
 * cannot be told one thing by the pane and another by an agent. Pure on purpose: nothing here holds a
 * socket, so the encoding is tested without one.
 */

const frame = (opcode: number, payload: unknown): Uint8Array => {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const out = new Uint8Array(1 + body.length);
  out[0] = opcode;
  out.set(body, 1);
  return out;
};

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
