import { connect as unixConnect, type Socket } from "node:net";

/**
 * A connection to a TCP port on an iPhone's OWN loopback, through the Mac's usbmuxd.
 *
 * The device runner listens on the phone's loopback interface only, so nothing on the phone's Wi-Fi
 * can drive it. usbmuxd is how the Mac reaches that interface: asked to `Connect` to a device and a
 * port, it answers `Result 0` and the same socket becomes a pipe to that port on the phone — which is
 * what `iproxy` and Xcode itself use, and why nothing needs to be installed for it.
 *
 * The protocol is usbmuxd's plist dialect: a 16-byte little-endian header (length, version 1,
 * message 8, tag) and an XML property list. The two messages here are the whole of what Realm needs,
 * and each was checked against this Mac's own usbmuxd, which lists a wired iPhone 17 Pro with its
 * UDID as `SerialNumber`.
 */

export const USBMUXD_SOCKET = "/var/run/usbmuxd";

/** One device usbmuxd can reach. A phone on the cable AND on Wi-Fi is listed twice, once per way. */
export type MuxDevice = { deviceId: number; udid: string; connection: string };

export class UsbmuxError extends Error {}

/* ── the plist dialect ──────────────────────────────────────────────────────────────────────────── */

type Plist = string | number | boolean | Plist[] | { [k: string]: Plist };

const escape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plistXml(dict: Record<string, string | number>): string {
  const body = Object.entries(dict).map(([k, v]) =>
    `<key>${escape(k)}</key>${typeof v === "number" ? `<integer>${Math.trunc(v)}</integer>` : `<string>${escape(v)}</string>`}`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>\n`;
}

const unescape = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** An XML plist → a value: dict, array, string, integer, real, true, false, data (kept as base64).
 *  The subset usbmuxd writes; anything else is an error rather than a guess. */
export function parsePlist(xml: string): Plist {
  // A tag (closing slash, name, attributes skipped, self-closing slash) or the text between two tags.
  // `<?xml …?>` and `<!DOCTYPE …>` match neither and fall away as text before `<plist>`.
  const tokens = [...xml.matchAll(/<(\/?)([A-Za-z]\w*)[^>]*?(\/?)>|([^<]+)/g)];
  let i = 0;
  const skipText = () => { while (i < tokens.length && tokens[i]![4] !== undefined) i++; };
  const expectClose = (name: string) => { skipText(); const t = tokens[i++]; if (!t || t[1] !== "/" || t[2] !== name) throw new UsbmuxError(`plist: expected </${name}>`); };
  const text = (name: string): string => {
    const t = tokens[i];
    let out = "";
    if (t && t[4] !== undefined) { out = unescape(t[4]); i++; }
    expectClose(name);
    return out;
  };
  const value = (): Plist => {
    skipText();
    const t = tokens[i++];
    if (!t || t[1] === "/") throw new UsbmuxError("plist: expected a value");
    const name = t[2]!;
    if (t[3]) { // self-closing
      if (name === "true") return true;
      if (name === "false") return false;
      if (name === "dict") return {};
      if (name === "array") return [];
      if (name === "string") return "";
      throw new UsbmuxError(`plist: <${name}/> is not a value`);
    }
    switch (name) {
      case "dict": {
        const out: Record<string, Plist> = {};
        for (;;) {
          skipText();
          const k = tokens[i];
          if (k && k[1] === "/" && k[2] === "dict") { i++; return out; }
          if (!k || k[2] !== "key") throw new UsbmuxError("plist: expected a key");
          i++;
          const key = text("key");
          out[key] = value();
        }
      }
      case "array": {
        const out: Plist[] = [];
        for (;;) {
          skipText();
          const k = tokens[i];
          if (k && k[1] === "/" && k[2] === "array") { i++; return out; }
          out.push(value());
        }
      }
      case "string": return text("string");
      case "data": return text("data").replace(/\s+/g, "");
      case "integer": case "real": { const n = Number(text(name).trim()); if (!Number.isFinite(n)) throw new UsbmuxError("plist: not a number"); return n; }
      case "true": expectClose("true"); return true;
      case "false": expectClose("false"); return false;
      default: throw new UsbmuxError(`plist: <${name}> is not a value this reads`);
    }
  };
  // Past the prolog and the doctype, into <plist>.
  while (i < tokens.length && tokens[i]![2] !== "plist") i++;
  if (i >= tokens.length) throw new UsbmuxError("plist: no <plist>");
  i++;
  return value();
}

/* ── the wire ───────────────────────────────────────────────────────────────────────────────────── */

const HEADER = 16;
const PLIST_MESSAGE = 8;

export function packet(dict: Record<string, string | number>, tag: number): Buffer {
  const body = Buffer.from(plistXml(dict), "utf8");
  const head = Buffer.alloc(HEADER);
  head.writeUInt32LE(HEADER + body.length, 0);
  head.writeUInt32LE(1, 4);
  head.writeUInt32LE(PLIST_MESSAGE, 8);
  head.writeUInt32LE(tag, 12);
  return Buffer.concat([head, body]);
}

const HELLO = { ClientVersionString: "realm", ProgName: "realm", kLibUSBMuxVersion: 3 };

/** usbmuxd takes the port in NETWORK byte order inside a little-endian integer. */
export const muxPort = (port: number): number => ((port & 0xff) << 8) | ((port >> 8) & 0xff);

/** One reply off the socket: the plist, and whatever arrived after it — which, after a successful
 *  Connect, is already the far end's first bytes and must be handed back rather than dropped. */
function readReply(socket: Socket, timeoutMs: number): Promise<{ reply: Record<string, Plist>; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { cleanup(); reject(new UsbmuxError("usbmuxd did not answer")); }, timeoutMs);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4) return;
      const size = buf.readUInt32LE(0);
      if (buf.length < size) return;
      cleanup();
      try {
        const reply = parsePlist(buf.subarray(HEADER, size).toString("utf8"));
        if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw new UsbmuxError("usbmuxd's reply is not a dictionary");
        resolve({ reply, rest: buf.subarray(size) });
      } catch (e) { reject(e); }
    };
    const onError = (e: Error) => { cleanup(); reject(new UsbmuxError(`usbmuxd: ${e.message}`)); };
    const onClose = () => { cleanup(); reject(new UsbmuxError("usbmuxd closed the connection")); };
    const cleanup = () => { clearTimeout(timer); socket.off("data", onData); socket.off("error", onError); socket.off("close", onClose); };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

const openMux = (path: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const s = unixConnect(path);
    s.once("connect", () => resolve(s));
    s.once("error", (e) => reject(new UsbmuxError(`usbmuxd is not reachable at ${path}: ${e.message}`)));
  });

/** usbmuxd's `Result` numbers, in words. 3 is the one that means "nothing is listening yet". */
const RESULTS: Record<number, string> = {
  1: "usbmuxd refused the request", 2: "the device is not connected", 3: "nothing on the phone is listening on that port", 5: "usbmuxd does not speak this version",
};

export async function listDevices(path = USBMUXD_SOCKET, timeoutMs = 5_000): Promise<MuxDevice[]> {
  const s = await openMux(path);
  try {
    s.write(packet({ MessageType: "ListDevices", ...HELLO }, 1));
    const { reply } = await readReply(s, timeoutMs);
    const list = Array.isArray(reply.DeviceList) ? reply.DeviceList : [];
    const out: MuxDevice[] = [];
    for (const entry of list) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const props = (entry as Record<string, Plist>).Properties;
      if (!props || typeof props !== "object" || Array.isArray(props)) continue;
      const p = props as Record<string, Plist>;
      const id = typeof p.DeviceID === "number" ? p.DeviceID : (entry as Record<string, Plist>).DeviceID;
      if (typeof id !== "number" || typeof p.SerialNumber !== "string") continue;
      out.push({ deviceId: id, udid: p.SerialNumber, connection: typeof p.ConnectionType === "string" ? p.ConnectionType : "" });
    }
    return out;
  } finally {
    s.destroy();
  }
}

/** A socket that IS a TCP connection to `port` on the phone with this UDID. A cable is preferred to
 *  Wi-Fi when usbmuxd has both, being the one a person plugged in. */
export async function connectToDevice(udid: string, port: number, path = USBMUXD_SOCKET, timeoutMs = 5_000): Promise<Socket> {
  const devices = await listDevices(path, timeoutMs);
  const mine = devices.filter((d) => sameUdid(d.udid, udid));
  const device = mine.find((d) => d.connection === "USB") ?? mine[0];
  if (!device) throw new UsbmuxError("the phone is not on this Mac's cable or network as far as usbmuxd can see");
  const s = await openMux(path);
  try {
    s.write(packet({ MessageType: "Connect", DeviceID: device.deviceId, PortNumber: muxPort(port), ...HELLO }, 2));
    const { reply, rest } = await readReply(s, timeoutMs);
    const n = typeof reply.Number === "number" ? reply.Number : -1;
    if (reply.MessageType !== "Result" || n !== 0) throw new UsbmuxError(RESULTS[n] ?? `usbmuxd answered ${n}`);
    if (rest.length > 0) s.unshift(rest);
    return s;
  } catch (e) {
    s.destroy();
    throw e;
  }
}

/** usbmuxd names a phone by its UDID as `SerialNumber`, with the hyphen the newer UDIDs carry;
 *  `USBSerialNumber` drops it. Either spelling names the same phone. */
const sameUdid = (a: string, b: string): boolean => a.replace(/-/g, "").toUpperCase() === b.replace(/-/g, "").toUpperCase();
