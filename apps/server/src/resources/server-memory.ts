import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeHeapSnapshot } from "node:v8";
import { durationWords, gb } from "./words";

/**
 * realm-server's own memory over time. The server once reached 1.6 GB and restarted before anyone
 * could say what grew, and `server.log` had nothing to look back on. So every few minutes it reads
 * `process.memoryUsage()` — a few microseconds — writes one line to the log, keeps the last day of
 * readings for `machine_status`, and says so once when rss climbs a step. Past `SNAPSHOT_RSS_BYTES`
 * it writes a heap snapshot to `~/Realm/logs`, at most once a day, so the leak itself can be found.
 */

export const SAMPLE_EVERY_MS = 5 * 60_000;
/** A day of readings. */
export const SAMPLES_KEPT = 288;
/** How far rss climbs above its low before the log says so; once, until it climbs as far again. */
export const RISE_LOG_BYTES = 256 * 1024 ** 2;
export const SNAPSHOT_RSS_BYTES = 1024 ** 3;
export const SNAPSHOT_EVERY_MS = 24 * 3_600_000;
const SNAPSHOT_SUFFIX = ".heapsnapshot";

export type MemorySample = { at: number } & Pick<NodeJS.MemoryUsage, "rss" | "heapUsed" | "heapTotal" | "external" | "arrayBuffers">;
export interface MemoryGrowth { fromBytes: number; toBytes: number; changeBytes: number; peakBytes: number; overMs: number }
export interface ServerMemoryStatus { now: MemorySample; growth: MemoryGrowth | null }

/** rss from the oldest sample kept to `now`, and the highest it reached between. */
export function growth(samples: readonly MemorySample[], now: MemorySample): MemoryGrowth | null {
  const first = samples[0];
  if (!first) return null;
  return {
    fromBytes: first.rss, toBytes: now.rss, changeBytes: now.rss - first.rss,
    peakBytes: Math.max(now.rss, ...samples.map((s) => s.rss)),
    overMs: now.at - first.at,
  };
}

export const describeSample = (s: MemorySample): string =>
  `rss ${gb(s.rss)} · heap ${gb(s.heapUsed)} of ${gb(s.heapTotal)} · external ${gb(s.external)} · array buffers ${gb(s.arrayBuffers)}`;

export class ServerMemory {
  private ring: MemorySample[] = [];
  /** The lowest rss since the log last spoke of a rise, which the next rise is measured from. */
  private low: MemorySample | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly d: {
    log: (line: string) => void;
    /** Where heap snapshots go (`~/Realm/logs`); none are taken without one. */
    snapshotDir?: string;
    usage?: () => NodeJS.MemoryUsage;
    now?: () => number;
    writeSnapshot?: (path: string) => void;
  }) {}

  start(): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), SAMPLE_EVERY_MS);
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  samples(): readonly MemorySample[] {
    return this.ring;
  }

  /** Memory now, against the samples kept. Adds no sample. */
  status(): ServerMemoryStatus {
    const now = this.read();
    return { now, growth: growth(this.ring, now) };
  }

  sample(): MemorySample {
    const s = this.read();
    this.ring.push(s);
    if (this.ring.length > SAMPLES_KEPT) this.ring.shift();
    this.d.log(`[server-memory] ${describeSample(s)}`);
    if (!this.low || s.rss < this.low.rss) this.low = s;
    else if (s.rss - this.low.rss >= RISE_LOG_BYTES) {
      this.d.log(`[server-memory] realm-server rss rose ${gb(s.rss - this.low.rss)} to ${gb(s.rss)} in ${durationWords(s.at - this.low.at)}`);
      this.low = s;
    }
    if (s.rss >= SNAPSHOT_RSS_BYTES) this.snapshot(s.at);
    return s;
  }

  private snapshot(at: number): void {
    const dir = this.d.snapshotDir;
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      const earlier = readdirSync(dir).filter((f) => f.startsWith("server-") && f.endsWith(SNAPSHOT_SUFFIX));
      if (earlier.some((f) => at - statSync(join(dir, f)).mtimeMs < SNAPSHOT_EVERY_MS)) return;
      // One snapshot is about the size of the heap, on a disk that is often full: keep only the newest.
      for (const f of earlier) rmSync(join(dir, f), { force: true });
      const path = join(dir, `server-${new Date(at).toISOString().replace(/[:.]/g, "-")}${SNAPSHOT_SUFFIX}`);
      const started = Date.now();
      (this.d.writeSnapshot ?? writeHeapSnapshot)(path);
      this.d.log(`[server-memory] heap snapshot written to ${path} in ${Date.now() - started} ms`);
    } catch (e) {
      this.d.log(`[server-memory] heap snapshot failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private read(): MemorySample {
    const u = this.d.usage?.() ?? process.memoryUsage();
    return { at: this.d.now?.() ?? Date.now(), rss: u.rss, heapUsed: u.heapUsed, heapTotal: u.heapTotal, external: u.external, arrayBuffers: u.arrayBuffers };
  }
}
