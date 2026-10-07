import { describe, expect, it } from "vitest";
import { approvedCsp, approvedSource, viewCsp } from "./csp";

const directives = (header: string) => Object.fromEntries(header.split("; ").map((d) => { const [name, ...rest] = d.split(" "); return [name, rest.join(" ")]; }));

describe("a declared domain", () => {
  it("is kept when it is a public https or wss origin, wildcard and port included", () => {
    expect(approvedSource("https://api.weather.com", ["https", "wss"])).toBe("https://api.weather.com");
    expect(approvedSource("wss://realtime.service.com", ["https", "wss"])).toBe("wss://realtime.service.com");
    expect(approvedSource("https://*.cloudflare.com", ["https"])).toBe("https://*.cloudflare.com");
    expect(approvedSource("https://cdn.example.com:8443/", ["https"])).toBe("https://cdn.example.com:8443");
    // No scheme reads as https — the scheme a CSP host-source would take from the view anyway.
    expect(approvedSource("CDN.jsdelivr.net", ["https"])).toBe("https://cdn.jsdelivr.net");
  });

  it("is dropped when it reaches this Mac or a private network", () => {
    // THE MUTANT: drop the private-name check, and a view can declare its way onto this Mac's own
    // listeners — Realm's RPC socket among them.
    for (const d of ["https://localhost", "https://localhost:8443", "https://a.localhost", "https://x.mcp-view.localhost", "https://printer.local",
      "https://db.internal", "https://router.lan", "https://nas.home.arpa", "https://127.0.0.1.nip.io", "https://app.lvh.me"]) {
      expect(approvedSource(d, ["https", "wss"]), d).toBeNull();
    }
    for (const d of ["https://127.0.0.1", "https://10.0.0.8", "https://192.168.1.1:443", "https://169.254.169.254", "https://[::1]", "https://[fd00::1]"]) {
      expect(approvedSource(d, ["https", "wss"]), d).toBeNull();
    }
  });

  it("is dropped when it is not a secure origin, or not an origin at all", () => {
    for (const d of ["http://api.example.com", "ws://rt.example.com", "ftp://files.example.com", "*", "https://*", "https://*.com", "intranet",
      "https://api.example.com/path", "https://user@api.example.com", "", 7, null]) {
      expect(approvedSource(d, ["https", "wss"]), String(d)).toBeNull();
    }
    expect(approvedSource("wss://rt.example.com", ["https"])).toBeNull();
  });

  it("cannot carry a directive of its own into the header", () => {
    // THE MUTANT: build the header from the declared strings as given, and this one adds a script
    // source of the server's choosing — the whole policy, rewritten from inside one field.
    const csp = approvedCsp({ connectDomains: ["https://ok.example.com", "https://evil.example; script-src *", "https://a.example.com,https://b.example.com", "https://q.example.com' 'unsafe-eval"] });
    expect(csp.connectDomains).toEqual(["https://ok.example.com"]);
    const header = viewCsp(csp, true);
    expect(header.split(";").length).toBe(11);
    expect(header).not.toContain("evil.example");
    expect(header).not.toContain("unsafe-eval");
    expect(directives(header)["script-src"]).toBe("'self' 'unsafe-inline'");
  });
});

describe("the header", () => {
  it("is the spec's restrictive default when the resource declared nothing", () => {
    expect(viewCsp(approvedCsp(undefined), false)).toBe(
      "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; "
      + "connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'");
  });

  it("puts each declared list where the spec maps it, and keeps 'self' out of connect-src", () => {
    const d = directives(viewCsp(approvedCsp({
      connectDomains: ["https://api.example.com"], resourceDomains: ["https://cdn.example.com"],
      frameDomains: ["https://www.youtube.com"], baseUriDomains: ["https://base.example.com"],
    }), true));
    expect(d["connect-src"]).toBe("https://api.example.com");
    for (const k of ["script-src", "style-src", "img-src", "font-src", "media-src"]) expect(d[k]).toContain("https://cdn.example.com");
    expect(d["frame-src"]).toBe("https://www.youtube.com");
    expect(d["base-uri"]).toBe("https://base.example.com");
    expect(d["object-src"]).toBe("'none'");
    expect(d["form-action"]).toBe("'none'");
    expect(d["default-src"]).toBe("'none'");
  });

  it("closes a list that declared nothing Realm kept, rather than leaving it to fall open", () => {
    const d = directives(viewCsp(approvedCsp({ connectDomains: ["http://127.0.0.1:9"], frameDomains: ["https://localhost"] }), true));
    expect(d["connect-src"]).toBe("'none'");
    expect(d["frame-src"]).toBe("'none'");
    expect(d["base-uri"]).toBe("'self'");
  });
});
