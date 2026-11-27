import type { ServerResponse } from "node:http";
import { WebSocket } from "ws";
import { CHILD_VIEWS_BINDING, CHILD_VIEWS_GLOBAL, ViewerChildViewSchema, ViewerInputSchema, type ViewerChildView } from "@realm/contracts";

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
 * Realm's browser panes) are not in it. When the page lists child views in
 * `CHILD_VIEWS_GLOBAL` (see `ViewerChildViewSchema`), each gets a screencast of its own, drawn at its
 * rect over the window's frame, and a point inside its rect goes to it. A page with no child views
 * is passed through as it comes, and sharp is never loaded.
 */

const BOUNDARY = "realmframe";
const JPEG_QUALITY = 70;
/** How long a page may sit still before its last frame is sent again. */
const STILL_MS = 1000;
/** How long close waits for `Page.stopScreencast` before dropping the socket anyway. */
const STOP_WAIT_MS = 500;
/** The least time between composited frames. Chromium paints moving content at the display's rate
 *  (about 95 fps measured), and drawing each of those cost two cores at 1400x900. */
const COMPOSITE_MS = 50;

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
type Raw = { width: number; height: number; channels: 3 | 4 };
type ScreencastFrame = { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } };

/** One page target's DevTools socket: commands answered by id, and its events. */
class CdpPage {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private readonly onEvent: (e: CdpEvent) => void, private readonly onClose: () => void) {}

  async open(wsUrl: string): Promise<void> {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.on("message", (raw) => this.receive(JSON.parse(String(raw)) as CdpMessage));
    ws.on("close", () => { this.release(); this.onClose(); });
    ws.on("error", () => {});
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("the app's DevTools socket is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private receive(m: CdpMessage): void {
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
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
    for (const p of this.pending.values()) p.reject(new Error("the app's DevTools socket closed"));
    this.pending.clear();
  }
}

/** A child view's picture, and the rect main says it covers. `layer` is that picture resized to the
 *  rect in frame pixels, kept until either changes. */
type Child = { rect: ViewerChildView; cdp: CdpPage; jpeg: Buffer | null; page: Size | null; layer: { key: string; input: Buffer; raw: Raw } | null };

export class ElectronRelay {
  private readonly cdp: CdpPage;
  private readonly clients = new Set<ServerResponse>();
  private frame: Buffer | null = null;
  /** The window's own latest frame, which child views are drawn over. */
  private windowFrame: Buffer | null = null;
  /** The page's viewport in CSS pixels, from the latest frame's metadata. */
  private page: Size | null = null;
  private stillTimer: NodeJS.Timeout | null = null;
  private ended = false;
  /** In z-order, bottom first, as main lists them. */
  private children = new Map<string, Child>();
  private compositing = false;
  private compositeAgain = false;
  private compositeTimer: NodeJS.Timeout | null = null;
  private lastComposite = 0;
  /** The window's latest frame decoded, while it is the latest: a child that changes alone is drawn
   *  over it without decoding the window again. */
  private base: { jpeg: Buffer; data: Buffer; raw: Raw } | null = null;
  /** Keys go where the last press went: the window's page, or a child's. */
  private keyTarget: CdpPage | null = null;

  constructor(
    private readonly wsUrl: string,
    private readonly opts: { maxWidth?: number; maxHeight?: number; everyNthFrame?: number; stillMs?: number; onExit: () => void },
  ) {
    this.cdp = new CdpPage((e) => this.receive(e), () => this.teardown(true));
  }

  async start(): Promise<void> {
    await this.cdp.open(this.wsUrl);
    await this.screencast(this.cdp);
    await this.cdp.send("Runtime.addBinding", { name: CHILD_VIEWS_BINDING });
    const seeded = await this.cdp.send("Runtime.evaluate", { expression: `JSON.stringify(globalThis.${CHILD_VIEWS_GLOBAL} ?? [])`, returnByValue: true }) as { result?: { value?: unknown } } | undefined;
    this.setChildren(seeded?.result?.value);
  }

  private async screencast(page: CdpPage): Promise<void> {
    await page.send("Page.enable");
    await page.send("Page.startScreencast", {
      format: "jpeg", quality: JPEG_QUALITY, everyNthFrame: this.opts.everyNthFrame ?? 1,
      ...(this.opts.maxWidth ? { maxWidth: this.opts.maxWidth } : {}),
      ...(this.opts.maxHeight ? { maxHeight: this.opts.maxHeight } : {}),
    });
  }

  private receive({ method, params }: CdpEvent): void {
    if (method === "Runtime.bindingCalled" && params.name === CHILD_VIEWS_BINDING) { this.setChildren(params.payload); return; }
    if (method !== "Page.screencastFrame") return;
    const { data, sessionId, metadata } = params as ScreencastFrame;
    void this.cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    const frame = Buffer.from(data, "base64");
    this.page = { width: metadata.deviceWidth, height: metadata.deviceHeight };
    this.windowFrame = frame;
    if (this.children.size > 0) { this.composite(); return; }
    this.frame = frame;
    this.broadcast();
  }

  /** Main's list of child views, as JSON text: opens a screencast on each new one, drops the ones
   *  that went, and keeps the rest with their new rects. */
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
      if (!/^[\w-]+$/.test(rect.targetId) || next.has(rect.targetId)) continue;
      const had = this.children.get(rect.targetId);
      next.set(rect.targetId, had ? { ...had, rect } : this.openChild(rect));
    }
    for (const [id, child] of this.children) if (!next.has(id)) this.dropChild(child);
    this.children = next;
    if (!this.windowFrame) return;
    if (next.size > 0) { this.composite(); return; }
    this.frame = this.windowFrame;
    this.broadcast();
  }

  private openChild(rect: ViewerChildView): Child {
    const cdp = new CdpPage((e) => {
      if (e.method !== "Page.screencastFrame") return;
      const { data, sessionId, metadata } = e.params as ScreencastFrame;
      void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      const current = this.children.get(rect.targetId);
      if (current?.cdp !== cdp) return;
      current.jpeg = Buffer.from(data, "base64");
      current.page = { width: metadata.deviceWidth, height: metadata.deviceHeight };
      current.layer = null;
      this.composite();
    }, () => {
      const current = this.children.get(rect.targetId);
      if (current?.cdp !== cdp) return;
      this.children.delete(rect.targetId);
      if (this.keyTarget === cdp) this.keyTarget = null;
      this.composite();
    });
    const child: Child = { rect, cdp, jpeg: null, page: null, layer: null };
    cdp.open(this.wsUrl.replace(/[^/]+$/, rect.targetId)).then(() => this.screencast(cdp)).catch(() => cdp.close());
    return child;
  }

  private dropChild(child: Child): void {
    if (this.keyTarget === child.cdp) this.keyTarget = null;
    void child.cdp.stop();
  }

  /** Draws the child views over the window's latest frame. One at a time and at most one per
   *  `COMPOSITE_MS`: frames that arrive in between are folded into the next. */
  private composite(): void {
    if (this.compositing || this.compositeTimer) { this.compositeAgain = true; return; }
    const wait = this.lastComposite + COMPOSITE_MS - Date.now();
    if (wait > 0) {
      this.compositeTimer = setTimeout(() => { this.compositeTimer = null; this.composite(); }, wait);
      return;
    }
    this.compositing = true;
    this.compositeAgain = false;
    this.lastComposite = Date.now();
    void this.draw()
      .then((jpeg) => {
        if (!jpeg || this.ended || this.children.size === 0) return;
        this.frame = jpeg;
        this.broadcast();
      })
      .catch(() => {})
      .finally(() => {
        this.compositing = false;
        if (this.compositeAgain && !this.ended) this.composite();
      });
  }

  private async draw(): Promise<Buffer | null> {
    const base = this.windowFrame, page = this.page;
    if (!base || !page) return null;
    const { default: sharp } = await import("sharp");
    if (this.base?.jpeg !== base) {
      const { data, info } = await sharp(base).raw().toBuffer({ resolveWithObject: true });
      this.base = { jpeg: base, data, raw: { width: info.width, height: info.height, channels: info.channels as 3 | 4 } };
    }
    const { data, raw } = this.base, { width, height } = raw;
    // The rects are in the page's CSS pixels; the frame may be smaller (maxWidth) or larger (a 2x display).
    const sx = width / page.width, sy = height / page.height;
    const layers: { input: Buffer; raw: Raw; left: number; top: number }[] = [];
    for (const child of this.children.values()) {
      if (!child.jpeg) continue;
      const { rect } = child;
      const left = Math.round(rect.x * sx), top = Math.round(rect.y * sy);
      const w = Math.round((rect.x + rect.width) * sx) - left, h = Math.round((rect.y + rect.height) * sy) - top;
      // Only the part of the rect inside the frame: sharp refuses a layer that hangs off the edge.
      const x0 = Math.max(0, left), y0 = Math.max(0, top);
      const x1 = Math.min(width, left + w), y1 = Math.min(height, top + h);
      if (w <= 0 || h <= 0 || x1 <= x0 || y1 <= y0) continue;
      const key = `${left},${top},${w},${h},${width},${height}`;
      if (child.layer?.key !== key) {
        const { data, info } = await sharp(child.jpeg)
          .resize(w, h, { fit: "fill" })
          .extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 })
          .raw().toBuffer({ resolveWithObject: true });
        child.layer = { key, input: data, raw: { width: info.width, height: info.height, channels: info.channels as 3 | 4 } };
      }
      layers.push({ input: child.layer.input, raw: child.layer.raw, left: x0, top: y0 });
    }
    return sharp(data, { raw }).composite(layers).jpeg({ quality: JPEG_QUALITY }).toBuffer();
  }

  private broadcast(): void {
    for (const res of this.clients) this.write(res);
    if (this.stillTimer) clearTimeout(this.stillTimer);
    this.stillTimer = setTimeout(() => this.broadcast(), this.opts.stillMs ?? STILL_MS);
  }

  private write(res: ServerResponse): void {
    if (!this.frame) return;
    res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${this.frame.length}\r\n\r\n`);
    res.write(this.frame);
    res.write("\r\n");
  }

  /** A client on the picture. One multipart response, held open until the viewer closes. */
  serve(res: ServerResponse): void {
    if (this.ended) { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Connection: "close",
    });
    res.flushHeaders();
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
    this.write(res);
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
    const onPage = toPage(msg, this.page);
    if (!onPage) return;
    const { target, at } = this.under(onPage);
    if (msg.action === "down") this.keyTarget = target === this.cdp ? null : target;
    const type = { down: "mousePressed", up: "mouseReleased", move: "mouseMoved", wheel: "mouseWheel" }[msg.action];
    await target.send("Input.dispatchMouseEvent", {
      type, x: at.x, y: at.y, button: msg.button, clickCount: msg.clickCount, modifiers: msg.modifiers,
      ...(msg.action === "wheel" ? { deltaX: msg.deltaX, deltaY: msg.deltaY } : {}),
    });
  }

  /** The page a point on the window's page lands on: the topmost child view whose rect holds it, in
   *  that child's own CSS pixels, or else the window's page. */
  private under(p: { x: number; y: number }): { target: CdpPage; at: { x: number; y: number } } {
    for (const child of [...this.children.values()].reverse()) {
      const { rect } = child;
      if (p.x < rect.x || p.y < rect.y || p.x >= rect.x + rect.width || p.y >= rect.y + rect.height) continue;
      // The child's page can be zoomed, or emulating a device, inside its rect.
      const kx = child.page ? child.page.width / rect.width : 1, ky = child.page ? child.page.height / rect.height : 1;
      return { target: child.cdp, at: { x: Math.round((p.x - rect.x) * kx), y: Math.round((p.y - rect.y) * ky) } };
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
    if (this.compositeTimer) clearTimeout(this.compositeTimer);
    this.compositeTimer = null;
    for (const res of this.clients) res.end();
    this.clients.clear();
    for (const child of this.children.values()) child.cdp.close();
    this.children.clear();
    this.keyTarget = null;
    this.cdp.close();
    this.frame = null;
    this.windowFrame = null;
    this.base = null;
    if (exited) this.opts.onExit();
  }
}
