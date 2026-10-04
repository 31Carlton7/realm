/**
 * "Share this site's sign-in with ▸ <profile>" (Plan 27 Phase 2): copy the cookies a site signs you in
 * with from one profile's browser partition into another's. The decisions — which cookies are this
 * site's, and how each is written so Chromium takes it and it means the same thing on the other side —
 * live here, Electron-free; browser-pane.ts reads and writes the two sessions.
 *
 * A COPY, like sharing a saved sign-in: the pane keeps its cookies, and the other profile gets its own
 * from then on. What it cannot carry is a sign-in kept somewhere other than cookies — a token in a
 * page's local storage stays behind, and that site will ask the other profile to sign in again.
 */

/** The slice of Electron's `Cookie` a copy reads. */
export type CookieLike = {
  name: string; value: string;
  domain?: string; hostOnly?: boolean; path?: string;
  secure?: boolean; httpOnly?: boolean;
  session?: boolean; expirationDate?: number;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
};

/** What Electron's `cookies.set` takes. */
export type CookieSetDetails = {
  url: string; name: string; value: string;
  domain?: string; path?: string; secure?: boolean; httpOnly?: boolean;
  expirationDate?: number; sameSite?: CookieLike["sameSite"];
};

/** The site a page is on, as cookies are scoped: its host (ports do not separate cookies), and the
 *  page's own address, which is what the cookies its requests carry are read against. Null for
 *  anything that is not an ordinary web page — a blank tab has no sign-in to share. */
export function siteOf(pageUrl: string): { host: string; url: string } | null {
  let u: URL;
  try { u = new URL(pageUrl); } catch { return null; }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.hostname === "") return null;
  return { host: u.hostname, url: u.href };
}

/**
 * This site's cookies, from two reads of the source partition: the ones the page's own requests carry
 * (which includes a parent domain's, like `.example.com` for `app.example.com` — the browser itself
 * counts those as this page's) and every cookie on the page's host and its subdomains, whatever its
 * path. Deliberately NOT every cookie of the parent domain's other subdomains: without the public
 * suffix list that walk cannot tell `example.com` from `github.io`, and would hand the other profile
 * every github.io site this one ever visited.
 */
export function siteCookies(sent: readonly CookieLike[], onHost: readonly CookieLike[]): CookieLike[] {
  const seen = new Set<string>();
  const out: CookieLike[] = [];
  for (const c of [...sent, ...onHost]) {
    const key = `${c.name}\u0000${c.domain ?? ""}\u0000${c.path ?? "/"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * One cookie as `cookies.set` must be given it to mean the same thing in the other partition, or null
 * for one that has already expired.
 *
 *   - A host-only cookie is written with NO domain: naming one would widen it to every subdomain, and
 *     a `__Host-` cookie is refused outright with a domain.
 *   - A session cookie is written with no expiry, so it stays a session cookie rather than becoming a
 *     persistent one by accident.
 *   - The url is the cookie's own scheme, host and path — Chromium refuses a cookie whose url could not
 *     have set it, and a secure cookie must arrive over https.
 */
export function cookieToSet(c: CookieLike, nowSeconds: number): CookieSetDetails | null {
  const host = (c.domain ?? "").replace(/^\./, "");
  if (host === "") return null;
  const persistent = c.session !== true && typeof c.expirationDate === "number";
  if (persistent && c.expirationDate! <= nowSeconds) return null;
  const path = c.path && c.path.startsWith("/") ? c.path : "/";
  return {
    url: `${c.secure ? "https" : "http"}://${host}${path}`,
    name: c.name,
    value: c.value,
    path,
    ...(c.hostOnly ? {} : { domain: c.domain }),
    ...(c.secure !== undefined ? { secure: c.secure } : {}),
    ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
    ...(c.sameSite !== undefined ? { sameSite: c.sameSite } : {}),
    ...(persistent ? { expirationDate: c.expirationDate } : {}),
  };
}
