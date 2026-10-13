import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ReleaseNotes } from "./whats-new-notes";

/**
 * What's new: a sheet that opens once after Realm updates, and again from the rail or Help.
 *
 * The version this Realm last showed its notes for is kept in userData (`whats-new.json`), beside the
 * window's place and the theme — a fact about this install, known before the server is up. When it
 * differs from the running version the first window to ask is told to open the sheet; closing the
 * sheet writes the running version down, so it does not open again until the next update.
 *
 * A brand-new install has nothing to catch up on, so it records its version silently. A Realm that
 * predates this file is told apart from a new install by what earlier runs left behind — a saved
 * window place or a database in the Realm home — and is shown the sheet once, like any update.
 */
export const WHATS_NEW_FILE = "whats-new.json";

export type WhatsNewFs = {
  read: (path: string) => string;
  write: (path: string, data: string) => void;
};
/* The folder is made first: a new install's userData does not exist yet when main loads, and the
   silent record was lost there — so its second launch took the window's saved place for an earlier
   Realm and showed the sheet to someone who had just installed it. */
const realFs: WhatsNewFs = {
  read: (p) => readFileSync(p, "utf8"),
  write: (p, d) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, d); },
};

/** What the build bakes in: the running version and its notes (null when the changelog has none). */
export type WhatsNewBuild = { version: string; notes: ReleaseNotes | null };
/** What the renderer is handed: that, and where the whole changelog is read. */
export type WhatsNew = WhatsNewBuild & { url: string };

export class WhatsNewState {
  private readonly file: string;
  /** Whether this run still owes the person the sheet. Cleared by the first window that asks, so a
   *  second window opening during the same run does not show it again on top of the first. */
  private owed: boolean;

  constructor(private readonly d: {
    dir: string;
    version: string;
    /** Whether an earlier Realm ran here, for an install that predates `whats-new.json`. */
    ranBefore: boolean;
    fs?: WhatsNewFs;
  }) {
    this.file = join(d.dir, WHATS_NEW_FILE);
    const seen = this.lastSeen();
    if (seen === null && !d.ranBefore) {
      this.owed = false;
      this.markSeen();
    } else {
      this.owed = seen !== d.version;
    }
  }

  /** The version whose notes this install last saw, or null when it has never recorded one. */
  lastSeen(): string | null {
    try {
      const raw = JSON.parse((this.d.fs ?? realFs).read(this.file)) as { seen?: unknown };
      return typeof raw.seen === "string" ? raw.seen : null;
    } catch {
      return null;
    }
  }

  /** True exactly once per run, and only when the running version's notes have not been seen. */
  claim(): boolean {
    const owed = this.owed;
    this.owed = false;
    return owed;
  }

  /** The sheet was closed: this version's notes are seen. */
  markSeen(): void {
    this.owed = false;
    try { (this.d.fs ?? realFs).write(this.file, JSON.stringify({ seen: this.d.version })); }
    catch { /* a read-only userData shows the sheet again next launch, which is the honest failure */ }
  }
}

/** `whats-new:notes`, `whats-new:claim` and `whats-new:seen`. */
export function registerWhatsNew(deps: {
  handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => void;
  state: WhatsNewState;
  notes: WhatsNew;
}): void {
  deps.handle("whats-new:notes", () => deps.notes);
  deps.handle("whats-new:claim", () => deps.state.claim());
  deps.handle("whats-new:seen", () => { deps.state.markSeen(); });
}
