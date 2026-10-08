import { randomBytes } from "node:crypto";
import type { EventName, EventPayload, StoredSessionEvent } from "@realm/contracts";
import {
  b64u, deviceId, encodeLink, FrameReader, fromB64u, HandshakeState, NoiseError, PROLOGUE, sealMessage,
  type CipherState, type DeviceKeys, type MobileErrorCode, type MobileEventPayload, type Row,
} from "@realm/remote";
import { MobileApi, MobileError, type ChannelContext } from "./api";
import { RelayLink, type LinkState } from "./link";
import type { RpcPort } from "./rpc-port";
import type { MacIdentity, PairedPhone, PhoneStore } from "./store";

/**
 * Plan 28's gateway: the Mac's end of every phone's encrypted channel.
 *
 * It holds one outbound link to the relay, runs a Noise handshake per phone channel (IKpsk1 to pair,
 * IK after), answers mobile.v1 calls through the desktop's own RPC, and streams the rows of the
 * sessions a phone has open. It never forwards a broadcast as it is: each one is projected into rows
 * for the phones that asked for that session, so `terminal.data` and every other session's stream
 * simply have no path out.
 */

export type PushPayload = { kind: "permission" | "question" | "finished" | "failed" | "blocked" | "test"; title: string; body: string; session: string | null };
export type PushResult = { ok: boolean; status: number; reason: string | null };

type Window = { id: string; secret: Buffer; expiresAt: number; url: string; timer: NodeJS.Timeout; expired: boolean };

/** The open pairing window, as Settings shows it: the link its QR code carries, and until when. */
export type PairingWindow = { windowId: string; url: string; expiresAt: number };

type Channel = {
  ch: string;
  mode: "phone" | "pair";
  phoneId: string | null;
  windowId: string | null;
  handshake: HandshakeState | null;
  send: CipherState | null;
  reader: FrameReader | null;
  ctx: ChannelContext;
  /** Rows changed by text deltas, flushed at most ten times a second. */
  dirty: Map<string, Set<string>>;
  flush: NodeJS.Timeout | null;
};

const DELTA_FLUSH_MS = 100;
const HOME_DEBOUNCE_MS = 1_000;
const PAIR_TTL_MS = 5 * 60_000;
const PUSH_TIMEOUT_MS = 15_000;

export type GatewayOptions = {
  /** This Mac's keys, which every paired phone has pinned. */
  identity: MacIdentity;
  /** Where paired phones are kept: `remote_devices` in realm-server, a scratch file in the live scripts. */
  phones: PhoneStore;
  relay: string;
  /** The server's broadcasts, and the calls a phone makes when there is no port of its own to make them on. */
  rpc: RpcPort;
  /** A phone's calls, made as that phone (`inProcessRpc(rpc, "phone:<id>")`). The live scripts dial a
   *  built server over loopback, which has no principal to give, and leave it out. */
  rpcFor?: (phoneId: string) => RpcPort;
  macName: string;
  version: string;
  /** Asks the owner whether to pair a phone that proved it holds the window's secret: a sheet in
   *  Settings (`remote.pairRequest`), or the sidecar's prompt. Raced against the window's expiry. */
  confirm: (phone: { name: string; model: string; windowId: string }) => Promise<boolean>;
  /** Where `debug.report` writes, in development builds. */
  reportsDir: string;
  dev?: boolean;
  log?: (line: string) => void;
  /** Tests: the pairing link's scheme. */
  linkBase?: string;
  /** A phone was added, removed or seen, or the pairing window opened or closed. */
  onChange?: () => void;
};

export class RemoteGateway {
  private readonly store: PhoneStore;
  private readonly keys: DeviceKeys;
  readonly macId: string;
  private readonly link: RelayLink;
  private readonly api: MobileApi;
  private readonly channels = new Map<string, Channel>();
  private window: Window | null = null;
  private homeTimer: NodeJS.Timeout | null = null;
  private offEvents: (() => void) | null = null;
  private readonly pushes = new Map<string, (r: PushResult) => void>();
  private readonly log: (line: string) => void;
  private stateListeners = new Set<(s: LinkState) => void>();

  constructor(private readonly o: GatewayOptions) {
    this.log = o.log ?? (() => {});
    this.store = o.phones;
    this.keys = o.identity.keys;
    this.macId = o.identity.macId;
    this.api = new MobileApi({ macName: () => o.macName, reportsDir: o.reportsDir, dev: o.dev === true });
    this.link = new RelayLink({
      relay: o.relay, macId: this.macId, keys: this.keys, log: this.log,
      on: {
        ready: () => this.syncRelay(),
        state: (s) => { for (const l of this.stateListeners) l(s); },
        open: (ch, who) => this.openChannel(ch, who),
        data: (ch, bytes) => { void this.onData(ch, bytes); },
        close: (ch) => this.dropChannel(ch),
        control: (m) => this.onControl(m),
      },
    });
  }

  get state(): LinkState { return this.link.state; }

  get relay(): string { return this.o.relay; }

  get pairing(): PairingWindow | null {
    const w = this.window;
    return w ? { windowId: w.id, url: w.url, expiresAt: w.expiresAt } : null;
  }

  /** A phone that proved the window's secret is still waiting on, or still being told, the answer.
   *  The link must stay up until it has heard — even after the window itself has closed. */
  get pairingBusy(): boolean {
    for (const c of this.channels.values()) if (c.mode === "pair" && c.send) return true;
    return false;
  }

  onState(l: (s: LinkState) => void): () => void { this.stateListeners.add(l); return () => { this.stateListeners.delete(l); }; }

  start(): void {
    this.offEvents = this.o.rpc.onEvent((event, payload) => this.onRpcEvent(event, payload));
    this.link.start();
  }

  stop(): void {
    this.offEvents?.();
    this.offEvents = null;
    for (const c of [...this.channels.keys()]) this.dropChannel(c);
    if (this.homeTimer) clearTimeout(this.homeTimer);
    this.homeTimer = null;
    if (this.window) clearTimeout(this.window.timer);
    this.window = null;
    this.link.stop();
  }

  devices(): PairedPhone[] { return this.store.list(); }

  /** Opens a pairing window at the relay and returns the link to show as a QR code. A window already
   *  open is replaced: only the newest code pairs. The window closes itself when it expires. */
  openPairing(ttlMs = PAIR_TTL_MS): PairingWindow {
    if (this.window) clearTimeout(this.window.timer);
    const id = b64u(randomBytes(16));
    const secret = randomBytes(32);
    const expiresAt = Date.now() + ttlMs;
    const url = encodeLink({ relay: this.o.relay, macId: this.macId, macKey: this.keys.dh.pub, secret, windowId: id, macName: this.o.macName, expiresAt }, this.o.linkBase);
    const timer = setTimeout(() => {
      if (this.window?.id !== id) return;
      // Marked before it closes, so a phone still waiting on the owner hears "expired", not "declined".
      this.window.expired = true;
      this.closePairing();
    }, ttlMs);
    timer.unref?.();
    this.window = { id, secret, expiresAt, url, timer, expired: false };
    this.link.control({ t: "pair", window: id, until: expiresAt });
    this.o.onChange?.();
    return { windowId: id, url, expiresAt };
  }

  closePairing(): void {
    if (!this.window) return;
    clearTimeout(this.window.timer);
    this.window = null;
    this.link.control({ t: "pair", window: null });
    this.o.onChange?.();
  }

  /** Remove: the relay forgets the phone's key (closing it with 4410) and its channels drop here at once. */
  revoke(phoneId: string): boolean {
    const removed = this.store.remove(phoneId);
    for (const c of [...this.channels.values()]) if (c.phoneId === phoneId) { this.link.control({ t: "close", ch: c.ch }); this.dropChannel(c.ch); }
    this.syncPhones();
    this.o.onChange?.();
    return removed;
  }

  /** Seals a push to one phone with Noise K and asks the relay to deliver it (PROTOCOL.md §4.3, §7). */
  push(phoneId: string, p: PushPayload, o: { urgent?: boolean; collapse?: string | null; badge?: number | null } = {}): Promise<PushResult> {
    const phone = this.store.get(phoneId);
    if (!phone) return Promise.resolve({ ok: false, status: 0, reason: "not-paired" });
    const id = b64u(randomBytes(12));
    const payload = { v: 1, id, at: Date.now(), ...p };
    const hs = new HandshakeState({ pattern: "K", initiator: true, prologue: PROLOGUE.push(this.macId, phoneId), s: this.keys.dh, rs: phone.dh });
    const blob = b64u(hs.writeMessage(Buffer.from(JSON.stringify(payload), "utf8")));
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pushes.delete(id); resolve({ ok: false, status: 0, reason: "relay-timeout" }); }, PUSH_TIMEOUT_MS);
      this.pushes.set(id, (r) => { clearTimeout(timer); resolve(r); });
      if (!this.link.control({ t: "push", id, phone: phoneId, blob, urgent: o.urgent ?? false, collapse: o.collapse ?? null, badge: o.badge ?? null })) {
        clearTimeout(timer);
        this.pushes.delete(id);
        resolve({ ok: false, status: 0, reason: "relay-offline" });
      }
    });
  }

  private syncRelay(): void {
    this.syncPhones();
    if (this.window && this.window.expiresAt > Date.now()) this.link.control({ t: "pair", window: this.window.id, until: this.window.expiresAt });
  }

  private syncPhones(): void {
    this.link.control({ t: "phones", list: this.store.list().map((p) => ({ id: p.phoneId, key: b64u(p.sign) })) });
  }

  private onControl(m: Record<string, unknown>): void {
    if (m.t === "pushed" && typeof m.id === "string") {
      this.pushes.get(m.id)?.({ ok: m.ok === true, status: typeof m.status === "number" ? m.status : 0, reason: typeof m.reason === "string" ? m.reason : null });
      this.pushes.delete(m.id);
    }
  }

  private openChannel(ch: string, who: { phone: string } | { pair: string }): void {
    this.dropChannel(ch);
    const pair = "pair" in who;
    if (!pair && !this.store.get(who.phone)) { this.link.control({ t: "close", ch }); return; }
    // A pairing channel never reaches the API (`onMessage` refuses it first), so it gets the plain port.
    const rpc = pair ? this.o.rpc : this.o.rpcFor?.(who.phone) ?? this.o.rpc;
    this.channels.set(ch, {
      ch, mode: pair ? "pair" : "phone", phoneId: pair ? null : who.phone, windowId: pair ? who.pair : null,
      handshake: null, send: null, reader: null, ctx: { phoneId: pair ? "" : who.phone, rpc, sessions: new Map() }, dirty: new Map(), flush: null,
    });
  }

  private dropChannel(ch: string): void {
    const c = this.channels.get(ch);
    if (!c) return;
    if (c.flush) clearTimeout(c.flush);
    this.channels.delete(ch);
    // Last seen is when a phone was last connected, so a channel that got as far as speaking to us
    // marks it on the way out as well as on the way in.
    if (c.mode === "phone" && c.send && c.phoneId && this.store.get(c.phoneId)) {
      this.store.touch(c.phoneId, Date.now());
      this.o.onChange?.();
    }
    // A pairing phone that has had its answer no longer needs the link (`pairingBusy`).
    if (c.mode === "pair" && c.send) this.o.onChange?.();
  }

  private reject(c: Channel, why: string): void {
    this.log(`[remote] closing channel ${c.ch}: ${why}`);
    this.link.control({ t: "close", ch: c.ch });
    this.dropChannel(c.ch);
  }

  private async onData(ch: string, bytes: Buffer): Promise<void> {
    const c = this.channels.get(ch);
    if (!c) return;
    try {
      if (!c.send) { await this.handshake(c, bytes); return; }
      const text = c.reader!.push(bytes);
      if (text === null) return;
      await this.onMessage(c, text);
    } catch (e) {
      this.reject(c, e instanceof NoiseError ? e.message : `bad message: ${(e as Error).message}`);
    }
  }

  private async handshake(c: Channel, msg1: Buffer): Promise<void> {
    if (c.mode === "phone") {
      const phone = this.store.get(c.phoneId!);
      if (!phone) return this.reject(c, "phone no longer paired");
      const hs = new HandshakeState({ pattern: "IK", initiator: false, prologue: PROLOGUE.ik(this.macId, phone.phoneId), s: this.keys.dh });
      hs.readMessage(msg1);
      // IK reveals the phone's static key in its first message; it must be the one paired, or this is
      // someone else holding a relay key the Mac once trusted.
      if (!hs.remoteStatic?.equals(phone.dh)) return this.reject(c, "static key does not match the paired phone");
      this.link.send(c.ch, hs.writeMessage(Buffer.from(JSON.stringify({ v: 1, mac: this.o.macName, server: this.o.version }), "utf8")));
      this.begin(c, hs);
      this.store.touch(phone.phoneId, Date.now());
      this.o.onChange?.();
      return;
    }
    const w = this.window;
    if (!w || w.id !== c.windowId || w.expiresAt <= Date.now()) return this.reject(c, "no open pairing window");
    const hs = new HandshakeState({ pattern: "IKpsk1", initiator: false, prologue: PROLOGUE.pair(this.macId, w.id), s: this.keys.dh, psk: w.secret });
    const hello = JSON.parse(hs.readMessage(msg1).toString("utf8")) as { v?: number; name?: unknown; model?: unknown; sign?: unknown };
    const sign = typeof hello.sign === "string" ? fromB64u(hello.sign) : null;
    if (hello.v !== 1 || !sign || sign.length !== 32 || !hs.remoteStatic) return this.reject(c, "malformed pairing hello");
    this.link.send(c.ch, hs.writeMessage(Buffer.from(JSON.stringify({ v: 1, mac: this.o.macName }), "utf8")));
    this.begin(c, hs);
    const name = typeof hello.name === "string" ? hello.name.slice(0, 80) : "iPhone";
    const model = typeof hello.model === "string" ? hello.model.slice(0, 40) : "";
    const left = w.expiresAt - Date.now();
    let expiry: NodeJS.Timeout | undefined;
    const answer = await Promise.race([
      this.o.confirm({ name, model, windowId: w.id }),
      new Promise<"expired">((r) => { expiry = setTimeout(() => r("expired"), Math.max(0, left)); }),
    ]).finally(() => clearTimeout(expiry));
    if (answer !== true) {
      this.sendEvent(c, "pair.result", { ok: false, reason: answer === "expired" || w.expired ? "expired" : "declined" });
      setTimeout(() => this.reject(c, "pairing not confirmed"), 200);
      return;
    }
    const phoneId = deviceId(sign);
    this.store.add({ phoneId, name, model, dh: hs.remoteStatic, sign, addedAt: Date.now(), lastSeen: null });
    this.syncPhones();
    this.closePairing();
    this.sendEvent(c, "pair.result", { ok: true, phoneId });
    this.log(`[remote] paired ${name} (${phoneId})`);
    setTimeout(() => this.reject(c, "paired"), 200);
  }

  private begin(c: Channel, hs: HandshakeState): void {
    c.send = hs.transport!.send;
    c.reader = new FrameReader(hs.transport!.receive);
  }

  private sendJson(c: Channel, v: unknown): void {
    if (!c.send) return;
    for (const frame of sealMessage(c.send, JSON.stringify(v))) this.link.send(c.ch, frame);
  }

  private sendEvent(c: Channel, event: string, payload: unknown): void { this.sendJson(c, { event, payload }); }

  private async onMessage(c: Channel, text: string): Promise<void> {
    const m = JSON.parse(text) as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof m.id !== "number" || typeof m.method !== "string") throw new Error("not a request");
    if (c.mode === "pair") { this.sendJson(c, { id: m.id, ok: false, error: { code: "FORBIDDEN" satisfies MobileErrorCode, message: "pairing channel" } }); return; }
    try {
      const result = await this.api.handle(c.ctx, m.method, m.params);
      this.sendJson(c, { id: m.id, ok: true, result });
    } catch (e) {
      const err = e instanceof MobileError ? e : new MobileError("INTERNAL", (e as Error).message);
      this.sendJson(c, { id: m.id, ok: false, error: { code: err.code, message: err.message } });
    }
  }

  private onRpcEvent<E extends EventName>(event: E, payload: EventPayload<E>): void {
    switch (event) {
      case "session.event": {
        const p = payload as EventPayload<"session.event">;
        const stored: StoredSessionEvent = { seq: p.seq, sessionId: p.sessionId, event: p.event };
        for (const c of this.channels.values()) this.toChannel(c, stored);
        return;
      }
      case "session.status": {
        const p = payload as EventPayload<"session.status">;
        for (const c of this.channels.values()) {
          if (!c.ctx.sessions.has(p.sessionId)) continue;
          this.sendEvent(c, "session.status", { id: p.sessionId, status: p.status === "waiting_permission" ? "waiting" : p.status });
        }
        this.homeChanged();
        return;
      }
      case "spaces.changed": case "items.changed": case "notifications.changed":
        this.homeChanged();
        return;
      default:
        return;
    }
  }

  private toChannel(c: Channel, ev: StoredSessionEvent): void {
    const entry = c.ctx.sessions.get(ev.sessionId);
    if (!entry || !c.send) return;
    if (entry.buffer) { entry.buffer.push(ev); return; }
    const changed = entry.projector.apply(ev);
    if (changed.length === 0) return;
    if (ev.seq < 0) {
      // A text delta: mark the row and let the timer send its latest text, at most ten times a second.
      const keys = c.dirty.get(ev.sessionId) ?? new Set<string>();
      for (const r of changed) keys.add(r.key);
      c.dirty.set(ev.sessionId, keys);
      c.flush ??= setTimeout(() => this.flushDeltas(c), DELTA_FLUSH_MS);
      return;
    }
    // A persisted event goes out at once — after any deltas still owed for that session, so a row
    // never arrives older than the one it replaces.
    this.flushSession(c, ev.sessionId);
    this.sendRows(c, ev.sessionId, changed);
  }

  private flushDeltas(c: Channel): void {
    c.flush = null;
    for (const sessionId of [...c.dirty.keys()]) this.flushSession(c, sessionId);
  }

  private flushSession(c: Channel, sessionId: string): void {
    const keys = c.dirty.get(sessionId);
    if (!keys) return;
    c.dirty.delete(sessionId);
    const entry = c.ctx.sessions.get(sessionId);
    if (!entry) return;
    const rows = entry.projector.all().filter((r) => keys.has(r.key));
    if (rows.length) this.sendRows(c, sessionId, rows);
  }

  private sendRows(c: Channel, sessionId: string, rows: Row[]): void {
    this.sendEvent(c, "session.rows", { id: sessionId, rows } satisfies MobileEventPayload<"session.rows">);
  }

  private homeChanged(): void {
    if (this.homeTimer) return;
    this.homeTimer = setTimeout(() => {
      this.homeTimer = null;
      for (const c of this.channels.values()) if (c.send && c.mode === "phone") this.sendEvent(c, "home.changed", {});
    }, HOME_DEBOUNCE_MS);
  }
}

