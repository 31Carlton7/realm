import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buttonFrame, gestureFrame, keystrokeFrames, orientationFrame } from "@realm/contracts";
import { characterOf, DeviceBridge, type BridgeRunner } from "./device-bridge";

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
