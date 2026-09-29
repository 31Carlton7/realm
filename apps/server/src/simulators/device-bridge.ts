import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { SIM_WS_OPCODE, SHIFT_USAGE } from "@realm/contracts";
import type { RunnerAct } from "./runner-client";

/**
 * A real iPhone's picture and touch, in the shape the simulator pane already speaks.
 *
 * The pane shows a device as an `<img>` on an MJPEG stream and sends a person's touches as serve-sim's
 * frames down a WebSocket. A phone has no serve-sim, so this is a small loopback server that plays
 * serve-sim's part for one phone: `/stream.mjpeg` is the runner's own screenshots, and the socket's
 * frames become runner calls. The pane does not know the difference, and that is the point — its
 * picture stays an ordinary DOM element (design.md: a native view composites above everything and a
 * CDP capture would show a hole), and it is the SAME picture the agent reads and acts on.
 *
 * Frames are taken only while somebody is watching: the first client starts the loop, the last one to
 * leave stops it. A pane that is off screen drops its `<img>`, so a hidden pane costs the phone nothing.
 */

export type BridgeRunner = {
  screenshot(o: { format: "jpeg"; scale: number; quality: number }): Promise<Buffer>;
  tap(x: number, y: number, count: 1 | 2, holdMs?: number): Promise<RunnerAct>;
  swipe(from: { x: number; y: number }, to: { x: number; y: number }, durationMs: number, holdMs: number): Promise<RunnerAct>;
  text(text: string): Promise<RunnerAct>;
  key(key: "return" | "delete" | "space"): Promise<RunnerAct>;
  button(button: "home" | "volume-up" | "volume-down"): Promise<RunnerAct>;
};

export type BridgeOptions = {
  runner: BridgeRunner;
  /** The screen in POINTS — what a 0..1 frame from the pane is multiplied by. */
  screen: { width: number; height: number };
  /** How often a frame is asked for while somebody watches. */
  frameMs?: number;
  /** Keystrokes arriving this close together are typed as one run. */
  typeAfterMs?: number;
};

/** A finger that moved less than this, in points, did not swipe. */
const TAP_SLOP = 10;
/** Held still longer than this, a touch is a long press. */
const LONG_PRESS_MS = 450;
const BOUNDARY = "realmframe";

export class DeviceBridge {
  readonly streamUrl: string;
  readonly wsUrl: string;
  private readonly watchers = new Set<ServerResponse>();
  private latest: Buffer | null = null;
  private looping = false;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly server: Server, private readonly wss: WebSocketServer, readonly port: number, private readonly o: Required<BridgeOptions>) {
    this.streamUrl = `http://127.0.0.1:${port}/stream.mjpeg`;
    this.wsUrl = `ws://127.0.0.1:${port}/ws`;
  }

  static async start(options: BridgeOptions): Promise<DeviceBridge> {
    const o: Required<BridgeOptions> = { frameMs: 250, typeAfterMs: 150, ...options };
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
    const bridge = new DeviceBridge(server, wss, (server.address() as { port: number }).port, o);
    server.on("request", (req, res) => bridge.request(req, res));
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (req.url !== "/ws") { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => bridge.input(ws));
    });
    return bridge;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const res of this.watchers) res.end();
    this.watchers.clear();
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /* ── the picture ─────────────────────────────────────────────────────────────────────────────── */

  private request(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET" || req.url !== "/stream.mjpeg") { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "Cache-Control": "no-cache, no-store",
      Connection: "close",
    });
    this.watchers.add(res);
    // The last frame at once, so a pane that reconnects is not black until the next one.
    if (this.latest) this.send(res, this.latest);
    res.on("close", () => this.watchers.delete(res));
    void this.loop();
  }

  private send(res: ServerResponse, jpeg: Buffer): void {
    res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
    res.write(jpeg);
    res.write("\r\n");
  }

  /** One loop per phone, however many panes watch it, and none while nobody does. */
  private async loop(): Promise<void> {
    if (this.looping) return;
    this.looping = true;
    try {
      while (!this.closed && this.watchers.size > 0) {
        const t0 = Date.now();
        try {
          // Half size: a quarter of the bytes across the cable, and still sharper than the pane draws it.
          const jpeg = await this.o.runner.screenshot({ format: "jpeg", scale: 0.5, quality: 0.6 });
          this.latest = jpeg;
          for (const res of this.watchers) this.send(res, jpeg);
        } catch {
          // A runner mid-restart, or a phone that went to sleep: keep the last picture and look again later.
          await new Promise((r) => setTimeout(r, 1_000));
        }
        const left = this.o.frameMs - (Date.now() - t0);
        if (left > 0) await new Promise((r) => setTimeout(r, left));
      }
    } finally {
      this.looping = false;
    }
  }

  /* ── touch and keys ──────────────────────────────────────────────────────────────────────────── */

  /** One step at a time, in the order the pane sent them: a tap must not overtake the swipe before it. */
  private serially(work: () => Promise<unknown>): void {
    this.queue = this.queue.then(work, work).catch(() => {});
  }

  private input(ws: WebSocket): void {
    let down: { x: number; y: number; at: number } | null = null;
    let shift = false;
    let typed = "";
    let typing: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (typing) { clearTimeout(typing); typing = null; }
      const text = typed;
      typed = "";
      if (text) this.serially(() => this.o.runner.text(text));
    };
    const points = (p: { x: number; y: number }) => ({ x: p.x * this.o.screen.width, y: p.y * this.o.screen.height });

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary || data.length < 2) return;
      let body: Record<string, unknown>;
      try { body = JSON.parse(data.subarray(1).toString("utf8")) as Record<string, unknown>; } catch { return; }
      const op = data[0];
      if (op === SIM_WS_OPCODE.gesture) {
        const x = Number(body.x), y = Number(body.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const at = points({ x, y });
        // A move says nothing the end does not: the runner draws a straight line from where the finger
        // went down to where it came up, in the time it took.
        if (body.type === "begin") { flush(); down = { ...at, at: Date.now() }; return; }
        if (body.type !== "end" || !down) return;
        const from = down, to = at, heldMs = Date.now() - from.at;
        down = null;
        const moved = Math.hypot(to.x - from.x, to.y - from.y) >= TAP_SLOP;
        if (!moved) {
          this.serially(() => this.o.runner.tap(from.x, from.y, 1, heldMs >= LONG_PRESS_MS ? heldMs : undefined));
        } else {
          this.serially(() => this.o.runner.swipe({ x: from.x, y: from.y }, to, Math.min(2_000, Math.max(50, heldMs)), 0));
        }
        return;
      }
      if (op === SIM_WS_OPCODE.button) {
        const button = body.button;
        // Home and the volume buttons are what the runner can press. The side button is not: a phone
        // the runner locked is one only its owner can unlock.
        if (button === "home" || button === "volume-up" || button === "volume-down") {
          flush();
          this.serially(() => this.o.runner.button(button));
        }
        return;
      }
      if (op === SIM_WS_OPCODE.key) {
        const usage = Number(body.usage);
        if (usage === SHIFT_USAGE) { shift = body.type === "down"; return; }
        if (body.type !== "down") return;
        const named = NAMED_KEYS[usage];
        if (named) { flush(); this.serially(() => this.o.runner.key(named)); return; }
        const ch = characterOf(usage, shift);
        if (!ch) return;
        typed += ch;
        if (typing) clearTimeout(typing);
        typing = setTimeout(flush, this.o.typeAfterMs);
      }
      // Orientation is not something the runner turns on a phone in someone's hand; it is ignored.
    });
    ws.on("close", flush);
  }
}

/** The keys that are keys rather than characters, by HID usage. */
const NAMED_KEYS: Record<number, "return" | "delete"> = { 40: "return", 42: "delete" };

/** A HID usage (and shift) → the character a US keyboard types: `keyUsage` in `simulator-input.ts`,
 *  read backwards. */
export function characterOf(usage: number, shift: boolean): string | null {
  if (usage >= 4 && usage <= 29) { const c = String.fromCharCode(97 + usage - 4); return shift ? c.toUpperCase() : c; }
  if (usage >= 30 && usage <= 39) {
    const digits = "1234567890", shifted = "!@#$%^&*()";
    return (shift ? shifted : digits)[usage - 30] ?? null;
  }
  const table: Record<number, [string, string]> = {
    44: [" ", " "], 45: ["-", "_"], 46: ["=", "+"], 47: ["[", "{"], 48: ["]", "}"], 49: ["\\", "|"],
    51: [";", ":"], 52: ["'", "\""], 53: ["`", "~"], 54: [",", "<"], 55: [".", ">"], 56: ["/", "?"],
  };
  const pair = table[usage];
  return pair ? pair[shift ? 1 : 0] : null;
}
