import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, get, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { toPage } from "./electron-relay";
import { ViewerService } from "./service";

/** A stand-in for an Electron app's `--remote-debugging-port`: `/json/list` naming one page, and that
 *  page's socket recording every command and answering each with `{}`. */
async function fakeCdp() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const sockets: WebSocket[] = [];
  const server: Server = createServer((req, res) => {
    if (req.url !== "/json/list") { res.writeHead(404).end(); return; }
    const { port } = server.address() as { port: number };
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify([
      { id: "SW", type: "service_worker", url: "chrome://x", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/SW` },
      { id: "P1", type: "page", url: "file:///app/index.html", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/P1` },
      { id: "P2", type: "page", url: "file:///app/index.html", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/P2` },
    ]));
  });
  const wss = new WebSocketServer({ server });
  const paths: string[] = [];
  wss.on("connection", (ws, req) => {
    sockets.push(ws);
    paths.push(req.url ?? "");
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as { id: number; method: string; params?: Record<string, unknown> };
      calls.push({ method: m.method, params: m.params ?? {} });
      ws.send(JSON.stringify({ id: m.id, result: {} }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  let session = 0;
  return {
    port, calls, sockets, paths,
    /** One `Page.screencastFrame`, as Chromium sends it. */
    frame(jpeg: Buffer, deviceWidth = 800, deviceHeight = 600) {
      const sessionId = ++session;
      for (const ws of sockets) ws.send(JSON.stringify({ method: "Page.screencastFrame", params: { data: jpeg.toString("base64"), sessionId, metadata: { deviceWidth, deviceHeight, offsetTop: 0, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 0 } } }));
      return sessionId;
    },
    async waitFor(method: string, n = 1) {
      await until(() => calls.filter((c) => c.method === method).length >= n, `${method} x${n}`);
      return calls.filter((c) => c.method === method);
    },
    async close() { wss.clients.forEach((c) => c.terminate()); await new Promise<void>((r) => server.close(() => r())); },
  };
}

async function until(fn: () => boolean, what: string, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A client on the MJPEG stream, splitting the body into its JPEG parts. */
function watch(url: string) {
  const parts: Buffer[] = [];
  let ended = false;
  let res: IncomingMessage | null = null;
  let buf = Buffer.alloc(0);
  const req = get(url, (r) => {
    res = r;
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
    r.on("end", () => { ended = true; });
    r.on("close", () => { ended = true; });
  });
  req.on("error", () => { ended = true; });
  return { parts, get ended() { return ended; }, get res() { return res; }, stop: () => req.destroy() };
}

async function input(url: string, ...msgs: unknown[]) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  for (const m of msgs) ws.send(JSON.stringify(m));
  return ws;
}

/** An interval no other timer in this file uses, so the relay's own can be told apart. */
const STILL = 37;
const JPEG_A = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const JPEG_B = Buffer.from([0xff, 0xd8, 4, 5, 6, 7, 0xff, 0xd9]);

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanup.reverse()) await c(); cleanup = []; });

async function setup(opts: { stillMs?: number } = {}) {
  const cdp = await fakeCdp();
  const viewers = new ViewerService(opts);
  cleanup.push(() => cdp.close(), () => viewers.closeAll());
  const viewer = await viewers.open({ kind: "electron", cdpPort: cdp.port, title: "Realm", pid: 4242, maxWidth: 1280, maxHeight: 720 });
  return { cdp, viewers, viewer };
}

describe("toPage (letterbox)", () => {
  it("maps a point in a wider box through the pillarbox", () => {
    // An 800x600 page in a 1000x600 box: scale 1, 100px bars left and right.
    expect(toPage({ x: 100, y: 0, width: 1000, height: 600 }, { width: 800, height: 600 })).toEqual({ x: 0, y: 0 });
    expect(toPage({ x: 500, y: 300, width: 1000, height: 600 }, { width: 800, height: 600 })).toEqual({ x: 400, y: 300 });
  });
  it("maps a point in a taller, smaller box through the letterbox and the scale", () => {
    // An 800x600 page in a 400x400 box: scale 0.5, picture 400x300, 50px bars top and bottom.
    expect(toPage({ x: 200, y: 50, width: 400, height: 400 }, { width: 800, height: 600 })).toEqual({ x: 400, y: 0 });
    expect(toPage({ x: 400, y: 350, width: 400, height: 400 }, { width: 800, height: 600 })).toEqual({ x: 800, y: 600 });
  });
  it("refuses a point on the bars", () => {
    expect(toPage({ x: 50, y: 300, width: 1000, height: 600 }, { width: 800, height: 600 })).toBeNull();
    expect(toPage({ x: 200, y: 20, width: 400, height: 400 }, { width: 800, height: 600 })).toBeNull();
  });
});

describe("ViewerService (electron)", () => {
  it("opens on the app's page target and starts a JPEG screencast sized to the pane", async () => {
    const { cdp, viewer, viewers } = await setup();
    expect(viewer).toMatchObject({ kind: "electron", title: "Realm", pid: 4242, status: "live" });
    expect(viewer.streamUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    expect(viewer.inputUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\//);
    const [start] = await cdp.waitFor("Page.startScreencast");
    expect(start!.params).toMatchObject({ format: "jpeg", maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
    expect(viewers.list()).toEqual([viewer]);
  });

  it("attaches to the page target named by id, or else the first page, at the frame rate asked for", async () => {
    const { cdp } = await setup();
    const viewers = new ViewerService();
    cleanup.push(() => viewers.closeAll());
    await viewers.open({ kind: "electron", cdpPort: cdp.port, targetId: "P2", everyNthFrame: 3 });
    expect(cdp.paths).toEqual(["/devtools/page/P1", "/devtools/page/P2"]);
    const starts = await cdp.waitFor("Page.startScreencast", 2);
    expect(starts[1]!.params).toMatchObject({ everyNthFrame: 3 });
  });

  it("relays each screencast frame to the MJPEG stream", async () => {
    const { cdp, viewer } = await setup();
    const client = watch(viewer.streamUrl);
    cleanup.push(async () => { client.stop(); });
    await until(() => client.res !== null, "the stream response");
    expect(client.res!.headers["content-type"]).toMatch(/^multipart\/x-mixed-replace; boundary=/);
    cdp.frame(JPEG_A);
    await until(() => client.parts.length >= 1, "frame A");
    cdp.frame(JPEG_B);
    await until(() => client.parts.some((p) => p.equals(JPEG_B)), "frame B");
    expect(client.parts[0]).toEqual(JPEG_A);
  });

  it("acks every frame with its own session id", async () => {
    const { cdp } = await setup();
    await cdp.waitFor("Page.startScreencast");
    const a = cdp.frame(JPEG_A), b = cdp.frame(JPEG_B);
    const acks = await cdp.waitFor("Page.screencastFrameAck", 2);
    expect(acks.map((x) => x.params.sessionId)).toEqual([a, b]);
  });

  it("sends the last frame to a client that joins late, and again while the page is still", async () => {
    const { cdp, viewer } = await setup({ stillMs: 40 });
    await cdp.waitFor("Page.startScreencast");
    cdp.frame(JPEG_A);
    await cdp.waitFor("Page.screencastFrameAck");
    const late = watch(viewer.streamUrl);
    cleanup.push(async () => { late.stop(); });
    await until(() => late.parts.length >= 1, "the last frame");
    expect(late.parts[0]).toEqual(JPEG_A);
    await until(() => late.parts.length >= 3, "re-sends while still");
    expect(late.parts.every((p) => p.equals(JPEG_A))).toBe(true);
  });

  it("scales pointer events from viewer to page coordinates", async () => {
    const { cdp, viewer } = await setup();
    await cdp.waitFor("Page.startScreencast");
    cdp.frame(JPEG_A, 800, 600);
    await cdp.waitFor("Page.screencastFrameAck");
    const ws = await input(viewer.inputUrl,
      { type: "pointer", action: "down", x: 200, y: 150, width: 400, height: 400 },
      { type: "pointer", action: "up", x: 200, y: 150, width: 400, height: 400 },
      { type: "pointer", action: "down", x: 10, y: 10, width: 400, height: 400 }, // on the bar: dropped
      { type: "pointer", action: "wheel", x: 0, y: 200, width: 400, height: 400, button: "none", deltaY: 120 },
    );
    cleanup.push(async () => ws.close());
    const mouse = await cdp.waitFor("Input.dispatchMouseEvent", 3);
    expect(mouse.map((m) => m.params)).toEqual([
      expect.objectContaining({ type: "mousePressed", x: 400, y: 200, button: "left", clickCount: 1 }),
      expect.objectContaining({ type: "mouseReleased", x: 400, y: 200, button: "left", clickCount: 1 }),
      expect.objectContaining({ type: "mouseWheel", x: 0, y: 300, deltaY: 120 }),
    ]);
  });

  it("forwards keys and text", async () => {
    const { cdp, viewer } = await setup();
    await cdp.waitFor("Page.startScreencast");
    const ws = await input(viewer.inputUrl,
      { type: "key", action: "down", key: "a", code: "KeyA", keyCode: 65, text: "a" },
      { type: "key", action: "up", key: "a", code: "KeyA", keyCode: 65 },
      { type: "key", action: "down", key: "Enter", code: "Enter", keyCode: 13, modifiers: 4 },
      { type: "text", text: "héllo" },
    );
    cleanup.push(async () => ws.close());
    const keys = await cdp.waitFor("Input.dispatchKeyEvent", 3);
    expect(keys.map((k) => k.params)).toEqual([
      expect.objectContaining({ type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, text: "a" }),
      expect.objectContaining({ type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 }),
      expect.objectContaining({ type: "rawKeyDown", key: "Enter", windowsVirtualKeyCode: 13, modifiers: 4 }),
    ]);
    const [text] = await cdp.waitFor("Input.insertText");
    expect(text!.params).toEqual({ text: "héllo" });
  });

  it("close stops the screencast, releases the CDP socket and ends the stream", async () => {
    const { cdp, viewer, viewers } = await setup({ stillMs: STILL });
    await cdp.waitFor("Page.startScreencast");
    cdp.frame(JPEG_A);
    const client = watch(viewer.streamUrl);
    await until(() => client.parts.length >= 1, "a frame");
    const ws = await input(viewer.inputUrl);
    const socket = cdp.sockets[0]!;
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    await viewers.close(viewer.id);
    await cdp.waitFor("Page.stopScreencast");
    await until(() => socket.readyState === WebSocket.CLOSED, "the CDP socket to close");
    await until(() => client.ended, "the stream to end");
    await until(() => ws.readyState === WebSocket.CLOSED, "the input socket to close");
    expect(viewers.list()).toEqual([]);
    const seen = client.parts.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(client.parts.length).toBe(seen);
    // A still re-send timer left behind re-arms itself forever; none may be scheduled after close.
    expect(timeouts.mock.calls.filter(([, ms]) => ms === STILL)).toEqual([]);
    timeouts.mockRestore();
    const after = watch(viewer.streamUrl);
    await until(() => after.res !== null || after.ended, "a reply");
    expect(after.res?.statusCode).toBe(404);
  });

  it("when the app exits, marks the viewer exited and tears its stream down", async () => {
    const { cdp, viewer, viewers } = await setup({ stillMs: STILL });
    await cdp.waitFor("Page.startScreencast");
    cdp.frame(JPEG_A);
    const client = watch(viewer.streamUrl);
    await until(() => client.parts.length >= 1, "a frame");
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    cdp.sockets[0]!.terminate();
    await until(() => viewers.list()[0]?.status === "exited", "status exited");
    await until(() => client.ended, "the stream to end");
    const seen = client.parts.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(client.parts.length).toBe(seen);
    expect(timeouts.mock.calls.filter(([, ms]) => ms === STILL)).toEqual([]);
    timeouts.mockRestore();
  });

  it("refuses a port with no page target", async () => {
    const server = createServer((_req, res) => res.writeHead(200).end("[]"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
    const viewers = new ViewerService();
    cleanup.push(() => viewers.closeAll());
    await expect(viewers.open({ kind: "electron", cdpPort: (server.address() as { port: number }).port })).rejects.toThrow(/no page/i);
    expect(viewers.list()).toEqual([]);
  });
});
