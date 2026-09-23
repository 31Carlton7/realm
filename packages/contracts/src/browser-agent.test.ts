import { describe, expect, it } from "vitest";
import {
  BROWSER_READ_ONLY_TOOLS, CREDENTIAL_PRESENCE_TTLS, normalizeOrigin, passkeyRpIdForPageUrl,
} from "./browser-agent";

/**
 * `normalizeOrigin` IS the anti-phishing gate — the fill executor's whole decision is an `===`
 * against this function's output, so a mutant that loosens it here loosens the gate everywhere. The
 * cases below are written as the attacks they stand for, not as URL trivia.
 */
describe("normalizeOrigin", () => {
  it("normalizes spellings of the SAME origin together", () => {
    for (const input of ["https://example.com", "https://example.com/", "https://EXAMPLE.com/login?a=1#x", "https://example.com:443/"]) {
      expect(normalizeOrigin(input), input).toBe("https://example.com");
    }
    expect(normalizeOrigin("  https://example.com/  ")).toBe("https://example.com");
  });

  it("keeps genuinely DIFFERENT origins apart — each of these is a real lookalike technique", () => {
    const target = normalizeOrigin("https://example.com")!;
    for (const attacker of [
      "https://examp1e.com/",            // homoglyph
      "https://login.example.com/",      // subdomain: not the same site
      "https://example.com.evil.co/",    // suffix that reads like the target
      "https://example.co/",             // truncated TLD
      "http://example.com/",             // downgraded scheme
      "https://example.com:8443/",       // non-default port
      "https://user:pw@evil.com/example.com", // credentials-in-URL confusion
    ]) {
      expect(normalizeOrigin(attacker), attacker).not.toBe(target);
    }
  });

  it("refuses opaque and non-web schemes rather than letting them share one origin string", () => {
    // `URL.origin` answers the literal "null" for these. A stored "null" matching a live "null" would
    // be a credential that fills on every opaque page — so they get no origin at all.
    for (const input of ["about:blank", "data:text/html,<b>hi", "file:///etc/passwd", "javascript:alert(1)", "chrome://settings", ""]) {
      expect(normalizeOrigin(input), input).toBeNull();
    }
  });

  it("refuses anything that is not a parseable URL", () => {
    for (const input of ["example.com", "not a url", "https://", "   "]) {
      expect(normalizeOrigin(input), input).toBeNull();
    }
  });
});

describe("BROWSER_READ_ONLY_TOOLS", () => {
  it("pins its exact contents — an addition here weakens the broker gate AND Claude's own prompt", () => {
    expect([...BROWSER_READ_ONLY_TOOLS]).toEqual([
      "browser_list", "browser_snapshot", "browser_read", "browser_screenshot", "browser_credentials",
    ]);
  });

  it("contains no tool that can change a page, put a secret on one, or take a file off this Mac", () => {
    for (const mutating of [
      "browser_open", "browser_navigate", "browser_act", "browser_batch", "browser_fill_credential",
      "browser_download", "browser_upload", "browser_dismiss_dialog",
    ]) {
      expect(BROWSER_READ_ONLY_TOOLS).not.toContain(mutating);
    }
  });
});

describe("CREDENTIAL_PRESENCE_TTLS", () => {
  it("defaults to prompting every time, and offers nothing longer than five minutes", () => {
    expect(CREDENTIAL_PRESENCE_TTLS[0]).toBe(0);
    expect(Math.max(...CREDENTIAL_PRESENCE_TTLS)).toBeLessThanOrEqual(300_000);
  });
});


/**
 * `passkeyRpIdForPageUrl` is the passkey half of the same gate `normalizeOrigin` is for passwords,
 * and it is deliberately a DIFFERENT rule: WebAuthn scopes a credential to a registrable domain, so
 * `gist.github.com` using `github.com`'s passkey is the design working, while a password saved for
 * `https://github.com` filling on `gist.github.com` would be the hole.
 *
 * What it decides in Realm is which private keys get unsealed and which site a Touch ID prompt is
 * allowed to name, so its mutants are: the leading dot dropped from the suffix test, the claim
 * trusted when the page's own host disagrees, and a non-web page allowed to ask at all.
 */
describe("passkeyRpIdForPageUrl", () => {
  it("falls back to the page's own host when the page states no rp id, as the spec does", () => {
    expect(passkeyRpIdForPageUrl(null, "https://github.com/login")).toBe("github.com");
    expect(passkeyRpIdForPageUrl("", "https://github.com/login")).toBe("github.com");
  });

  it("lets a subdomain claim its parent — the case passkeys exist to serve", () => {
    expect(passkeyRpIdForPageUrl("github.com", "https://gist.github.com/x")).toBe("github.com");
    expect(passkeyRpIdForPageUrl("github.com", "https://github.com/x")).toBe("github.com");
  });

  it("requires the suffix to start at a label boundary (mutant: the leading dot dropped)", () => {
    // Without the dot, "notgithub.com".endsWith("github.com") is true, and a lookalike registered
    // this morning gets a Touch ID prompt naming github.com.
    expect(passkeyRpIdForPageUrl("github.com", "https://notgithub.com/login")).toBeNull();
    expect(passkeyRpIdForPageUrl("github.com", "https://github.com.evil.example/login")).toBeNull();
  });

  it("refuses a parent claiming a child, and an unrelated site entirely", () => {
    expect(passkeyRpIdForPageUrl("gist.github.com", "https://github.com/x")).toBeNull();
    expect(passkeyRpIdForPageUrl("github.com", "https://example.com/x")).toBeNull();
  });

  it("is case-insensitive about hosts, which DNS is", () => {
    expect(passkeyRpIdForPageUrl("GitHub.com", "https://GIST.GITHUB.COM/x")).toBe("github.com");
  });

  it("refuses pages a passkey has no business on", () => {
    expect(passkeyRpIdForPageUrl(null, "about:blank")).toBeNull();
    expect(passkeyRpIdForPageUrl(null, "file:///tmp/x.html")).toBeNull();
    expect(passkeyRpIdForPageUrl(null, "data:text/html,hi")).toBeNull();
    expect(passkeyRpIdForPageUrl(null, "not a url")).toBeNull();
    // A bare host with no dot is not a registrable domain — except the one everybody develops on.
    expect(passkeyRpIdForPageUrl(null, "https://intranet/login")).toBeNull();
    expect(passkeyRpIdForPageUrl(null, "http://localhost:3000/login")).toBe("localhost");
  });
});
