import { b64u, CHANNEL_ID_BYTES, ed25519Sign, HEARTBEAT_MS, PING, relayAuthMessage, type DeviceKeys } from "@realm/remote";
import WebSocket from "ws";

/**
 * The Mac's one outbound connection to the relay (PROTOCOL.md §3). Nothing listens on the Mac's
 * network: realm-server dials out, signs the relay's challenge, and from then on carries every phone's
 * channel over this socket, each frame prefixed with its 16-byte channel id.
 */

export type LinkState = "connecting" | "connected" | "offline";

export type LinkEvents = {
  /** The relay has a socket for this channel: a paired phone (`phone`) or a phone pairing (`pair`). */
  open(ch: string, who: { phone: string } | { pair: string }): void;
  data(ch: string, bytes: Buffer): void;
  close(ch: string): void;
  /** Any other control message (`pushed`, …). */
  control(msg: Record<string, unknown>): void;
  state(s: LinkState): void;
  /** Called on every `ready`, so the relay always holds the current phone list and window. */
  ready(): void;
};

export class RelayLink {
  private ws: WebSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = false;
  private current: LinkState = "offline";

  constructor(private readonly o: { relay: string; macId: string; keys: DeviceKeys; on: LinkEvents; log?: (s: string) => void }) {}

  get state(): LinkState { return this.current; }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.ws?.close(1000, "stopped");
    this.ws = null;
    this.setState("offline");
  }

  send(ch: string, bytes: Buffer): boolean {
    if (this.current !== "connected" || !this.ws) return false;
    this.ws.send(Buffer.concat([Buffer.from(ch, "base64url"), bytes]));
    return true;
  }

  control(msg: Record<string, unknown>): boolean {
    if (this.current !== "connected" || !this.ws) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private setState(s: LinkState): void {
    if (s === this.current) return;
    this.current = s;
    this.o.on.state(s);
  }

  private connect(): void {
    this.setState("connecting");
    // No permessage-deflate (PROTOCOL.md §3): every frame is ciphertext, which does not compress, and
    // \`ws\` offers it by default — Cloudflare accepts, and each frame then queues for zlib on libuv's
    // thread pool, which under load cost the spike's events hundreds of milliseconds for nothing.
    const ws = new WebSocket(`${this.o.relay}/v1/mac/${this.o.macId}`, { perMessageDeflate: false });
    this.ws = ws;
    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        if (buf.length < CHANNEL_ID_BYTES) return;
        this.o.on.data(b64u(buf.subarray(0, CHANNEL_ID_BYTES)), buf.subarray(CHANNEL_ID_BYTES));
        return;
      }
      const text = String(raw);
      if (text === "pong") return;
      let m: Record<string, unknown>;
      try { m = JSON.parse(text) as Record<string, unknown>; } catch { return; }
      switch (m.t) {
        case "challenge": {
          const sig = ed25519Sign(this.o.keys.sign.priv, relayAuthMessage("mac", this.o.macId, null, String(m.nonce)));
          ws.send(JSON.stringify({ t: "auth", key: b64u(this.o.keys.sign.pub), sig: b64u(sig) }));
          return;
        }
        case "ready":
          this.attempt = 0;
          this.setState("connected");
          this.o.on.ready();
          return;
        case "open":
          this.o.on.open(String(m.ch), typeof m.pair === "string" ? { pair: m.pair } : { phone: String(m.phone) });
          return;
        case "close":
          this.o.on.close(String(m.ch));
          return;
        default:
          this.o.on.control(m);
      }
    });
    ws.on("open", () => {
      this.heartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(PING); }, HEARTBEAT_MS);
    });
    ws.on("error", (e) => this.o.log?.(`[remote] relay socket error: ${e.message}`));
    ws.on("close", (code, reason) => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      if (this.ws !== ws) return;
      this.ws = null;
      this.setState("offline");
      this.o.log?.(`[remote] relay closed ${code} ${String(reason)}`);
      if (!this.stopped) this.scheduleRetry();
    });
  }

  /** Backoff from half a second to thirty, with jitter so a fleet of Macs coming back after an outage
   *  does not arrive as one wave. */
  private scheduleRetry(): void {
    const base = Math.min(30_000, 500 * 2 ** this.attempt);
    this.attempt += 1;
    const wait = base * (0.8 + Math.random() * 0.4);
    this.retry = setTimeout(() => { this.retry = null; if (!this.stopped) this.connect(); }, wait);
  }
}
