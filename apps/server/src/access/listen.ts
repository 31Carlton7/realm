import { BlockList, isIP, isIPv4 } from "node:net";
import { CtlError } from "../ctl/errors";

/**
 * Where `realm serve --listen` may listen, decided before anything is bound.
 *
 * Loopback is the default and stays the only thing a server listens on until someone asks for more.
 * Asked for more, the rule is that an access token never crosses a network in the clear unless the
 * person said the network itself is private and encrypted:
 *
 * - **loopback** (127.0.0.1, ::1): plain `ws://` is allowed. Something on this machine terminates the
 *   encryption — `ssh -L`, or Tailscale Serve proxying HTTPS from the tailnet to this port.
 * - **private** (RFC 1918, a tailnet's 100.64.0.0/10, IPv6 ULA and link-local): TLS, or
 *   `--allow-plaintext` for a network that encrypts on its own (a tailnet, WireGuard). Realm cannot
 *   see whether it does, so the person has to say so.
 * - **any address** (0.0.0.0, ::) or a **public** one: TLS, always. There is no flag that turns this off.
 *
 * Every remote handshake needs an access token whatever the address (`listenRemote`), so "plain
 * 0.0.0.0 without a token" cannot be configured at all.
 */
export type ListenAddress = { host: string; port: number };
export type ListenConfig = ListenAddress & { tls: { cert: string; key: string } | null; allowPlaintext: boolean };
export type AddressKind = "loopback" | "private" | "wildcard" | "public";

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

const PRIVATE = new BlockList();
for (const [net, bits] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10], ["169.254.0.0", 16]] as const) PRIVATE.addSubnet(net, bits, "ipv4");
PRIVATE.addSubnet("fc00::", 7, "ipv6");
PRIVATE.addSubnet("fe80::", 10, "ipv6");

/** `7420`, `127.0.0.1:7420`, `localhost:7420`, `[::1]:7420`. A bare port is loopback. Names other than
 *  localhost are refused: what a name resolves to can change under a running server, and the rules
 *  above are about an address. */
export function parseListenAddress(value: string): ListenAddress {
  const v = value.trim();
  let host: string; let port: string;
  const v6 = /^\[([^\]]+)\]:(\d+)$/.exec(v);
  if (/^\d+$/.test(v)) { host = "127.0.0.1"; port = v; }
  else if (v6) { host = v6[1]!; port = v6[2]!; }
  else {
    const colon = v.lastIndexOf(":");
    if (colon <= 0 || v.indexOf(":") !== colon) throw new CtlError("USAGE", `--listen takes ADDRESS:PORT (127.0.0.1:7420, [::1]:7420), not ${value}`);
    host = v.slice(0, colon); port = v.slice(colon + 1);
  }
  if (host === "localhost") host = "127.0.0.1";
  if (isIP(host) === 0) throw new CtlError("USAGE", `--listen takes an address, not a name: ${host}`);
  if (!/^\d+$/.test(port) || Number(port) > 65535) throw new CtlError("USAGE", `--listen needs a port from 0 to 65535, not ${port}`);
  return { host, port: Number(port) };
}

export function classifyAddress(host: string): AddressKind {
  // An IPv4 address written as IPv6 (`::ffff:127.0.0.1`) is that IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
  const h = mapped ? mapped[1]! : host;
  const family = isIPv4(h) ? "ipv4" : "ipv6";
  if (h === "0.0.0.0" || h === "::") return "wildcard";
  if (LOOPBACK.check(h, family)) return "loopback";
  if (PRIVATE.check(h, family)) return "private";
  return "public";
}

const ALTERNATIVES = "listen on 127.0.0.1 behind Tailscale Serve (`realm serve --tailscale`) or an SSH tunnel";

/** The address's kind, or a refusal saying what would be allowed instead. */
export function checkListen(c: ListenConfig): AddressKind {
  const kind = classifyAddress(c.host);
  if (c.tls || kind === "loopback") return kind;
  if (kind === "private") {
    if (c.allowPlaintext) return kind;
    throw new CtlError("LISTEN_REFUSED", `refusing to listen on ${c.host} without TLS: other machines on that network could read the access token. Give --tls-cert and --tls-key, ${ALTERNATIVES}, or, on a network that encrypts on its own (a tailnet, WireGuard), pass --allow-plaintext`);
  }
  const where = kind === "wildcard" ? `every address (${c.host})` : `the public address ${c.host}`;
  throw new CtlError("LISTEN_REFUSED", `refusing to listen on ${where} without TLS: anyone on the way could read the access token. Give --tls-cert and --tls-key, or ${ALTERNATIVES}`);
}

/** The listener `realm serve` handed `main.ts`, from the environment it set. Null when there is none. */
export function listenFromEnv(env: NodeJS.ProcessEnv): ListenConfig | null {
  const listen = env.REALM_LISTEN?.trim();
  if (!listen) return null;
  const cert = env.REALM_TLS_CERT?.trim() || null;
  const key = env.REALM_TLS_KEY?.trim() || null;
  if ((cert === null) !== (key === null)) throw new CtlError("USAGE", "TLS needs both a certificate (--tls-cert) and its key (--tls-key)");
  return { ...parseListenAddress(listen), tls: cert && key ? { cert, key } : null, allowPlaintext: env.REALM_ALLOW_PLAINTEXT === "1" };
}

/** What a client dials to reach a listener: the scheme its TLS says, and the address with brackets
 *  round an IPv6 one. */
export function listenUrl(c: Pick<ListenConfig, "host" | "tls">, port: number): string {
  const host = c.host.includes(":") ? `[${c.host}]` : c.host;
  return `${c.tls ? "wss" : "ws"}://${host}:${port}`;
}
