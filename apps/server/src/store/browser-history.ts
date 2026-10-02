import type { Db } from "../db/database";
import type { BrowserHistoryPage } from "@realm/contracts";

type Row = { url: string; title: string; visit_count: number; last_visit_at: number };
const toPage = (r: Row): BrowserHistoryPage => ({ url: r.url, title: r.title, visits: r.visit_count, lastVisitAt: r.last_visit_at });

/** How many pages one profile's history keeps. A suggestion list reads the top of it; the tail is
 *  pages nobody has been back to, and a table that only grows is a table that slows every read. */
export const BROWSER_HISTORY_MAX = 5_000;
/** Bounds on what one row stores — a URL or a `<title>` is the page's to make as long as it likes. */
export const HISTORY_URL_MAX = 2_048;
export const HISTORY_TITLE_MAX = 300;

/**
 * Only an address a person could type back in is history. `about:blank` is Realm's own bootstrap,
 * `data:` and `blob:` are documents with no address, and a URL carrying a user name or password has
 * a credential in it that has no business being kept in a list of places.
 */
export function isHistoryUrl(url: string): boolean {
  if (url.length > HISTORY_URL_MAX) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return (u.protocol === "http:" || u.protocol === "https:") && u.username === "" && u.password === "";
}

/** `%`, `_` and the escape itself mean something to LIKE; typed into the address field they are text. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * The pages a profile's browser panes have shown (Plan 26 W7c). Rows only: the rule for WHEN a visit
 * is recorded lives in `BrowserService.update`, the one writer.
 */
export class BrowserHistoryStore {
  constructor(private db: Db) {}

  /** A visit: a new row, or one more on the row this url already has, moved to now. */
  recordVisit(profileId: string, url: string, title: string, at: number): void {
    const t = title.slice(0, HISTORY_TITLE_MAX);
    const r = this.db.prepare(`INSERT INTO browser_history (profile_id, url, title, visit_count, last_visit_at) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT (profile_id, url) DO UPDATE SET visit_count = visit_count + 1, last_visit_at = excluded.last_visit_at,
        title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE browser_history.title END`).run(profileId, url, t, at);
    if (Number(r.changes) > 0) this.trim(profileId);
  }

  /** The page set its title after the visit was counted: the row is renamed, and that is all. */
  retitle(profileId: string, url: string, title: string): void {
    if (title === "") return;
    this.db.prepare("UPDATE browser_history SET title = ? WHERE profile_id = ? AND url = ?").run(title.slice(0, HISTORY_TITLE_MAX), profileId, url);
  }

  /**
   * Pages whose address or title contains `query`, most visited first and then most recent. LIKE is
   * case-insensitive for ASCII, which is what an address field wants: "GitHub" finds "github.com".
   */
  search(profileId: string, query: string, limit: number): BrowserHistoryPage[] {
    const q = query.trim();
    if (q === "") return [];
    const pattern = likePattern(q);
    return (this.db.prepare(`SELECT url, title, visit_count, last_visit_at FROM browser_history
      WHERE profile_id = ? AND (url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')
      ORDER BY visit_count DESC, last_visit_at DESC LIMIT ?`).all(profileId, pattern, pattern, limit) as Row[]).map(toPage);
  }

  /**
   * The pages a profile went to last, for a blank tab's Recently visited (Plan 26 W6): most recent
   * first. Recency leads because the list is named for it — the page opened forty times last month is
   * the address field's to offer, not this list's. Two visits in the same millisecond go to the page
   * gone back to more often, the one other thing a row knows.
   */
  recent(profileId: string, limit: number): BrowserHistoryPage[] {
    return (this.db.prepare(`SELECT url, title, visit_count, last_visit_at FROM browser_history
      WHERE profile_id = ? ORDER BY last_visit_at DESC, visit_count DESC LIMIT ?`).all(profileId, limit) as Row[]).map(toPage);
  }

  /** Every profile's history — the browser's partition is shared by every profile, and so is a clear. */
  clearAll(): void {
    this.db.prepare("DELETE FROM browser_history").run();
  }

  private trim(profileId: string): void {
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM browser_history WHERE profile_id = ?").get(profileId) as { n: number };
    if (n <= BROWSER_HISTORY_MAX) return;
    this.db.prepare(`DELETE FROM browser_history WHERE profile_id = ? AND url IN (
      SELECT url FROM browser_history WHERE profile_id = ? ORDER BY last_visit_at ASC LIMIT ?)`).run(profileId, profileId, n - BROWSER_HISTORY_MAX);
  }
}
