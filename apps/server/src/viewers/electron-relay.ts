import type { ServerResponse } from "node:http";
import { WebSocket } from "ws";
import { ViewerInputSchema, type ViewerInput } from "@realm/contracts";

/**
 * One Electron webContents as MJPEG, over the app's own DevTools protocol.
 *
 * `Page.startScreencast` hands over a JPEG only when the page has painted something new, and holds
 * the next one until the last is acked. So a still page sends nothing, and the last frame is what a
 * client joining late, or an `<img>` waiting on a part boundary, is given — serve-sim's habit, kept
 * for the same pane.
 *
 * Input is synthetic (`Input.dispatch*`), so it needs no Accessibility or Screen Recording grant and
 * never activates the app. Child WebContentsViews are not in the picture: the screencast is this one
 * page's DOM, as `capturePage()` is.
 */

export const BOUNDARY = "realmframe";
const JPEG_QUALITY = 70;
const EVERY_NTH_FRAME = 1;
/** How long a page may sit still before its last frame is sent again. */
export const STILL_MS = 1000;
/** How long close waits for `Page.stopScreencast` before dropping the socket anyway. */
const STOP_WAIT_MS = 500;

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

type CdpMessage = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } };

export class ElectronRelay {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly clients = new Set<ServerResponse>();
  private frame: Buffer | null = null;
  /** The page's viewport in CSS pixels, from the latest frame's metadata. */
  private page: Size | null = null;
  private stillTimer: NodeJS.Timeout | null = null;
  private ended = false;

  constructor(
    private readonly wsUrl: string,
    private readonly opts: { maxWidth?: number; maxHeight?: number; stillMs?: number; onExit: () => void },
  ) {}

  async start(): Promise<void> {
    const ws = new WebSocket(this.wsUrl, { perMessageDeflate: false });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.on("message", (raw) => this.receive(JSON.parse(String(raw)) as CdpMessage));
    ws.on("close", () => this.teardown(true));
    ws.on("error", () => {});
    await this.send("Page.enable");
    await this.send("Page.startScreencast", {
      format: "jpeg", quality: JPEG_QUALITY, everyNthFrame: EVERY_NTH_FRAME,
      ...(this.opts.maxWidth ? { maxWidth: this.opts.maxWidth } : {}),
      ...(this.opts.maxHeight ? { maxHeight: this.opts.maxHeight } : {}),
    });
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
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
    if (m.method !== "Page.screencastFrame" || !m.params) return;
    const { data, sessionId, metadata } = m.params as { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } };
    void this.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    this.frame = Buffer.from(data, "base64");
    this.page = { width: metadata.deviceWidth, height: metadata.deviceHeight };
    this.broadcast();
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
    const msg: ViewerInput = parsed.data;
    if (msg.type === "text") { await this.send("Input.insertText", { text: msg.text }); return; }
    if (msg.type === "key") {
      const type = msg.action === "up" ? "keyUp" : msg.text ? "keyDown" : "rawKeyDown";
      await this.send("Input.dispatchKeyEvent", {
        type, key: msg.key, code: msg.code, windowsVirtualKeyCode: msg.keyCode, modifiers: msg.modifiers ?? 0,
        ...(type === "keyDown" ? { text: msg.text, unmodifiedText: msg.text } : {}),
      });
      return;
    }
    if (!this.page) return;
    const at = toPage(msg, this.page);
    if (!at) return;
    const type = { down: "mousePressed", up: "mouseReleased", move: "mouseMoved", wheel: "mouseWheel" }[msg.action];
    await this.send("Input.dispatchMouseEvent", {
      type, x: at.x, y: at.y, button: msg.button, clickCount: msg.clickCount, modifiers: msg.modifiers ?? 0,
      ...(msg.action === "wheel" ? { deltaX: msg.deltaX, deltaY: msg.deltaY } : {}),
    });
  }

  /** Stops the screencast and releases the socket. */
  async close(): Promise<void> {
    if (this.ended) return;
    const stopped = this.send("Page.stopScreencast").catch(() => {});
    await Promise.race([stopped, new Promise((r) => setTimeout(r, STOP_WAIT_MS))]);
    this.teardown(false);
  }

  private teardown(exited: boolean): void {
    if (this.ended) return;
    this.ended = true;
    if (this.stillTimer) clearTimeout(this.stillTimer);
    this.stillTimer = null;
    for (const res of this.clients) res.end();
    this.clients.clear();
    for (const p of this.pending.values()) p.reject(new Error("the app's DevTools socket closed"));
    this.pending.clear();
    this.ws?.close();
    this.ws = null;
    this.frame = null;
    if (exited) this.opts.onExit();
  }
}
