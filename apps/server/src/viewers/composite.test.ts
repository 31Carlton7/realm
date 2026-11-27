import { afterEach, describe, expect, it } from "vitest";
import { createServer, get, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import sharp from "sharp";
import { CHILD_VIEWS_BINDING, type ViewerChildView } from "@realm/contracts";
import { ViewerService } from "./service";

/** A stand-in for a quiet Realm's `--remote-debugging-port`: the window's page W and the child pages
 *  C1 and C2, each on its own socket. W answers `Runtime.evaluate` with the child list main left in
 *  the page, and `children()` changes it the way main does, through the binding. */
async function fakeRealm() {
  const calls: { page: string; method: string; params: Record<string, unknown> }[] = [];
  const sockets = new Map<string, WebSocket[]>();
  let children: ViewerChildView[] = [];
  const server: Server = createServer((req, res) => {
    if (req.url !== "/json/list") { res.writeHead(404).end(); return; }
    const { port } = server.address() as { port: number };
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(["W", "C1", "C2"].map((id) => (
      { id, type: "page", url: id === "W" ? "file:///app/index.html" : "http://127.0.0.1/", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${id}` }
    ))));
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    const page = /\/devtools\/page\/(\w+)$/.exec(req.url ?? "")?.[1] ?? "?";
    sockets.set(page, [...(sockets.get(page) ?? []), ws]);
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as { id: number; method: string; params?: Record<string, unknown> };
      calls.push({ page, method: m.method, params: m.params ?? {} });
      const result = m.method === "Runtime.evaluate" && page === "W" ? { result: { type: "string", value: JSON.stringify(children) } } : {};
      ws.send(JSON.stringify({ id: m.id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  let session = 0;
  const live = (page: string) => (sockets.get(page) ?? []).filter((ws) => ws.readyState === WebSocket.OPEN);
  return {
    port, calls,
    live,
    /** What main has left in the window's page before the viewer opens. */
    seed(list: ViewerChildView[]) { children = list; },
    /** Main moving, adding or dropping a child view. */
    children(list: ViewerChildView[]) {
      children = list;
      for (const ws of live("W")) ws.send(JSON.stringify({ method: "Runtime.bindingCalled", params: { name: CHILD_VIEWS_BINDING, payload: JSON.stringify(list), executionContextId: 1 } }));
    },
    frame(page: string, jpeg: Buffer, deviceWidth: number, deviceHeight: number) {
      const sessionId = ++session;
      for (const ws of live(page)) ws.send(JSON.stringify({ method: "Page.screencastFrame", params: { data: jpeg.toString("base64"), sessionId, metadata: { deviceWidth, deviceHeight, offsetTop: 0, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 0 } } }));
    },
    on(page: string, method: string) { return calls.filter((c) => c.page === page && c.method === method); },
    async close() { wss.clients.forEach((c) => c.terminate()); await new Promise<void>((r) => server.close(() => r())); },
  };
}

async function until(fn: () => boolean | Promise<boolean>, what: string | (() => string), ms = 3000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${typeof what === "string" ? what : what()}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function watch(url: string) {
  const parts: Buffer[] = [];
  let buf = Buffer.alloc(0);
  const req = get(url, (r) => {
    r.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const head = buf.indexOf("\r\n\r\n");
        if (head < 0) return;
        const len = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, head).toString())?.[1]);
        if (buf.length < head + 4 + len + 2) return;
        parts.push(buf.subarray(head + 4, head + 4 + len));
        buf = buf.subarray(head + 4 + len + 2);
      }
    });
  });
  req.on("error", () => {});
  return { parts, stop: () => req.destroy() };
}

type Rgb = [number, number, number];
const RED: Rgb = [220, 30, 30], BLUE: Rgb = [30, 60, 220], GREEN: Rgb = [30, 200, 60];
const solid = (width: number, height: number, [r, g, b]: Rgb) =>
  sharp({ create: { width, height, channels: 3, background: { r, g, b } } }).jpeg({ quality: 95 }).toBuffer();
/** Left half one colour, right half another: a frame cropped to its rect instead of scaled shows one half. */
const halves = async (width: number, height: number, left: Rgb, right: Rgb) =>
  sharp(await solid(width, height, right)).composite([{ input: await sharp(await solid(width / 2, height, left)).toBuffer(), left: 0, top: 0 }]).jpeg({ quality: 95 }).toBuffer();

/** The colour at each point of a JPEG, as the nearest of the test colours. */
async function colours(jpeg: Buffer, points: [number, number][]): Promise<string[]> {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  return points.map(([x, y]) => {
    const i = (y * info.width + x) * info.channels;
    const px = [data[i]!, data[i + 1]!, data[i + 2]!];
    const named: [string, Rgb][] = [["red", RED], ["blue", BLUE], ["green", GREEN]];
    const [name, c] = named.reduce((a, b) => (dist(b[1]) < dist(a[1]) ? b : a));
    return dist(c) < 40 ? name : `rgb(${px.join(",")})`;
    function dist(c: Rgb) { return Math.max(...c.map((v, k) => Math.abs(v - px[k]!))); }
  });
}

/** Waits for a stream part whose colours at `points` are `want`. */
async function frameWith(client: { parts: Buffer[] }, points: [number, number][], want: string[]) {
  let seen: string[] = [];
  await until(async () => {
    const last = client.parts.at(-1);
    if (!last) return false;
    seen = await colours(last, points).catch(() => ["undecodable"]);
    return seen.join() === want.join();
  }, () => `a frame of ${want.join(",")} (last was ${seen.join(",")})`);
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanup.reverse()) await c(); cleanup = []; });

async function setup(seed: ViewerChildView[] = []) {
  const app = await fakeRealm();
  app.seed(seed);
  const viewers = new ViewerService({ stillMs: 50 });
  cleanup.push(() => app.close(), () => viewers.closeAll());
  const viewer = await viewers.open({ kind: "electron", cdpPort: app.port, targetId: "W" });
  const client = watch(viewer.streamUrl);
  cleanup.push(async () => { client.stop(); });
  return { app, viewers, viewer, client };
}

const PANE = { targetId: "C1", x: 100, y: 50, width: 200, height: 100 };

describe("ViewerService compositing child views", () => {
  it("draws a child view's frame at its rect over the window's", async () => {
    const { app, client } = await setup([PANE]);
    await until(() => app.on("C1", "Page.startScreencast").length > 0, "the child's screencast");
    app.frame("W", await solid(800, 600, RED), 800, 600);
    app.frame("C1", await solid(200, 100, BLUE), 200, 100);
    // Inside the rect's corners, and just outside each edge.
    await frameWith(client, [[102, 52], [297, 147], [200, 100], [97, 100], [303, 100], [200, 47], [200, 153]],
      ["blue", "blue", "blue", "red", "red", "red", "red"]);
  });

  it("follows the rect as main moves the view", async () => {
    const { app, client } = await setup([PANE]);
    await until(() => app.on("C1", "Page.startScreencast").length > 0, "the child's screencast");
    app.frame("W", await solid(800, 600, RED), 800, 600);
    app.frame("C1", await solid(200, 100, BLUE), 200, 100);
    await frameWith(client, [[200, 100], [500, 350]], ["blue", "red"]);
    app.children([{ ...PANE, x: 400, y: 300 }]);
    await frameWith(client, [[200, 100], [500, 350], [402, 302], [597, 397]], ["red", "blue", "blue", "blue"]);
  });

  it("adds a view that appears later, and drops one that goes, stopping its screencast", async () => {
    const { app, client } = await setup();
    app.frame("W", await solid(800, 600, RED), 800, 600);
    await until(() => client.parts.length > 0, "a window frame");
    app.children([PANE]);
    await until(() => app.on("C1", "Page.startScreencast").length > 0, "the child's screencast");
    app.frame("C1", await solid(200, 100, BLUE), 200, 100);
    await frameWith(client, [[200, 100]], ["blue"]);
    app.children([]);
    await frameWith(client, [[200, 100]], ["red"]);
    await until(() => app.on("C1", "Page.stopScreencast").length > 0, "the child's screencast to stop");
    await until(() => app.live("C1").length === 0, "the child's socket to close");
  });

  it("scales each rect from page CSS pixels to the frame, and each child frame to its rect", async () => {
    // The window streams at half its CSS size; the child streams at twice its rect (a 2x display).
    const { app, client } = await setup([PANE, { targetId: "C2", x: 500, y: 400, width: 100, height: 100 }]);
    await until(() => app.on("C2", "Page.startScreencast").length > 0, "the second child's screencast");
    app.frame("W", await solid(400, 300, RED), 800, 600);
    app.frame("C1", await halves(400, 200, BLUE, GREEN), 200, 100);
    app.frame("C2", await solid(200, 200, GREEN), 100, 100);
    // C1 lands on (50,25)-(150,75), blue then green; C2 on (250,200)-(300,250).
    await frameWith(client, [[55, 30], [94, 69], [106, 30], [144, 69], [44, 50], [156, 50], [100, 81], [255, 205], [294, 244], [244, 225], [306, 225]],
      ["blue", "blue", "green", "green", "red", "red", "red", "green", "green", "red", "red"]);
    const last = client.parts.at(-1)!;
    expect(await sharp(last).metadata()).toMatchObject({ width: 400, height: 300 });
  });

  it("sends a point inside a child's rect to the child, in the child's own coordinates", async () => {
    // C2 overlaps C1's right edge, above it.
    const { app, viewer } = await setup([PANE, { targetId: "C2", x: 250, y: 50, width: 100, height: 100 }]);
    await until(() => app.on("C1", "Page.startScreencast").length > 0, "the child's screencast");
    app.frame("W", await solid(800, 600, RED), 800, 600);
    // The child's page is 400x200 CSS px in a 200x100 rect: zoomed out, or a device preset.
    app.frame("C1", await solid(200, 100, BLUE), 400, 200);
    await until(() => app.on("C1", "Page.screencastFrameAck").length > 0, "the child's frame");
    const ws = new WebSocket(viewer.inputUrl);
    cleanup.push(async () => ws.close());
    await new Promise((r) => ws.once("open", r));
    // An 800x600 viewer box: viewer coordinates are window CSS px.
    const at = (action: string, x: number, y: number) => ws.send(JSON.stringify({ type: "pointer", action, x, y, width: 800, height: 600 }));
    at("down", 150, 75); at("up", 150, 75);
    at("move", 275, 60);
    ws.send(JSON.stringify({ type: "key", action: "down", key: "a", code: "KeyA", keyCode: 65, text: "a" }));
    at("down", 50, 40); at("up", 50, 40);
    ws.send(JSON.stringify({ type: "text", text: "b" }));
    await until(() => app.on("W", "Input.dispatchMouseEvent").length >= 2 && app.on("W", "Input.insertText").length > 0, "the window's click and text");
    expect(app.on("C2", "Input.dispatchMouseEvent").map((c) => c.params)).toEqual([expect.objectContaining({ type: "mouseMoved", x: 25, y: 10 })]);
    expect(app.on("C1", "Input.dispatchMouseEvent").map((c) => c.params)).toEqual([
      expect.objectContaining({ type: "mousePressed", x: 100, y: 50 }),
      expect.objectContaining({ type: "mouseReleased", x: 100, y: 50 }),
    ]);
    // Keys follow the last press: the child had it, then the window.
    expect(app.on("C1", "Input.dispatchKeyEvent").map((c) => c.params.text)).toEqual(["a"]);
    expect(app.on("W", "Input.dispatchKeyEvent")).toEqual([]);
    expect(app.on("W", "Input.dispatchMouseEvent").map((c) => c.params)).toEqual([
      expect.objectContaining({ type: "mousePressed", x: 50, y: 40 }),
      expect.objectContaining({ type: "mouseReleased", x: 50, y: 40 }),
    ]);
    expect(app.on("C1", "Input.insertText")).toEqual([]);
  });

  it("passes a window with no child views through untouched, byte for byte", async () => {
    const { app, client } = await setup();
    // Listening for child views, with none there.
    await until(() => app.on("W", "Runtime.addBinding").length > 0, "the binding");
    expect(app.on("W", "Runtime.addBinding")[0]!.params).toEqual({ name: CHILD_VIEWS_BINDING });
    // Not a decodable JPEG: anything that decoded or re-encoded it would fail.
    const raw = Buffer.from([0xff, 0xd8, 9, 8, 7, 0xff, 0xd9]);
    app.frame("W", raw, 800, 600);
    await until(() => client.parts.length > 0, "the frame");
    expect(client.parts[0]).toEqual(raw);
    expect(app.calls.filter((c) => c.page !== "W")).toEqual([]);
  });

  it("goes back to passing frames through when the last child view goes", async () => {
    const { app, client } = await setup([PANE]);
    await until(() => app.on("C1", "Page.startScreencast").length > 0, "the child's screencast");
    app.children([]);
    await until(() => app.live("C1").length === 0, "the child's socket to close");
    const raw = Buffer.from([0xff, 0xd8, 1, 1, 1, 0xff, 0xd9]);
    app.frame("W", raw, 800, 600);
    await until(() => client.parts.some((p) => p.equals(raw)), "the frame, untouched");
  });

  it("stops each child's screencast and closes its socket when the viewer closes", async () => {
    const { app, viewers, viewer } = await setup([PANE]);
    await until(() => app.on("C1", "Page.startScreencast").length > 0, "the child's screencast");
    await viewers.close(viewer.id);
    expect(app.on("C1", "Page.stopScreencast")).toHaveLength(1);
    await until(() => app.live("C1").length === 0 && app.live("W").length === 0, "every socket to close");
  });
});
