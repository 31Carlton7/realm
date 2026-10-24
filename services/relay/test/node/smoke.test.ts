/**
 * scripts/smoke.ts, run against the local relay: what it reports on a relay that works, on one with
 * no APNs key, and how it reads each answer APNs can give the made-up token.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { apnsVerdict, smoke } from "../../scripts/smoke";
import { startLocalRelay, type ApnsPush } from "../../src/node";

const SCRIPT = fileURLToPath(new URL("../../scripts/smoke.ts", import.meta.url));

const CHECKS = ["health", "routes", "forged answer", "Mac signs in", "pairing window", "paired phone signs in", "heartbeat", "APNs production", "Mac away and back", "Remove"];

describe("the deployed relay's smoke test", () => {
  it("passes every check on a relay that works, with APNs refusing only the made-up token", async () => {
    const pushes: ApnsPush[] = [];
    const relay = await startLocalRelay({ apns: { send: async (push) => { pushes.push(push); return { ok: false, status: 400, reason: "BadDeviceToken" }; } } });
    try {
      const checks = await smoke(relay.url, { timeoutMs: 3_000 });
      expect(checks.map((c) => [c.name, c.ok, c.ok ? "" : c.detail])).toEqual(CHECKS.map((name) => [name, true, ""]));
      // One push, to the environment a TestFlight build registers, and sealed: nothing readable in it.
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toMatchObject({ env: "production", urgent: false, collapse: null, badge: null });
      expect(pushes[0]!.token).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await relay.close();
    }
  });

  it("stops at APNs on a relay with no APNs key, and names the secrets to set", async () => {
    const relay = await startLocalRelay();
    try {
      const checks = await smoke(relay.url, { timeoutMs: 3_000 });
      const failed = checks.filter((c) => !c.ok);
      expect(failed.map((c) => c.name)).toEqual(["APNs production"]);
      expect(failed[0]!.detail).toMatch(/set APNS_KEY_ID and APNS_KEY_P8/);
      // Nothing after the failure runs: each check stands on the one before it.
      expect(checks.at(-1)!.name).toBe("APNs production");
    } finally {
      await relay.close();
    }
  });

  it("checks the sandbox when asked, and leaves APNs out entirely on --apns skip", async () => {
    const pushes: ApnsPush[] = [];
    const relay = await startLocalRelay({ apns: { send: async (push) => { pushes.push(push); return { ok: false, status: 400, reason: "BadDeviceToken" }; } } });
    try {
      expect((await smoke(relay.url, { apns: "sandbox", timeoutMs: 3_000 })).every((c) => c.ok)).toBe(true);
      expect(pushes.map((p) => p.env)).toEqual(["sandbox"]);
      const skipped = await smoke(relay.url, { apns: "skip", timeoutMs: 3_000 });
      expect(skipped.map((c) => c.name)).toEqual(CHECKS.filter((name) => !name.startsWith("APNs")));
      expect(skipped.every((c) => c.ok)).toBe(true);
      expect(pushes).toHaveLength(1);
    } finally {
      await relay.close();
    }
  });

  it("is the same Mac on every run, so a relay keeps one room for it, and a new one with fresh keys", async () => {
    const relay = await startLocalRelay();
    try {
      const macOf = async (fresh: boolean) => (await smoke(relay.url, { apns: "skip", fresh, timeoutMs: 3_000 })).find((c) => c.name === "Mac signs in")!.detail;
      const first = await macOf(false);
      expect(await macOf(false)).toBe(first);
      expect(await macOf(true)).not.toBe(first);
    } finally {
      await relay.close();
    }
  });

  it("runs as Node runs it, by stripping its types, and exits 0 only when every check passed", async () => {
    const relay = await startLocalRelay();
    const run = (...args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        child.on("exit", (code) => resolve({ code, out }));
      });
    try {
      const skipped = await run(relay.url, "--apns", "skip");
      expect(skipped.out).toContain("All 9 checks passed");
      expect(skipped.code).toBe(0);
      // This relay has no APNs key, so the default check of it fails the run.
      const unconfigured = await run(relay.url);
      expect(unconfigured.out).toContain('Failed at "APNs production"');
      expect(unconfigured.code).toBe(1);
      expect((await run("--apns", "everything")).code).toBe(2);
    } finally {
      await relay.close();
    }
  });

  it("refuses an address that is not a relay base", async () => {
    await expect(smoke("https://realm-relay.realm-relay.workers.dev")).rejects.toThrow(/not a relay base URL/);
    await expect(smoke("wss://relay.example/v1/mac")).rejects.toThrow(/not a relay base URL/);
  });

  it("reads APNs' answer to the made-up token as a verdict on the relay's APNs secrets", () => {
    expect(apnsVerdict({ ok: false, status: 400, reason: "BadDeviceToken" })).toMatchObject({ ok: true });
    expect(apnsVerdict({ ok: false, status: 0, reason: "apns-not-configured" }).detail).toMatch(/APNS_KEY_ID and APNS_KEY_P8/);
    expect(apnsVerdict({ ok: false, status: 0, reason: "apns-key-invalid" }).detail).toMatch(/APNS_KEY_P8 is not a \.p8/);
    expect(apnsVerdict({ ok: false, status: 403, reason: "InvalidProviderToken" }).detail).toMatch(/check APNS_KEY_ID, APNS_KEY_P8 and APNS_TEAM_ID/);
    expect(apnsVerdict({ ok: false, status: 400, reason: "DeviceTokenNotForTopic" }).detail).toMatch(/APNS_TOPIC/);
    // A token APNs accepted would mean the made-up token reached a phone: never a pass.
    expect(apnsVerdict({ ok: true, status: 200, reason: null })).toMatchObject({ ok: false });
  });
});
