/**
 * The relay's rules (PROTOCOL.md §3), as one class both hosts run: the Durable Object in durable.ts
 * and the local Node relay in node.ts. Nothing here imports Workers or Node, so the tests that hold
 * the Node relay to §3 are testing the code the Worker runs.
 *
 * State lives in exactly two places: each socket's attachment, and the room's storage. A hibernating
 * Durable Object keeps both and forgets everything else, so nothing that must outlive one event is
 * kept in a field here.
 */
import type { ApnsResult, ApnsSender } from "./apns";

/** §3.1's close codes, named as packages/remote names them. */
export const CLOSE = {
  channelClosed: 4000,
  malformed: 4400,
  unauthorized: 4401,
  forbidden: 4403,
  authTimeout: 4408,
  replaced: 4409,
  removed: 4410,
  tooLarge: 4413,
} as const;

const MAX_FRAME_BYTES = 1 << 20;
const AUTH_TIMEOUT_MS = 10_000;
/** The Mac counts as online while its last message or heartbeat is younger than this (§3.2). It
 *  heartbeats every 20 s, so this is three missed beats. */
const ONLINE_WINDOW_MS = 60_000;
/** While the Mac is quiet, how often the room looks for its heartbeat. The runtime answers a heartbeat
 *  without waking the room, so this is how a Mac that wakes and sends nothing else is noticed. */
const QUIET_RECHECK_MS = 10_000;
const PAIR_WINDOW_MAX_MS = 10 * 60_000;
const PAIR_ATTEMPTS = 5;
const CHANNEL_BYTES = 16;
const NONCE_BYTES = 32;

export type Role = "mac" | "phone" | "pair";

export type Route =
  | { role: "mac"; macId: string }
  | { role: "phone"; macId: string; phoneId: string }
  | { role: "pair"; macId: string; windowId: string };

/** What the relay remembers about one socket. Hosts store it with the socket (a Durable Object's
 *  `serializeAttachment`), so it survives hibernation along with the connection itself. */
export type Attachment = {
  role: Role;
  macId: string;
  phoneId?: string;
  windowId?: string;
  /** The challenge, until the socket authenticates. Pairing sockets are never challenged. */
  nonce?: string;
  /** A Mac socket's own random id: a pairing window belongs to the socket that opened it. */
  connection?: string;
  authed: boolean;
  /** A phone's signing key, kept so a new `phones` list can tell whether it still names this socket. */
  key?: string;
  /** The channel id, `b64u` of 16 bytes, once a phone or pairing socket is admitted. */
  ch?: string;
  openedAt: number;
  /** The last message from this socket. Kept up to date for the Mac only: it is half of liveness. */
  lastSeen: number;
  /** Set on the Mac's socket while the room has told every channel the Mac is quiet (§3.2). */
  quiet?: boolean;
  /** Set once the relay has finished with this socket, so its close event and any message still
   *  queued behind it do nothing twice. */
  closed?: boolean;
};

export type RoomStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
};

export type RelayCrypto = {
  verifyEd25519(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean>;
  sha256(data: Uint8Array): Promise<Uint8Array>;
  randomBytes(length: number): Uint8Array;
};

/** Everything the room needs from the runtime that hosts it. `S` is the host's socket handle. */
export type RoomHost<S> = {
  /** Every socket of this room whose close the room has not yet been told about. Not filtered by
   *  the transport's state: the room's own `closed` flags decide, so it sees closes in event order. */
  sockets(): S[];
  attachment(ws: S): Attachment | null;
  setAttachment(ws: S, attachment: Attachment): void;
  /** Must not throw: the peer may already be gone. */
  send(ws: S, data: string | Uint8Array): void;
  close(ws: S, code: number, reason: string): void;
  /** When the runtime last answered this socket's `ping` itself, or null if it never has. */
  heartbeatAt(ws: S): number | null;
  storage: RoomStorage;
  /** Arrange for `alarm()` to run at `at`, replacing any earlier arrangement; null cancels it. */
  setAlarm(at: number | null): Promise<void>;
  now(): number;
  crypto: RelayCrypto;
  apns: ApnsSender;
  /** Work that finishes after the event that started it (an APNs request). */
  background(work: Promise<unknown>): void;
};

type PhoneEntry = { id: string; key: string };
/** `mac` is the `connection` of the Mac socket that opened the window. */
type PairWindow = { window: string; until: number; attempts: number; mac: string };
type ApnsRegistration = { token: string; env: "sandbox" | "production" };
type Control = { t: string } & Record<string, unknown>;

/** The room's storage keys. */
export const STORE = {
  /** The Mac's latest `phones` list. */
  phones: "phones",
  /** The open pairing window, if any. */
  pair: "pair",
  /** When the Mac was last seen, for phones that ask while it is away. */
  lastSeen: "lastSeen",
  /** Each phone's APNs registration, by phoneId. */
  apns: "apns",
} as const;

const ID = /^[A-Za-z0-9_-]{22}$/;
const B64U = /^[A-Za-z0-9_-]*$/;

/** A 22-character base64url id: a device id (§1), a pairing window or a channel. */
const isId = (value: unknown): value is string => typeof value === "string" && ID.test(value);

/** The three WebSocket routes of §3, or null for any other path. */
export function parseRoute(pathname: string): Route | null {
  const [empty, version, role, a, b, ...rest] = pathname.split("/");
  if (empty !== "" || version !== "v1" || rest.length > 0 || !isId(a)) return null;
  if (role === "mac" && b === undefined) return { role, macId: a };
  if (role === "phone" && isId(b)) return { role, macId: a, phoneId: b };
  if (role === "pair" && isId(b)) return { role, macId: a, windowId: b };
  return null;
}

/** base64url without padding — PROTOCOL.md's `b64u`. */
export function b64u(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes `b64u`, or returns null. Only the canonical spelling is accepted, so one key cannot
 *  arrive in two spellings that compare unequal against the Mac's list. */
function fromB64u(text: string): Uint8Array | null {
  if (!B64U.test(text) || text.length % 4 === 1) return null;
  const bytes = Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  return b64u(bytes) === text ? bytes : null;
}

const utf8 = new TextEncoder();

/** §3.1: the bytes a Mac or phone signs to answer the challenge. */
const authMessage = (role: "mac" | "phone", macId: string, phoneId: string, nonce: string): Uint8Array =>
  utf8.encode(`realm-relay/1\n${role}\n${macId}\n${phoneId}\n${nonce}`);

/** §1: `b64u(SHA-256(signPub)[0..16])`. */
async function deviceId(crypto: RelayCrypto, signPub: Uint8Array): Promise<string> {
  return b64u((await crypto.sha256(signPub)).subarray(0, 16));
}

function tooLarge(data: string | Uint8Array): boolean {
  if (typeof data !== "string") return data.byteLength > MAX_FRAME_BYTES;
  // UTF-8 never takes more than three bytes per UTF-16 unit, so short text needs no encoding.
  return data.length * 3 > MAX_FRAME_BYTES && utf8.encode(data).byteLength > MAX_FRAME_BYTES;
}

function parseControl(text: string): Control | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return typeof (value as { t?: unknown }).t === "string" ? (value as Control) : null;
}

const isPhoneEntry = (value: unknown): value is PhoneEntry => {
  if (typeof value !== "object" || value === null) return false;
  const { id, key } = value as Record<string, unknown>;
  return isId(id) && typeof key === "string" && fromB64u(key)?.byteLength === 32;
};

const HEX_TOKEN = /^(?:[0-9a-fA-F]{2}){1,256}$/;

export class RelayRoom<S> {
  /**
   * Every event — a socket opening, a message, a close, the alarm — runs to completion before the
   * next starts, in arrival order. §3.1 needs that for one socket's messages: data pipelined behind
   * `auth` must wait for the verdict, and verifying is async. Running the whole room in order also
   * makes each read-modify-write of storage atomic, in both hosts. The chain only ever holds work in
   * flight, and a Durable Object never hibernates with work in flight, so it is safe as a field.
   */
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly host: RoomHost<S>) {}

  open(ws: S, route: Route): Promise<void> {
    return this.serially(() => this.onOpen(ws, route));
  }

  message(ws: S, data: string | ArrayBuffer | Uint8Array): Promise<void> {
    return this.serially(() => this.onMessage(ws, data));
  }

  closed(ws: S): Promise<void> {
    return this.serially(() => this.onClosed(ws));
  }

  alarm(): Promise<void> {
    return this.serially(() => this.onAlarm());
  }

  private serially(task: () => Promise<void>): Promise<void> {
    const run = this.tail.then(task);
    this.tail = run.catch(() => {});
    return run;
  }

  private async onOpen(ws: S, route: Route): Promise<void> {
    const now = this.host.now();
    if (route.role === "pair") return this.admitPairing(ws, route.macId, route.windowId, now);
    const nonce = b64u(this.host.crypto.randomBytes(NONCE_BYTES));
    const attachment: Attachment = { role: route.role, macId: route.macId, nonce, authed: false, openedAt: now, lastSeen: now };
    if (route.role === "phone") attachment.phoneId = route.phoneId;
    else attachment.connection = b64u(this.host.crypto.randomBytes(16));
    this.host.setAttachment(ws, attachment);
    this.sendJson(ws, { t: "challenge", nonce });
    await this.scheduleAlarm();
  }

  private async onMessage(ws: S, raw: string | ArrayBuffer | Uint8Array): Promise<void> {
    const a = this.host.attachment(ws);
    if (!a || a.closed) return;
    const data = typeof raw === "string" || raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (tooLarge(data)) return this.drop(ws, a, CLOSE.tooLarge, "frame over 1 MiB");
    if (!a.authed) return this.onAuth(ws, a, data);
    if (a.role === "mac") return this.fromMac(ws, a, data);
    return this.fromPhone(ws, a, data);
  }

  private async onClosed(ws: S): Promise<void> {
    const a = this.host.attachment(ws);
    if (a && !a.closed) await this.drop(ws, a);
  }

  private async onAlarm(): Promise<void> {
    const now = this.host.now();
    for (const [ws, a] of this.live()) {
      if (this.awaitingAuth(a) && now >= a.openedAt + AUTH_TIMEOUT_MS) await this.drop(ws, a, CLOSE.authTimeout, "no auth within 10 s");
    }
    const window = await this.host.storage.get<PairWindow>(STORE.pair);
    if (window && window.until <= now) await this.host.storage.delete(STORE.pair);
    const mac = this.currentMac();
    if (mac) this.announceLiveness(...mac);
    await this.scheduleAlarm();
  }

  // ── Authentication (§3.1) ──────────────────────────────────────────────────────────────────

  private async onAuth(ws: S, a: Attachment, data: string | Uint8Array): Promise<void> {
    // Data may follow `auth` without waiting for `ready`, but never precede it.
    if (typeof data !== "string") return this.drop(ws, a, CLOSE.unauthorized, "auth must come first");
    const msg = parseControl(data);
    if (!msg) return this.drop(ws, a, CLOSE.malformed, "malformed message");
    if (msg.t !== "auth") return this.drop(ws, a, CLOSE.unauthorized, "auth must come first");
    if (typeof msg.key !== "string" || typeof msg.sig !== "string") return this.drop(ws, a, CLOSE.malformed, "malformed auth");

    const role = a.role === "mac" ? "mac" : "phone";
    const key = fromB64u(msg.key);
    const sig = fromB64u(msg.sig);
    const signed = authMessage(role, a.macId, a.phoneId ?? "", a.nonce ?? "");
    if (!key || key.byteLength !== 32 || !sig || !(await this.host.crypto.verifyEd25519(key, sig, signed))) {
      return this.drop(ws, a, CLOSE.unauthorized, "authentication failed");
    }
    // The URL names the device; only the key it signed with can prove it is that device.
    if ((await deviceId(this.host.crypto, key)) !== (role === "mac" ? a.macId : a.phoneId)) {
      return this.drop(ws, a, CLOSE.unauthorized, "key does not match the id");
    }
    return role === "mac" ? this.admitMac(ws, a) : this.admitPhone(ws, a, msg.key);
  }

  private async admitMac(ws: S, a: Attachment): Promise<void> {
    // A Mac has one socket. The newest wins: an older one is most likely a connection the Mac has
    // already given up on and the relay has not noticed yet.
    for (const [other, oa] of this.live()) {
      if (other !== ws && oa.role === "mac" && oa.authed) await this.endMac(other, oa, CLOSE.replaced, "replaced by a newer connection");
    }
    const now = this.host.now();
    delete a.nonce;
    a.authed = true;
    a.lastSeen = now;
    this.host.setAttachment(ws, a);
    this.sendJson(ws, { t: "ready" });
    const channels = this.channels();
    for (const [, pa] of channels) this.sendJson(ws, openMessage(pa));
    for (const [phone] of channels) this.sendJson(phone, { t: "mac", online: true, lastSeen: now });
    await this.host.storage.put(STORE.lastSeen, now);
    await this.scheduleAlarm();
  }

  private async admitPhone(ws: S, a: Attachment, key: string): Promise<void> {
    const phones = (await this.host.storage.get<PhoneEntry[]>(STORE.phones)) ?? [];
    if (!phones.some((p) => p.id === a.phoneId && p.key === key)) return this.drop(ws, a, CLOSE.forbidden, "not a phone this Mac has added");
    for (const [other, oa] of this.live()) {
      if (other !== ws && oa.role === "phone" && oa.authed && oa.phoneId === a.phoneId) this.endChannel(other, oa, CLOSE.replaced, "replaced by a newer connection");
    }
    // Read before this socket is a channel, so news it settles goes only to the phones already here.
    const status = await this.macStatus();
    delete a.nonce;
    a.authed = true;
    a.key = key;
    a.ch = b64u(this.host.crypto.randomBytes(CHANNEL_BYTES));
    this.host.setAttachment(ws, a);
    this.sendJson(ws, { t: "ready", mac: status });
    const mac = this.currentMac();
    if (mac) this.sendJson(mac[0], openMessage(a));
    await this.scheduleAlarm();
  }

  /** A pairing phone sends no `auth` (§3.1): an open window with an attempt left is its admission. */
  private async admitPairing(ws: S, macId: string, windowId: string, now: number): Promise<void> {
    const attachment: Attachment = { role: "pair", macId, windowId, authed: false, openedAt: now, lastSeen: now };
    const window = await this.host.storage.get<PairWindow>(STORE.pair);
    // §3.2: the window closes with the Mac socket that opened it. Checking the opener, rather than
    // trusting that its close was handled, keeps that true whatever order the events arrive in.
    const mac = this.currentMac();
    if (!mac || !window || window.mac !== mac[1].connection || window.window !== windowId || window.until <= now || window.attempts < 1) {
      this.host.setAttachment(ws, { ...attachment, closed: true });
      this.host.close(ws, CLOSE.forbidden, "no open pairing window");
      return;
    }
    await this.host.storage.put(STORE.pair, { ...window, attempts: window.attempts - 1 });
    const status = await this.macStatus();
    attachment.authed = true;
    attachment.ch = b64u(this.host.crypto.randomBytes(CHANNEL_BYTES));
    this.host.setAttachment(ws, attachment);
    this.sendJson(ws, { t: "ready", mac: status });
    this.sendJson(mac[0], openMessage(attachment));
    // A channel now exists, so the Mac's silence is worth watching.
    await this.scheduleAlarm();
  }

  // ── The Mac's socket (§3.2) ────────────────────────────────────────────────────────────────

  private async fromMac(ws: S, a: Attachment, data: string | Uint8Array): Promise<void> {
    a.lastSeen = this.host.now();
    this.host.setAttachment(ws, a);
    // A quiet Mac heard from again: every channel is told before this message reaches any of them,
    // and the alarm goes back to watching for the next silence.
    if (a.quiet) {
      this.announceLiveness(ws, a);
      await this.scheduleAlarm();
    }
    if (typeof data !== "string") {
      if (data.byteLength < CHANNEL_BYTES) return this.endMac(ws, a, CLOSE.malformed, "binary without a channel id");
      // The relay reads the prefix and nothing after it. A channel that has closed already got its
      // `close`; anything the Mac sent it in the meantime has nowhere to go.
      const target = this.channel(b64u(data.subarray(0, CHANNEL_BYTES)));
      if (target) this.host.send(target[0], data.subarray(CHANNEL_BYTES));
      return;
    }
    const msg = parseControl(data);
    if (!msg) return this.endMac(ws, a, CLOSE.malformed, "malformed message");
    switch (msg.t) {
      case "phones":
        return this.setPhones(ws, a, msg);
      case "pair":
        return this.setPairWindow(ws, a, msg);
      case "close":
        return this.closeChannel(ws, a, msg);
      case "push":
        return this.push(ws, a, msg);
      default:
        // A type this relay does not know is ignored rather than refused, so a newer Mac can add one
        // without an older relay hanging up on it.
        return;
    }
  }

  private async setPhones(ws: S, a: Attachment, msg: Control): Promise<void> {
    if (!Array.isArray(msg.list) || !msg.list.every(isPhoneEntry)) return this.endMac(ws, a, CLOSE.malformed, "malformed phones");
    const phones = msg.list.map((p) => ({ id: p.id, key: p.key }));
    await this.host.storage.put(STORE.phones, phones);
    const listed = (id: string | undefined, key: string | undefined) => phones.some((p) => p.id === id && p.key === key);
    // A removed phone's push token goes with it: nothing may reach a phone the Mac has let go.
    const tokens = await this.host.storage.get<Record<string, ApnsRegistration>>(STORE.apns);
    if (tokens) {
      const kept = Object.fromEntries(Object.entries(tokens).filter(([id]) => phones.some((p) => p.id === id)));
      if (Object.keys(kept).length !== Object.keys(tokens).length) await this.host.storage.put(STORE.apns, kept);
    }
    for (const [phone, pa] of this.live()) {
      if (pa.role === "phone" && pa.authed && !listed(pa.phoneId, pa.key)) this.endChannel(phone, pa, CLOSE.removed, "removed by the Mac");
    }
  }

  private async setPairWindow(ws: S, a: Attachment, msg: Control): Promise<void> {
    if (msg.window === null) {
      await this.host.storage.delete(STORE.pair);
    } else if (isId(msg.window) && typeof msg.until === "number" && Number.isFinite(msg.until)) {
      const until = Math.min(msg.until, this.host.now() + PAIR_WINDOW_MAX_MS);
      const window: PairWindow = { window: msg.window, until, attempts: PAIR_ATTEMPTS, mac: a.connection ?? "" };
      await this.host.storage.put(STORE.pair, window);
    } else {
      return this.endMac(ws, a, CLOSE.malformed, "malformed pair");
    }
    await this.scheduleAlarm();
  }

  private async closeChannel(ws: S, a: Attachment, msg: Control): Promise<void> {
    if (!isId(msg.ch)) return this.endMac(ws, a, CLOSE.malformed, "malformed close");
    const target = this.channel(msg.ch);
    if (target) this.endChannel(target[0], target[1], CLOSE.channelClosed, "closed by the Mac");
  }

  private async push(ws: S, a: Attachment, msg: Control): Promise<void> {
    const { id, phone, blob } = msg;
    const urgent = msg.urgent ?? false;
    const collapse = msg.collapse ?? null;
    const badge = msg.badge ?? null;
    const valid =
      typeof id === "string" &&
      isId(phone) &&
      typeof blob === "string" &&
      B64U.test(blob) &&
      typeof urgent === "boolean" &&
      (collapse === null || typeof collapse === "string") &&
      (badge === null || (Number.isSafeInteger(badge) && (badge as number) >= 0));
    if (!valid) return this.endMac(ws, a, CLOSE.malformed, "malformed push");

    const reply = (result: ApnsResult) => {
      // To whichever socket is the Mac when APNs answers: a reconnect in between should not lose it.
      const mac = this.currentMac();
      if (mac) this.sendJson(mac[0], { t: "pushed", phone, id, ok: result.ok, status: result.status, reason: result.reason });
    };
    const registration = (await this.host.storage.get<Record<string, ApnsRegistration>>(STORE.apns))?.[phone];
    if (!registration) return reply({ ok: false, status: 0, reason: "no-token" });
    // Not awaited: an APNs round trip must not hold up the Mac's channels behind it.
    const sent = this.host.apns
      .send({ ...registration, macId: a.macId, blob, urgent, collapse: collapse as string | null, badge: badge as number | null })
      .catch((): ApnsResult => ({ ok: false, status: 0, reason: "apns-error" }))
      .then(reply);
    this.host.background(sent);
  }

  // ── Phone and pairing sockets (§3.2) ───────────────────────────────────────────────────────

  private async fromPhone(ws: S, a: Attachment, data: string | Uint8Array): Promise<void> {
    if (typeof data !== "string") {
      const mac = this.currentMac();
      if (!mac) {
        this.sendJson(ws, { t: "mac", online: false, lastSeen: await this.storedLastSeen() });
        return;
      }
      // Only an admitted socket gets here, and admission is what gives it `ch`.
      const frame = new Uint8Array(CHANNEL_BYTES + data.byteLength);
      frame.set(fromB64u(a.ch!)!);
      frame.set(data, CHANNEL_BYTES);
      this.host.send(mac[0], frame);
      return;
    }
    const msg = parseControl(data);
    if (!msg) return this.endChannel(ws, a, CLOSE.malformed, "malformed message");
    // A pairing socket has no phoneId yet, so there is nothing to register a token under.
    if (msg.t === "apns" && a.role === "phone") return this.registerApns(ws, a, msg);
  }

  private async registerApns(ws: S, a: Attachment, msg: Control): Promise<void> {
    const { token, env } = msg;
    if (typeof token !== "string" || !HEX_TOKEN.test(token) || (env !== "sandbox" && env !== "production")) {
      return this.endChannel(ws, a, CLOSE.malformed, "malformed apns");
    }
    const tokens = (await this.host.storage.get<Record<string, ApnsRegistration>>(STORE.apns)) ?? {};
    tokens[a.phoneId!] = { token: token.toLowerCase(), env };
    await this.host.storage.put(STORE.apns, tokens);
  }

  // ── Endings ────────────────────────────────────────────────────────────────────────────────

  /** Finishes with a socket, closing it first when the relay is the one ending it. */
  private async drop(ws: S, a: Attachment, code?: number, reason?: string): Promise<void> {
    if (a.role === "mac") await this.endMac(ws, a, code, reason);
    else this.endChannel(ws, a, code, reason);
    // Its auth deadline no longer needs an alarm.
    if (this.awaitingAuth(a)) await this.scheduleAlarm();
  }

  private async endMac(ws: S, a: Attachment, code?: number, reason?: string): Promise<void> {
    const lastSeen = this.lastSeenOf(ws, a);
    this.finish(ws, a, code, reason);
    // Only the Mac's current socket going away is news. An older socket's close can be handled after
    // a newer socket has authenticated, and by then the newer one speaks for the Mac.
    if (!a.authed || this.currentMac()) return;
    for (const [phone] of this.channels()) this.sendJson(phone, { t: "mac", online: false, lastSeen });
    await this.host.storage.put(STORE.lastSeen, lastSeen);
    // §3.2: the pairing window is the open Mac socket's, and goes with it.
    await this.host.storage.delete(STORE.pair);
    await this.scheduleAlarm();
  }

  private endChannel(ws: S, a: Attachment, code?: number, reason?: string): void {
    this.finish(ws, a, code, reason);
    if (!a.authed || !a.ch) return;
    const mac = this.currentMac();
    if (mac) this.sendJson(mac[0], { t: "close", ch: a.ch });
  }

  private finish(ws: S, a: Attachment, code?: number, reason?: string): void {
    a.closed = true;
    this.host.setAttachment(ws, a);
    if (code !== undefined) this.host.close(ws, code, reason ?? "");
  }

  // ── Views over the sockets ─────────────────────────────────────────────────────────────────

  private live(): Array<[S, Attachment]> {
    const out: Array<[S, Attachment]> = [];
    for (const ws of this.host.sockets()) {
      const a = this.host.attachment(ws);
      if (a && !a.closed) out.push([ws, a]);
    }
    return out;
  }

  private currentMac(): [S, Attachment] | undefined {
    return this.live().find(([, a]) => a.role === "mac" && a.authed);
  }

  /** Every admitted phone and pairing socket: one channel each. */
  private channels(): Array<[S, Attachment]> {
    return this.live().filter(([, a]) => a.role !== "mac" && a.authed && a.ch !== undefined);
  }

  private channel(ch: string): [S, Attachment] | undefined {
    return this.channels().find(([, a]) => a.ch === ch);
  }

  private awaitingAuth(a: Attachment): boolean {
    return a.role !== "pair" && !a.authed;
  }

  private lastSeenOf(ws: S, a: Attachment): number {
    return Math.max(a.lastSeen, this.host.heartbeatAt(ws) ?? 0);
  }

  /**
   * §3.2 liveness, for a `ready`: an authenticated socket, and a message or heartbeat within the last
   * 60 s. Settles first what the channels already here were told, so the phone being admitted agrees
   * with them and is not sent the same news again.
   */
  private async macStatus(): Promise<{ online: boolean; lastSeen: number | null }> {
    const mac = this.currentMac();
    if (!mac) return { online: false, lastSeen: await this.storedLastSeen() };
    this.announceLiveness(...mac);
    return { online: !mac[1].quiet, lastSeen: this.lastSeenOf(...mac) };
  }

  /**
   * §3.2's quiet Mac. A sleeping Mac's socket stays open and says nothing, so no event reports it;
   * the alarm comes and looks. Tells every channel when the Mac goes quiet or is heard again, and
   * only on that change, so each phone hears each change once.
   */
  private announceLiveness(ws: S, a: Attachment): void {
    const lastSeen = this.lastSeenOf(ws, a);
    const quiet = this.host.now() - lastSeen >= ONLINE_WINDOW_MS;
    if (quiet === (a.quiet === true)) return;
    if (quiet) a.quiet = true;
    else delete a.quiet;
    this.host.setAttachment(ws, a);
    for (const [phone] of this.channels()) this.sendJson(phone, { t: "mac", online: !quiet, lastSeen });
  }

  private async storedLastSeen(): Promise<number | null> {
    return (await this.host.storage.get<number>(STORE.lastSeen)) ?? null;
  }

  /**
   * One alarm covers every deadline: each unauthenticated socket's 10 s, the pairing window, and,
   * while any channel is open, the Mac's silence. That is the moment the Mac would go quiet, or once
   * it has, the next look for its heartbeat. An active Mac moves that moment on with every message
   * without rescheduling, so the alarm wakes about once a minute and finds the deadline has moved.
   */
  private async scheduleAlarm(): Promise<void> {
    const deadlines = this.live()
      .filter(([, a]) => this.awaitingAuth(a))
      .map(([, a]) => a.openedAt + AUTH_TIMEOUT_MS);
    const window = await this.host.storage.get<PairWindow>(STORE.pair);
    if (window) deadlines.push(window.until);
    const mac = this.currentMac();
    if (mac && this.channels().length > 0) {
      deadlines.push(mac[1].quiet ? this.host.now() + QUIET_RECHECK_MS : this.lastSeenOf(...mac) + ONLINE_WINDOW_MS);
    }
    await this.host.setAlarm(deadlines.length > 0 ? Math.min(...deadlines) : null);
  }

  private sendJson(ws: S, message: object): void {
    this.host.send(ws, JSON.stringify(message));
  }
}

function openMessage(a: Attachment): object {
  return a.role === "pair" ? { t: "open", ch: a.ch, pair: a.windowId } : { t: "open", ch: a.ch, phone: a.phoneId };
}
