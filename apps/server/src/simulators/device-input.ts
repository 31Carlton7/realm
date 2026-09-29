import WebSocket from "ws";
import { buttonFrame, gestureFrame, keystrokeFrames, type SimulatorButton, type SimulatorPlatform } from "@realm/contracts";
import { firstUntypeable } from "./android";

/**
 * A touch, some text or a key, sent to a device by an agent — the `realm-simulator` input tools'
 * half of what the pane does with a person's pointer and keyboard.
 *
 * Coordinates are NORMALIZED, 0..1 of the device's screen from the top-left, because that is what
 * the device speaks: serve-sim takes it as it is, and Android's stream converts it to pixels at the
 * last moment, as it already does for the pane's frames. Nothing that chooses WHERE to touch has to
 * know which kind of device it is touching.
 *
 * iOS input goes down the same serve-sim socket the pane holds, as the same frames
 * (`@realm/contracts`' `simulator-input.ts`). The gestures are choreographed here because the pane
 * never needed choreography — its timing is a person's — and the numbers are serve-sim's own CLI's
 * where it has an opinion: a tap is down, 40 ms, up; typing leaves 4 ms between frames.
 */

/** 0..1 of the screen's width and height, from the top-left. */
export type DevicePoint = { x: number; y: number };

export type DeviceInput =
  | { kind: "tap"; at: DevicePoint; count: 1 | 2 }
  | { kind: "hold"; at: DevicePoint; ms: number }
  /** `stopMs` holds the finger still at `to` before it lifts, so a list stops where the finger does
   *  rather than flying on — how a walk scrolls by a known amount. iOS only: Android's `input swipe`
   *  has no pause before the lift. */
  | { kind: "swipe"; from: DevicePoint; to: DevicePoint; ms: number; holdMs: number; stopMs?: number }
  | { kind: "text"; text: string }
  | { kind: "press"; key: DeviceKey };

/** The buttons and keys an agent can press, by one name on both platforms. `back` is Android's
 *  alone; the rest are either hardware every phone has or keys every keyboard has. */
export const DEVICE_KEYS = [
  "home", "lock", "volume-up", "volume-down", "back",
  "return", "delete", "tab", "escape", "space", "up", "down", "left", "right",
] as const;
export type DeviceKey = (typeof DEVICE_KEYS)[number];

/** One frame, and how long to wait after it before sending the next. */
export type InputStep = { frame: Uint8Array; waitMs: number };

/** How iOS input leaves the server: these steps, down the device's socket. A seam, so a suite can
 *  record what would have been sent instead of opening a socket to a daemon it does not have. */
export type InputChannel = (wsUrl: string, steps: readonly InputStep[]) => Promise<{ ok: boolean; detail: string }>;

/** serve-sim's own `tap`: down, 40 ms, up. */
const TAP_HOLD_MS = 40;
/** Between the two taps of a double tap: well inside the ~300 ms UIKit allows a second tap, and far
 *  enough apart that the first has ended. */
const DOUBLE_TAP_GAP_MS = 100;
/** serve-sim's own `type` leaves this between key frames; back to back, keys are dropped. */
const KEY_GAP_MS = 4;
/** Long enough for a daemon on this Mac to answer; a socket that has not opened by then is not
 *  going to, and the agent's turn should hear so. */
const OPEN_TIMEOUT_MS = 5_000;
/** One move per display frame, the rate a pointer reports at, so a swipe reads to a scroll view as a
 *  finger rather than as a teleport. */
const MOVE_EVERY_MS = 16;

/** `lock` is the side button — what locks a phone, and wakes it. */
const IOS_BUTTONS: Partial<Record<DeviceKey, SimulatorButton>> = { home: "home", lock: "power", "volume-up": "volume-up", "volume-down": "volume-down" };
/** The keyboard keys, by the `KeyboardEvent.key` the shared HID table knows them by. */
const IOS_KEYS: Partial<Record<DeviceKey, string>> = {
  return: "Enter", delete: "Backspace", tab: "Tab", escape: "Escape", space: " ",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
};

export const ANDROID_KEYCODES: Record<DeviceKey, string> = {
  home: "KEYCODE_HOME", lock: "KEYCODE_POWER", "volume-up": "KEYCODE_VOLUME_UP", "volume-down": "KEYCODE_VOLUME_DOWN", back: "KEYCODE_BACK",
  return: "KEYCODE_ENTER", delete: "KEYCODE_DEL", tab: "KEYCODE_TAB", escape: "KEYCODE_ESCAPE", space: "KEYCODE_SPACE",
  up: "KEYCODE_DPAD_UP", down: "KEYCODE_DPAD_DOWN", left: "KEYCODE_DPAD_LEFT", right: "KEYCODE_DPAD_RIGHT",
};

/** What Realm's test runner can press on a real iPhone (`resources/ios-device-runner`). */
const PHONE_KEYS: ReadonlySet<DeviceKey> = new Set(["home", "volume-up", "volume-down", "return", "delete", "space"]);

/** A new line is return and a tab is tab, on both platforms; a carriage return is dropped, as
 *  serve-sim's own `type` drops it, so text with Windows line endings is not typed twice. */
const TYPED_AS_KEY: Record<string, string> = { "\n": "Enter", "\t": "Tab" };

/**
 * Why a device cannot do this at all, or null when it can — asked BEFORE anything is sent, so text
 * is never typed half-way and then refused.
 *
 * Text is where the two platforms differ most. iOS types through a US keyboard layout; Android's
 * `input text` knows printable ASCII and nothing else. Either way the answer is the same set of
 * characters, and the refusal names the first one outside it, so it can be acted on.
 */
export function inputRefusal(input: DeviceInput, platform: SimulatorPlatform, physical = false): string | null {
  if (input.kind === "press" && input.key === "back" && platform === "ios") {
    return "iOS has no back button. Tap the app's own Back button instead — simulator_elements lists it.";
  }
  /* A real iPhone is pressed through Realm's test runner, which has fewer keys than serve-sim. The side
     button is left out on purpose: a phone Realm locked is one only its owner can unlock. The arrows,
     tab and escape go through the runner's typing, which MEASURED puts ← and → into a field as text. */
  if (physical && platform === "ios" && input.kind === "press" && !PHONE_KEYS.has(input.key)) {
    return input.key === "lock"
      ? "Realm never presses a real iPhone's side button: a phone it locked is one only its owner can unlock. Press home to leave an app."
      : `a real iPhone takes home, volume-up, volume-down, return, delete and space from Realm — not ${input.key}.`;
  }
  if (input.kind !== "text") return null;
  const bad = platform === "ios"
    ? [...input.text].find((ch) => ch !== "\r" && keystrokeFrames(TYPED_AS_KEY[ch] ?? ch).length === 0)
    : firstUntypeable(input.text.replace(/[\n\t\r]/g, ""));
  return bad ? `${JSON.stringify(bad)} cannot be typed on this device: only the printable characters of a US keyboard can, and a new line presses return.` : null;
}

/** What one input is on an iOS device, frame by frame. Assumes `inputRefusal` has said yes. */
export function iosSteps(input: DeviceInput): InputStep[] {
  const touch = (type: "begin" | "move" | "end", p: DevicePoint, waitMs: number): InputStep => ({ frame: gestureFrame(type, p.x, p.y), waitMs });
  const keys = (key: string): InputStep[] => keystrokeFrames(key).map((frame) => ({ frame, waitMs: KEY_GAP_MS }));
  switch (input.kind) {
    case "tap": {
      const once = (last: boolean) => [touch("begin", input.at, TAP_HOLD_MS), touch("end", input.at, last ? 0 : DOUBLE_TAP_GAP_MS)];
      return input.count === 2 ? [...once(false), ...once(true)] : once(true);
    }
    case "hold":
      return [touch("begin", input.at, input.ms), touch("end", input.at, 0)];
    case "swipe": {
      /* Moves spaced a display frame apart until the finger arrives, and the lift in the same beat as
         the last move: a scroll view reads the release velocity off the final moves, so a pause
         before lifting would turn every flick into a drag that stops dead. */
      const n = Math.max(2, Math.round(input.ms / MOVE_EVERY_MS));
      const every = input.ms / n;
      const at = (t: number): DevicePoint => ({ x: input.from.x + (input.to.x - input.from.x) * t, y: input.from.y + (input.to.y - input.from.y) * t });
      const moves = Array.from({ length: n }, (_, i) => touch("move", at((i + 1) / n), i === n - 1 ? (input.stopMs ?? 0) : every));
      return [touch("begin", input.from, input.holdMs + every), ...moves, touch("end", input.to, 0)];
    }
    case "text":
      // A carriage return has no key, so it sends nothing — the drop `TYPED_AS_KEY` promises.
      return [...input.text].flatMap((ch) => keys(TYPED_AS_KEY[ch] ?? ch));
    case "press": {
      const button = IOS_BUTTONS[input.key];
      if (button) return [{ frame: buttonFrame(button), waitMs: 0 }];
      return keys(IOS_KEYS[input.key] ?? "");
    }
  }
}

/**
 * The steps, down one socket opened for them and closed after — what serve-sim's own CLI does for
 * each command, and right for an agent's pace: a step every few seconds does not need a connection
 * held open between them, and a held one would be a second thing to reconnect.
 *
 * Each frame is waited on until it is written before the pause after it starts, so a gesture's
 * timing is the device's and not the send buffer's; and the socket closes only once the last frame
 * is out. A failure is an answer, never a throw: the tool reports it as what happened.
 */
export const sendSteps: InputChannel = async (wsUrl, steps) => {
  const ws = new WebSocket(wsUrl);
  // Every failure is answered through the promises below; an `error` with no listener would throw
  // out of the socket instead, past all of them.
  ws.on("error", () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the device's input channel did not answer")), OPEN_TIMEOUT_MS);
      ws.once("open", () => { clearTimeout(timer); resolve(); });
      ws.once("error", (e) => { clearTimeout(timer); reject(e); });
    });
    for (const step of steps) {
      await new Promise<void>((resolve, reject) => ws.send(step.frame, (e) => (e ? reject(e) : resolve())));
      if (step.waitMs > 0) await new Promise((r) => setTimeout(r, step.waitMs));
    }
    return { ok: true, detail: "" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    if (ws.readyState === WebSocket.OPEN) ws.close();
    else ws.terminate();
  }
};
