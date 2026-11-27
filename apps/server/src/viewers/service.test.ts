import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, get, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { toPage } from "./electron-relay";
import { HiddenApps } from "./hidden-apps";
import { ViewerService } from "./service";

/** A stand-in for an Electron app's `--remote-debugging-port`: `/json/list` naming one page, and that
 *  page's socket recording every command and answering each with `{}`. `wsUrl` lets a test have the
 *  list name some other socket; `hang` leaves `/json/list` unanswered, and `silent` every command. */
async function fakeCdp(opts: { wsUrl?: (port: number, id: string) => string; hang?: boolean; silent?: boolean } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const sockets: WebSocket[] = [];
  let lists = 0;
  const server: Server = createServer((req, res) => {
    if (req.url !== "/json/list") { res.writeHead(404).end(); return; }
    lists++;
    if (opts.hang) return;
    const { port } = server.address() as { port: number };
    const wsUrl = opts.wsUrl ?? ((p: number, id: string) => `ws://127.0.0.1:${p}/devtools/page/${id}`);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify([
      { id: "SW", type: "service_worker", url: "chrome://x", webSocketDebuggerUrl: wsUrl(port, "SW") },
      { id: "P1", type: "page", url: "file:///app/index.html", webSocketDebuggerUrl: wsUrl(port, "P1") },
      { id: "P2", type: "page", url: "file:///app/index.html", webSocketDebuggerUrl: wsUrl(port, "P2") },
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
      if (!opts.silent) ws.send(JSON.stringify({ id: m.id, result: {} }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  let session = 0;
  return {
    port, calls, sockets, paths, get lists() { return lists; },
    /** Anything, sent raw down every page socket. */
    raw(text: string) { for (const ws of sockets) ws.send(text); },
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
    async close() { wss.clients.forEach((c) => c.terminate()); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); },
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
  return inputFrom(undefined, url, ...msgs);
}

async function inputFrom(origin: string | undefined, url: string, ...msgs: unknown[]) {
  const ws = new WebSocket(url, origin === undefined ? {} : { origin });
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

/** Where the renderer's handshakes come from, as `createApp` passes the RPC socket's list. */
const ORIGINS = ["file://"];

async function setup(opts: { stillMs?: number } = {}) {
  const cdp = await fakeCdp();
  const apps = new HiddenApps();
  const app = apps.record({ cdpPort: cdp.port, pid: 4242 });
  const viewers = new ViewerService({ apps, allowedOrigins: ORIGINS, ...opts });
  cleanup.push(() => cdp.close(), () => viewers.closeAll());
  const viewer = await viewers.open({ kind: "electron", appId: app.id, title: "Realm", maxWidth: 1280, maxHeight: 720 });
  return { cdp, apps, app, viewers, viewer };
}

/** Watches the stream until it has its response, and stops watching when the test ends. */
async function watching(url: string) {
  const client = watch(url);
  cleanup.push(async () => { client.stop(); });
  await until(() => client.res !== null || client.ended, "the stream response");
  return client;
}

/** Whether a WebSocket handshake to `url` is let in. */
function upgrades(url: string, origin?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, origin === undefined ? {} : { origin });
    ws.once("open", () => { ws.close(); resolve(true); });
    ws.once("error", () => resolve(false));
  });
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
    await watching(viewer.streamUrl);
    const [start] = await cdp.waitFor("Page.startScreencast");
    expect(start!.params).toMatchObject({ format: "jpeg", maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
    expect(viewers.list()).toEqual([viewer]);
  });

  it("attaches to the page target named by id, or else the first page, at the frame rate asked for", async () => {
    const { cdp, apps, app } = await setup();
    const viewers = new ViewerService({ apps });
    cleanup.push(() => viewers.closeAll());
    const viewer = await viewers.open({ kind: "electron", appId: app.id, targetId: "P2", everyNthFrame: 3 });
    expect(cdp.paths).toEqual(["/devtools/page/P1", "/devtools/page/P2"]);
    await watching(viewer.streamUrl);
    const [start] = await cdp.waitFor("Page.startScreencast");
    expect(start!.params).toMatchObject({ everyNthFrame: 3 });
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
    const { cdp, viewer } = await setup();
    await watching(viewer.streamUrl);
    await cdp.waitFor("Page.startScreencast");
    const a = cdp.frame(JPEG_A), b = cdp.frame(JPEG_B);
    const acks = await cdp.waitFor("Page.screencastFrameAck", 2);
    expect(acks.map((x) => x.params.sessionId)).toEqual([a, b]);
  });

  it("sends the last frame to a client that joins late, and again while the page is still", async () => {
    const { cdp, viewer } = await setup({ stillMs: 40 });
    const first = await watching(viewer.streamUrl);
    await cdp.waitFor("Page.startScreencast");
    cdp.frame(JPEG_A);
    await until(() => first.parts.length >= 1, "frame A");
    const late = watch(viewer.streamUrl);
    cleanup.push(async () => { late.stop(); });
    await until(() => late.parts.length >= 1, "the last frame");
    expect(late.parts[0]).toEqual(JPEG_A);
    await until(() => late.parts.length >= 3, "re-sends while still");
    expect(late.parts.every((p) => p.equals(JPEG_A))).toBe(true);
  });

  it("scales pointer events from viewer to page coordinates", async () => {
    const { cdp, viewer } = await setup();
    await watching(viewer.streamUrl);
    await cdp.waitFor("Page.startScreencast");
    cdp.frame(JPEG_A, 800, 600);
    await cdp.waitFor("Page.screencastFrameAck");
    const ws = await input(viewer.inputUrl,
      { type: "pointer", action: "down", x: 200, y: 150, width: 400, height: 400 },
      { type: "pointer", action: "up", x: 200, y: 150, width: 400, height: 400 },
      { type: "pointer", action: "down", x: 10, y: 10, width: 400, height: 400 }, // on the bar: dropped
      { type: "pointer", action: "wheel", x: 0, y: 200, width: 400, height: 400, deltaY: 120 },
      { type: "pointer", action: "move", x: 200, y: 150, width: 400, height: 400 },
      { type: "pointer", action: "move", x: 202, y: 150, width: 400, height: 400, button: "left" },
    );
    cleanup.push(async () => ws.close());
    const mouse = await cdp.waitFor("Input.dispatchMouseEvent", 5);
    expect(mouse.map((m) => m.params)).toEqual([
      expect.objectContaining({ type: "mousePressed", x: 400, y: 200, button: "left", clickCount: 1 }),
      expect.objectContaining({ type: "mouseReleased", x: 400, y: 200, button: "left", clickCount: 1 }),
      // A wheel and a bare move are no button, so a hover is not a drag; a drag says so.
      expect.objectContaining({ type: "mouseWheel", x: 0, y: 300, deltaY: 120, button: "none" }),
      expect.objectContaining({ type: "mouseMoved", x: 400, y: 200, button: "none" }),
      expect.objectContaining({ type: "mouseMoved", x: 404, y: 200, button: "left" }),
    ]);
  });

  it("forwards keys and text", async () => {
    const { cdp, viewer } = await setup();
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
    const client = watch(viewer.streamUrl);
    await cdp.waitFor("Page.startScreencast");
    cdp.frame(JPEG_A);
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

  it("when the app exits, drops the viewer and tears its stream down", async () => {
    const { cdp, viewer, viewers } = await setup({ stillMs: STILL });
    const client = watch(viewer.streamUrl);
    await cdp.waitFor("Page.startScreencast");
    cdp.frame(JPEG_A);
    await until(() => client.parts.length >= 1, "a frame");
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    cdp.sockets[0]!.terminate();
    await until(() => viewers.list().length === 0, "the viewer to leave the list");
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
    const apps = new HiddenApps();
    const app = apps.record({ cdpPort: (server.address() as { port: number }).port, pid: null });
    const viewers = new ViewerService({ apps });
    cleanup.push(() => viewers.closeAll());
    await expect(viewers.open({ kind: "electron", appId: app.id })).rejects.toThrow(/no page/i);
    expect(viewers.list()).toEqual([]);
  });
});

describe("ViewerService screencast lifetime", () => {
  it("captures only while someone watches: the first client starts it, the last one out stops it", async () => {
    const { cdp, viewer } = await setup({ stillMs: STILL });
    await cdp.waitFor("Page.enable");
    await new Promise((r) => setTimeout(r, 30));
    expect(cdp.calls.filter((c) => c.method === "Page.startScreencast")).toEqual([]);

    const a = await watching(viewer.streamUrl);
    const b = await watching(viewer.streamUrl);
    cdp.frame(JPEG_A);
    await until(() => a.parts.length >= 1 && b.parts.length >= 1, "frame A on both");
    expect(cdp.calls.filter((c) => c.method === "Page.startScreencast")).toHaveLength(1);

    a.stop();
    await new Promise((r) => setTimeout(r, 30));
    expect(cdp.calls.filter((c) => c.method === "Page.stopScreencast")).toEqual([]);

    b.stop();
    await cdp.waitFor("Page.stopScreencast");
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    // A frame Chromium had in flight when it was told to stop.
    const late = cdp.frame(JPEG_A);
    await until(() => cdp.calls.some((x) => x.method === "Page.screencastFrameAck" && x.params.sessionId === late), "the late frame acked");
    await new Promise((r) => setTimeout(r, STILL * 3));
    // With nobody watching, nothing re-sends the still frame either.
    expect(timeouts.mock.calls.filter(([, ms]) => ms === STILL)).toEqual([]);
    timeouts.mockRestore();

    const c = await watching(viewer.streamUrl);
    const starts = await cdp.waitFor("Page.startScreencast", 2);
    expect(starts[1]!.params).toMatchObject({ format: "jpeg", maxWidth: 1280, maxHeight: 720 });
    cdp.frame(JPEG_B);
    await until(() => c.parts.some((p) => p.equals(JPEG_B)), "frame B on the next client");
  });
});

describe("ViewerService secrets and origins", () => {
  it("gives each viewer its own secret: a wrong one, or another viewer's, is a 404 and a refused socket", async () => {
    const { app, viewer, viewers } = await setup();
    const other = await viewers.open({ kind: "electron", appId: app.id, targetId: "P2" });
    expect(new URL(other.streamUrl).pathname.split("/")[1]).not.toBe(new URL(viewer.streamUrl).pathname.split("/")[1]);

    const wrong = viewer.streamUrl.replace(/\/[A-Za-z0-9_-]+\/([0-9A-Z]{26})\//, "/AAAAAAAAAAAAAAAAAAAAAA/$1/");
    expect(wrong).not.toBe(viewer.streamUrl);
    expect((await watching(wrong)).res?.statusCode).toBe(404);
    expect(await upgrades(wrong.replace(/^http/, "ws").replace(/frames$/, "input"))).toBe(false);

    // The other viewer's secret on this viewer's id.
    const swapped = viewer.streamUrl.replace(new URL(viewer.streamUrl).pathname.split("/")[1]!, new URL(other.streamUrl).pathname.split("/")[1]!);
    expect((await watching(swapped)).res?.statusCode).toBe(404);
    expect(await upgrades(swapped.replace(/^http/, "ws").replace(/frames$/, "input"))).toBe(false);

    expect((await watching(viewer.streamUrl)).res?.statusCode).toBe(200);
    expect(await upgrades(viewer.inputUrl)).toBe(true);
  });

  it("refuses an input socket from a page that is not Realm's renderer", async () => {
    const { cdp, viewer } = await setup();
    expect(await upgrades(viewer.inputUrl, "https://evil.example")).toBe(false);
    expect(await upgrades(viewer.inputUrl, "http://127.0.0.1:5173")).toBe(false);
    expect(await upgrades(viewer.inputUrl, "file://")).toBe(true);
    // Node's `ws` sends no Origin: judged on the secret alone, as the RPC socket does.
    expect(await upgrades(viewer.inputUrl)).toBe(true);
    const ws = await inputFrom("file://", viewer.inputUrl, { type: "text", text: "ok" });
    cleanup.push(async () => ws.close());
    const [text] = await cdp.waitFor("Input.insertText");
    expect(text!.params).toEqual({ text: "ok" });
  });
});

describe("ViewerService attach guard", () => {
  async function bare(cdpOpts: Parameters<typeof fakeCdp>[0] = {}, own?: number) {
    const cdp = await fakeCdp(cdpOpts);
    const apps = new HiddenApps();
    const app = apps.record({ cdpPort: cdp.port, pid: 1 });
    const viewers = new ViewerService({ apps, ownDevtoolsPort: own === undefined ? null : own === 0 ? cdp.port : own, timeoutMs: 200 });
    cleanup.push(() => cdp.close(), () => viewers.closeAll());
    return { cdp, apps, app, viewers };
  }

  it("refuses an app id Realm's launcher never recorded, and a raw port", async () => {
    const { cdp, viewers } = await bare();
    await expect(viewers.open({ kind: "electron", appId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(viewers.open({ kind: "electron", cdpPort: cdp.port } as never)).rejects.toThrow();
    expect(cdp.lists).toBe(0);
    expect(cdp.paths).toEqual([]);
    expect(viewers.list()).toEqual([]);
  });

  it("refuses Realm's own DevTools port even when the launcher recorded it", async () => {
    const { cdp, app, viewers } = await bare({}, 0);
    await expect(viewers.open({ kind: "electron", appId: app.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(cdp.lists).toBe(0);
    expect(cdp.paths).toEqual([]);
  });

  it.each([
    ["another port", (p: number, id: string) => `ws://127.0.0.1:${p + 1}/devtools/page/${id}`],
    ["another host", (p: number, id: string) => `ws://localhost:${p}/devtools/page/${id}`],
    ["the browser socket", (p: number) => `ws://127.0.0.1:${p}/devtools/browser/B`],
    ["another page's id", (p: number) => `ws://127.0.0.1:${p}/devtools/page/SW`],
    ["no socket at all", () => undefined as unknown as string],
  ])("refuses a page whose webSocketDebuggerUrl names %s", async (_what, wsUrl) => {
    const { cdp, app, viewers } = await bare({ wsUrl });
    await expect(viewers.open({ kind: "electron", appId: app.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(cdp.lists).toBe(1);
    expect(cdp.paths).toEqual([]);
    expect(viewers.list()).toEqual([]);
  });
});

describe("ViewerService robustness", () => {
  it("gives up on a /json/list that never answers", async () => {
    const cdp = await fakeCdp({ hang: true });
    const apps = new HiddenApps();
    const app = apps.record({ cdpPort: cdp.port, pid: null });
    const viewers = new ViewerService({ apps, timeoutMs: 100 });
    cleanup.push(() => cdp.close(), () => viewers.closeAll());
    await expect(viewers.open({ kind: "electron", appId: app.id })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("gives up on a page that never answers a command", async () => {
    const cdp = await fakeCdp({ silent: true });
    const apps = new HiddenApps();
    const app = apps.record({ cdpPort: cdp.port, pid: null });
    const viewers = new ViewerService({ apps, timeoutMs: 100 });
    cleanup.push(() => cdp.close(), () => viewers.closeAll());
    await expect(viewers.open({ kind: "electron", appId: app.id })).rejects.toThrow(/did not answer Page\.enable/);
    expect(viewers.list()).toEqual([]);
  });

  it("survives a message that is not JSON and frames with no size", async () => {
    const { cdp, viewer, viewers } = await setup();
    const client = await watching(viewer.streamUrl);
    await cdp.waitFor("Page.startScreencast");
    cdp.raw("not json {");
    cdp.raw(JSON.stringify({ method: "Page.screencastFrame", params: { data: JPEG_A.toString("base64"), sessionId: 98 } }));
    cdp.raw(JSON.stringify({ method: "Page.screencastFrame", params: { data: JPEG_A.toString("base64"), sessionId: 99, metadata: {} } }));
    await until(() => cdp.calls.some((c) => c.method === "Page.screencastFrameAck" && c.params.sessionId === 99), "the bad frames acked");
    cdp.frame(JPEG_B);
    await until(() => client.parts.some((p) => p.equals(JPEG_B)), "the next good frame");
    expect(client.parts.some((p) => p.equals(JPEG_A))).toBe(false);
    expect(viewers.list()[0]?.status).toBe("live");
  });
});
