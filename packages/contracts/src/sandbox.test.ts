import { describe, expect, it } from "vitest";
import { E2B_STREAM_PORT, SANDBOX_NOTES, WEBSOCKIFY_PATH, describeEndpoint, e2bEndpoint, parseMachineAddress, providerOfHost } from "./sandbox";
import { VncEndpointSchema } from "./machine";

const ok = (input: string) => {
  const r = parseMachineAddress(input);
  if ("error" in r) throw new Error(`expected ${input} to parse, got: ${r.error}`);
  return r;
};

describe("what a person is likely to paste", () => {
  /**
   * E2B Desktop's own stream URL, verbatim from `getUrl()`.
   *
   * The trap, and the whole reason this function exists: that URL points at `vnc.html`, which is the
   * noVNC WEB APP. Following it hands the renderer's RFB client a lump of HTML, which produces "the
   * server's first bytes were not an RFB version line" — true, and impossible to act on. websockify
   * is on the same origin at its own path, and that is what to dial.
   */
  it("turns an E2B stream URL into the websockify beside it, not the page it points at", () => {
    const r = ok("https://6080-i7bx2k9qp.e2b.app/vnc.html?autoconnect=true&resize=scale");
    expect(r.endpoint).toEqual({ transport: "wss", host: "6080-i7bx2k9qp.e2b.app", port: 443, path: WEBSOCKIFY_PATH });
    expect(r.provider).toBe("e2b");
    expect(r.inferred).toContain("noVNC's own page");
  });

  it("builds an E2B endpoint from a bare sandbox id, on E2B's own port and host shape", () => {
    // `<port>-<sandboxId>.<domain>` is `getHost()` in the E2B core SDK; 6080 is `Stream`'s default.
    expect(e2bEndpoint("i7bx2k9qp")).toEqual({ transport: "wss", host: `${E2B_STREAM_PORT}-i7bx2k9qp.e2b.app`, port: 443, path: WEBSOCKIFY_PATH });
    expect(E2B_STREAM_PORT).toBe(6080);
  });

  /* Modal's `tls_socket` is a host and a port with TLS in front of it and nothing in the shape to
     say so. Dialled as plaintext it writes an RFB version line into a TLS handshake and gets
     silence — the failure that looks like the sandbox is broken. The host is the only tell. */
  it("dials a Modal tunnel over TLS, because its tls_socket is not plaintext", () => {
    const r = ok("nvzsyt1z.modal.host:44421");
    expect(r.endpoint).toMatchObject({ transport: "tls", host: "nvzsyt1z.modal.host", port: 44421 });
    expect(r.provider).toBe("modal");
    expect(r.inferred).toContain("not plaintext");
  });

  it("takes a Vercel Sandbox or Namespace HTTPS origin as a websockify target", () => {
    for (const [url, provider] of [
      ["https://my-sandbox-6080.vercel.run", "vercel"],
      ["https://abc123-6080.nscluster.cloud/", "namespace"],
    ] as const) {
      const r = ok(url);
      expect(r.endpoint, url).toMatchObject({ transport: "wss", port: 443, path: WEBSOCKIFY_PATH });
      expect(r.provider, url).toBe(provider);
    }
  });

  it("keeps a path the URL actually carried, rather than assuming websockify's", () => {
    // Somebody serving websockify under a prefix has said where it is, and overwriting that with a
    // default would be Realm knowing better than the person who set it up.
    const r = ok("wss://box.example.com/desktop/socket");
    expect(r.endpoint).toEqual({ transport: "wss", host: "box.example.com", port: 443, path: "/desktop/socket" });
    expect(r.inferred).toBeNull();
  });

  it("takes a plain host, a host and port, and an IPv6 literal", () => {
    expect(ok("studio.local").endpoint).toMatchObject({ transport: "tcp", host: "studio.local", port: 5900 });
    expect(ok("10.0.1.14:5901").endpoint).toMatchObject({ transport: "tcp", host: "10.0.1.14", port: 5901 });
    expect(ok("[2001:db8::1]:5900").endpoint).toMatchObject({ transport: "tcp", host: "2001:db8::1", port: 5900 });
  });

  it("defaults a WebSocket's port from its scheme rather than leaving it at VNC's", () => {
    // `wss://host` has a port — 443 — and dialling 5900 because that is RFB's default would reach
    // nothing at all. Explicit ports still win.
    expect(ok("wss://box.example.com/websockify").endpoint.port).toBe(443);
    expect(ok("ws://box.example.com/websockify").endpoint.port).toBe(80);
    expect(ok("wss://box.example.com:8443/websockify").endpoint.port).toBe(8443);
  });

  it("forgives what a paste actually looks like", () => {
    for (const messy of ['  https://6080-abc.e2b.app/vnc.html  ', '"10.0.1.14:5900"', "<studio.local>", "10.0.1.14:5900,"]) {
      expect(() => ok(messy), messy).not.toThrow();
    }
  });

  it("refuses what it cannot dial, and says what to paste instead", () => {
    for (const [input, contains] of [
      ["", "Paste an address"],
      ["ssh://box.example.com", "cannot connect over ssh:"],
      ["10.0.1.14:99999", "between 1 and 65535"],
      ["not a host at all", "not an address Realm recognises"],
    ] as const) {
      const r = parseMachineAddress(input);
      expect("error" in r, input).toBe(true);
      expect((r as { error: string }).error, input).toContain(contains);
    }
  });

  /* Every endpoint this produces has to survive the schema it will be stored and sent under. A
     parser that emitted a shape the contract rejects would fail at the RPC boundary, which is a long
     way from here and reads as the address being wrong. */
  it("only ever produces endpoints the contract accepts", () => {
    for (const input of ["https://6080-abc.e2b.app/vnc.html", "nvzsyt1z.modal.host:44421", "studio.local", "wss://x.example.com/s", "[::1]:5900"]) {
      expect(VncEndpointSchema.safeParse(ok(input).endpoint).success, input).toBe(true);
    }
  });
});

describe("which provider a host belongs to", () => {
  it("matches on the published domain and its subdomains, not on a substring", () => {
    expect(providerOfHost("6080-abc.e2b.app")).toBe("e2b");
    expect(providerOfHost("xyz.modal.host")).toBe("modal");
    expect(providerOfHost("abc.nscluster.cloud")).toBe("namespace");
    expect(providerOfHost("box.vercel.run")).toBe("vercel");
    // A host that merely CONTAINS a provider's name is not that provider — `e2b.app.evil.com` is
    // somebody else's, and treating it as E2B would apply E2B's assumptions to it.
    expect(providerOfHost("e2b.app.evil.com")).toBe("generic");
    expect(providerOfHost("notmodal.host.example.com")).toBe("generic");
    expect(providerOfHost("box.example.com")).toBe("generic");
  });

  it("calls this Mac's own neighbourhood screen sharing", () => {
    expect(providerOfHost("studio.local")).toBe("screen-sharing");
    expect(providerOfHost("127.0.0.1")).toBe("screen-sharing");
  });
});

describe("what the form tells you", () => {
  /* Every note names something the PERSON has to have done, because a URL that reaches a sandbox
     with no VNC server in it fails in a way that looks like Realm's fault. */
  it("gives every provider a sentence, and says nothing it cannot support", () => {
    for (const [provider, note] of Object.entries(SANDBOX_NOTES)) {
      expect(note.length, provider).toBeGreaterThan(20);
      expect(note, provider).toMatch(/[.]$/);
    }
    // The two that carry a LIMIT rather than a reassurance. Vercel's docs say nothing about
    // WebSocket upgrade through an exposed port, and Namespace's TCP ingress wants a client
    // certificate Realm cannot present — saying so beats a confident connect that dead-ends.
    expect(SANDBOX_NOTES.vercel).toContain("do not say");
    expect(SANDBOX_NOTES.namespace).toContain("client certificate");
  });

  it("reads an endpoint back the way it will be dialled", () => {
    expect(describeEndpoint({ transport: "tcp", host: "10.0.1.14", port: 5900, path: "/websockify" })).toBe("10.0.1.14:5900");
    expect(describeEndpoint({ transport: "tls", host: "x.modal.host", port: 44421, path: "/websockify" })).toBe("x.modal.host:44421 over TLS");
    // The port is left off where it is the scheme's own — `wss://host:443` is noise.
    expect(describeEndpoint({ transport: "wss", host: "6080-abc.e2b.app", port: 443, path: "/websockify" })).toBe("wss://6080-abc.e2b.app/websockify");
    expect(describeEndpoint({ transport: "wss", host: "box.example.com", port: 8443, path: "/s" })).toBe("wss://box.example.com:8443/s");
  });
});
