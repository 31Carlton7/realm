import { b64u, fromB64u } from "./bytes";

/** What a pairing QR code carries (PROTOCOL.md §2). */
export type PairingLink = {
  relay: string;
  macId: string;
  /** The Mac's X25519 public key — the static key IKpsk1 needs in advance. */
  macKey: Buffer;
  /** The one-time secret, used as the Noise PSK. */
  secret: Buffer;
  windowId: string;
  macName: string;
  expiresAt: number;
};

export const LINK_BASE = "https://realm.computer/pair";
const LINK_PREFIXES = [`${LINK_BASE}#`, "realm-mobile://pair#"];
const VERSION = "1";

export class LinkError extends Error {
  constructor(readonly reason: "malformed" | "version" | "expired") { super(`pairing link ${reason}`); }
}

/** The payload goes after `#`, so a browser that opens the link sends none of it to the website. */
export function encodeLink(l: PairingLink, base = LINK_BASE): string {
  const data = { r: l.relay, m: l.macId, k: b64u(l.macKey), s: b64u(l.secret), w: l.windowId, n: l.macName, e: l.expiresAt };
  return `${base}#${VERSION}.${b64u(Buffer.from(JSON.stringify(data), "utf8"))}`;
}

export function parseLink(url: string, now = Date.now()): PairingLink {
  const prefix = LINK_PREFIXES.find((p) => url.startsWith(p));
  if (!prefix) throw new LinkError("malformed");
  const rest = url.slice(prefix.length);
  const dot = rest.indexOf(".");
  if (dot < 0) throw new LinkError("malformed");
  if (rest.slice(0, dot) !== VERSION) throw new LinkError("version");
  let d: Record<string, unknown>;
  try { d = JSON.parse(fromB64u(rest.slice(dot + 1)).toString("utf8")) as Record<string, unknown>; } catch { throw new LinkError("malformed"); }
  const str = (k: string): string => { const v = d[k]; if (typeof v !== "string" || v === "") throw new LinkError("malformed"); return v; };
  const key = (k: string): Buffer => { try { const b = fromB64u(str(k)); if (b.length !== 32) throw new Error(); return b; } catch { throw new LinkError("malformed"); } };
  if (typeof d.e !== "number" || !Number.isFinite(d.e)) throw new LinkError("malformed");
  const link: PairingLink = { relay: str("r"), macId: str("m"), macKey: key("k"), secret: key("s"), windowId: str("w"), macName: str("n"), expiresAt: d.e };
  if (!/^wss?:\/\/[^/]+(\/.*)?$/.test(link.relay) || link.relay.endsWith("/")) throw new LinkError("malformed");
  if (link.expiresAt <= now) throw new LinkError("expired");
  return link;
}
