import type { ServerResponse } from "node:http";
import { WebSocket } from "ws";
import {
  CHILD_VIEWS_BINDING, CHILD_VIEWS_GLOBAL, encodeViewerFrame, VIEWER_WINDOW_LAYER, ViewerChildViewSchema, ViewerInputSchema,
  type ViewerChildView, type ViewerLayout,
} from "@realm/contracts";

/**
 * One Electron webContents as MJPEG, over the app's own DevTools protocol.
 *
 * `Page.startScreencast` hands over a JPEG only when the page has painted something new, and holds
 * the next one until the last is acked. So a still page sends nothing, and the last frame is what a
 * client joining late, or an `<img>` waiting on a part boundary, is given — serve-sim's habit, kept
 * for the same pane.
 *
 * Input is synthetic (`Input.dispatch*`), so it needs no Accessibility or Screen Recording grant and
 * never activates the app.
 *
 * The screencast is this one page's DOM, as `capturePage()` is, so child WebContentsViews (a quiet
 * Realm's browser panes) are not in it. When the page lists child views in `CHILD_VIEWS_GLOBAL`,
 * each gets a screencast of its own, sent as a layer of its own on the layers socket beside the
 * window's (`ViewerLayout`), for the viewer to draw at its rect. Nothing here decodes a frame: each
 * JPEG goes out as the app sent it.
 */

const BOUNDARY = "realmframe";
const JPEG_QUALITY = 70;
/** How long a page may sit still before its last frame is sent again. */
const STILL_MS = 1000;
/** How long close waits for `Page.stopScreencast` before dropping the socket anyway. */
const STOP_WAIT_MS = 500;
/** How long the socket may take to open, and a command to be answered, before the app counts as hung. */
export const CDP_TIMEOUT_MS = 5000;

type Size = { width: number; height: number };

/**
 * A point in a `width` x `height` box holding the picture letterboxed (object-fit: contain), as a
 * point on the page in CSS pixels. Null on the bars: a click there is on nothing.
 */
export function toPage(p: { x: number; y: number } & Size, page: Size): { x: number; y: number } | null {
  const scale = Math.min(p.width / page.width, p.height / page.height);
  const left = (p.width - page.width * scale) / 2;
  const top = (p.height - page.height * scale) / 2;
  const x = (p.x - left) / scale, y = (p.y - top) / scale;
  if (x < 0 || y < 0 || x > page.width || y > page.height) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

type CdpEvent = { method: string; params: Record<string, unknown> };
type CdpMessage = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } };
type ScreencastFrame = { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } };

/** One page target's DevTools socket: commands answered by id, and its events. */
class CdpPage {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly timeoutMs: number, private readonly onEvent: (e: CdpEvent) => void, private readonly onClose: () => void) {}

  async open(wsUrl: string): Promise<void> {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, handshakeTimeout: this.timeoutMs });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.on("message", (raw) => {
      let msg: CdpMessage;
      try { msg = JSON.parse(String(raw)) as CdpMessage; } catch { return; }
      this.receive(msg);
    });
    ws.on("close", () => { this.release(); this.onClose(); });
    ws.on("error", () => {});
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("the app's DevTools socket is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the app did not answer ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private receive(m: CdpMessage): void {
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (p) clearTimeout(p.timer);
      if (m.error) p?.reject(new Error(m.error.message)); else p?.resolve(m.result);
      return;
    }
    if (m.method && m.params) this.onEvent({ method: m.method, params: m.params });
  }

  /** Stops the screencast, waiting a moment for Chromium to say so, then drops the socket. */
  async stop(): Promise<void> {
    const stopped = this.send("Page.stopScreencast").catch(() => {});
    await Promise.race([stopped, new Promise((r) => setTimeout(r, STOP_WAIT_MS))]);
    this.close();
  }

  close(): void {
    this.release();
    this.ws?.close();
    this.ws = null;
  }

  private release(): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("the app's DevTools socket closed")); }
    this.pending.clear();
  }
}

/** A screencast frame's JPEG and page size, or null for one that is not usable. Acked either way. */
function frameOf(cdp: CdpPage, params: Record<string, unknown>): { jpeg: Buffer; page: Size } | null {
  const { data, sessionId, metadata } = params as ScreencastFrame;
  void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  let page: Size;
  try {
    page = { width: metadata.deviceWidth, height: metadata.deviceHeight };
    if (typeof data !== "string" || !(page.width > 0) || !(page.height > 0)) return null;
  } catch { return null; }
  return { jpeg: Buffer.from(data, "base64"), page };
}

/** A child view: the rect main says it covers, its own page, and that page's last frame. */
type Child = { rect: ViewerChildView; cdp: CdpPage; attached: boolean; casting: boolean; jpeg: Buffer | null; page: Size | null };

export class ElectronRelay {
  private readonly cdp: CdpPage;
  /** Clients on the window's MJPEG picture. */
  private readonly clients = new Set<ServerResponse>();
  /** Clients on the layers socket. */
  private readonly layerClients = new Set<WebSocket>();
  private windowCasting = false;
  private frame: Buffer | null = null;
  /** The page's viewport in CSS pixels, from the latest frame's metadata. */
  private page: Size | null = null;
  private stillTimer: NodeJS.Timeout | null = null;
  private ended = false;
  /** In z-order, bottom first, as main lists them. */
  private children = new Map<string, Child>();
  private sentLayout = "";
  /** Keys go where the last press went: the window's page, or a child's. */
  private keyTarget: CdpPage | null = null;

  constructor(
    private readonly wsUrl: string,
    private readonly opts: { maxWidth?: number; maxHeight?: number; everyNthFrame?: number; stillMs?: number; timeoutMs?: number; onExit: () => void },
  ) {
    this.cdp = new CdpPage(this.timeoutMs, (e) => this.receive(e), () => this.teardown(true));
  }

  /** Attaches to the page and reads its child views. The screencasts run only while someone is
   *  watching (`serve`, `serveLayers`). */
  async start(): Promise<void> {
    await this.cdp.open(this.wsUrl);
    await this.cdp.send("Page.enable");
    await this.cdp.send("Runtime.addBinding", { name: CHILD_VIEWS_BINDING });
    const seeded = await this.cdp.send("Runtime.evaluate", { expression: `JSON.stringify(globalThis.${CHILD_VIEWS_GLOBAL} ?? [])`, returnByValue: true }) as { result?: { value?: unknown } } | undefined;
    this.setChildren(seeded?.result?.value);
  }

  private get timeoutMs(): number {
    return this.opts.timeoutMs ?? CDP_TIMEOUT_MS;
  }

  private startScreencast(page: CdpPage): void {
    void page.send("Page.startScreencast", {
      format: "jpeg", quality: JPEG_QUALITY, everyNthFrame: this.opts.everyNthFrame ?? 1,
      ...(this.opts.maxWidth ? { maxWidth: this.opts.maxWidth } : {}),
      ...(this.opts.maxHeight ? { maxHeight: this.opts.maxHeight } : {}),
    }).catch(() => {});
  }

  /** Each screencast runs only while someone can see it, as a screencast with no client still costs
   *  the app most of a core on moving content: the window's while any client is connected, a child's
   *  while a layers client is (the MJPEG picture has no children in it). */
  private updateScreencasts(): void {
    if (this.ended) return;
    const window = this.clients.size + this.layerClients.size > 0;
    if (window !== this.windowCasting) {
      this.windowCasting = window;
      if (window) this.startScreencast(this.cdp);
      else {
        if (this.stillTimer) clearTimeout(this.stillTimer);
        this.stillTimer = null;
        void this.cdp.send("Page.stopScreencast").catch(() => {});
      }
    }
    for (const child of this.children.values()) this.updateChild(child);
  }

  private updateChild(child: Child): void {
    const on = child.attached && this.layerClients.size > 0;
    if (on === child.casting) return;
    child.casting = on;
    if (on) this.startScreencast(child.cdp);
    else void child.cdp.send("Page.stopScreencast").catch(() => {});
  }

  private receive({ method, params }: CdpEvent): void {
    if (method === "Runtime.bindingCalled" && params.name === CHILD_VIEWS_BINDING) { this.setChildren(params.payload); return; }
    if (method !== "Page.screencastFrame") return;
    const frame = frameOf(this.cdp, params);
    if (!frame) return;
    this.frame = frame.jpeg;
    this.page = frame.page;
    this.broadcast();
    this.sendFrame(VIEWER_WINDOW_LAYER, frame.jpeg);
    this.sendLayout();
  }

  /** Main's list of child views, as JSON text: attaches to each new one, drops the ones that went,
   *  and keeps the rest with their new rects. */
  private setChildren(json: unknown): void {
    if (this.ended || typeof json !== "string") return;
    let list: ViewerChildView[];
    try {
      const parsed = ViewerChildViewSchema.array().safeParse(JSON.parse(json));
      if (!parsed.success) return;
      list = parsed.data;
    } catch { return; }
    const next = new Map<string, Child>();
    for (const rect of list) {
      if (!/^[\w-]{1,128}$/.test(rect.targetId) || next.has(rect.targetId)) continue;
      const had = this.children.get(rect.targetId);
      if (had) had.rect = rect;
      next.set(rect.targetId, had ?? this.openChild(rect));
    }
    for (const [id, child] of this.children) if (!next.has(id)) this.dropChild(child);
    this.children = next;
    this.sendLayout();
  }

  private openChild(rect: ViewerChildView): Child {
    const id = rect.targetId;
    const current = () => {
      const child = this.children.get(id);
      return child?.cdp === cdp ? child : null;
    };
    const cdp = new CdpPage(this.timeoutMs, (e) => {
      if (e.method !== "Page.screencastFrame") return;
      const frame = frameOf(cdp, e.params);
      const child = current();
      if (!frame || !child) return;
      child.jpeg = frame.jpeg;
      child.page = frame.page;
      this.sendFrame(id, frame.jpeg);
    }, () => {
      if (!current()) return;
      this.children.delete(id);
      if (this.keyTarget === cdp) this.keyTarget = null;
      this.sendLayout();
    });
    cdp.open(this.wsUrl.replace(/[^/]+$/, id))
      .then(() => cdp.send("Page.enable"))
      .then(() => {
        const child = current();
        if (!child || this.ended) { cdp.close(); return; }
        child.attached = true;
        this.updateChild(child);
      })
      .catch(() => cdp.close());
    return { rect, cdp, attached: false, casting: false, jpeg: null, page: null };
  }

  private dropChild(child: Child): void {
    if (this.keyTarget === child.cdp) this.keyTarget = null;
    void child.cdp.stop();
  }

  private layout(): ViewerLayout {
    return {
      type: "layout",
      layers: [
        { id: VIEWER_WINDOW_LAYER, x: 0, y: 0, width: this.page?.width ?? 0, height: this.page?.height ?? 0, z: 0 },
        ...[...this.children.values()].map(({ rect }, i) => ({ id: rect.targetId, x: rect.x, y: rect.y, width: rect.width, height: rect.height, z: i + 1 })),
      ],
    };
  }

  /** Tells the layers clients where the layers are, when that has changed since they were last told. */
  private sendLayout(): void {
    const text = JSON.stringify(this.layout());
    if (text === this.sentLayout) return;
    this.sentLayout = text;
    for (const ws of this.layerClients) ws.send(text);
  }

  private sendFrame(layer: string, jpeg: Buffer, to: Iterable<WebSocket> = this.layerClients): void {
    let message: Uint8Array | null = null;
    for (const ws of to) {
      message ??= encodeViewerFrame(layer, jpeg);
      ws.send(message);
    }
  }

  private broadcast(): void {
    for (const res of this.clients) this.write(res);
    if (this.stillTimer) clearTimeout(this.stillTimer);
    this.stillTimer = null;
    if (this.clients.size === 0) return;
    this.stillTimer = setTimeout(() => this.broadcast(), this.opts.stillMs ?? STILL_MS);
  }

  private write(res: ServerResponse): void {
    if (!this.frame) return;
    res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${this.frame.length}\r\n\r\n`);
    res.write(this.frame);
    res.write("\r\n");
  }

  /** A client on the window's picture. One multipart response, held open until the viewer closes. */
  serve(res: ServerResponse): void {
    if (this.ended) { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Connection: "close",
    });
    res.flushHeaders();
    this.clients.add(res);
    res.on("close", () => {
      if (this.clients.delete(res)) this.updateScreencasts();
    });
    this.updateScreencasts();
    this.write(res);
  }

  /** A client on the layers socket: given the layout and each layer's last frame now, and every
   *  change and frame after. */
  serveLayers(ws: WebSocket): void {
    if (this.ended) { ws.close(); return; }
    this.layerClients.add(ws);
    ws.on("close", () => {
      if (this.layerClients.delete(ws)) this.updateScreencasts();
    });
    ws.send(JSON.stringify(this.layout()));
    if (this.frame) this.sendFrame(VIEWER_WINDOW_LAYER, this.frame, [ws]);
    for (const child of this.children.values()) if (child.jpeg) this.sendFrame(child.rect.targetId, child.jpeg, [ws]);
    this.updateScreencasts();
  }

  /** One message from the input socket. Pointer events before the first frame are dropped: with no
   *  picture yet there is nothing they could have been aimed at. */
  async input(raw: unknown): Promise<void> {
    const parsed = ViewerInputSchema.safeParse(raw);
    if (!parsed.success) return;
    const msg = parsed.data;
    const keys = this.keyTarget ?? this.cdp;
    if (msg.type === "text") { await keys.send("Input.insertText", { text: msg.text }); return; }
    if (msg.type === "key") {
      const type = msg.action === "up" ? "keyUp" : msg.text ? "keyDown" : "rawKeyDown";
      await keys.send("Input.dispatchKeyEvent", {
        type, key: msg.key, code: msg.code, windowsVirtualKeyCode: msg.keyCode, modifiers: msg.modifiers,
        ...(type === "keyDown" ? { text: msg.text, unmodifiedText: msg.text } : {}),
      });
      return;
    }
    if (!this.page) return;
    let hit: { target: CdpPage; at: { x: number; y: number } } | null;
    if (msg.layer !== undefined) hit = this.onLayer(msg.layer, msg);
    else {
      const onPage = toPage(msg, this.page);
      hit = onPage && this.under(onPage);
    }
    if (!hit) return;
    const { target, at } = hit;
    if (msg.action === "down") this.keyTarget = target === this.cdp ? null : target;
    const type = { down: "mousePressed", up: "mouseReleased", move: "mouseMoved", wheel: "mouseWheel" }[msg.action];
    await target.send("Input.dispatchMouseEvent", {
      type, x: at.x, y: at.y, button: msg.button, clickCount: msg.clickCount, modifiers: msg.modifiers,
      ...(msg.action === "wheel" ? { deltaX: msg.deltaX, deltaY: msg.deltaY } : {}),
    });
  }

  /** A point in a layer's own CSS pixels, on that layer's page. */
  private onLayer(id: string, p: { x: number; y: number }): { target: CdpPage; at: { x: number; y: number } } | null {
    if (id === VIEWER_WINDOW_LAYER) return { target: this.cdp, at: { x: Math.round(p.x), y: Math.round(p.y) } };
    const child = this.children.get(id);
    if (!child) return null;
    // The child's page can be zoomed, or emulating a device, inside its rect.
    const { rect, page } = child;
    const kx = page && rect.width > 0 ? page.width / rect.width : 1, ky = page && rect.height > 0 ? page.height / rect.height : 1;
    return { target: child.cdp, at: { x: Math.round(p.x * kx), y: Math.round(p.y * ky) } };
  }

  /** The page a point on the window's page lands on: the topmost child view whose rect holds it, or
   *  else the window's page. */
  private under(p: { x: number; y: number }): { target: CdpPage; at: { x: number; y: number } } {
    for (const { rect } of [...this.children.values()].reverse()) {
      if (p.x < rect.x || p.y < rect.y || p.x >= rect.x + rect.width || p.y >= rect.y + rect.height) continue;
      return this.onLayer(rect.targetId, { x: p.x - rect.x, y: p.y - rect.y })!;
    }
    return { target: this.cdp, at: p };
  }

  /** Stops the screencasts and releases the sockets. */
  async close(): Promise<void> {
    if (this.ended) return;
    await Promise.all([this.cdp, ...[...this.children.values()].map((c) => c.cdp)].map((c) => c.stop()));
    this.teardown(false);
  }

  private teardown(exited: boolean): void {
    if (this.ended) return;
    this.ended = true;
    if (this.stillTimer) clearTimeout(this.stillTimer);
    this.stillTimer = null;
    for (const res of this.clients) res.end();
    this.clients.clear();
    for (const ws of this.layerClients) ws.close();
    this.layerClients.clear();
    for (const child of this.children.values()) child.cdp.close();
    this.children.clear();
    this.keyTarget = null;
    this.cdp.close();
    this.frame = null;
    if (exited) this.opts.onExit();
  }
}
