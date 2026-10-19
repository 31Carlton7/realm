/**
 * createApnsSender on its own: which host it picks, how it signs and caches its token, and that
 * every failure comes back as a result. The request's exact headers and body are checked end to end,
 * against a fake APNs, by the contract suite.
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApnsSender, type ApnsPush } from "../../src/apns";
import { fromB64u } from "../shared/devices";

const keyP8 = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const config = { teamId: "FY9QB79VAP", keyId: "KEY1234567", keyP8, topic: "co.charmtechnologies.realm.ios" };
const push: ApnsPush = { token: "ab".repeat(32), env: "sandbox", macId: "AAAAAAAAAAAAAAAAAAAAAA", blob: "AAAA", urgent: true, collapse: null, badge: null };

/** A fetch that records each request and answers with `respond`. */
function recorder(respond: () => Response | Promise<Response> = () => new Response(null, { status: 200 })) {
  const requests: Array<{ url: string; authorization: string }> = [];
  const fetch = (async (url: string, init: { headers: Record<string, string> }) => {
    requests.push({ url, authorization: init.headers.authorization ?? "" });
    return respond();
  }) as unknown as typeof globalThis.fetch;
  return { requests, fetch };
}

const claimsOf = (authorization: string): { iss: string; iat: number } =>
  JSON.parse(new TextDecoder().decode(fromB64u(authorization.split(".")[1]!)));

describe("createApnsSender", () => {
  it("posts to the sandbox host or the production host by the phone's environment", async () => {
    const { requests, fetch } = recorder();
    const apns = createApnsSender({ ...config, fetch });
    expect(await apns.send(push)).toEqual({ ok: true, status: 200, reason: null });
    await apns.send({ ...push, env: "production" });
    expect(requests.map((r) => r.url)).toEqual([
      `https://api.sandbox.push.apple.com/3/device/${push.token}`,
      `https://api.push.apple.com/3/device/${push.token}`,
    ]);
  });

  it("sends every request to the override origin when one is set", async () => {
    const { requests, fetch } = recorder();
    await createApnsSender({ ...config, origin: "http://127.0.0.1:9", fetch }).send({ ...push, env: "production" });
    expect(requests[0]!.url).toBe(`http://127.0.0.1:9/3/device/${push.token}`);
  });

  for (const missing of ["teamId", "keyId", "keyP8", "topic"] as const) {
    it(`answers apns-not-configured without ${missing}, and sends nothing`, async () => {
      const { requests, fetch } = recorder();
      expect(await createApnsSender({ ...config, [missing]: undefined, fetch }).send(push)).toEqual({ ok: false, status: 0, reason: "apns-not-configured" });
      expect(requests).toEqual([]);
    });
  }

  it("answers apns-key-invalid for a key it cannot import, rather than throwing", async () => {
    const { requests, fetch } = recorder();
    const apns = createApnsSender({ ...config, keyP8: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----", fetch });
    expect(await apns.send(push)).toEqual({ ok: false, status: 0, reason: "apns-key-invalid" });
    expect(requests).toEqual([]);
  });

  it("accepts a .p8 whose newlines arrived escaped, as a pasted secret's often do", async () => {
    const { fetch } = recorder();
    expect(await createApnsSender({ ...config, keyP8: keyP8.replace(/\n/g, "\\n"), fetch }).send(push)).toMatchObject({ ok: true });
  });

  it("signs a token with iat in seconds and reuses it for 50 minutes", async () => {
    let now = 1_800_000_000_000;
    const { requests, fetch } = recorder();
    const apns = createApnsSender({ ...config, fetch, now: () => now });
    await apns.send(push);
    now += 50 * 60_000 - 1;
    await apns.send(push);
    now += 1;
    await apns.send(push);
    const [first, reused, fresh] = requests.map((r) => r.authorization);
    expect(reused).toBe(first);
    expect(fresh).not.toBe(first);
    expect(claimsOf(first!)).toEqual({ iss: config.teamId, iat: 1_800_000_000 });
    expect(claimsOf(fresh!)).toEqual({ iss: config.teamId, iat: 1_800_000_000 + 50 * 60 });
  });

  it("shares one token among pushes that race", async () => {
    const { requests, fetch } = recorder();
    const apns = createApnsSender({ ...config, fetch });
    await Promise.all([apns.send(push), apns.send(push), apns.send(push)]);
    expect(new Set(requests.map((r) => r.authorization)).size).toBe(1);
  });

  it("answers apns-unreachable when the request itself fails", async () => {
    const { fetch } = recorder(() => {
      throw new TypeError("fetch failed");
    });
    expect(await createApnsSender({ ...config, fetch }).send(push)).toEqual({ ok: false, status: 0, reason: "apns-unreachable" });
  });

  it("reports APNs's status, with its reason when it gives one", async () => {
    const refused = recorder(() => Response.json({ reason: "BadDeviceToken" }, { status: 400 }));
    expect(await createApnsSender({ ...config, fetch: refused.fetch }).send(push)).toEqual({ ok: false, status: 400, reason: "BadDeviceToken" });
    const garbled = recorder(() => new Response("<html>", { status: 502 }));
    expect(await createApnsSender({ ...config, fetch: garbled.fetch }).send(push)).toEqual({ ok: false, status: 502, reason: null });
  });
});
