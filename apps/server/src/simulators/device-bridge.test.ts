import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buttonFrame, gestureFrame, keystrokeFrames, orientationFrame } from "@realm/contracts";
import { characterOf, DeviceBridge, type BridgeRunner } from "./device-bridge";
import type { StartVideo, VideoStop } from "./phone-video";

/**
 * The pane's view of a real phone: an MJPEG stream made of the runner's screenshots, and serve-sim's
 * input frames turned into runner calls — so the pane that shows a simulator shows a phone unchanged.
 */

const bridges: DeviceBridge[] = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map((b) => b.close())); });

const JPEG = (n: number) => Buffer.from([0xff, 0xd8, n, 0xff, 0xd9]);

function phone() {
  const calls: unknown[][] = [];
  let shots = 0;
  const runner: BridgeRunner = {
    screenshot: async (o) => { calls.push(["screenshot", o]); return JPEG(++shots); },
    tap: async (...a) => { calls.push(["tap", ...a]); return { ok: true, detail: "" }; },
    swipe: async (...a) => { calls.push(["swipe", ...a]); return { ok: true, detail: "" }; },
    text: async (t) => { calls.push(["text", t]); return { ok: true, detail: "" }; },
    key: async (k) => { calls.push(["key", k]); return { ok: true, detail: "" }; },
    button: async (b) => { calls.push(["button", b]); return { ok: true, detail: "" }; },
  };
  return { runner, calls, shots: () => shots };
}

async function bridge(p = phone(), o: { frameMs?: number; typeAfterMs?: number } = {}) {
  const b = await DeviceBridge.start({ runner: p.runner, screen: { width: 400, height: 800 }, frameMs: o.frameMs ?? 20, typeAfterMs: o.typeAfterMs ?? 30 });
  bridges.push(b);
  return { b, p };
}

/** Read `n` frames off the stream, then hang up. */
function frames(url: string, n: number): Promise<{ type: string; frames: Buffer[] }> {
  return new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      let buf = Buffer.alloc(0);
      const out: Buffer[] = [];
      res.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          const head = buf.indexOf("\r\n\r\n");
          if (head < 0) break;
          const length = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, head).toString())?.[1]);
          if (buf.length < head + 4 + length + 2) break;
          out.push(buf.subarray(head + 4, head + 4 + length));
          buf = buf.subarray(head + 4 + length + 2);
        }
        if (out.length >= n) { req.destroy(); resolve({ type: String(res.headers["content-type"]), frames: out.slice(0, n) }); }
      });
    });
    req.on("error", (e) => { if (!/aborted|socket hang up/i.test(e.message)) reject(e); });
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the picture", () => {
  it("is an MJPEG stream of the runner's half-size JPEGs", async () => {
    const { b, p } = await bridge();
    const got = await frames(b.streamUrl, 3);
    expect(got.type).toBe("multipart/x-mixed-replace; boundary=realmframe");
    expect(got.frames.map((f) => [...f])).toEqual([[...JPEG(1)], [...JPEG(2)], [...JPEG(3)]]);
    expect(p.calls[0]).toEqual(["screenshot", { format: "jpeg", scale: 0.5, quality: 0.6 }]);
  });

  it("is asked for only while somebody watches — the last one to hang up stops it", async () => {
    const { b, p } = await bridge();
    await frames(b.streamUrl, 2);
    await sleep(60);
    const after = p.shots();
    await sleep(120);
    expect(p.shots()).toBeLessThanOrEqual(after + 1);
    expect(p.shots()).toBeLessThan(8);
  });

  it("shows a newcomer the last frame at once, rather than black until the next", async () => {
    const { b } = await bridge(phone(), { frameMs: 400 });
    const first = frames(b.streamUrl, 2);
    await sleep(50);
    const second = await frames(b.streamUrl, 1);
    expect([...second.frames[0]!]).toEqual([...JPEG(1)]);
    await first;
  });

  it("answers nothing else", async () => {
    const { b } = await bridge();
    const status = await new Promise<number>((r) => request(b.streamUrl.replace("/stream.mjpeg", "/other"), (res) => r(res.statusCode ?? 0)).end());
    expect(status).toBe(404);
  });
});

describe("touch and keys", () => {
  async function socket(url: string): Promise<WebSocket> {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
    return ws;
  }

  it("turns a press and a lift in one place into a tap, in the screen's points", async () => {
    const { b, p } = await bridge();
    const ws = await socket(b.wsUrl);
    ws.send(gestureFrame("begin", 0.5, 0.25));
    ws.send(gestureFrame("end", 0.505, 0.25));
    await sleep(40);
    expect(p.calls.filter((c) => c[0] === "tap")).toEqual([["tap", 200, 200, 1, undefined]]);
    ws.close();
  });

  it("holds a press that was held, and draws a drag from where it went down to where it came up", async () => {
    const { b, p } = await bridge();
    const ws = await socket(b.wsUrl);
    ws.send(gestureFrame("begin", 0.1, 0.1));
    await sleep(500);
    ws.send(gestureFrame("end", 0.1, 0.1));
    ws.send(gestureFrame("begin", 0.5, 0.75));
    ws.send(gestureFrame("move", 0.5, 0.5));
    await sleep(60);
    ws.send(gestureFrame("end", 0.5, 0.25));
    await sleep(40);
    const acts = p.calls.filter((c) => c[0] === "tap" || c[0] === "swipe");
    expect(acts[0]![0]).toBe("tap");
    expect(acts[0]![4]).toBeGreaterThanOrEqual(450);
    expect(acts[1]!.slice(0, 3)).toEqual(["swipe", { x: 200, y: 600 }, { x: 200, y: 200 }]);
    expect(acts[1]![3]).toBeGreaterThanOrEqual(50);
    ws.close();
  });

  it("presses home and the volume buttons, and never the side button", async () => {
    const { b, p } = await bridge();
    const ws = await socket(b.wsUrl);
    for (const button of ["home", "power", "volume-up", "action", "volume-down"] as const) ws.send(buttonFrame(button));
    ws.send(orientationFrame("landscape_left"));
    await sleep(40);
    expect(p.calls.filter((c) => c[0] === "button")).toEqual([["button", "home"], ["button", "volume-up"], ["button", "volume-down"]]);
    ws.close();
  });

  it("types keystrokes as one run, shift and all, and presses return and delete as keys", async () => {
    const { b, p } = await bridge();
    const ws = await socket(b.wsUrl);
    for (const k of ["A", "b", "o", "u", "t", "!"]) for (const f of keystrokeFrames(k)) ws.send(f);
    await sleep(80);
    for (const f of keystrokeFrames("Backspace")) ws.send(f);
    for (const f of keystrokeFrames("Enter")) ws.send(f);
    await sleep(40);
    expect(p.calls.filter((c) => c[0] === "text" || c[0] === "key")).toEqual([["text", "About!"], ["key", "delete"], ["key", "return"]]);
    ws.close();
  });

  it("sends what was typed before a touch that follows it, in order", async () => {
    const { b, p } = await bridge(phone(), { typeAfterMs: 5_000 });
    const ws = await socket(b.wsUrl);
    for (const f of keystrokeFrames("x")) ws.send(f);
    ws.send(gestureFrame("begin", 0.5, 0.5));
    ws.send(gestureFrame("end", 0.5, 0.5));
    await sleep(40);
    expect(p.calls.filter((c) => c[0] !== "screenshot").map((c) => c[0])).toEqual(["text", "tap"]);
    ws.close();
  });

  it("refuses a socket on any other path", async () => {
    const { b } = await bridge();
    await expect(socket(b.wsUrl.replace("/ws", "/other"))).rejects.toBeTruthy();
  });
});

describe("characterOf", () => {
  it("reads a US keyboard's usages back into the characters they type", () => {
    expect([characterOf(4, false), characterOf(29, true), characterOf(30, false), characterOf(39, false), characterOf(30, true), characterOf(44, false), characterOf(56, true), characterOf(52, true)])
      .toEqual(["a", "Z", "1", "0", "!", " ", "?", "\""]);
    expect(characterOf(40, false)).toBeNull();
  });
});

/* ── live video ──────────────────────────────────────────────────────────────────────────────────── */

const VID = (n: number) => Buffer.from([0xff, 0xd8, 0x80 + n, 0xff, 0xd9]);
const RETRY = { camera: 40, "camera-denied": 40, "no-cable": 40, failed: 40 };

/** A feed the test drives: it hands frames over, goes ready and ends when told. */
function video() {
  const feeds: { frame(n: number): void; ready(): void; end(why: VideoStop | null): void; stopped: boolean }[] = [];
  const start: StartVideo = (onFrame) => {
    let ready!: () => void;
    let end!: (why: VideoStop | null) => void;
    const ended = new Promise<VideoStop | null>((r) => { end = r; });
    const feed = { frame: (n: number) => onFrame(VID(n)), ready: () => ready(), end: (why: VideoStop | null) => end(why), stopped: false };
    feeds.push(feed);
    return { ready: new Promise<void>((r) => { ready = r; }), ended, stop: () => { feed.stopped = true; end(null); } };
  };
  return { start, feeds };
}

async function liveBridge(o: { runner?: ReturnType<typeof phone>; warmMs?: number } = {}) {
  const p = o.runner ?? phone();
  const v = video();
  const told: (VideoStop | null)[] = [];
  const b = await DeviceBridge.start({
    runner: p.runner, screen: { width: 400, height: 800 }, frameMs: 20, typeAfterMs: 30,
    video: v.start, onStills: (why) => told.push(why), retryMs: RETRY, warmMs: o.warmMs ?? 10_000,
  });
  bridges.push(b);
  return { b, p, v, told };
}

/** Every frame on the stream, as it comes, until `stop`. */
function watch(url: string): { got: Buffer[]; stop(): void } {
  const got: Buffer[] = [];
  let buf = Buffer.alloc(0);
  const req = request(url, (res) => {
    res.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const head = buf.indexOf("\r\n\r\n");
        if (head < 0) break;
        const length = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, head).toString())?.[1]);
        if (buf.length < head + 4 + length + 2) break;
        got.push(buf.subarray(head + 4, head + 4 + length));
        buf = buf.subarray(head + 4 + length + 2);
      }
    });
  });
  req.on("error", () => {});
  req.end();
  return { got, stop: () => req.destroy() };
}

const until = async (ok: () => boolean, ms = 2_000) => {
  const t0 = Date.now();
  while (!ok()) { if (Date.now() - t0 > ms) throw new Error("timed out"); await sleep(5); }
};
const isVideo = (f: Buffer) => f[2]! >= 0x80;

describe("the picture, as live video", () => {
  it("is the feed's frames once its first is out, and the runner takes no more screenshots", async () => {
    const { b, p, v, told } = await liveBridge();
    const w = watch(b.streamUrl);
    await until(() => v.feeds.length === 1 && w.got.length > 0);
    // Screenshots while the feed starts: a pane is never dark waiting for video.
    expect(isVideo(w.got[0]!)).toBe(false);
    v.feeds[0]!.frame(1);
    v.feeds[0]!.ready();
    await until(() => told.length === 1);
    const shots = p.shots();
    v.feeds[0]!.frame(2);
    v.feeds[0]!.frame(3);
    await until(() => w.got.filter(isVideo).length === 3);
    await sleep(100);
    // THE MUTANT: keep taking screenshots under the video — the runner stays busy, and every tap still
    // waits 773 ms behind one. One already in flight may finish; none may start.
    expect(p.shots()).toBeLessThanOrEqual(shots + 1);
    expect(w.got.filter(isVideo).map((f) => f[2])).toEqual([0x81, 0x82, 0x83]);
    expect(told).toEqual([null]);
    w.stop();
  });

  it("never shows a screenshot taken before the video went live after the video", async () => {
    const p = phone();
    let release!: () => void;
    let slow = true;
    p.runner.screenshot = async () => {
      if (slow) { slow = false; await new Promise<void>((r) => { release = r; }); return JPEG(99); }
      return JPEG(1);
    };
    const { b, v } = await liveBridge({ runner: p });
    const w = watch(b.streamUrl);
    await until(() => v.feeds.length === 1 && release !== undefined);
    v.feeds[0]!.frame(1);
    v.feeds[0]!.ready();
    await sleep(20);
    release();
    await sleep(60);
    // THE MUTANT: publish whatever screenshot comes back. The old picture lands over the live one.
    expect(w.got.map((f) => f[2])).not.toContain(99);
    w.stop();
  });

  it("stays screenshots when there is no video, says why, and tries again later", async () => {
    const { b, p, v, told } = await liveBridge();
    const w = watch(b.streamUrl);
    await until(() => v.feeds.length === 1);
    v.feeds[0]!.end("camera");
    await until(() => told.length === 1);
    expect(told).toEqual(["camera"]);
    const shots = p.shots();
    await until(() => p.shots() > shots + 2);
    // THE MUTANT: give up on video for good. A camera allowed a moment later never goes live.
    await until(() => v.feeds.length === 2);
    v.feeds[1]!.frame(1);
    v.feeds[1]!.ready();
    await until(() => told.length === 2);
    expect(told).toEqual(["camera", null]);
    w.stop();
  });

  it("goes back to screenshots at once when the feed dies, and says so once", async () => {
    const { b, p, v, told } = await liveBridge();
    const w = watch(b.streamUrl);
    await until(() => v.feeds.length === 1);
    v.feeds[0]!.frame(1);
    v.feeds[0]!.ready();
    await until(() => told.length === 1);
    const shots = p.shots();
    v.feeds[0]!.end("failed");
    // THE MUTANT: wait on a feed that is gone. The picture freezes on its last frame.
    await until(() => p.shots() > shots + 1, 500);
    expect(told).toEqual([null, "failed"]);
    w.stop();
  });

  it("runs on a while after the last watcher leaves, for whoever comes back, then stops", async () => {
    const { b, v } = await liveBridge({ warmMs: 150 });
    const first = watch(b.streamUrl);
    await until(() => v.feeds.length === 1);
    v.feeds[0]!.frame(1);
    v.feeds[0]!.ready();
    await until(() => first.got.some(isVideo));
    first.stop();
    await sleep(60);
    // Back within the wait: the same feed, no second start, and its latest frame at once.
    const again = watch(b.streamUrl);
    await until(() => again.got.length > 0);
    expect(isVideo(again.got[0]!)).toBe(true);
    expect(v.feeds).toHaveLength(1);
    again.stop();
    expect(v.feeds[0]!.stopped).toBe(false);
    // THE MUTANT: never stop it. A phone nobody looks at would be captured until Realm quits.
    await until(() => v.feeds[0]!.stopped, 1_000);
  });

  it("stops the feed when the bridge closes", async () => {
    const { b, v } = await liveBridge();
    const w = watch(b.streamUrl);
    await until(() => v.feeds.length === 1);
    w.stop();
    await b.close();
    expect(v.feeds[0]!.stopped).toBe(true);
  });
});
