import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * A rendered picture of a file, by way of macOS Quick Look.
 *
 * This is how Realm shows the formats it has no editor for — Word, Excel, PowerPoint, the iWork
 * three. `qlmanage` is the same renderer behind the Finder's space bar, which is the one thing on
 * this machine that already understands all of them, and using it means Realm bundles no converter
 * and inherits every format the OS learns next.
 *
 * **What this is not.** It is an IMAGE. There is no text to select, no scrolling within the
 * document, and for most formats Quick Look renders the first page only. That is a real limit and
 * the pane says so rather than letting a reader discover it by trying to select a paragraph. The
 * alternative — bundling mammoth, SheetJS and a `.pptx` reader — is three dependencies and three
 * fidelity problems, and it was weighed and declined.
 *
 * **Sandboxing.** `qlmanage` runs Quick Look generators, which are third-party code for third-party
 * formats. It is given a file path and a temp directory and nothing else: no shell (`execFile`, so
 * the path is an argv entry and cannot be word-split or interpreted), a hard timeout, and an output
 * directory Realm made and deletes. A generator that hangs costs one timeout, not the server.
 */

/** Long side of the render, in pixels. Large enough that a page of body text is readable on a
 *  Retina display at pane width, small enough that a PNG of one stays well inside a megabyte. */
export const QUICKLOOK_SIZE = 1600;

/** How long a generator gets. Quick Look is a local render of a local file; anything past this is a
 *  generator that is stuck, and waiting longer only holds the request open. */
const TIMEOUT_MS = 15_000;

/** Nothing above this is offered a preview. `qlmanage` will happily spend a minute on a 300 MB
 *  presentation, and the answer would still be one page. */
export const QUICKLOOK_MAX_BYTES = 100 * 1024 * 1024;

export type QuickLookDeps = {
  /** Test seam. Production leaves this alone and shells out to `qlmanage`. */
  render?: (abs: string, outDir: string) => Promise<void>;
  now?: () => number;
};

/** One cached render, keyed by the file's identity at the moment it was made. */
type Entry = { mtimeMs: number; size: number; png: Buffer };

export class QuickLookRenderer {
  /** Keyed by absolute path. Bounded by `MAX_ENTRIES` — a preview is a picture of one open tab, and
   *  a workspace with forty of them is not the case to hold megabytes for. */
  private readonly cache = new Map<string, Entry>();
  private static readonly MAX_ENTRIES = 8;
  /** In-flight renders, so two frames asking for the same preview cost one `qlmanage`. */
  private readonly inflight = new Map<string, Promise<Buffer | null>>();

  constructor(private readonly d: QuickLookDeps = {}) {}

  /**
   * The PNG for this file, rendering it if the cache has nothing current.
   *
   * `null` for a file too large, a generator that failed, and a platform with no `qlmanage` — all
   * three are "no preview", and the caller answers with the same honest 415 rather than pretending
   * a blank image is the document.
   *
   * The cache key is the file's mtime AND size, not its path: an agent that rewrites a `.docx` in
   * place keeps the path, and a preview that kept showing the version before the edit would be
   * exactly the stale view this feature exists to avoid.
   */
  async png(abs: string): Promise<Buffer | null> {
    let st;
    try { st = await stat(abs); } catch { return null; }
    if (!st.isFile() || st.size > QUICKLOOK_MAX_BYTES) return null;
    const hit = this.cache.get(abs);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.png;

    const pending = this.inflight.get(abs);
    if (pending) return pending;
    const job = this.render(abs, st.mtimeMs, st.size).finally(() => this.inflight.delete(abs));
    this.inflight.set(abs, job);
    return job;
  }

  private async render(abs: string, mtimeMs: number, size: number): Promise<Buffer | null> {
    const outDir = await mkdtemp(join(tmpdir(), "realm-ql-"));
    try {
      if (this.d.render) await this.d.render(abs, outDir);
      else {
        // `-t` is thumbnail mode, which is the only `qlmanage` mode that writes a file; `-f 1`
        // stops it scaling for the display's backing factor on top of `-s`, which would otherwise
        // produce an image twice the size that was asked for.
        await run("qlmanage", ["-t", "-s", String(QUICKLOOK_SIZE), "-f", "1", "-o", outDir, abs], { timeout: TIMEOUT_MS });
      }
      // `qlmanage` names its output after the input and does not report the path, so the directory
      // is read back. It is one Realm just made for this render, so whatever is in it is the answer.
      const made = (await readdir(outDir)).filter((f) => f.toLowerCase().endsWith(".png"));
      // Prefer the one named after the file; fall back to whatever single PNG landed, since the
      // naming has changed across macOS releases and the directory has exactly one candidate.
      const pick = made.find((f) => f.startsWith(basename(abs))) ?? made[0];
      if (!pick) return null;
      const png = await readFile(join(outDir, pick));
      // Empty output is a generator that declined — a password-protected document, a format whose
      // generator is not installed. Caching that would be caching a failure.
      if (png.length === 0) return null;
      this.remember(abs, { mtimeMs, size, png });
      return png;
    } catch {
      // A missing `qlmanage` (not macOS), a generator crash, a timeout. All the same answer.
      return null;
    } finally {
      await rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private remember(abs: string, entry: Entry): void {
    this.cache.delete(abs);
    this.cache.set(abs, entry);
    // Insertion order is recency here, because a hit re-inserts through `png`'s caller only on a
    // MISS — which is what makes this an "oldest render" eviction rather than a true LRU. For eight
    // entries holding one picture each, the difference is not worth a second data structure.
    while (this.cache.size > QuickLookRenderer.MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /** Drop everything held. Called on close so a long-lived process does not keep megabytes of
   *  pictures of files nobody has open. */
  clear(): void { this.cache.clear(); }
}
