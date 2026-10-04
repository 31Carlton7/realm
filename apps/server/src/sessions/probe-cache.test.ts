import { describe, expect, it } from "vitest";
import type { ProbeResult } from "@realm/adapters";
import { ProbeCache } from "./probe-cache";

/** A scripted prober: counts passes and answers whatever `answer` currently holds. */
function prober(answer: () => string) {
  let passes = 0;
  let release: (() => void) | null = null;
  const gate = { hold: false };
  const run = async (): Promise<ProbeResult[]> => {
    passes++;
    // Snapshotted at pass time, like a real probe: what the machine looked like when it LOOKED, not
    // when its promise happened to settle. That distinction is the whole point of forcing.
    const version = answer();
    if (gate.hold) await new Promise<void>((r) => { release = r; });
    return [{ kind: "claude", available: true, version, loggedIn: null, reason: null }];
  };
  return { run, gate, get passes() { return passes; }, let: () => { release?.(); release = null; } };
}

describe("ProbeCache", () => {
  it("serves repeat gets from one pass while the TTL holds", async () => {
    let now = 1000;
    const p = prober(() => "v1");
    const c = new ProbeCache(p.run, { ttlMs: 30_000, now: () => now });
    expect((await c.get())[0]!.version).toBe("v1");
    now += 29_999;
    expect((await c.get())[0]!.version).toBe("v1");
    expect(p.passes).toBe(1);
  });

  it("re-probes once the TTL expires — a cache that never invalidates is a cache that lies", async () => {
    let now = 1000;
    let version = "v1";
    const p = prober(() => version);
    const c = new ProbeCache(p.run, { ttlMs: 30_000, now: () => now });
    await c.get();
    version = "v2";
    now += 30_000; // exactly at the boundary: no longer "< ttl"
    expect((await c.get())[0]!.version).toBe("v2");
    expect(p.passes).toBe(2);
  });

  it("dedups concurrent gets into a single pass", async () => {
    const p = prober(() => "v1");
    p.gate.hold = true;
    const c = new ProbeCache(p.run, { now: () => 0 });
    const all = Promise.all([c.get(), c.get(), c.get()]);
    await Promise.resolve();
    p.let();
    const [a, b, d] = await all;
    expect(p.passes).toBe(1);
    expect(a).toBe(b); expect(b).toBe(d); // literally the same array — one probe, shared
  });

  it("force skips a warm cache and refills it for everyone behind it", async () => {
    let version = "missing";
    const p = prober(() => version);
    const c = new ProbeCache(p.run, { ttlMs: 30_000, now: () => 1000 });
    await c.get();
    version = "installed";
    expect((await c.get())[0]!.version).toBe("missing"); // still cached, as it should be
    expect((await c.get({ force: true }))[0]!.version).toBe("installed");
    expect(p.passes).toBe(2);
    // The refill means the cheap callers (prompter mounts) see the new truth without forcing.
    expect((await c.get())[0]!.version).toBe("installed");
    expect(p.passes).toBe(2);
  });

  it("a forced get never joins an UNFORCED probe already in flight", async () => {
    // That probe may have read the filesystem before the installer finished — exactly the stale answer
    // the force exists to escape. Two probes here is the correct number.
    let version = "missing";
    const p = prober(() => version);
    p.gate.hold = true;
    const c = new ProbeCache(p.run, { now: () => 0 });
    const cheap = c.get();
    await Promise.resolve();
    version = "installed";
    p.gate.hold = false;
    const forced = c.get({ force: true });
    p.let(); // release the first (held) probe
    expect((await cheap)[0]!.version).toBe("missing");
    expect((await forced)[0]!.version).toBe("installed");
    expect(p.passes).toBe(2);
    // …and the late-landing stale probe must not have overwritten the forced result.
    expect((await c.get())[0]!.version).toBe("installed");
    expect(p.passes).toBe(2);
  });

  it("amend rewrites the cached answer without making it any younger", async () => {
    // One agent probed on its own is fresh; the rest of the rows are as old as they were.
    let now = 0;
    const p = prober(() => "v1");
    const c = new ProbeCache(p.run, { ttlMs: 30_000, now: () => now });
    await c.get();
    now = 29_999;
    c.amend((rows) => rows.map((r) => ({ ...r, loggedIn: true })));
    expect((await c.get())[0]!.loggedIn).toBe(true);
    expect(p.passes).toBe(1);
    now = 30_000;
    await c.get();
    expect(p.passes).toBe(2);
  });

  it("a probe out when something is amended lands with it, rather than over it", async () => {
    // The sign-in that just finished, against the window-focus probe that looked a moment before:
    // landing late, that probe would put "not signed in" back in the cache for every caller.
    const p = prober(() => "v1");
    p.gate.hold = true;
    const c = new ProbeCache(p.run, { now: () => 0 });
    const out = c.get({ force: true });
    await Promise.resolve();
    c.amend((rows) => rows.map((r) => ({ ...r, loggedIn: true })));
    p.let();
    expect((await out)[0]).toMatchObject({ version: "v1", loggedIn: true });
    expect((await c.get())[0]!.loggedIn).toBe(true);
  });

  it("a probe that started after an amendment answers with what it saw itself", async () => {
    // It looked after the amendment was learned, so its own reading is the newer one.
    let version = "v1";
    const p = prober(() => version);
    p.gate.hold = true;
    const c = new ProbeCache(p.run, { now: () => 0 });
    const first = c.get();
    await Promise.resolve();
    c.amend((rows) => rows.map((r) => ({ ...r, version: "amended" })));
    version = "v2";
    p.gate.hold = false;
    expect((await c.get({ force: true }))[0]!.version).toBe("v2");
    p.let();
    // …while the one that was already out when it was learned still lands with it.
    expect((await first)[0]!.version).toBe("amended");
  });

  it("two forced gets in flight share one pass — a double-click is one question", async () => {
    const p = prober(() => "v1");
    p.gate.hold = true;
    const c = new ProbeCache(p.run, { now: () => 0 });
    const both = Promise.all([c.get({ force: true }), c.get({ force: true })]);
    await Promise.resolve();
    p.let();
    await both;
    expect(p.passes).toBe(1);
  });
});
