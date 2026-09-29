import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { SHIFT_USAGE } from "@realm/contracts";
import { inputRefusal, iosSteps, sendSteps, type InputStep } from "./device-input";

/**
 * An agent's input, as the frames an iOS device is sent, and the socket that sends them.
 *
 * The choreography is tested as data — the frames and the pauses between them — because timing is
 * the part that decides what a gesture IS: a tap held for a second is a long press, a swipe that
 * pauses before lifting is a drag that stops dead. The socket is tested against a real one, since
 * "the frames arrived, in order, with the pauses kept" is a claim about a wire.
 */

const read = (f: Uint8Array): { op: number; body: Record<string, unknown> } =>
  ({ op: f[0]!, body: JSON.parse(new TextDecoder().decode(f.slice(1))) as Record<string, unknown> });
const plan = (steps: InputStep[]) => steps.map((s) => ({ ...read(s.frame), waitMs: s.waitMs }));

describe("what one input is on an iOS device", () => {
  it("a tap is a touch down and up at one point, 40 ms apart — serve-sim's own tap", () => {
    expect(plan(iosSteps({ kind: "tap", at: { x: 0.5, y: 0.25 }, count: 1 }))).toEqual([
      { op: 3, body: { type: "begin", x: 0.5, y: 0.25 }, waitMs: 40 },
      { op: 3, body: { type: "end", x: 0.5, y: 0.25 }, waitMs: 0 },
    ]);
  });

  it("a double tap is two of them with a short gap, not one long one", () => {
    const steps = plan(iosSteps({ kind: "tap", at: { x: 0.1, y: 0.2 }, count: 2 }));
    expect(steps.map((s) => s.body.type)).toEqual(["begin", "end", "begin", "end"]);
    // THE MUTANT: no gap between the taps. The second begin then lands in the same instant as the
    // first end, which UIKit reads as the first touch never having lifted.
    expect(steps[1]!.waitMs).toBeGreaterThan(0);
    expect(steps[1]!.waitMs).toBeLessThan(300); // inside the double-tap window
  });

  it("a long press holds for as long as it was asked, and not a beat longer", () => {
    const steps = plan(iosSteps({ kind: "hold", at: { x: 0.3, y: 0.3 }, ms: 1200 }));
    expect(steps).toEqual([
      { op: 3, body: { type: "begin", x: 0.3, y: 0.3 }, waitMs: 1200 },
      { op: 3, body: { type: "end", x: 0.3, y: 0.3 }, waitMs: 0 },
    ]);
  });

  it("a swipe moves a display frame at a time, and lifts on its last move with no pause", () => {
    const steps = plan(iosSteps({ kind: "swipe", from: { x: 0.5, y: 0.8 }, to: { x: 0.5, y: 0.2 }, ms: 320, holdMs: 0 }));
    expect(steps[0]!.body).toEqual({ type: "begin", x: 0.5, y: 0.8 });
    expect(steps.at(-1)!.body).toEqual({ type: "end", x: 0.5, y: 0.2 });
    const moves = steps.filter((s) => s.body.type === "move");
    expect(moves.length).toBe(20); // 320 ms at 16 ms a move
    // Monotonic from the start to the end: a swipe that doubled back would scroll the other way.
    const ys = moves.map((m) => m.body.y as number);
    expect(ys.every((y, i) => i === 0 || y < ys[i - 1]!)).toBe(true);
    expect(ys.at(-1)).toBeCloseTo(0.2, 10);
    // The whole gesture takes the time it was given…
    expect(steps.reduce((t, s) => t + s.waitMs, 0)).toBeCloseTo(320, 6);
    /* …and THE MUTANT is a pause before the lift. A scroll view reads the release velocity off the
       last moves; wait before `end` and every flick becomes a drag that stops where the finger did. */
    expect(steps.at(-2)!.waitMs).toBe(0);
  });

  it("holds still where the finger went down before it moves, when asked to", () => {
    const held = plan(iosSteps({ kind: "swipe", from: { x: 0.2, y: 0.5 }, to: { x: 0.8, y: 0.5 }, ms: 160, holdMs: 700 }));
    const plain = plan(iosSteps({ kind: "swipe", from: { x: 0.2, y: 0.5 }, to: { x: 0.8, y: 0.5 }, ms: 160, holdMs: 0 }));
    // The hold is on the touch-down, before the first move — not spread over the moves.
    expect(held[0]!.waitMs - plain[0]!.waitMs).toBe(700);
    expect(held.slice(1)).toEqual(plain.slice(1));
  });

  it("types a character as the keystroke the pane would send, and a new line as return", () => {
    const keys = plan(iosSteps({ kind: "text", text: "Hi\n" }));
    expect(keys.map((k) => [k.body.type, k.body.usage])).toEqual([
      ["down", SHIFT_USAGE], ["down", 11], ["up", 11], ["up", SHIFT_USAGE], // H
      ["down", 12], ["up", 12], // i
      ["down", 40], ["up", 40], // return
    ]);
    expect(keys.every((k) => k.op === 6)).toBe(true);
    // serve-sim's own `type` spaces its frames; sent back to back, the device drops keys.
    expect(keys.every((k) => k.waitMs > 0)).toBe(true);
    // A carriage return is dropped, so Windows line endings press return once, not twice.
    expect(plan(iosSteps({ kind: "text", text: "a\r\nb" })).filter((k) => k.body.usage === 40 && k.body.type === "down")).toHaveLength(1);
  });

  it("presses the side button for lock, and the named keys as keys", () => {
    expect(plan(iosSteps({ kind: "press", key: "lock" }))).toEqual([{ op: 4, body: { button: "power", page: 12, usage: 48 }, waitMs: 0 }]);
    expect(plan(iosSteps({ kind: "press", key: "home" }))).toEqual([{ op: 4, body: { button: "home" }, waitMs: 0 }]);
    expect(plan(iosSteps({ kind: "press", key: "volume-down" }))[0]!.body).toEqual({ button: "volume-down", page: 12, usage: 234 });
    expect(plan(iosSteps({ kind: "press", key: "return" })).map((k) => k.body.usage)).toEqual([40, 40]);
    expect(plan(iosSteps({ kind: "press", key: "delete" })).map((k) => k.body.usage)).toEqual([42, 42]);
    expect(plan(iosSteps({ kind: "press", key: "up" })).map((k) => k.body.usage)).toEqual([82, 82]);
    expect(plan(iosSteps({ kind: "press", key: "space" })).map((k) => k.body.usage)).toEqual([44, 44]);
  });
});

describe("what a device cannot do at all", () => {
  it("refuses text with a character the keyboard does not have, naming it, before anything is sent", () => {
    expect(inputRefusal({ kind: "text", text: "café" }, "ios")).toContain('"é"');
    expect(inputRefusal({ kind: "text", text: "naïve" }, "android")).toContain('"ï"');
    expect(inputRefusal({ kind: "text", text: "plain text, 100%!\n\tok" }, "ios")).toBeNull();
    // A new line and a tab are keys on Android too, typed between the runs — not refused.
    expect(inputRefusal({ kind: "text", text: "line one\nline two\t" }, "android")).toBeNull();
  });

  it("refuses back on iOS, where there is no such button, and names where to go instead", () => {
    expect(inputRefusal({ kind: "press", key: "back" }, "ios")).toMatch(/no back button.*simulator_elements/);
    expect(inputRefusal({ kind: "press", key: "back" }, "android")).toBeNull();
    expect(inputRefusal({ kind: "press", key: "home" }, "ios")).toBeNull();
  });
});

describe("the socket the steps go down", () => {
  const servers: WebSocketServer[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(r)); });

  /** A stand-in for serve-sim's input socket: it records every frame, with when it arrived. */
  async function device() {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    servers.push(wss);
    await new Promise((r) => wss.once("listening", r));
    const got: { op: number; body: Record<string, unknown>; at: number }[] = [];
    let closed = 0;
    wss.on("connection", (ws) => {
      ws.on("message", (raw: Buffer) => got.push({ ...read(new Uint8Array(raw)), at: Date.now() }));
      ws.on("close", () => { closed++; });
    });
    return { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/helper/UDID/ws`, got, closed: () => closed };
  }

  it("sends every frame, in order, keeps the pauses, and closes the socket after", async () => {
    const dev = await device();
    const r = await sendSteps(dev.url, iosSteps({ kind: "hold", at: { x: 0.4, y: 0.6 }, ms: 250 }));
    expect(r).toEqual({ ok: true, detail: "" });
    await expect.poll(() => dev.got.length).toBe(2);
    expect(dev.got.map((g) => g.body.type)).toEqual(["begin", "end"]);
    // THE MUTANT: send without waiting. The long press arrives as a tap.
    expect(dev.got[1]!.at - dev.got[0]!.at).toBeGreaterThanOrEqual(240);
    await expect.poll(() => dev.closed()).toBe(1);
  });

  it("answers a device that is not there with a sentence, not a throw", async () => {
    const dev = await device();
    const port = Number(new URL(dev.url).port);
    await new Promise((r) => servers.pop()!.close(r));
    const r = await sendSteps(`ws://127.0.0.1:${port}/helper/UDID/ws`, iosSteps({ kind: "tap", at: { x: 0.5, y: 0.5 }, count: 1 }));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/ECONNREFUSED/);
  });
});
