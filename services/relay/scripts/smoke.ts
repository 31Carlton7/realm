/**
 * Smoke-tests a relay that is already deployed, end to end, the way a Mac and its phones use it
 * (PROTOCOL.md §3 and §7):
 *
 *   node --experimental-strip-types scripts/smoke.ts <relay> [--apns production|sandbox|skip] [--fresh]
 *   pnpm smoke wss://realm-relay.realm-relay.workers.dev
 *
 * It plays a Mac and a phone with keys of its own, never anyone's pairing: /health and the routes,
 * the challenge and a forged answer to it, a pairing window, a paired phone and bytes both ways on
 * each channel, the heartbeat, the Mac going away and coming back, and Remove. APNs is checked with a
 * made-up device token: Apple checks the relay's provider token and topic before the device token, so
 * `400 BadDeviceToken` proves the APNs secrets work without a notification reaching any phone.
 *
 * The Mac and the phone are the same two identities on every run (their keys come from fixed seeds),
 * so the relay keeps one small room for the smoke test rather than one per run; a run leaves it with
 * no phones, no window and no push token. `--fresh` uses new keys instead. Two runs at once replace
 * each other's sockets (4409).
 */
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { setDefaultResultOrder } from "node:dns";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";

export type SmokeOptions = {
  /** Which APNs environment to check, as a TestFlight build (production) or a development build
   *  (sandbox) registers. `skip` leaves APNs out. Default: production. */
  apns?: "production" | "sandbox" | "skip";
  /** New identities instead of the fixed smoke-test ones. */
  fresh?: boolean;
  /** How long to wait for any one answer. */
  timeoutMs?: number;
  /** Each check as it finishes. */
  log?: (line: string) => void;
};

export type SmokeCheck = { name: string; ok: boolean; detail: string; ms: number };

type Device = { id: string; key: string; sign(message: Uint8Array): Promise<string> };

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

/** An Ed25519 key's PKCS#8 wrapping, so a fixed 32-byte seed can be imported as a private key. */
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/** §1's device: an Ed25519 key, and its id `b64u(SHA-256(signPub)[0..16])`. */
async function device(seed: Uint8Array): Promise<Device> {
  const subtle = webcrypto.subtle;
  const privateKey = await subtle.importKey("pkcs8", Buffer.concat([PKCS8_ED25519, seed]), { name: "Ed25519" }, true, ["sign"]);
  const { x } = await subtle.exportKey("jwk", privateKey);
  const publicKey = Buffer.from(x!, "base64url");
  return {
    id: b64u(createHash("sha256").update(publicKey).digest().subarray(0, 16)),
    key: b64u(publicKey),
    sign: async (message) => b64u(new Uint8Array(await subtle.sign({ name: "Ed25519" }, privateKey, message))),
  };
}

const seed = (fresh: boolean, who: string): Uint8Array =>
  fresh ? randomBytes(32) : createHash("sha256").update(`realm-relay-smoke/1 ${who}`).digest();

/** §3.1: what a client signs to answer the challenge. */
const challengeAnswer = (role: "mac" | "phone", macId: string, phoneId: string, nonce: string): Uint8Array =>
  utf8(`realm-relay/1\n${role}\n${macId}\n${phoneId}\n${nonce}`);

type Message = { text: string } | { bytes: Buffer };

/** A client socket that keeps every frame from the moment it exists: the relay speaks first. */
class Socket {
  private readonly inbox: Message[] = [];
  private wake: (() => void) | null = null;
  private readonly ws: WebSocket;
  private readonly timeoutMs: number;
  closed: { code: number; reason: string } | null = null;

  // Fields assigned by hand: Node runs this file by stripping its types, which has no parameter properties.
  private constructor(ws: WebSocket, timeoutMs: number) {
    this.ws = ws;
    this.timeoutMs = timeoutMs;
    ws.binaryType = "nodebuffer";
    ws.on("message", (data: Buffer, binary: boolean) => {
      this.inbox.push(binary ? { bytes: data } : { text: data.toString("utf8") });
      this.wake?.();
    });
    ws.on("close", (code: number, reason: Buffer) => {
      this.closed = { code, reason: reason.toString("utf8") };
      this.wake?.();
    });
    // `ws` emits an error before the close that explains it; the close is what is read.
    ws.on("error", () => {});
  }

  /** Opens a socket, or rejects with the HTTP status or close code the relay answered with. */
  static open(url: string, timeoutMs: number): Promise<Socket> {
    // No permessage-deflate, as PROTOCOL.md §3 requires of every client.
    const ws = new WebSocket(url, { perMessageDeflate: false });
    const socket = new Socket(ws, timeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.terminate(); reject(new Error(`no answer from ${url} within ${timeoutMs} ms`)); }, timeoutMs);
      ws.once("open", () => { clearTimeout(timer); resolve(socket); });
      ws.once("unexpected-response", (_req, res) => { clearTimeout(timer); ws.terminate(); reject(new Error(`HTTP ${res.statusCode} from ${url}`)); });
      ws.once("close", (code) => { clearTimeout(timer); reject(new Error(`closed before opening (${code})`)); });
    });
  }

  send(data: string | Uint8Array): void {
    this.ws.send(data);
  }

  sendJson(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  close(): void {
    this.ws.close(1000);
  }

  /** The next frame, skipping the heartbeat's `pong` unless `pong` is what is asked for. */
  async next(what: string, keepPong = false): Promise<Message> {
    for (;;) {
      const message = this.inbox.shift() ?? (await this.wait(what));
      if (!keepPong && "text" in message && message.text === "pong") continue;
      return message;
    }
  }

  /** The next control message, which must be of type `t`. */
  async control(t: string): Promise<Record<string, unknown>> {
    const message = await this.next(`{"t":"${t}"}`);
    if (!("text" in message)) throw new Error(`expected {"t":"${t}"}, got ${message.bytes.length} binary bytes`);
    const parsed = JSON.parse(message.text) as Record<string, unknown>;
    if (parsed.t !== t) throw new Error(`expected {"t":"${t}"}, got ${message.text}`);
    return parsed;
  }

  async binary(): Promise<Buffer> {
    const message = await this.next("a binary frame");
    if (!("bytes" in message)) throw new Error(`expected a binary frame, got ${message.text}`);
    return message.bytes;
  }

  /** The close code, once the relay has closed this socket. */
  async closedWith(): Promise<number> {
    const deadline = Date.now() + this.timeoutMs;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error(`still open after ${this.timeoutMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.closed.code;
  }

  private wait(what: string): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.wake = null; reject(new Error(`no ${what} within ${this.timeoutMs} ms`)); }, this.timeoutMs);
      this.wake = () => {
        const message = this.inbox.shift();
        if (message) {
          clearTimeout(timer);
          this.wake = null;
          resolve(message);
        } else if (this.closed) {
          clearTimeout(timer);
          this.wake = null;
          reject(new Error(`closed ${this.closed.code} ${this.closed.reason} while waiting for ${what}`));
        }
      };
      if (this.closed) this.wake();
    });
  }
}

/** Signs in as `who` on `path`, answering the relay's challenge. Resolves with the `ready`. */
async function signIn(relay: string, path: string, role: "mac" | "phone", macId: string, phone: Device | null, who: Device, timeoutMs: number) {
  const socket = await Socket.open(`${relay}${path}`, timeoutMs);
  const { nonce } = await socket.control("challenge");
  socket.sendJson({ t: "auth", key: who.key, sig: await who.sign(challengeAnswer(role, macId, phone?.id ?? "", String(nonce))) });
  return { socket, ready: await socket.control("ready") };
}

/** A phone socket that the Mac's last message lets in: the relay's room takes each event in turn,
 *  but a new socket and the Mac's message are separate arrivals, so a 4403 is tried again briefly. */
async function admitted<T>(open: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await open();
    } catch (e) {
      if (attempt >= 4 || !/4403/.test((e as Error).message)) throw e;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/** What APNs' answer to the made-up token says about the relay's APNs secrets. */
export function apnsVerdict(pushed: { ok?: unknown; status?: unknown; reason?: unknown }): { ok: boolean; detail: string } {
  const status = typeof pushed.status === "number" ? pushed.status : 0;
  const reason = typeof pushed.reason === "string" ? pushed.reason : null;
  if (status === 400 && reason === "BadDeviceToken") {
    return { ok: true, detail: "APNs took the relay's key and topic, and refused only the made-up device token (400 BadDeviceToken)" };
  }
  if (reason === "apns-not-configured") return { ok: false, detail: "the relay has no APNs key: set APNS_KEY_ID and APNS_KEY_P8 for this environment" };
  if (reason === "apns-key-invalid") return { ok: false, detail: "APNS_KEY_P8 is not a .p8 key the relay can read" };
  if (status === 403) return { ok: false, detail: `APNs refused the relay's provider token (${reason}): check APNS_KEY_ID, APNS_KEY_P8 and APNS_TEAM_ID` };
  if (reason === "TopicDisallowed" || reason === "BadTopic" || reason === "DeviceTokenNotForTopic") {
    return { ok: false, detail: `APNs refused the topic (${reason}): check APNS_TOPIC against the app's bundle id` };
  }
  return { ok: false, detail: `unexpected answer from APNs: ok ${String(pushed.ok)}, status ${status}, reason ${reason}` };
}

/** Runs every check in order, stopping at the first that fails: each one stands on the last. */
export async function smoke(relayBase: string, o: SmokeOptions = {}): Promise<SmokeCheck[]> {
  const relay = relayBase.replace(/\/+$/, "");
  if (!/^wss?:\/\/[^/]+$/.test(relay)) throw new Error(`${relayBase} is not a relay base URL (wss://host, no path)`);
  const timeoutMs = o.timeoutMs ?? 10_000;
  const apns = o.apns ?? "production";
  const log = o.log ?? (() => {});
  const http = relay.replace(/^ws/, "http");
  const checks: SmokeCheck[] = [];
  const sockets: Socket[] = [];
  const track = <T extends { socket: Socket }>(opened: T): T => { sockets.push(opened.socket); return opened; };

  const check = async (name: string, run: () => Promise<string>): Promise<boolean> => {
    const started = performance.now();
    let result: SmokeCheck;
    try {
      result = { name, ok: true, detail: await run(), ms: Math.round(performance.now() - started) };
    } catch (e) {
      result = { name, ok: false, detail: (e as Error).message, ms: Math.round(performance.now() - started) };
    }
    checks.push(result);
    log(`${result.ok ? "✓" : "✗"} ${result.name}: ${result.detail} (${result.ms} ms)`);
    return result.ok;
  };

  const mac = await device(seed(o.fresh === true, "mac"));
  const phone = await device(seed(o.fresh === true, "phone"));
  let macSocket: Socket | null = null;
  let phoneSocket: Socket | null = null;
  let phoneChannel = "";

  const steps: Array<[string, () => Promise<string>]> = [
    ["health", async () => {
      const res = await fetch(`${http}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      const body = await res.text();
      if (res.status !== 200 || body !== "ok") throw new Error(`GET /health answered ${res.status} ${JSON.stringify(body.slice(0, 80))}`);
      return "GET /health answers ok";
    }],
    ["routes", async () => {
      const unknown = await fetch(`${http}/v1/nothing`, { signal: AbortSignal.timeout(timeoutMs) });
      const plain = await fetch(`${http}/v1/mac/${mac.id}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (unknown.status !== 404) throw new Error(`an unknown path answered ${unknown.status}, not 404`);
      if (plain.status !== 426) throw new Error(`a socket path asked for without an upgrade answered ${plain.status}, not 426`);
      return "an unknown path is 404, and a socket path without an upgrade is 426";
    }],
    ["forged answer", async () => {
      // An answer signed by a key that is not the one the URL's id is derived from.
      const impostor = await device(randomBytes(32));
      const socket = await Socket.open(`${relay}/v1/mac/${mac.id}`, timeoutMs);
      sockets.push(socket);
      const { nonce } = await socket.control("challenge");
      socket.sendJson({ t: "auth", key: impostor.key, sig: await impostor.sign(challengeAnswer("mac", mac.id, "", String(nonce))) });
      const code = await socket.closedWith();
      if (code !== 4401) throw new Error(`the relay closed a forged Mac with ${code}, not 4401`);
      return "a Mac whose key is not its id's is refused with 4401";
    }],
    ["Mac signs in", async () => {
      macSocket = track(await signIn(relay, `/v1/mac/${mac.id}`, "mac", mac.id, null, mac, timeoutMs)).socket;
      return `challenge, auth and ready as Mac ${mac.id}`;
    }],
    ["pairing window", async () => {
      const window = b64u(randomBytes(16));
      macSocket!.sendJson({ t: "pair", window, until: Date.now() + 60_000 });
      const pairing = await admitted(async () => {
        const socket = await Socket.open(`${relay}/v1/pair/${mac.id}/${window}`, timeoutMs);
        try {
          return { socket, ready: await socket.control("ready") };
        } catch (e) {
          throw new Error(socket.closed ? `closed ${socket.closed.code}` : (e as Error).message);
        }
      });
      sockets.push(pairing.socket);
      const opened = await macSocket!.control("open");
      if (opened.pair !== window || typeof opened.ch !== "string") throw new Error(`the Mac was told ${JSON.stringify(opened)}`);
      const channel = Buffer.from(opened.ch, "base64url");
      const up = randomBytes(48);
      pairing.socket.send(up);
      const received = await macSocket!.binary();
      if (!sameBytes(received.subarray(0, 16), channel) || !sameBytes(received.subarray(16), up)) throw new Error("the phone's bytes reached the Mac changed");
      const down = randomBytes(48);
      macSocket!.send(Buffer.concat([channel, down]));
      if (!sameBytes(await pairing.socket.binary(), down)) throw new Error("the Mac's bytes reached the phone changed");
      pairing.socket.close();
      await macSocket!.control("close");
      macSocket!.sendJson({ t: "pair", window: null });
      return "a phone at an open window is let in, and bytes cross both ways under the channel's prefix";
    }],
    ["paired phone signs in", async () => {
      macSocket!.sendJson({ t: "phones", list: [{ id: phone.id, key: phone.key }] });
      const signed = await admitted(() => signIn(relay, `/v1/phone/${mac.id}/${phone.id}`, "phone", mac.id, phone, phone, timeoutMs));
      phoneSocket = track(signed).socket;
      const presence = signed.ready.mac as { online?: unknown } | undefined;
      if (presence?.online !== true) throw new Error(`the phone's ready said the Mac is ${JSON.stringify(signed.ready.mac)}`);
      const opened = await macSocket!.control("open");
      if (opened.phone !== phone.id || typeof opened.ch !== "string") throw new Error(`the Mac was told ${JSON.stringify(opened)}`);
      phoneChannel = opened.ch;
      const up = randomBytes(64);
      phoneSocket.send(up);
      const received = await macSocket!.binary();
      if (!sameBytes(received.subarray(16), up)) throw new Error("the phone's bytes reached the Mac changed");
      const down = randomBytes(64);
      macSocket!.send(Buffer.concat([Buffer.from(phoneChannel, "base64url"), down]));
      if (!sameBytes(await phoneSocket.binary(), down)) throw new Error("the Mac's bytes reached the phone changed");
      return "a phone the Mac lists signs in, hears the Mac is online, and bytes cross both ways";
    }],
    ["heartbeat", async () => {
      phoneSocket!.send("ping");
      const answer = await phoneSocket!.next("pong", true);
      if (!("text" in answer) || answer.text !== "pong") throw new Error("ping was not answered with pong");
      return "ping is answered with pong";
    }],
    ...(apns === "skip" ? [] : [["APNs " + apns, async () => {
      phoneSocket!.sendJson({ t: "apns", token: randomBytes(32).toString("hex"), env: apns });
      // A socket's messages are taken in order, so once this marker reaches the Mac the token is kept.
      const marker = randomBytes(8);
      phoneSocket!.send(marker);
      await macSocket!.binary();
      macSocket!.sendJson({ t: "push", id: `smoke-${b64u(randomBytes(6))}`, phone: phone.id, blob: b64u(randomBytes(96)), urgent: false, collapse: null, badge: null });
      const pushed = await macSocket!.control("pushed");
      const verdict = apnsVerdict(pushed);
      if (!verdict.ok) throw new Error(verdict.detail);
      return verdict.detail;
    }] as [string, () => Promise<string>]]),
    ["Mac away and back", async () => {
      macSocket!.close();
      const away = await phoneSocket!.control("mac");
      if (away.online !== false) throw new Error(`the phone heard ${JSON.stringify(away)} when the Mac left`);
      macSocket = track(await signIn(relay, `/v1/mac/${mac.id}`, "mac", mac.id, null, mac, timeoutMs)).socket;
      const back = await phoneSocket!.control("mac");
      if (back.online !== true) throw new Error(`the phone heard ${JSON.stringify(back)} when the Mac came back`);
      return "the phone hears the Mac leave and come back";
    }],
    ["Remove", async () => {
      macSocket!.sendJson({ t: "phones", list: [] });
      const code = await phoneSocket!.closedWith();
      if (code !== 4410) throw new Error(`the removed phone was closed with ${code}, not 4410`);
      return "a phone the Mac stops listing is closed with 4410, and its push token is forgotten";
    }],
  ];

  try {
    for (const [name, run] of steps) if (!(await check(name, run))) break;
  } finally {
    for (const socket of sockets) if (!socket.closed) socket.close();
  }
  return checks;
}

function parseArgs(argv: string[]): { relay: string; options: SmokeOptions } {
  let relay: string | null = null;
  const options: SmokeOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--fresh") options.fresh = true;
    else if (arg === "--apns") {
      const value = argv[++i];
      if (value !== "production" && value !== "sandbox" && value !== "skip") throw new Error("--apns takes production, sandbox or skip");
      options.apns = value;
    } else if (!arg.startsWith("--") && relay === null) relay = arg;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!relay) throw new Error("usage: smoke.ts <wss://relay> [--apns production|sandbox|skip] [--fresh]");
  return { relay, options };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Node tries IPv6 first, and on a network whose IPv6 goes nowhere every request then times out.
  setDefaultResultOrder("ipv4first");
  try {
    const { relay, options } = parseArgs(process.argv.slice(2));
    console.log(`Smoke-testing ${relay}`);
    const started = performance.now();
    const checks = await smoke(relay, { ...options, log: (line) => console.log(`  ${line}`) });
    const failed = checks.filter((c) => !c.ok);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    if (failed.length === 0) console.log(`All ${checks.length} checks passed in ${seconds} s.`);
    else console.log(`Failed at "${failed[0]!.name}" after ${checks.length - 1} passed (${seconds} s).`);
    process.exit(failed.length === 0 ? 0 : 1);
  } catch (e) {
    console.error(`smoke: ${(e as Error).message}`);
    process.exit(2);
  }
}
