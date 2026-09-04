import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_CATALOG_KEY, MODEL_CATALOG_URL } from "@realm/contracts";
import { openDatabase } from "../db/database";
import { SettingsStore } from "../store/settings";
import { ModelCatalogService } from "./catalog";

/** One row in the live catalog's shape — enough for the parser, which has its own fixture tests. */
const body = (name = "Anthropic: Claude Opus 5", completion = "0.000025") => ({
  data: [{ id: "anthropic/claude-opus-5", name, context_length: 1_000_000,
    architecture: { output_modalities: ["text"] }, pricing: { prompt: "0.000005", completion } }],
});

function harness(fetchImpl: typeof fetch, now = () => 1000) {
  const home = mkdtempSync(join(tmpdir(), "realm-catalog-"));
  const settings = new SettingsStore(openDatabase(join(home, "realm.db")));
  return { settings, service: new ModelCatalogService({ settings, fetchImpl, now, ttlMs: 100 }) };
}

const ok = (json: unknown) => vi.fn(async () => new Response(JSON.stringify(json), { status: 200 })) as unknown as typeof fetch;

describe("ModelCatalogService", () => {
  it("fetches the public catalog once and caches it in settings", async () => {
    const f = ok(body());
    const { service, settings } = harness(f);
    expect((await service.list()).map((r) => r.label)).toEqual(["Claude Opus 5"]);
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(MODEL_CATALOG_URL);
    // Cached under a plain settings key, with the time it was taken — the only thing the TTL needs.
    const cached = settings.get(MODEL_CATALOG_KEY) as { fetchedAt: number; rows: unknown[] };
    expect(cached.fetchedAt).toBe(1000);
    expect(cached.rows).toHaveLength(1);
    await service.list();
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1); // fresh cache, no second GET
  });

  it("refetches once the cache is older than the TTL, and on force before that", async () => {
    let clock = 1000;
    const f = ok(body());
    const { settings } = harness(f, () => clock);
    const service = new ModelCatalogService({ settings, fetchImpl: f, now: () => clock, ttlMs: 100 });
    await service.list();
    clock = 1050;
    await service.list();
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1); // still fresh
    await service.list({ force: true });
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2); // "check again"
    clock = 1200;
    await service.list();
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3); // past the TTL
  });

  it("serves the stale cache when the network is gone, rather than losing every price", async () => {
    let clock = 1000;
    const good = ok(body());
    const { settings } = harness(good, () => clock);
    await new ModelCatalogService({ settings, fetchImpl: good, now: () => clock, ttlMs: 100 }).list();
    clock = 5000;
    const dead = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const offline = new ModelCatalogService({ settings, fetchImpl: dead, now: () => clock, ttlMs: 100 });
    expect((await offline.list()).map((r) => r.label)).toEqual(["Claude Opus 5"]);
    expect(offline.lastError).toBe("offline");
  });

  it("answers with nothing rather than failing when there is no cache at all", async () => {
    const dead = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const { service } = harness(dead);
    // The picker must open on a dead network; it renders rows without prices.
    await expect(service.list()).resolves.toEqual([]);
    expect(service.cached()).toEqual([]);
  });

  it("refuses to overwrite a good cache with an empty parse or an error status", async () => {
    let clock = 1000;
    const good = ok(body());
    const { settings } = harness(good, () => clock);
    await new ModelCatalogService({ settings, fetchImpl: good, now: () => clock, ttlMs: 100 }).list();
    clock = 5000;
    // A catalog with hundreds of models answering with none means the SHAPE changed, not that every
    // model was retired — writing that through would silently erase every price in the picker.
    const empty = ok({ data: [] });
    const s1 = new ModelCatalogService({ settings, fetchImpl: empty, now: () => clock, ttlMs: 100 });
    expect((await s1.list()).map((r) => r.label)).toEqual(["Claude Opus 5"]);
    const failing = vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const s2 = new ModelCatalogService({ settings, fetchImpl: failing, now: () => clock, ttlMs: 100 });
    expect((await s2.list()).map((r) => r.label)).toEqual(["Claude Opus 5"]);
    expect(s2.lastError).toBe("catalog 503");
  });

  it("collapses concurrent refreshes into one request", async () => {
    // Four panes mounting in one tick is the ordinary case, not a stress test.
    const f = ok(body());
    const { service } = harness(f);
    await Promise.all([service.list(), service.list(), service.list(), service.list()]);
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("treats a settings row that is not a cache as no cache", async () => {
    const f = ok(body());
    const { service, settings } = harness(f);
    settings.set(MODEL_CATALOG_KEY, "hand-edited nonsense");
    expect(service.cached()).toEqual([]);
    await expect(service.list()).resolves.toHaveLength(1); // and it just refetches
  });
});
