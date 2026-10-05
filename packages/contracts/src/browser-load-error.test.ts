import { describe, expect, it } from "vitest";
import { describeLoadError, isLoopbackHost, loadErrorLine, type BrowserLoadError } from "./browser-load-error";

const err = (name: string, code: number, url: string): BrowserLoadError => ({ code, name, url });

describe("describeLoadError", () => {
  it("says what the owner expected for a dev server that is not running", () => {
    const page = describeLoadError(err("ERR_CONNECTION_REFUSED", -102, "http://localhost:3000/"));
    expect(page.title).toBe("This site can't be reached");
    expect(page.reason).toBe("localhost refused to connect.");
    expect(page.mark).toBe("reach");
    // On this Mac the useful suggestion is the server, on the port that was asked for.
    expect(page.tips[0]).toBe("Checking that a server is running on port 3000");
  });

  it("suggests the network, not a dev server, for a site somewhere else", () => {
    const page = describeLoadError(err("ERR_CONNECTION_REFUSED", -102, "https://example.com/docs"));
    expect(page.reason).toBe("example.com refused to connect.");
    expect(page.tips).toEqual(["Checking the connection", "Checking the proxy and the firewall"]);
  });

  it("names the scheme's own port when the address gives none", () => {
    expect(describeLoadError(err("ERR_CONNECTION_REFUSED", -102, "http://127.0.0.1/")).tips[0]).toContain("port 80");
    expect(describeLoadError(err("ERR_CONNECTION_TIMED_OUT", -118, "https://localhost/")).tips[0]).toContain("port 443");
  });

  it("covers each of the common failures with its own reason", () => {
    const reasons = {
      unresolved: describeLoadError(err("ERR_NAME_NOT_RESOLVED", -105, "http://realm-live-check.invalid/")).reason,
      timedOut: describeLoadError(err("ERR_CONNECTION_TIMED_OUT", -118, "https://example.com/")).reason,
      offline: describeLoadError(err("ERR_INTERNET_DISCONNECTED", -106, "https://example.com/")).reason,
      reset: describeLoadError(err("ERR_CONNECTION_RESET", -101, "http://127.0.0.1:8895/")).reason,
      unsafePort: describeLoadError(err("ERR_UNSAFE_PORT", -312, "http://localhost:6000/")).reason,
    };
    expect(reasons).toEqual({
      unresolved: "realm-live-check.invalid's address couldn't be found.",
      timedOut: "example.com took too long to respond.",
      offline: "This Mac isn't connected to the internet.",
      reset: "The connection to 127.0.0.1 was reset.",
      unsafePort: "Port 6000 is reserved for another kind of service, so Realm won't open it.",
    });
    expect(describeLoadError(err("ERR_INTERNET_DISCONNECTED", -106, "https://example.com/")).title).toBe("No internet connection");
  });

  it("gives a certificate failure the padlock and a page with no way past it", () => {
    const page = describeLoadError(err("ERR_CERT_AUTHORITY_INVALID", -202, "https://127.0.0.1:8893/"));
    expect(page.mark).toBe("lock");
    expect(page.title).toBe("Your connection isn't private");
    expect(page.reason).toBe("The certificate 127.0.0.1 sent isn't from an authority this Mac trusts.");
    expect(page.note).toMatch(/won't open it/);
    // Nothing in the copy offers to carry on anyway.
    expect([page.reason, page.note, ...page.tips].join(" ")).not.toMatch(/proceed|continue|anyway|unsafe/i);
  });

  it("knows a certificate failure by its range as well as by its name", () => {
    // A code from the certificate block whose name this table has never heard of is still one.
    expect(describeLoadError(err("ERR_CERT_SOMETHING_NEW", -219, "https://example.com/")).mark).toBe("lock");
    expect(describeLoadError(err("", -209, "https://example.com/")).title).toBe("Your connection isn't private");
  });

  it("points a TLS failure on this Mac at plain http, which is what a dev server usually speaks", () => {
    const page = describeLoadError(err("ERR_SSL_PROTOCOL_ERROR", -107, "https://127.0.0.1:8896/"));
    expect(page.title).toBe("This site can't provide a secure connection");
    expect(page.tips).toEqual(["Using http:// if the server doesn't speak HTTPS"]);
  });

  it("falls back to a plain sentence for a failure it has no words for", () => {
    const page = describeLoadError(err("ERR_SOMETHING_ELSE", -999, "https://example.com/a"));
    expect(page).toMatchObject({ mark: "reach", title: "This site can't be reached", reason: "The page at example.com didn't load." });
  });

  it("survives an address that does not parse", () => {
    expect(describeLoadError(err("ERR_CONNECTION_REFUSED", -102, "not a url")).reason).toBe("not a url refused to connect.");
  });
});

describe("isLoopbackHost", () => {
  it("is this Mac by every name a dev server answers to", () => {
    for (const h of ["localhost", "LOCALHOST", "app.localhost", "127.0.0.1", "127.1.2.3", "[::1]", "::1"]) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ["example.com", "localhost.example.com", "10.0.0.1", "128.0.0.1", "192.168.1.2"]) expect(isLoopbackHost(h), h).toBe(false);
  });
});

describe("loadErrorLine", () => {
  it("is the page's title, its reason and the code, in one line for an agent", () => {
    expect(loadErrorLine(err("ERR_CONNECTION_REFUSED", -102, "http://localhost:3000/")))
      .toBe("This site can't be reached: localhost refused to connect. (ERR_CONNECTION_REFUSED)");
  });
});
