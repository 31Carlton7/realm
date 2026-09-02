import { watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { isTempArtifact, readIfExists } from "./files";

/** Coalescing window for the burst of events a single save produces. */
const DEBOUNCE_MS = 40;

/**
 * Watches the documents a pane has open and reports real content changes.
 *
 * **Directories, not files.** Every watch is bound to a file's parent directory and filtered by name.
 * Watching the file itself is the obvious implementation, and on macOS it survives more than you would
 * expect — `fs.watch` is path-based here, so even an atomic temp-file-plus-rename save still reports
 * (measured, 2026-09-01; the first version of this comment claimed otherwise and was wrong).
 *
 * What a file-bound watcher does NOT survive is the path going away and coming back: after a delete,
 * it reports the deletion and then stays permanently silent, including for every edit made after the
 * file is recreated. That is not an exotic case here. `git checkout` of a branch without the file,
 * `git stash`, an agent that removes and rewrites rather than edits in place, and the pane's own
 * stale-tab rescue save all produce exactly that sequence — and the failure is silent: the pane keeps
 * showing a document it will never again hear about. A directory-bound watch keeps reporting across
 * the whole cycle, which is the reason this one is written the way it is.
 *
 * **Content hashes, not mtimes.** An event only becomes a change if the file's hash differs from the
 * last hash this watcher knows about. mtime comparison is the tempting alternative and is wrong twice
 * over: HFS+/APFS timestamps and a fast agent write can land in the same tick (so a real change is
 * swallowed), and touching a file without editing it reports a change that never happened.
 *
 * **The known-hash rule.** `known` tracks the last content this watcher has OBSERVED OR WRITTEN, and is
 * updated on both. Tracking only the last *write* would be the subtle bug: after Realm saves H, an
 * agent writes X, and then the agent writes H back, a write-only filter still holds H, suppresses the
 * final event, and leaves the pane displaying X over a file that says H. That divergence is silent and
 * permanent, and `documents.write`'s baseHash guard would then reject the user's next save with a
 * conflict they cannot explain.
 */
export class DocumentWatcher {
  private dirs = new Map<string, { w: FSWatcher; files: Set<string> }>();
  private known = new Map<string, string | null>();
  private timers = new Map<string, NodeJS.Timeout>();
  private closed = false;

  constructor(
    private onChange: (abs: string, hash: string | null) => void,
    private debounceMs: number = DEBOUNCE_MS,
  ) {}

  /** Idempotent. Records the file's current content so the first event compares against something. */
  async watch(abs: string): Promise<void> {
    if (this.closed) return;
    const dir = dirname(abs);
    let entry = this.dirs.get(dir);
    if (!entry) {
      // A directory that cannot be watched (deleted worktree, permissions) must not throw into the
      // caller's save path — the pane keeps working, it just stops hearing about outside edits.
      let w: FSWatcher;
      try {
        w = watch(dir, { persistent: false });
      } catch { return; }
      w.on("error", () => this.dropDir(dir));
      entry = { w, files: new Set() };
      this.dirs.set(dir, entry);
      w.on("change", (_e, name) => { if (name) this.onDirEvent(dir, name.toString()); });
    }
    entry.files.add(abs);
    if (!this.known.has(abs)) this.known.set(abs, (await readIfExists(abs))?.hash ?? null);
  }

  /** Stop watching one file, tearing the directory watcher down once nothing in it is open. */
  unwatch(abs: string): void {
    const dir = dirname(abs);
    const entry = this.dirs.get(dir);
    if (entry) {
      entry.files.delete(abs);
      if (entry.files.size === 0) this.dropDir(dir);
    }
    this.known.delete(abs);
    const t = this.timers.get(abs);
    if (t) { clearTimeout(t); this.timers.delete(abs); }
  }

  /**
   * Record content Realm itself just wrote, so the resulting filesystem event is recognised as an echo
   * rather than reported as somebody else's edit. Without this the pane reloads itself on every
   * autosave — at best a cursor jump mid-sentence, at worst a fight with the user's own typing.
   */
  noteWrite(abs: string, hash: string | null): void {
    this.known.set(abs, hash);
  }

  close(): void {
    this.closed = true;
    for (const dir of [...this.dirs.keys()]) this.dropDir(dir);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.known.clear();
  }

  private dropDir(dir: string): void {
    const entry = this.dirs.get(dir);
    if (!entry) return;
    entry.w.close();
    this.dirs.delete(dir);
  }

  private onDirEvent(dir: string, name: string): void {
    if (isTempArtifact(name)) return; // our own atomic-save churn
    const abs = join(dir, name);
    if (!this.dirs.get(dir)?.files.has(abs)) return; // a file in this directory nobody has open
    const existing = this.timers.get(abs);
    if (existing) clearTimeout(existing);
    this.timers.set(abs, setTimeout(() => { void this.settle(abs); }, this.debounceMs));
  }

  private async settle(abs: string): Promise<void> {
    this.timers.delete(abs);
    if (this.closed) return;
    let hash: string | null;
    try { hash = (await readIfExists(abs))?.hash ?? null; } catch { return; } // unreadable (too large, races) — say nothing
    // Re-check after the await: the file may have been closed while we were reading it.
    if (!this.known.has(abs)) return;
    if (this.known.get(abs) === hash) return; // no real content change — echo, touch, or a no-op save
    this.known.set(abs, hash);
    this.onChange(abs, hash);
  }
}
