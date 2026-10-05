import type { ProbeResult } from "@realm/adapters";

/** How long a probe result is reused before the adapters are asked again. */
export const PROBE_TTL_MS = 30_000;

/**
 * TTL cache + in-flight dedup around `SessionService.probeAll()` — same shape as `GitInfoService`, for the
 * same reason: probing spawns one child process per registered agent (each with a 5s timeout), and the
 * renderer asks on every prompter mount, every install card, and every onboarding sheet.
 *
 * `get({ force: true })` is the escape hatch the install card's "Check again" (and its window-focus
 * refresh) uses: the user just ran an installer, so a cached "not installed" is exactly the wrong answer.
 * A forced call also refills the cache, so the cheap callers behind it see the new truth.
 *
 * A forced call never joins an unforced probe already in flight — that probe may have read the filesystem
 * *before* the installer finished, which is the one answer the force was asking to escape. It joins another
 * forced probe (a double-click is one question), and unforced calls join anything in flight.
 *
 * Generic in what a probe answers with (defaulting to this file's original `ProbeResult[]`) so a
 * second probe — GraphifyService's — gets the same force/TTL/dedup semantics without a second copy
 * of this reasoning to keep in sync.
 */
export class ProbeCache<T = ProbeResult[]> {
  private cached: { at: number; value: T } | null = null;
  private inflight: { forced: boolean; p: Promise<T> } | null = null;
  /** Probes out right now, tracked or not — an older unforced one still answers its own joiners. */
  private out = 0;
  private seq = 0;
  /** What `amend` learned while a probe was out, numbered so each probe re-applies only what was
   *  learned after it started looking. Dropped once nothing is out to need it. */
  private amendments: { seq: number; fn: (value: T) => T }[] = [];
  private ttlMs: number;
  private now: () => number;
  constructor(private compute: () => Promise<T>, opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? PROBE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  async get({ force = false }: { force?: boolean } = {}): Promise<T> {
    if (!force && this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.value;
    const pending = this.inflight;
    if (pending && (!force || pending.forced)) return pending.p;
    const from = this.seq;
    this.out++;
    const p = this.compute().then((raw) => {
      // It read the machine before anything amended since, so those still stand over what it saw.
      const value = this.amendments.filter((a) => a.seq > from).reduce((v, a) => a.fn(v), raw);
      // Only the newest probe owns the cache: an older unforced one landing late must not overwrite
      // a forced result with the stale truth the force was escaping.
      if (this.inflight?.p === p) this.cached = { at: this.now(), value };
      return value;
    }).finally(() => {
      if (this.inflight?.p === p) this.inflight = null;
      if (--this.out === 0) this.amendments = [];
    });
    this.inflight = { forced: force, p };
    return p;
  }

  /** The last answer, however old, without starting a probe — or null when there has never been
   *  one. For a caller inside somebody else's wait (a tool call) that would rather read what the
   *  picker last saw than spend a probe of every agent finding out again. */
  peek(): { value: T; fresh: boolean } | null {
    return this.cached ? { value: this.cached.value, fresh: this.now() - this.cached.at < this.ttlMs } : null;
  }

  /**
   * Rewrite part of the answer with something learned more recently than the rest — one agent probed
   * on its own, say, the moment its sign-in finished. The cached value takes it without its age
   * changing (one fresh row does not make the others fresh), and so does whatever a probe still out
   * lands with: that probe looked before this was known, and landing late must not undo it.
   */
  amend(fn: (value: T) => T): void {
    if (this.cached) this.cached = { at: this.cached.at, value: fn(this.cached.value) };
    if (this.out > 0) this.amendments.push({ seq: ++this.seq, fn });
  }
}
