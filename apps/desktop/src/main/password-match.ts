import { getDomain } from "tldts";
import { normalizeOrigin, type BrowserCredential, type PasswordSiteMatch } from "@realm/contracts";

/**
 * Which saved passwords a page may be offered, and in what order.
 *
 * Saved passwords are pinned to an origin (`normalizeOrigin`), and an agent's fill still needs that
 * origin or this one. What this adds is what Chrome and Safari both do for a person: a password saved
 * for www.example.com is offered on login.example.com, because an export from the Passwords app holds
 * whichever address the user first saved it at, and a sign-in page is often a sibling of it.
 *
 * The line is the registrable domain under the PUBLIC-SUFFIX list (tldts, private section included),
 * never "the last two labels". Under the list alice.github.io and bob.github.io are two sites, as are
 * two shops on myshopify.com; under a two-label guess they would be one, and a page anyone can publish
 * would be offered everyone else's password on the same host.
 *
 * Three refusals, each one a hole otherwise:
 *   - a password saved for https:// is never offered on http:// — a downgrade is how a network
 *     attacker reads it. The reverse (saved for http://, page on https://) is offered: same site,
 *     better transport.
 *   - an IP address, `localhost`, or any host with no registrable domain matches only itself, port
 *     included: there is no "site" to widen to.
 *   - a different port on the same scheme is a different service, and is not offered.
 */
export function credentialSiteMatch(credentialOrigin: string, pageOrigin: string): PasswordSiteMatch | null {
  const saved = normalizeOrigin(credentialOrigin);
  const page = normalizeOrigin(pageOrigin);
  if (!saved || !page) return null;
  if (saved === page) return "exact";
  const a = new URL(saved), b = new URL(page);
  if (a.protocol === "https:" && b.protocol === "http:") return null;
  const upgrade = a.protocol === "http:" && b.protocol === "https:";
  // Same scheme: the port must agree. An upgrade: both on their scheme's default port, which URL
  // reports as "" — 8080 over http and 8443 over https are not the same service moved.
  if (upgrade ? a.port !== "" || b.port !== "" : a.port !== b.port) return null;
  if (a.hostname === b.hostname) return "same-site";
  const siteA = registrableDomain(a.hostname), siteB = registrableDomain(b.hostname);
  return siteA !== null && siteA === siteB ? "same-site" : null;
}

/** The host's registrable domain, or null where there is none (an IP, `localhost`, a bare suffix). */
function registrableDomain(host: string): string | null {
  return getDomain(host, { allowPrivateDomains: true }) ?? null;
}

/**
 * The passwords that may be offered on `pageOrigin`, exact matches first, then the rest of the site,
 * each run by username so the menu reads the same every time it opens.
 */
export function credentialsForPage<T extends BrowserCredential>(rows: readonly T[], pageOrigin: string): (T & { match: PasswordSiteMatch })[] {
  const out: (T & { match: PasswordSiteMatch })[] = [];
  for (const row of rows) {
    const match = credentialSiteMatch(row.origin, pageOrigin);
    if (match) out.push({ ...row, match });
  }
  const rank = (m: PasswordSiteMatch) => (m === "exact" ? 0 : 1);
  return out.sort((x, y) => rank(x.match) - rank(y.match) || x.username.localeCompare(y.username) || x.origin.localeCompare(y.origin));
}
