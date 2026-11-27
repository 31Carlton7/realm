import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RISE_LOG_BYTES, SAMPLES_KEPT, SAMPLE_EVERY_MS, SNAPSHOT_EVERY_MS, SNAPSHOT_RSS_BYTES, ServerMemory, growth, type MemorySample } from "./server-memory";

const MB = 1024 ** 2, GB = 1024 ** 3;
const usage = (rss: number, heapUsed = 50 * MB): NodeJS.MemoryUsage => ({ rss, heapUsed, heapTotal: 80 * MB, external: 4 * MB, arrayBuffers: 2 * MB });

/** A server whose clock and memory the test moves by hand. */
function rig(o: { snapshotDir?: string } = {}) {
  let now = 1_000_000;
  let rss = 200 * MB;
  const lines: string[] = [];
  const written: string[] = [];
  const m = new ServerMemory({
    now: () => now, usage: () => usage(rss), log: (l) => lines.push(l),
    snapshotDir: o.snapshotDir, writeSnapshot: (path) => { written.push(path); writeFileSync(path, "{}"); utimesSync(path, now / 1000, now / 1000); },
  });
  return {
    m, lines, written,
    set: (bytes: number) => { rss = bytes; },
    tick: (bytes?: number) => { now += SAMPLE_EVERY_MS; if (bytes !== undefined) rss = bytes; return m.sample(); },
    advance: (ms: number) => { now += ms; },
    rises: () => lines.filter((l) => l.includes("rose")),
  };
}

describe("ServerMemory sampling", () => {
  it("records every field of memoryUsage at the injected clock, and logs one compact line per sample", () => {
    const r = rig();
    const s = r.tick(300 * MB);
    expect(s).toEqual({ at: 1_000_000 + SAMPLE_EVERY_MS, rss: 300 * MB, heapUsed: 50 * MB, heapTotal: 80 * MB, external: 4 * MB, arrayBuffers: 2 * MB });
    expect(r.m.samples()).toEqual([s]);
    expect(r.lines).toEqual(["[server-memory] rss 300 MB · heap 50 MB of 80 MB · external 4 MB · array buffers 2 MB"]);
  });

  it("keeps a bounded ring: the oldest sample goes once SAMPLES_KEPT are held", () => {
    const r = rig();
    for (let i = 0; i < SAMPLES_KEPT + 5; i++) r.tick(200 * MB + i);
    const kept = r.m.samples();
    expect(kept).toHaveLength(SAMPLES_KEPT);
    expect(kept[0]!.rss).toBe(200 * MB + 5);
    expect(kept.at(-1)!.rss).toBe(200 * MB + SAMPLES_KEPT + 4);
  });

  it("samples once on start, and a second start adds no second timer", () => {
    const r = rig();
    r.m.start();
    r.m.start();
    expect(r.m.samples()).toHaveLength(1);
    r.m.close();
  });
});

describe("growth", () => {
  const s = (at: number, rss: number): MemorySample => ({ at, rss, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0 });

  it("is the oldest sample kept against the reading now, with the peak between", () => {
    expect(growth([s(0, 100 * MB), s(10, 400 * MB), s(20, 250 * MB)], s(30, 300 * MB)))
      .toEqual({ fromBytes: 100 * MB, toBytes: 300 * MB, changeBytes: 200 * MB, peakBytes: 400 * MB, overMs: 30 });
  });

  it("can fall, and counts the reading now toward the peak", () => {
    expect(growth([s(0, 500 * MB), s(10, 300 * MB)], s(40, 600 * MB))).toMatchObject({ changeBytes: 100 * MB, peakBytes: 600 * MB, overMs: 40 });
    expect(growth([s(0, 500 * MB)], s(40, 200 * MB))).toMatchObject({ changeBytes: -300 * MB, peakBytes: 500 * MB });
  });

  it("is null before the first sample", () => {
    expect(growth([], s(0, MB))).toBeNull();
  });

  it("status reads memory now without adding a sample", () => {
    const r = rig();
    r.tick(100 * MB);
    r.advance(60_000);
    r.set(150 * MB);
    const st = r.m.status();
    expect(st.now.rss).toBe(150 * MB);
    expect(st.growth).toMatchObject({ fromBytes: 100 * MB, changeBytes: 50 * MB, overMs: 60_000 });
    expect(r.m.samples()).toHaveLength(1);
  });
});

describe("the rise line", () => {
  it("fires once when rss climbs RISE_LOG_BYTES over its low, and not again until a further rise", () => {
    const r = rig();
    r.tick(200 * MB);
    r.tick(200 * MB + RISE_LOG_BYTES - MB);
    expect(r.rises()).toEqual([]);
    r.tick(200 * MB + RISE_LOG_BYTES);
    expect(r.rises()).toEqual([`[server-memory] realm-server rss rose ${RISE_LOG_BYTES / MB} MB to ${(200 * MB + RISE_LOG_BYTES) / MB} MB in 10 min`]);
    // Staying up there, or climbing less than another step, says nothing more.
    for (let i = 0; i < 5; i++) r.tick(200 * MB + RISE_LOG_BYTES + 10 * MB * i);
    expect(r.rises()).toHaveLength(1);
    // Another full step above where it last warned: one more line.
    r.tick(200 * MB + 2 * RISE_LOG_BYTES);
    expect(r.rises()).toHaveLength(2);
  });

  it("re-arms from a new low after memory falls back", () => {
    const r = rig();
    r.tick(200 * MB);
    r.tick(200 * MB + RISE_LOG_BYTES);
    r.tick(100 * MB);
    r.tick(100 * MB + RISE_LOG_BYTES);
    expect(r.rises()).toHaveLength(2);
  });
});

describe("the heap snapshot", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("is written once rss passes SNAPSHOT_RSS_BYTES, at most once a day, keeping only the newest", () => {
    dir = mkdtempSync(join(tmpdir(), "realm-heap-"));
    const r = rig({ snapshotDir: dir });
    r.tick(SNAPSHOT_RSS_BYTES - MB);
    expect(r.written).toEqual([]);
    r.tick(SNAPSHOT_RSS_BYTES);
    expect(r.written).toHaveLength(1);
    expect(r.lines.some((l) => l.startsWith("[server-memory] heap snapshot written to ") && l.includes(r.written[0]!))).toBe(true);
    r.tick(2 * GB);
    expect(r.written).toHaveLength(1);
    r.advance(SNAPSHOT_EVERY_MS);
    r.tick(2 * GB);
    expect(r.written).toHaveLength(2);
    expect(readdirSync(dir)).toEqual([r.written[1]!.split("/").at(-1)]);
  });

  it("counts a snapshot a previous run left today, so a restart does not take another", () => {
    dir = mkdtempSync(join(tmpdir(), "realm-heap-"));
    const r = rig({ snapshotDir: dir });
    const old = join(dir, "server-earlier.heapsnapshot");
    writeFileSync(old, "{}");
    const at = (1_000_000 + SAMPLE_EVERY_MS - 60_000) / 1000;
    utimesSync(old, at, at);
    r.tick(2 * GB);
    expect(r.written).toEqual([]);
  });

  it("is never taken without a folder to put it in", () => {
    const r = rig();
    r.tick(4 * GB);
    expect(r.written).toEqual([]);
  });
});
