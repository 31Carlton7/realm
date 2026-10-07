import { createServer, type Server } from "node:http";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { SIM_WS_OPCODE, SIMULATOR_BUTTONS, type SimulatorButton } from "@realm/contracts";
import type { Android } from "./android";

/**
 * Realm's own stream for an Android device — `serve-sim`'s counterpart, and there is no third-party
 * one to lean on.
 *
 * The shape is deliberately identical to `ServeSimStream`'s: a loopback `streamUrl` an `<img>` can
 * sit on, and a loopback `wsUrl` carrying the SAME opcode-plus-JSON frames the iOS pane already
 * sends. That is the whole reason the pane needs no Android branch — it draws a picture and sends
 * gestures, and both work out to the same two URLs whichever phone is on the other end.
 *
 * The pictures are `adb exec-out screencap -p`, which is a full PNG per frame and MEASURED at about
 * 1.37 MB and a few hundred milliseconds on a 1080x2400 emulator. So this is a slideshow at two or
 * three frames a second, not video, and it is honest about that rather than pretending: Android has
 * no equivalent of the simulator's framebuffer tap, and the alternative (scrcpy) is a native window
 * that cannot live in a DOM pane — which is the same argument `no-overlay.ts` already makes.
 *
 * `multipart/x-mixed-replace` with PNG parts rather than MJPEG: the frames arrive as PNG and
 * re-encoding each one to JPEG would cost a decode and an encode per frame to save bandwidth on a
 * loopback socket that has none to spare.
 */

/** The frame budget. A screencap round trip is 300-600ms, so asking faster only queues requests
 *  behind each other; the loop waits for a frame before asking for the next in any case. */
const FRAME_GAP_MS = 120;
const BOUNDARY = "realmframe";

export type AndroidStreamHandle = { streamUrl: string; wsUrl: string };

/** A gesture in flight, in device pixels. Android has no "touch down and hold" over adb — `input`
 *  is one complete gesture per invocation — so a drag is buffered and sent as a swipe on release. */
type Touch = { x: number; y: number; at: number; moved: boolean; lastX: number; lastY: number };

/** Below this, a drag is a tap. Two device pixels of jitter from a trackpad is not a swipe, and
 *  sending `input swipe` for it lands nothing at all on most views. */
const TAP_SLOP_PX = 12;

/** The buttons Android has, as keycodes. `home` and `power` exist on both platforms; the rest of the
 *  iOS table (volume, shake, siri) has no adb equivalent and is refused rather than mapped to
 *  something that looks similar. */
const KEYCODES: Partial<Record<SimulatorButton | "back", string>> = {
  home: "KEYCODE_HOME",
  power: "KEYCODE_POWER",
  back: "KEYCODE_BACK",
};

export class AndroidStream {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private port = 0;
  /** One per boot. In the PATH rather than a header, because an `<img src>` cannot set headers. */
  private readonly token = randomBytes(16).toString("base64url");
  private readonly live = new Set<string>();

  constructor(private readonly adb: Android, private readonly size: (serial: string) => Promise<{ width: number; height: number } | null>) {}

  private async listen(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => void this.frames(req.url ?? "", res));
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      const serial = this.match(req.url ?? "", "input");
      if (!serial) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => this.input(ws, serial));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    this.server = server; this.wss = wss;
  }

  /** `/<token>/<serial>/<kind>` → the serial, or null. Constant-time on the token: a path is the
   *  only credential here, and a timing oracle on it is a way to guess one. */
  private match(url: string, kind: "frames" | "input"): string | null {
    const m = new RegExp(`^/([A-Za-z0-9_-]+)/([A-Za-z0-9_.:-]+)/${kind}$`).exec(url.split("?")[0] ?? "");
    if (!m) return null;
    const given = Buffer.from(m[1]!), want = Buffer.from(this.token);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
    return this.live.has(m[2]!) ? m[2]! : null;
  }

  async start(serial: string): Promise<AndroidStreamHandle> {
    await this.listen();
    this.live.add(serial);
    const base = `127.0.0.1:${this.port}/${this.token}/${encodeURIComponent(serial)}`;
    return { streamUrl: `http://${base}/frames`, wsUrl: `ws://${base}/input` };
  }

  stop(serial: string): void { this.live.delete(serial); }

  async close(): Promise<void> {
    this.live.clear();
    this.wss?.clients.forEach((c) => c.terminate());
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null; this.wss = null;
  }

  /** The picture. One multipart response held open for the life of the pane. */
  private async frames(url: string, res: import("node:http").ServerResponse): Promise<void> {
    const serial = this.match(url, "frames");
    if (!serial) { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Connection: "close",
    });
    let open = true;
    res.on("close", () => { open = false; });
    while (open && this.live.has(serial)) {
      const png = await this.adb.screencap(serial);
      if (!open) break;
      if (!png) {
        // A dropped frame is not a dead stream: the device may be mid-rotation or briefly busy.
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      res.write(`--${BOUNDARY}\r\nContent-Type: image/png\r\nContent-Length: ${png.length}\r\n\r\n`);
      res.write(png);
      res.write("\r\n");
      await new Promise((r) => setTimeout(r, FRAME_GAP_MS));
    }
    res.end();
  }

  /** The input channel, speaking the iOS pane's own frames. */
  private input(ws: WebSocket, serial: string): void {
    let touch: Touch | null = null;
    let screen: { width: number; height: number } | null = null;
    void this.size(serial).then((s) => { screen = s; });

    ws.on("message", (raw: Buffer) => {
      void (async () => {
        if (raw.length < 1) return;
        const opcode = raw[0]!;
        let body: Record<string, unknown>;
        try { body = JSON.parse(raw.subarray(1).toString("utf8")) as Record<string, unknown>; } catch { return; }
        // Normalized 0..1 is what the pane speaks; adb wants device pixels. Without the size there
        // is nothing to convert with, and guessing a resolution puts every tap somewhere else.
        if (!screen) screen = await this.size(serial);
        if (!screen) return;
        const px = (v: unknown, span: number) => Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * span);

        if (opcode === SIM_WS_OPCODE.gesture) {
          const x = px(body.x, screen.width), y = px(body.y, screen.height);
          if (body.type === "begin") { touch = { x, y, at: Date.now(), moved: false, lastX: x, lastY: y }; return; }
          if (!touch) return;
          if (body.type === "move") {
            if (Math.hypot(x - touch.x, y - touch.y) > TAP_SLOP_PX) touch.moved = true;
            touch.lastX = x; touch.lastY = y;
            return;
          }
          if (body.type === "end") {
            const t = touch; touch = null;
            if (!t.moved && Math.hypot(x - t.x, y - t.y) <= TAP_SLOP_PX) await this.adb.tap(serial, t.x, t.y);
            else await this.adb.swipe(serial, t.x, t.y, x, y, Math.max(50, Date.now() - t.at));
          }
          return;
        }

        if (opcode === SIM_WS_OPCODE.button) {
          const code = KEYCODES[String(body.button) as SimulatorButton];
          if (code) await this.adb.key(serial, code);
          return;
        }
        if (opcode === SIM_WS_OPCODE.key) {
          // Only the keys with an unambiguous Android counterpart. A HID usage table mapped by guess
          // is a keyboard that types the wrong letters, which is worse than one that types none.
          if (body.type !== "down") return;
          const code = HID_TO_KEYCODE[Number(body.usage)];
          if (code) await this.adb.key(serial, code);
        }
      })();
    });
    ws.on("close", () => { touch = null; });
  }
}

/** The HID usages the pane sends that Android names too. Deliberately small — see the note at the
 *  call site about why a guessed table is worse than a short one. */
const HID_TO_KEYCODE: Record<number, string> = {
  40: "KEYCODE_ENTER",
  41: "KEYCODE_ESCAPE",
  42: "KEYCODE_DEL",
  43: "KEYCODE_TAB",
  44: "KEYCODE_SPACE",
  79: "KEYCODE_DPAD_RIGHT",
  80: "KEYCODE_DPAD_LEFT",
  81: "KEYCODE_DPAD_DOWN",
  82: "KEYCODE_DPAD_UP",
};

export { KEYCODES as ANDROID_BUTTON_KEYCODES, HID_TO_KEYCODE, TAP_SLOP_PX, BOUNDARY as ANDROID_FRAME_BOUNDARY };
