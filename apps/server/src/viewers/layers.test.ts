import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, get, type Server } from "node:http";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { CHILD_VIEWS_BINDING, decodeViewerFrame, type ViewerChildView, type ViewerLayout } from "@realm/contracts";
import { HiddenApps } from "./hidden-apps";
import { ViewerService } from "./service";

/** A stand-in for a quiet Realm's `--remote-debugging-port`: the window's page W and the child pages
 *  C1 and C2, each on its own socket. W answers `Runtime.evaluate` with the child list main left in
 *  the page, and `children()` changes it the way main does, through the binding. `slowStop` leaves
 *  `Page.stopScreencast` unanswered, as a busy page can, so a socket stays open past it. */
async function fakeRealm(opts: { slowStop?: boolean } = {}) {
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
      if (opts.slowStop && m.method === "Page.stopScreencast") return;
      const result = m.method === "Runtime.evaluate" && page === "W" ? { result: { type: "string", value: JSON.stringify(children) } } : {};
      ws.send(JSON.stringify({ id: m.id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  let session = 0;
  const live = (page: string) => (sockets.get(page) ?? []).filter((ws) => ws.readyState === WebSocket.OPEN);
  return {
    port, calls, live,
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
      return sessionId;
    },
    on(page: string, method: string) { return calls.filter((c) => c.page === page && c.method === method); },
    async close() { wss.clients.forEach((c) => c.terminate()); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); },
  };
}

async function until(fn: () => boolean, what: string | (() => string), ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${typeof what === "string" ? what : what()}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 40));

/** A client on the layers socket: every layout, and every frame with its layer. */
async function layers(url: string) {
  const layouts: ViewerLayout[] = [];
  const frames: { layer: string; jpeg: Buffer }[] = [];
  const ws = new WebSocket(url);
  ws.on("message", (raw, binary) => {
    if (!binary) { layouts.push(JSON.parse(String(raw)) as ViewerLayout); return; }
    const frame = decodeViewerFrame(new Uint8Array(raw as Buffer));
    if (frame) frames.push({ layer: frame.layer, jpeg: Buffer.from(frame.jpeg) });
  });
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  cleanup.push(async () => ws.close());
  return { layouts, frames, ws, get last() { return layouts.at(-1); }, stop: () => ws.close() };
}

/** A client on the window's MJPEG stream, splitting the body into its JPEG parts. */
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
  cleanup.push(async () => { req.destroy(); });
  return { parts, stop: () => req.destroy() };
}

const JPEG_W = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const JPEG_C1 = Buffer.from([0xff, 0xd8, 4, 5, 6, 0x00, 0xff, 0xd9]);
const JPEG_C2 = Buffer.from([0xff, 0xd8, 7, 8, 0xff, 0xd9]);

const C1: ViewerChildView = { targetId: "C1", x: 100, y: 50, width: 200, height: 100 };
const C2: ViewerChildView = { targetId: "C2", x: 250, y: 50, width: 300, height: 300 };

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanup.reverse()) await c(); cleanup = []; });

async function setup(seed: ViewerChildView[] = [], opts: { slowStop?: boolean } = {}) {
  const app = await fakeRealm(opts);
  app.seed(seed);
  const apps = new HiddenApps();
  const record = apps.record({ cdpPort: app.port, pid: 1 });
  const viewers = new ViewerService({ apps });
  cleanup.push(() => app.close(), () => viewers.closeAll());
  const viewer = await viewers.open({ kind: "electron", appId: record.id, targetId: "W" });
  return { app, viewers, viewer };
}

const windowAt = (width: number, height: number) => ({ id: "window", x: 0, y: 0, width, height, z: 0 });

describe("viewer layers: layout", () => {
  it("is sent on connect: the window at the bottom, then each child view at its rect", async () => {
    const { viewer } = await setup([C1, C2]);
    expect(viewer.layersUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/.+\/layers$/);
    const client = await layers(viewer.layersUrl);
    await until(() => client.layouts.length >= 1, "a layout");
    expect(client.layouts[0]).toEqual({ type: "layout", layers: [windowAt(0, 0), { id: "C1", x: 100, y: 50, width: 200, height: 100, z: 1 }, { id: "C2", x: 250, y: 50, width: 300, height: 300, z: 2 }] });
  });

  it("is sent again when a view moves, comes or goes, or the window's page changes size, and not otherwise", async () => {
    const { app, viewer } = await setup([C1]);
    const client = await layers(viewer.layersUrl);
    await until(() => client.layouts.length >= 1, "the first layout");

    app.children([{ ...C1, x: 120 }, C2]);
    await until(() => client.layouts.length >= 2, "the layout after a move and an add");
    expect(client.last!.layers.map((l) => [l.id, l.x, l.z])).toEqual([["window", 0, 0], ["C1", 120, 1], ["C2", 250, 2]]);

    app.children([C2]);
    await until(() => client.layouts.length >= 3, "the layout after a removal");
    expect(client.last!.layers.map((l) => [l.id, l.z])).toEqual([["window", 0], ["C2", 1]]);

    app.frame("W", JPEG_W, 800, 600);
    await until(() => client.layouts.length >= 4, "the layout with the window's size");
    expect(client.last!.layers[0]).toEqual(windowAt(800, 600));

    // The same list again, and another frame at the same size: nothing changed, nothing is sent.
    app.children([C2]);
    app.frame("W", JPEG_W, 800, 600);
    await until(() => client.frames.filter((f) => f.layer === "window").length >= 2, "the second window frame");
    await settle();
    expect(client.layouts).toHaveLength(4);
  });
});

describe("viewer layers: frames", () => {
  it("tags each frame with its layer and forwards the JPEG byte for byte", async () => {
    const { app, viewer } = await setup([C1]);
    const client = await layers(viewer.layersUrl);
    await until(() => app.on("C1", "Page.startScreencast").length >= 1 && app.on("W", "Page.startScreencast").length >= 1, "both screencasts");
    app.frame("W", JPEG_W, 800, 600);
    app.frame("C1", JPEG_C1, 400, 200);
    await until(() => client.frames.length >= 2, "two frames");
    const w = client.frames.find((f) => f.layer === "window"), c1 = client.frames.find((f) => f.layer === "C1");
    expect(w?.jpeg.equals(JPEG_W)).toBe(true);
    expect(c1?.jpeg.equals(JPEG_C1)).toBe(true);
    // Every frame is acked on its own page.
    await until(() => app.on("C1", "Page.screencastFrameAck").length >= 1, "C1's ack");
  });

  it("gives a client that joins late each layer's last frame, and the MJPEG stream only the window's", async () => {
    const { app, viewer } = await setup([C1]);
    const first = await layers(viewer.layersUrl);
    const mjpeg = watch(viewer.streamUrl);
    await until(() => app.on("C1", "Page.startScreencast").length >= 1, "C1's screencast");
    app.frame("W", JPEG_W, 800, 600);
    app.frame("C1", JPEG_C1, 400, 200);
    await until(() => first.frames.length >= 2 && mjpeg.parts.length >= 1, "the frames");
    const late = await layers(viewer.layersUrl);
    await until(() => late.frames.length >= 2, "the last frames");
    expect(late.layouts.length).toBe(1);
    expect(Object.fromEntries(late.frames.map((f) => [f.layer, [...f.jpeg]]))).toEqual({ window: [...JPEG_W], C1: [...JPEG_C1] });
    expect(mjpeg.parts.every((p) => p.equals(JPEG_W))).toBe(true);
  });

  it("drops a frame from a view that has gone", async () => {
    const { app, viewer } = await setup([C1], { slowStop: true });
    const client = await layers(viewer.layersUrl);
    await until(() => app.on("C1", "Page.startScreencast").length >= 1, "C1's screencast");
    app.children([]);
    await until(() => client.layouts.length >= 2 && app.on("C1", "Page.stopScreencast").length >= 1, "the layout without C1");
    // A frame Chromium had in flight, on a socket still waiting for its stop to be answered.
    expect(app.live("C1")).toHaveLength(1);
    app.frame("C1", JPEG_C1, 400, 200);
    await settle();
    expect(client.frames.filter((f) => f.layer === "C1")).toEqual([]);
  });
});

describe("viewer layers: input", () => {
  async function ready(seed: ViewerChildView[]) {
    const s = await setup(seed);
    const client = await layers(s.viewer.layersUrl);
    await until(() => seed.every((c) => s.app.on(c.targetId, "Page.startScreencast").length >= 1), "the child screencasts");
    s.app.frame("W", JPEG_W, 800, 600);
    // C1 is zoomed 2x inside its rect: its page is 400x200 CSS px in a 200x100 rect.
    s.app.frame("C1", JPEG_C1, 400, 200);
    s.app.frame("C2", JPEG_C2, 300, 300);
    await until(() => client.frames.length >= 1 + seed.length, "a frame on each layer");
    const ws = new WebSocket(s.viewer.inputUrl);
    await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
    cleanup.push(async () => ws.close());
    const send = (...msgs: unknown[]) => { for (const m of msgs) ws.send(JSON.stringify(m)); };
    return { ...s, send };
  }

  it("sends a pointer event naming a layer to that layer's page, mapped through its own zoom", async () => {
    const { app, send } = await ready([C1, C2]);
    send(
      { type: "pointer", layer: "C1", action: "down", x: 10, y: 20 },
      { type: "pointer", layer: "C1", action: "wheel", x: 50, y: 50, deltaY: 30 },
      // C2 is on top here, but the event named C1.
      { type: "pointer", layer: "C1", action: "up", x: 190, y: 20 },
      { type: "pointer", layer: "window", action: "move", x: 5, y: 6 },
      { type: "pointer", layer: "nope", action: "down", x: 1, y: 1 },
    );
    await until(() => app.on("C1", "Input.dispatchMouseEvent").length >= 3 && app.on("W", "Input.dispatchMouseEvent").length >= 1, "the mouse events");
    await settle();
    expect(app.on("C1", "Input.dispatchMouseEvent").map((c) => c.params)).toEqual([
      expect.objectContaining({ type: "mousePressed", x: 20, y: 40, button: "left" }),
      expect.objectContaining({ type: "mouseWheel", x: 100, y: 100, deltaY: 30, button: "none" }),
      expect.objectContaining({ type: "mouseReleased", x: 380, y: 40 }),
    ]);
    expect(app.on("W", "Input.dispatchMouseEvent").map((c) => c.params)).toEqual([expect.objectContaining({ type: "mouseMoved", x: 5, y: 6 })]);
    expect(app.on("C2", "Input.dispatchMouseEvent")).toEqual([]);
  });

  it("routes an event naming no layer to the topmost view under the point, or else the window", async () => {
    const { app, send } = await ready([C1, C2]);
    // The viewer box is the page's own size, so viewer and page coordinates agree.
    const box = { width: 800, height: 600 };
    send(
      { type: "pointer", action: "down", x: 270, y: 60, ...box }, // C1 and C2 overlap here: C2 is on top
      { type: "pointer", action: "down", x: 110, y: 60, ...box }, // C1 alone, zoomed 2x
      { type: "pointer", action: "down", x: 20, y: 500, ...box }, // the window
    );
    await until(() => app.on("C2", "Input.dispatchMouseEvent").length >= 1 && app.on("C1", "Input.dispatchMouseEvent").length >= 1 && app.on("W", "Input.dispatchMouseEvent").length >= 1, "a press on each");
    expect(app.on("C2", "Input.dispatchMouseEvent")[0]!.params).toMatchObject({ x: 20, y: 10 });
    expect(app.on("C1", "Input.dispatchMouseEvent")[0]!.params).toMatchObject({ x: 20, y: 20 });
    expect(app.on("W", "Input.dispatchMouseEvent")[0]!.params).toMatchObject({ x: 20, y: 500 });
  });

  it("sends keys and text to the page that took the last press", async () => {
    const { app, send } = await ready([C1]);
    send({ type: "pointer", layer: "C1", action: "down", x: 10, y: 10 }, { type: "text", text: "in C1" });
    await until(() => app.on("C1", "Input.insertText").length >= 1, "text in C1");
    send({ type: "pointer", action: "down", x: 20, y: 500, width: 800, height: 600 }, { type: "key", action: "down", key: "a", text: "a" });
    await until(() => app.on("W", "Input.dispatchKeyEvent").length >= 1, "a key in the window");
    expect(app.on("W", "Input.insertText")).toEqual([]);
    expect(app.on("C1", "Input.dispatchKeyEvent")).toEqual([]);
    send({ type: "pointer", action: "down", x: 110, y: 60, width: 800, height: 600 }, { type: "key", action: "down", key: "b", text: "b" });
    await until(() => app.on("C1", "Input.dispatchKeyEvent").length >= 1, "a key in C1 after a fallback press");
  });
});

describe("viewer layers: screencast lifetime", () => {
  it("captures a child view only while a layers client is connected: the first starts it, the last one out stops it", async () => {
    const { app, viewer } = await setup([C1]);
    await until(() => app.on("C1", "Page.enable").length >= 1, "C1 attached");
    // A window-only MJPEG client cannot show a child, so it starts the window's screencast alone.
    const mjpeg = watch(viewer.streamUrl);
    await until(() => app.on("W", "Page.startScreencast").length >= 1, "the window's screencast");
    await settle();
    expect(app.on("C1", "Page.startScreencast")).toEqual([]);

    const a = await layers(viewer.layersUrl);
    const b = await layers(viewer.layersUrl);
    await until(() => app.on("C1", "Page.startScreencast").length >= 1, "C1's screencast");
    await settle();
    expect(app.on("C1", "Page.startScreencast")).toHaveLength(1);
    expect(app.on("W", "Page.startScreencast")).toHaveLength(1);

    a.stop();
    await settle();
    expect(app.on("C1", "Page.stopScreencast")).toEqual([]);
    b.stop();
    await until(() => app.on("C1", "Page.stopScreencast").length >= 1, "C1's screencast to stop");
    // The MJPEG client still watches the window.
    expect(app.on("W", "Page.stopScreencast")).toEqual([]);
    expect(app.live("C1")).toHaveLength(1);

    mjpeg.stop();
    await until(() => app.on("W", "Page.stopScreencast").length >= 1, "the window's screencast to stop");

    await layers(viewer.layersUrl);
    await until(() => app.on("C1", "Page.startScreencast").length >= 2 && app.on("W", "Page.startScreencast").length >= 2, "both to start again");
  });

  it("starts a view that comes while watched, and stops and lets go of one that goes", async () => {
    const { app, viewer } = await setup([C1]);
    await layers(viewer.layersUrl);
    await until(() => app.on("C1", "Page.startScreencast").length >= 1, "C1's screencast");
    app.children([C1, C2]);
    await until(() => app.on("C2", "Page.startScreencast").length >= 1, "C2's screencast");
    app.children([C2]);
    await until(() => app.on("C1", "Page.stopScreencast").length >= 1, "C1's screencast to stop");
    await until(() => app.live("C1").length === 0, "C1's socket to close");
    expect(app.on("C2", "Page.stopScreencast")).toEqual([]);
  });

  it("drops a view whose page goes away by itself, and says so in the layout", async () => {
    const { app, viewer } = await setup([C1]);
    const client = await layers(viewer.layersUrl);
    await until(() => app.on("C1", "Page.startScreencast").length >= 1, "C1's screencast");
    for (const ws of app.live("C1")) ws.terminate();
    await until(() => client.layouts.length >= 2, "a layout without C1");
    expect(client.last!.layers.map((l) => l.id)).toEqual(["window"]);
  });

  it("close stops every layer's screencast and ends the layers socket", async () => {
    const { app, viewer, viewers } = await setup([C1]);
    const client = await layers(viewer.layersUrl);
    await until(() => app.on("C1", "Page.startScreencast").length >= 1, "C1's screencast");
    await viewers.close(viewer.id);
    expect(app.on("C1", "Page.stopScreencast")).toHaveLength(1);
    expect(app.on("W", "Page.stopScreencast")).toHaveLength(1);
    await until(() => client.ws.readyState === WebSocket.CLOSED, "the layers socket to close");
    await until(() => app.live("C1").length === 0 && app.live("W").length === 0, "the CDP sockets to close");
  });
});

describe("viewer layers: secret and origin", () => {
  function upgrades(url: string, origin?: string): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url, origin === undefined ? {} : { origin });
      ws.once("open", () => { ws.close(); resolve(true); });
      ws.once("error", () => resolve(false));
    });
  }

  it("refuses a layers socket with a wrong secret, or from a page that is not Realm's renderer", async () => {
    const app = await fakeRealm();
    const apps = new HiddenApps();
    const record = apps.record({ cdpPort: app.port, pid: 1 });
    const viewers = new ViewerService({ apps, allowedOrigins: ["file://"] });
    cleanup.push(() => app.close(), () => viewers.closeAll());
    const viewer = await viewers.open({ kind: "electron", appId: record.id, targetId: "W" });
    const wrong = viewer.layersUrl.replace(/\/[A-Za-z0-9_-]+\/([0-9A-Z]{26})\//, "/AAAAAAAAAAAAAAAAAAAAAA/$1/");
    expect(wrong).not.toBe(viewer.layersUrl);
    expect(await upgrades(wrong)).toBe(false);
    expect(await upgrades(viewer.layersUrl, "https://evil.example")).toBe(false);
    expect(await upgrades(viewer.layersUrl, "file://")).toBe(true);
  });
});

describe("viewer layers: the server decodes nothing", () => {
  it("has no sharp, nor any other image library, to decode with", () => {
    const root = join(import.meta.dirname, "../..");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
    expect(Object.keys(deps).filter((d) => /^(sharp|jpeg-js|@img\/)/.test(d))).toEqual([]);
    const sources = readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" }).filter((f) => /\.ts$/.test(f));
    expect(sources.filter((f) => /from ["']sharp["']|import\(["']sharp["']\)/.test(readFileSync(join(root, "src", f), "utf8")))).toEqual([]);
  });
});
