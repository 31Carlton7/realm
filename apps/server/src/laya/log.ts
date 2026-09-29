import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * The decision log — one JSON line per observed step, and in Phase 2 the training set.
 *
 * `<REALM_HOME>/laya/decisions.jsonl`, rotated at 16 MB into `decisions.1.jsonl` … `decisions.7.jsonl`,
 * the oldest dropped past seven. A row is two to three kilobytes, so that is some fifty thousand
 * steps: far more than a first evaluation needs, and a ceiling on what a machine that drives apps all
 * day can put on disk without being asked.
 *
 * The files are the user's alone (0600, in a 0700 directory): a row holds the labels of what was on
 * screen, which is other applications' content. Writes are synchronous and a line at a time — rows
 * come one per agent step, from work already off the step's path, so the order on disk is the order
 * of the steps and there is no buffer to lose.
 */
export class DecisionLog {
  /** Rows per file: [current, .1, .2, …]. Counted from disk once, then kept. */
  private counts: number[] | null = null;
  private size = 0;

  constructor(private readonly d: { path: string; maxBytes?: number; keep?: number }) {}

  get path(): string {
    return this.d.path;
  }

  append(row: unknown): void {
    const line = JSON.stringify(row) + "\n";
    const bytes = Buffer.byteLength(line);
    const counts = this.load();
    if (this.size > 0 && this.size + bytes > (this.d.maxBytes ?? 16 * 1024 * 1024)) this.rotate(counts);
    mkdirSync(dirname(this.d.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.d.path, line, { mode: 0o600 });
    this.size += bytes;
    counts[0]! += 1;
  }

  /** Rows across the current file and every rotated one. */
  count(): number {
    return this.load().reduce((a, b) => a + b, 0);
  }

  /** Every log file there is, rotated ones included — the whole of what "Delete log" promises. */
  delete(): void {
    for (const f of this.files()) rmSync(f, { force: true });
    this.counts = new Array<number>(this.keep + 1).fill(0);
    this.size = 0;
  }

  /** The current file and its rotations, newest first; only those that exist. */
  files(): string[] {
    const dir = dirname(this.d.path);
    const stem = basename(this.d.path).replace(/\.jsonl$/, "");
    let names: string[];
    try { names = readdirSync(dir); } catch { return []; }
    // Found by pattern, not by counting to `keep`: a file left by a larger `keep` is still this log.
    const rotated = names
      .map((n) => ({ n, i: Number(new RegExp(`^${escape(stem)}\\.(\\d+)\\.jsonl$`).exec(n)?.[1] ?? NaN) }))
      .filter((x) => Number.isInteger(x.i))
      .sort((a, b) => a.i - b.i)
      .map((x) => join(dir, x.n));
    return [...(existsSync(this.d.path) ? [this.d.path] : []), ...rotated];
  }

  private get keep(): number {
    return this.d.keep ?? 7;
  }

  private rotatedPath(i: number): string {
    return this.d.path.replace(/\.jsonl$/, `.${i}.jsonl`);
  }

  private rotate(counts: number[]): void {
    rmSync(this.rotatedPath(this.keep), { force: true });
    for (let i = this.keep - 1; i >= 1; i--) {
      if (existsSync(this.rotatedPath(i))) renameSync(this.rotatedPath(i), this.rotatedPath(i + 1));
    }
    renameSync(this.d.path, this.rotatedPath(1));
    counts.unshift(0);
    counts.length = this.keep + 1;
    this.size = 0;
  }

  private load(): number[] {
    if (this.counts) return this.counts;
    const counts = new Array<number>(this.keep + 1).fill(0);
    const lines = (p: string): number => {
      try {
        const buf = readFileSync(p);
        let n = 0;
        for (const b of buf) if (b === 10) n++;
        return n;
      } catch { return 0; }
    };
    counts[0] = lines(this.d.path);
    for (let i = 1; i <= this.keep; i++) counts[i] = lines(this.rotatedPath(i));
    try { this.size = statSync(this.d.path).size; } catch { this.size = 0; }
    this.counts = counts;
    return counts;
  }
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
