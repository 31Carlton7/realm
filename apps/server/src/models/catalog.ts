import { MODEL_CATALOG_KEY, MODEL_CATALOG_TTL_MS, MODEL_CATALOG_URL, parseModelCatalog, type ModelInfo } from "@realm/contracts";
import type { SettingsStore } from "../store/settings";

/** What a cached catalog looks like in the `settings` row — the rows plus WHEN they were fetched,
 *  because "how stale is this" is the only question the TTL needs answered and a row with no
 *  timestamp would have to be refetched on every boot. */
type Cache = { fetchedAt: number; rows: ModelInfo[] };

/**
 * Prices, context windows and reasoning efforts for the model picker — fetched from a public catalog,
 * cached in `settings`, and NEVER load-bearing.
 *
 * The design rule that shapes everything here: **this service may not be able to fail a caller.** A
 * model picker that cannot open because a catalog fetch timed out would be a strictly worse picker
 * than the one Realm had before prices existed. So every path returns rows — the cache when it is
 * fresh, the stale cache when the network is gone, and `[]` when there has never been a cache. The
 * picker renders a row without a price perfectly well; that is why `ModelInfo` fields are nullable.
 *
 * Refresh is lazy and single-flight: the first `list()` past the TTL starts one fetch, every caller
 * during it awaits that same promise, and a failure is swallowed after being recorded on `lastError`
 * (which the picker never shows — it is for a developer reading a log, not a user choosing a model).
 *
 * No API key, no user data, one GET. The catalog is public (verified live 2026-09-03), and Realm
 * sends nothing about the user with it — not the model they are on, not their prompt, nothing.
 */
export class ModelCatalogService {
  private inflight: Promise<ModelInfo[]> | null = null;
  /** The last refresh failure, for logs and tests. Never rendered: a user choosing a model does not
   *  need to hear that a price fetch 404'd, they need the list to open. */
  lastError: string | null = null;

  constructor(private readonly deps: {
    settings: SettingsStore;
    /** Injected so tests never touch the network — and so a live check CAN. */
    fetchImpl?: typeof fetch;
    /** Overridable for tests that need to force staleness without waiting a day. */
    ttlMs?: number;
    now?: () => number;
  }) {}

  /**
   * Every model the catalog knows, refreshing first if the cache is older than the TTL.
   *
   * `force` is the "Check again" path: it refetches even on a fresh cache, and — unlike the lazy
   * path — it still returns the old rows if that refetch fails, because the alternative is a picker
   * that loses its prices as a punishment for the user asking to update them.
   */
  async list({ force = false }: { force?: boolean } = {}): Promise<ModelInfo[]> {
    const cache = this.read();
    const now = (this.deps.now ?? Date.now)();
    const ttl = this.deps.ttlMs ?? MODEL_CATALOG_TTL_MS;
    if (cache && !force && now - cache.fetchedAt < ttl) return cache.rows;
    const rows = await this.refresh();
    return rows ?? cache?.rows ?? [];
  }

  /** The cached rows with no network at all — what a caller uses when it must answer synchronously
   *  and would rather say nothing than wait. */
  cached(): ModelInfo[] {
    return this.read()?.rows ?? [];
  }

  /** One fetch at a time, whoever asks. Returns null on any failure — the caller decides whether to
   *  fall back to a stale cache or to nothing, because those are different situations. */
  private refresh(): Promise<ModelInfo[] | null> {
    if (this.inflight) return this.inflight.then((r) => r, () => null);
    const run = (async () => {
      const f = this.deps.fetchImpl ?? fetch;
      // A picker's price is worth a few seconds and not a minute: whatever the catalog is doing, the
      // user is waiting on a popover. AbortSignal.timeout rather than a race, so the socket closes.
      const res = await f(MODEL_CATALOG_URL, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`catalog ${res.status}`);
      const rows = parseModelCatalog(await res.json());
      // An empty parse is a FAILURE, not an answer: the catalog has hundreds of models, so zero means
      // the shape changed under us, and writing that over a good cache would silently erase prices.
      if (rows.length === 0) throw new Error("catalog parsed to no rows");
      this.deps.settings.set(MODEL_CATALOG_KEY, { fetchedAt: (this.deps.now ?? Date.now)(), rows } satisfies Cache);
      this.lastError = null;
      return rows;
    })();
    this.inflight = run;
    return run
      .catch((e: unknown) => { this.lastError = e instanceof Error ? e.message : String(e); return null; })
      .finally(() => { this.inflight = null; });
  }

  /** The cached row, validated. A settings row is user-editable JSON, so anything that is not the
   *  shape this service wrote reads as "no cache" rather than crashing the picker. */
  private read(): Cache | null {
    const raw = this.deps.settings.get(MODEL_CATALOG_KEY);
    if (!raw || typeof raw !== "object") return null;
    const c = raw as Partial<Cache>;
    if (typeof c.fetchedAt !== "number" || !Array.isArray(c.rows)) return null;
    return { fetchedAt: c.fetchedAt, rows: c.rows.filter((r): r is ModelInfo => !!r && typeof (r as ModelInfo).key === "string") };
  }
}
