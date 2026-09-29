import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { motionTracker, watchMjpeg } from "./screen-motion";

/**
 * Motion from pictures. What must die: rest declared while frames are still changing, rest declared
 * before the renderer has shown the same picture twice, a change missed, a wait that outlives its
 * budget, and a stream cut at a JPEG end marker instead of by its length.
 */

function clocked() {
  let t = 0;
  const sleep = async (ms: number) => { t += ms; };
  const tracker = motionTracker(() => t, sleep);
  return { tracker, advance: (ms: number) => { t += ms; }, now: () => t };
}

const A = new Uint8Array([1, 2, 3]), B = new Uint8Array([4, 5, 6]), C = new Uint8Array([7, 8, 9]);

describe("motionTracker", () => {
  it("counts a picture that differs from the one before it, and only that", () => {
    const { tracker } = clocked();
    expect(tracker.motion.mark()).toBe(0);
    tracker.frame(A); tracker.frame(A); tracker.frame(B); tracker.frame(B); tracker.frame(A);
    expect(tracker.motion.mark()).toBe(3);
  });

  it("settles once the picture changed, then showed the same frame again with nothing new for stillMs", async () => {
    const { tracker, advance } = clocked();
    tracker.frame(A);
    const mark = tracker.motion.mark();
    tracker.frame(B);
    advance(50);
    tracker.frame(B);
    // 50 ms since the change: not yet. The wait's own ticks carry the clock past stillMs.
    expect(await tracker.motion.settle(mark, { changeWithinMs: 1_000, stillMs: 120, maxMs: 1_000 })).toBe("still");
  });

  it("is not at rest until the renderer has repeated the latest picture", async () => {
    const { tracker, advance } = clocked();
    tracker.frame(A);
    const mark = tracker.motion.mark();
    tracker.frame(B);
    advance(500);
    // THE MUTANT: call it rest on time alone. A stalled stream mid-animation then reads as a settled
    // screen, and the tree is read half-way between two.
    expect(await tracker.motion.settle(mark, { changeWithinMs: 1_000, stillMs: 120, maxMs: 200 })).toBe("moving");
  });

  it("answers none when nothing changed within changeWithinMs", async () => {
    const { tracker, now } = clocked();
    tracker.frame(A); tracker.frame(A);
    const mark = tracker.motion.mark();
    expect(await tracker.motion.settle(mark, { changeWithinMs: 300, stillMs: 120, maxMs: 3_000 })).toBe("none");
    expect(now()).toBeGreaterThanOrEqual(300);
    expect(now()).toBeLessThan(400);
  });

  it("answers moving when frames keep changing past maxMs — a spinner, a video", async () => {
    // A new picture every tick: never at rest.
    const t = { v: 0 };
    let flip = false;
    const moving = motionTracker(() => t.v, async (ms) => { t.v += ms; moving.frame((flip = !flip) ? B : C); });
    moving.frame(A);
    const mark = moving.motion.mark();
    moving.frame(B);
    expect(await moving.motion.settle(mark, { changeWithinMs: 1_000, stillMs: 120, maxMs: 600 })).toBe("moving");
    expect(t.v).toBeLessThan(700);
  });

  it("answers lost once the stream is gone, and rest says false", async () => {
    const { tracker } = clocked();
    tracker.frame(A);
    const mark = tracker.motion.mark();
    tracker.lost();
    expect(await tracker.motion.settle(mark, { changeWithinMs: 1_000, stillMs: 120, maxMs: 1_000 })).toBe("lost");
    expect(await tracker.motion.rest({ stillMs: 120, maxMs: 1_000 })).toBe(false);
  });

  it("rests when the same picture keeps arriving, and not before one has arrived at all", async () => {
    const { tracker } = clocked();
    expect(await tracker.motion.rest({ stillMs: 120, maxMs: 300 })).toBe(false);
    tracker.frame(A); tracker.frame(A);
    expect(await tracker.motion.rest({ stillMs: 120, maxMs: 300 })).toBe(true);
  });
});

describe("watchMjpeg", () => {
  let server: http.Server | null = null;
  afterEach(async () => { await new Promise<void>((r) => (server ? server.close(() => r()) : r())); server = null; });

  const part = (body: Buffer) => Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${body.length}\r\n\r\n`), body, Buffer.from("\r\n")]);

  it("cuts frames by their length, so a picture carrying an end marker inside it is still one picture", async () => {
    // A JPEG with a thumbnail in its EXIF carries a second start and end marker — and a boundary-looking
    // line — inside the one frame. THE MUTANT: cut at the first end marker; this stream then counts four
    // different pictures where there are two, and a still screen never rests.
    const one = Buffer.from([0xff, 0xd8, 1, 0xff, 0xd8, 2, 0xff, 0xd9, ...Buffer.from("\r\n--frame\r\n"), 3, 0xff, 0xd9]);
    const two = Buffer.from([0xff, 0xd8, 9, 9, 0xff, 0xd9]);
    const hold: { respond?: (chunk: Buffer) => void } = {};
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=frame" });
      hold.respond = (chunk) => res.write(chunk);
      // Split mid-header and mid-body: a frame arrives in pieces.
      const first = part(one);
      res.write(first.subarray(0, 20));
      setTimeout(() => res.write(first.subarray(20)), 5);
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    const motion = watchMjpeg(`http://127.0.0.1:${port}/stream.mjpeg`);
    try {
      await new Promise((r) => setTimeout(r, 60));
      expect(motion.mark()).toBe(1);
      hold.respond!(part(one));
      hold.respond!(Buffer.concat([part(two), part(two)]));
      await new Promise((r) => setTimeout(r, 60));
      expect(motion.mark()).toBe(2);
      expect(await motion.rest({ stillMs: 20, maxMs: 500 })).toBe(true);
    } finally {
      motion.close();
    }
  });

  it("reports the stream lost when the server refuses it", async () => {
    server = http.createServer((_req, res) => { res.writeHead(404); res.end("No serve-sim device"); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    const motion = watchMjpeg(`http://127.0.0.1:${port}/stream.mjpeg`);
    try {
      expect(await motion.settle(0, { changeWithinMs: 500, stillMs: 20, maxMs: 500 })).toBe("lost");
    } finally {
      motion.close();
    }
  });
});
