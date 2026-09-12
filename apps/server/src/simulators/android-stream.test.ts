import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { AndroidStream, ANDROID_BUTTON_KEYCODES, HID_TO_KEYCODE, TAP_SLOP_PX } from "./android-stream";
import type { Android } from "./android";

const SERIAL = "emulator-5554";
const SCREEN = { width: 1000, height: 2000 };

function fake() {
  const calls: string[] = [];
  const adb = {
    tap: async (_s: string, x: number, y: number) => { calls.push(`tap:${x},${y}`); },
    swipe: async (_s: string, a: number, b: number, c: number, d: number, ms: number) => { calls.push(`swipe:${a},${b}->${c},${d}:${ms > 0}`); },
    key: async (_s: string, k: string) => { calls.push(`key:${k}`); },
    screencap: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  } as unknown as Android;
  return { adb, calls };
}

const frame = (op: number, p: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(p), "utf8");
  return Buffer.concat([Buffer.from([op]), body]);
};
const OP = { gesture: 3, button: 4, key: 6 };

/** Reach the private handler the way a socket would, without standing up a real WebSocket. */
function channel(stream: AndroidStream, adbCalls: string[]) {
  const listeners: Record<string, ((d: Buffer) => void)[]> = {};
  const ws = { on: (ev: string, fn: (d: Buffer) => void) => { (listeners[ev] ??= []).push(fn); } };
  (stream as unknown as { input(ws: unknown, serial: string): void }).input(ws, SERIAL);
  return {
    send: async (b: Buffer) => { listeners.message?.forEach((fn) => fn(b)); await new Promise((r) => setTimeout(r, 5)); },
    calls: adbCalls,
  };
}

describe("the Android input bridge", () => {
  let stream: AndroidStream, calls: string[];
  beforeEach(() => {
    const f = fake();
    calls = f.calls;
    stream = new AndroidStream(f.adb, async () => SCREEN);
  });
  afterEach(async () => { await stream.close(); });

  it("turns the pane's 0..1 point into device pixels", async () => {
    /* The pane speaks normalized coordinates because it does not know the device's resolution; adb
       speaks pixels. Getting this backwards is the failure with no visible symptom — the picture is
       perfect and every tap lands somewhere else. */
    const c = channel(stream, calls);
    await c.send(frame(OP.gesture, { type: "begin", x: 0.5, y: 0.25 }));
    await c.send(frame(OP.gesture, { type: "end", x: 0.5, y: 0.25 }));
    expect(calls).toEqual(["tap:500,500"]);
  });

  it("clamps rather than sending a point off the device", async () => {
    const c = channel(stream, calls);
    await c.send(frame(OP.gesture, { type: "begin", x: 2, y: -1 }));
    await c.send(frame(OP.gesture, { type: "end", x: 2, y: -1 }));
    expect(calls).toEqual(["tap:1000,0"]);
  });

  it("a short drag is a TAP, because a trackpad never holds perfectly still", async () => {
    // Below the slop this must not become a swipe: `input swipe` over a few pixels lands nothing at
    // all on most views, so the button the finger was on would simply not respond.
    const c = channel(stream, calls);
    await c.send(frame(OP.gesture, { type: "begin", x: 0.5, y: 0.5 }));
    await c.send(frame(OP.gesture, { type: "move", x: 0.5 + (TAP_SLOP_PX - 4) / SCREEN.width, y: 0.5 }));
    await c.send(frame(OP.gesture, { type: "end", x: 0.5 + (TAP_SLOP_PX - 4) / SCREEN.width, y: 0.5 }));
    expect(calls).toEqual(["tap:500,1000"]);
  });

  it("a real drag is a swipe from where it began to where it ended", async () => {
    const c = channel(stream, calls);
    await c.send(frame(OP.gesture, { type: "begin", x: 0.2, y: 0.8 }));
    await c.send(frame(OP.gesture, { type: "move", x: 0.5, y: 0.5 }));
    await c.send(frame(OP.gesture, { type: "end", x: 0.8, y: 0.2 }));
    expect(calls).toEqual(["swipe:200,1600->800,400:true"]);
  });

  it("ignores a move or an end with no begin behind it", async () => {
    // A socket that reconnects mid-drag delivers exactly this, and a swipe from (0,0) would fling
    // the device's home screen for no reason.
    const c = channel(stream, calls);
    await c.send(frame(OP.gesture, { type: "move", x: 0.5, y: 0.5 }));
    await c.send(frame(OP.gesture, { type: "end", x: 0.5, y: 0.5 }));
    expect(calls).toEqual([]);
  });

  it("maps only the buttons Android actually has", async () => {
    const c = channel(stream, calls);
    await c.send(frame(OP.button, { button: "home" }));
    await c.send(frame(OP.button, { button: "power" }));
    // `shake` and `siri` are iOS-only. Mapping them to a plausible keycode would press some other
    // button entirely, which is worse than doing nothing.
    await c.send(frame(OP.button, { button: "shake" }));
    await c.send(frame(OP.button, { button: "siri" }));
    expect(calls).toEqual(["key:KEYCODE_HOME", "key:KEYCODE_POWER"]);
    expect(ANDROID_BUTTON_KEYCODES).not.toHaveProperty("shake");
  });

  it("sends a key once, on the DOWN edge", async () => {
    const c = channel(stream, calls);
    await c.send(frame(OP.key, { type: "down", usage: 40 }));
    await c.send(frame(OP.key, { type: "up", usage: 40 }));
    // `input keyevent` is a complete press; sending it again on key-up types every character twice.
    expect(calls).toEqual([`key:${HID_TO_KEYCODE[40]}`]);
  });

  it("drops a usage it has no honest mapping for", async () => {
    const c = channel(stream, calls);
    await c.send(frame(OP.key, { type: "down", usage: 9999 }));
    expect(calls).toEqual([]);
  });

  it("survives a frame that is not JSON, and an empty one", async () => {
    const c = channel(stream, calls);
    await c.send(Buffer.from([OP.gesture, 0x7b, 0x7b]));
    await c.send(Buffer.alloc(0));
    expect(calls).toEqual([]);
  });
});

describe("the stream's URLs", () => {
  it("carries a per-boot token in the PATH, because an <img src> cannot set a header", async () => {
    const f = fake();
    const s = new AndroidStream(f.adb, async () => SCREEN);
    const a = await s.start(SERIAL);
    expect(a.streamUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/emulator-5554\/frames$/);
    expect(a.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/emulator-5554\/input$/);
    // Loopback only: this serves a live picture of someone's phone.
    expect(new URL(a.streamUrl).hostname).toBe("127.0.0.1");

    // A wrong token is a 404, and so is a serial that was never started.
    const bad = a.streamUrl.replace(/\/[A-Za-z0-9_-]+\/emulator/, "/deadbeefdeadbeefdeadbeef/emulator");
    expect((await fetch(bad)).status).toBe(404);
    await s.stop(SERIAL);
    expect((await fetch(a.streamUrl)).status).toBe(404);
    await s.close();
  });
});
