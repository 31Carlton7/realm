import {
  b64u, deviceId, ed25519Sign, FrameReader, generateDeviceKeys, HandshakeState, HEARTBEAT_MS, parseLink, PING, PROLOGUE, relayAuthMessage, sealMessage,
  type CipherState, type DeviceKeys,
} from "@realm/remote";
import WebSocket from "ws";

/**
 * A phone in TypeScript, for the suite and the live checks only (never bundled: nothing in main.ts
 * imports it). It speaks exactly what RealmKit speaks — PROTOCOL.md end to end — so a test can pair,
 * connect, call and listen without a simulator, and so the spike can time the pipe from a script.
 */

export type PairedMac = { relay: string; macId: string; macKey: Buffer; macName: string };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class PhoneCallError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const json = (v: unknown): Buffer => Buffer.from(JSON.stringify(v), "utf8");

type Message = { data: Buffer; binary: boolean; at: number };

/**
 * A socket that keeps every message from the moment it exists. The relay speaks first — its challenge,
 * or a pairing socket's `ready`, goes out as the socket is accepted — and `ws` can deliver that frame
 * in the same task as `open`, before any listener attached after an `await` would see it. So nothing
 * here listens late: messages queue until a reader takes them or the socket goes live.
 */
class Socket {
  readonly ws: WebSocket;
  private queue: Message[] = [];
  private wake = new Set<() => void>();
  private live: ((m: Message) => void) | null = null;
  closed: { code: number; reason: string } | null = null;

  private constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "nodebuffer";
    this.ws.on("message", (data: Buffer, binary: boolean) => {
      const m = { data, binary, at: performance.now() };
      if (this.live) this.live(m);
      else { this.queue.push(m); this.notify(); }
    });
    this.ws.on("close", (code: number, reason: Buffer) => { this.closed = { code, reason: reason.toString() }; this.notify(); });
  }

  static open(url: string): Promise<Socket> {
    const s = new Socket(url);
    return new Promise((resolve, reject) => {
      s.ws.once("open", () => { s.ws.off("error", reject); resolve(s); });
      s.ws.once("error", reject);
    });
  }

  private notify(): void { for (const w of [...this.wake]) w(); }

  /** The first queued message `pick` accepts — taking it out of the queue — waiting for one if none has
   *  arrived yet. Rejects when the socket closes or the time runs out first. */
  next<T>(pick: (m: Message) => T | undefined, timeoutMs = 10_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const scan = (): boolean => {
        for (const [i, m] of this.queue.entries()) {
          const v = pick(m);
          if (v !== undefined) { this.queue.splice(i, 1); finish(() => resolve(v)); return true; }
        }
        if (this.closed) { finish(() => reject(new Error(`socket closed ${this.closed!.code} ${this.closed!.reason}`))); return true; }
        return false;
      };
      const finish = (fn: () => void) => { clearTimeout(timer); this.wake.delete(waker); fn(); };
      const waker = () => { scan(); };
      const timer = setTimeout(() => finish(() => reject(new Error("timed out waiting for the relay"))), timeoutMs);
      if (!scan()) this.wake.add(waker);
    });
  }

  /** From now on every message goes straight to `fn` — the queue first, in order. */
  goLive(fn: (m: Message) => void): void {
    this.live = fn;
    for (const m of this.queue.splice(0)) fn(m);
  }
}

const control = (t: string) => (m: Message): Record<string, unknown> | undefined => {
  if (m.binary) return undefined;
  try { const v = JSON.parse(m.data.toString()) as Record<string, unknown>; return v.t === t ? v : undefined; } catch { return undefined; }
};
const binary = (m: Message): Buffer | undefined => (m.binary ? m.data : undefined);

export class TestPhone {
  readonly keys: DeviceKeys;
  readonly phoneId: string;
  mac: PairedMac | null = null;
  macOnline: boolean | null = null;
  private socket: Socket | null = null;
  private send: CipherState | null = null;
  private reader: FrameReader | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(payload: unknown, at: number) => void>>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(keys: DeviceKeys = generateDeviceKeys(), mac: PairedMac | null = null) {
    this.keys = keys;
    this.phoneId = deviceId(keys.sign.pub);
    this.mac = mac;
  }

  /** Pairs through the relay's pairing route (PROTOCOL.md §4.1) and waits for the owner's answer. */
  async pair(url: string, o: { name?: string; model?: string; timeoutMs?: number } = {}): Promise<{ ok: true } | { ok: false; reason: string }> {
    const link = parseLink(url);
    const s = await Socket.open(`${link.relay}/v1/pair/${link.macId}/${link.windowId}`);
    try {
      await s.next(control("ready"));
      const hs = new HandshakeState({ pattern: "IKpsk1", initiator: true, prologue: PROLOGUE.pair(link.macId, link.windowId), s: this.keys.dh, rs: link.macKey, psk: link.secret });
      s.ws.send(hs.writeMessage(json({ v: 1, name: o.name ?? "Test iPhone", model: o.model ?? "iPhone18,1", sign: b64u(this.keys.sign.pub) })));
      const hello = JSON.parse(hs.readMessage(await s.next(binary)).toString("utf8")) as { mac: string };
      const reader = new FrameReader(hs.transport!.receive);
      const result = await s.next((m) => {
        if (!m.binary) return undefined;
        const text = reader.push(m.data);
        if (text === null) return undefined;
        const e = JSON.parse(text) as { event?: string; payload?: { ok: boolean; reason?: string } };
        return e.event === "pair.result" ? e.payload : undefined;
      }, o.timeoutMs ?? 30_000);
      if (!result?.ok) return { ok: false, reason: result?.reason ?? "unknown" };
      this.mac = { relay: link.relay, macId: link.macId, macKey: link.macKey, macName: hello.mac };
      return { ok: true };
    } finally {
      s.ws.close();
    }
  }

  /** Connects as itself and runs IK (§4.2). The handshake is pipelined behind the auth message, as the
   *  spec allows, so a reconnect costs one round trip to the Mac after the relay's challenge. */
  async connect(): Promise<{ handshakeMs: number; macOnline: boolean; mac: string }> {
    const mac = this.mac;
    if (!mac) throw new Error("not paired");
    this.close();
    const started = performance.now();
    const s = await Socket.open(`${mac.relay}/v1/phone/${mac.macId}/${this.phoneId}`);
    this.socket = s;
    const challenge = await s.next(control("challenge"));
    const sig = ed25519Sign(this.keys.sign.priv, relayAuthMessage("phone", mac.macId, this.phoneId, String(challenge.nonce)));
    s.ws.send(JSON.stringify({ t: "auth", key: b64u(this.keys.sign.pub), sig: b64u(sig) }));
    const hs = new HandshakeState({ pattern: "IK", initiator: true, prologue: PROLOGUE.ik(mac.macId, this.phoneId), s: this.keys.dh, rs: mac.macKey });
    s.ws.send(hs.writeMessage(json({ v: 1, app: "test-phone", os: process.platform })));
    const hello = JSON.parse(hs.readMessage(await s.next(binary)).toString("utf8")) as { mac: string };
    // `ready` precedes the Mac's reply on the wire, so it is already queued by now.
    const ready = await s.next(control("ready"), 1_000).catch(() => null);
    this.macOnline = (ready?.mac as { online?: boolean } | undefined)?.online ?? true;
    this.send = hs.transport!.send;
    this.reader = new FrameReader(hs.transport!.receive);
    s.ws.on("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("socket closed"));
      this.pending.clear();
    });
    s.goLive((m) => this.onMessage(m));
    this.heartbeat = setInterval(() => { if (s.ws.readyState === WebSocket.OPEN) s.ws.send(PING); }, HEARTBEAT_MS);
    return { handshakeMs: performance.now() - started, macOnline: this.macOnline, mac: hello.mac };
  }

  call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const ws = this.socket?.ws;
    if (!ws || !this.send || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("not connected"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        for (const frame of sealMessage(this.send!, JSON.stringify({ id, method, params }))) ws.send(frame);
      } catch (e) {
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  on(event: string, fn: (payload: unknown, at: number) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(fn);
    this.listeners.set(event, set);
    return () => { set.delete(fn); };
  }

  /** Resolves with the first `event` payload that `pick` accepts. */
  waitFor<T>(event: string, pick: (payload: unknown) => T | undefined, timeoutMs = 10_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const off = this.on(event, (p) => { const v = pick(p); if (v !== undefined) { clearTimeout(timer); off(); resolve(v); } });
      const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${event}`)); }, timeoutMs);
    });
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.socket?.ws.close();
    this.socket = null;
    this.send = null;
    this.reader = null;
  }

  private onMessage(m: Message): void {
    if (!m.binary) {
      const text = m.data.toString();
      if (text === "pong") return;
      try {
        const c = JSON.parse(text) as { t?: string; online?: boolean };
        if (c.t === "mac") { this.macOnline = c.online === true; this.emit("mac", c, m.at); }
      } catch { /* not ours */ }
      return;
    }
    const text = this.reader?.push(m.data);
    if (!text) return;
    const msg = JSON.parse(text) as { id?: number; ok?: boolean; result?: unknown; error?: { code: string; message: string }; event?: string; payload?: unknown };
    if (typeof msg.event === "string") { this.emit(msg.event, msg.payload, m.at); return; }
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new PhoneCallError(msg.error?.code ?? "INTERNAL", msg.error?.message ?? "error"));
  }

  private emit(event: string, payload: unknown, at: number): void {
    for (const fn of this.listeners.get(event) ?? []) fn(payload, at);
  }
}
