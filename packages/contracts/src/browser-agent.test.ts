import { describe, expect, it } from "vitest";
import {
  BROWSER_READ_ONLY_TOOLS, CREDENTIAL_PRESENCE_TTLS, DOWNLOAD_ALLOWED_EXTENSIONS,
  downloadExtensionAllowed, normalizeOrigin,
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

  it("contains no tool that can change a page or put a secret on one", () => {
    for (const mutating of ["browser_open", "browser_navigate", "browser_act", "browser_batch", "browser_fill_credential"]) {
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
 * The download allowlist. Its whole job is to bound what "an agent reads the web" can turn into, so
 * the test that matters is not "does .pdf pass" but "does anything that executes on double-click
 * get in" — including through the name tricks that make a denylist useless.
 */
describe("downloadExtensionAllowed", () => {
  it("permits the document, archive and media types the feature exists for", () => {
    for (const name of ["lecture.pdf", "notes.DOCX", "slides.pptx", "data.csv", "readme.md", "bundle.zip", "figure.png", "recording.mp4"]) {
      expect(downloadExtensionAllowed(name), name).toBe(true);
    }
  });

  it("refuses everything that executes on double-click, named or not", () => {
    for (const name of [
      "setup.dmg", "install.pkg", "app.exe", "x.msi", "run.command", "s.sh", "s.bash", "s.zsh",
      "a.scpt", "a.applescript", "t.terminal", "w.workflow", "l.webloc", "j.jar", "p.ps1", "b.bat",
      "app.app", "k.kext", "d.dylib", "s.so",
    ]) {
      expect(downloadExtensionAllowed(name), name).toBe(false);
    }
  });

  it("reads the FINAL extension — the trick a denylist gets wrong", () => {
    expect(downloadExtensionAllowed("safe.command.pdf")).toBe(true);
    expect(downloadExtensionAllowed("lecture.pdf.command")).toBe(false);
    expect(downloadExtensionAllowed("a.b.c.d.dmg")).toBe(false);
  });

  it("refuses a name with no usable extension at all", () => {
    for (const name of ["README", "", "   ", ".", "..", ".bashrc", "trailing.", "no-extension-here"]) {
      expect(downloadExtensionAllowed(name), JSON.stringify(name)).toBe(false);
    }
  });

  it("is an ALLOWLIST, not a denylist — an extension nobody enumerated is refused", () => {
    // The property that makes this safe as the format landscape changes: unknown means no.
    for (const name of ["x.someformatinventedin2029", "y.zzz", "z.øµ"]) {
      expect(downloadExtensionAllowed(name), name).toBe(false);
    }
  });

  it("the list itself contains nothing executable (guards a careless addition)", () => {
    const executable = ["exe", "dmg", "pkg", "app", "command", "sh", "bash", "zsh", "bat", "ps1", "msi", "jar", "scpt", "applescript", "workflow", "webloc", "terminal", "kext", "dylib", "so", "py", "rb", "pl"];
    for (const bad of executable) expect(DOWNLOAD_ALLOWED_EXTENSIONS, bad).not.toContain(bad);
  });
});
