import type { AppViewCsp } from "@realm/contracts";

/**
 * A view's Content Security Policy, built from what its resource declared (MCP Apps `_meta.ui.csp`)
 * and sent as the frame's response header — a header, not a meta tag, so nothing in the HTML can
 * loosen it.
 *
 * The spec's rule is "MAY further restrict, MUST NOT allow undeclared domains", and Realm restricts in
 * three places:
 *
 *  - A declared domain is kept only if it is a public `https://` or `wss://` origin, optionally with a
 *    leading `*.` over at least two labels and a port. Loopback, IP literals, single-label names and
 *    the names that only ever mean a private network (`.localhost`, `.local`, `.internal`, …) are
 *    dropped: a view reaching this Mac's own listeners, or the user's router, is the reach the sandbox
 *    exists to deny. So is anything carrying a space, a quote, a semicolon or a comma — the characters
 *    that would end a source and start a directive of the server's choosing.
 *  - `connect-src` does not include `'self'`. The view's own origin is Realm's views listener, which
 *    has nothing else to say to it.
 *  - `form-action 'none'`: a view may handle a form in script, never submit one somewhere.
 *
 * Its limit, stated: a public name can still resolve to a private address. The CSP cannot see DNS;
 * the names below that are well known to do it are dropped, and the rest is beyond a header.
 */

/** Names that resolve to loopback for anyone who asks — dropped like `localhost` itself. */
const LOOPBACK_NAMES = ["localtest.me", "lvh.me", "nip.io", "sslip.io", "xip.io", "traefik.me", "vcap.me"];
/** Suffixes that only ever name a private network. */
const PRIVATE_SUFFIXES = ["localhost", "local", "internal", "intranet", "lan", "home.arpa", "corp"];
/** The most domains one list keeps — a header is not a place for a server's whole CDN map. */
const MAX_DOMAINS = 32;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const SOURCE = new RegExp(`^(?:(https|wss)://)?(\\*\\.)?((?:${LABEL}\\.)+${LABEL})(?::(\\d{1,5}))?/?$`);

/** One declared domain as a CSP source, or null when it may not be one. */
export function approvedSource(raw: unknown, schemes: readonly ("https" | "wss")[]): string | null {
  if (typeof raw !== "string") return null;
  const m = SOURCE.exec(raw.trim().toLowerCase());
  if (!m) return null;
  const [, scheme = "https", wildcard = "", host, port] = m as unknown as [string, string | undefined, string | undefined, string, string | undefined];
  if (!schemes.includes(scheme as "https" | "wss")) return null;
  if (/^\d+(\.\d+){3}$/.test(host)) return null;
  if (PRIVATE_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) return null;
  if (LOOPBACK_NAMES.some((n) => host === n || host.endsWith(`.${n}`))) return null;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65_535)) return null;
  return `${scheme}://${wildcard}${host}${port !== undefined ? `:${port}` : ""}`;
}

function approvedList(raw: unknown, schemes: readonly ("https" | "wss")[]): string[] {
  if (!Array.isArray(raw)) return [];
  const kept = new Set<string>();
  for (const d of raw) {
    const source = approvedSource(d, schemes);
    if (source) kept.add(source);
    if (kept.size >= MAX_DOMAINS) break;
  }
  return [...kept];
}

/** What a resource's `_meta.ui.csp` declared, cut down to what Realm lets through. */
export function approvedCsp(declared: unknown): AppViewCsp {
  const d = declared && typeof declared === "object" ? declared as Record<string, unknown> : {};
  return {
    connectDomains: approvedList(d.connectDomains, ["https", "wss"]),
    resourceDomains: approvedList(d.resourceDomains, ["https"]),
    frameDomains: approvedList(d.frameDomains, ["https"]),
    baseUriDomains: approvedList(d.baseUriDomains, ["https"]),
  };
}

/** Whether a resource declared a CSP at all — the spec's restrictive default applies when it did not. */
export function declaresCsp(ui: Record<string, unknown> | null): boolean {
  return !!ui && !!ui.csp && typeof ui.csp === "object";
}

/**
 * The header. With no declaration, exactly the spec's restrictive default, plus the restrictions
 * above; with one, the spec's construction from the approved domains.
 */
export function viewCsp(csp: AppViewCsp, declared: boolean): string {
  const join = (xs: readonly string[]) => (xs.length ? ` ${xs.join(" ")}` : "");
  const r = join(csp.resourceDomains);
  const directives = declared
    ? [
      "default-src 'none'",
      `script-src 'self' 'unsafe-inline'${r}`,
      `style-src 'self' 'unsafe-inline'${r}`,
      `img-src 'self' data:${r}`,
      `font-src 'self'${r}`,
      `media-src 'self' data:${r}`,
      `connect-src ${csp.connectDomains.length ? csp.connectDomains.join(" ") : "'none'"}`,
      `frame-src ${csp.frameDomains.length ? csp.frameDomains.join(" ") : "'none'"}`,
      "object-src 'none'",
      `base-uri ${csp.baseUriDomains.length ? csp.baseUriDomains.join(" ") : "'self'"}`,
    ]
    : [
      "default-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "media-src 'self' data:",
      "connect-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'self'",
    ];
  return [...directives, "form-action 'none'"].join("; ");
}
