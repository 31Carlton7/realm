import { createHash } from "node:crypto";
import type { Db } from "../db/database";
import type { BrowserHistoryPage } from "@realm/contracts";

type Row = { url: string; title: string; visit_count: number; last_visit_at: number; favicon: string };
const toPage = (r: Row): BrowserHistoryPage => ({ url: r.url, title: r.title, visits: r.visit_count, lastVisitAt: r.last_visit_at, favicon: r.favicon });

/** A page as the lists read it: its row, and the picture its digest names (v36 keeps each once). */
const PAGES = `SELECT h.url, h.title, h.visit_count, h.last_visit_at, COALESCE(f.data, '') AS favicon FROM browser_history h
  LEFT JOIN browser_favicons f ON f.profile_id = h.profile_id AND f.digest = h.favicon_digest`;

/** The key a favicon is kept under: a digest of the picture, so every page showing the same one names one row. */
const digestOf = (favicon: string): string => createHash("sha256").update(favicon).digest("base64url");

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
   * The icon a visited page showed (`isFaviconDataUrl`, checked by the one writer). Kept once per
   * profile however many pages share it, and '' changes nothing: an icon the page has not offered YET
   * is not one it took away, and the last one seen is still the best picture of the page.
   */
  setFavicon(profileId: string, url: string, favicon: string): void {
    if (favicon === "") return;
    const row = this.db.prepare("SELECT favicon_digest FROM browser_history WHERE profile_id = ? AND url = ?").get(profileId, url) as { favicon_digest: string } | undefined;
    const digest = digestOf(favicon);
    if (!row || row.favicon_digest === digest) return;
    this.db.prepare("INSERT INTO browser_favicons (profile_id, digest, data) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(profileId, digest, favicon);
    this.db.prepare("UPDATE browser_history SET favicon_digest = ? WHERE profile_id = ? AND url = ?").run(digest, profileId, url);
    if (row.favicon_digest !== "") this.sweep(profileId); // the picture it replaced may be no page's now
  }

  /**
   * Pages whose address or title contains `query`, most visited first and then most recent. LIKE is
   * case-insensitive for ASCII, which is what an address field wants: "GitHub" finds "github.com".
   */
  search(profileId: string, query: string, limit: number): BrowserHistoryPage[] {
    const q = query.trim();
    if (q === "") return [];
    const pattern = likePattern(q);
    return (this.db.prepare(`${PAGES}
      WHERE h.profile_id = ? AND (h.url LIKE ? ESCAPE '\\' OR h.title LIKE ? ESCAPE '\\')
      ORDER BY h.visit_count DESC, h.last_visit_at DESC LIMIT ?`).all(profileId, pattern, pattern, limit) as Row[]).map(toPage);
  }

  /**
   * The pages a profile went to last, for a blank tab's Recently visited (Plan 26 W6): most recent
   * first. Recency leads because the list is named for it — the page opened forty times last month is
   * the address field's to offer, not this list's. Two visits in the same millisecond go to the page
   * gone back to more often, the one other thing a row knows.
   */
  recent(profileId: string, limit: number): BrowserHistoryPage[] {
    return (this.db.prepare(`${PAGES}
      WHERE h.profile_id = ? ORDER BY h.last_visit_at DESC, h.visit_count DESC LIMIT ?`).all(profileId, limit) as Row[]).map(toPage);
  }

  /** One profile's history — each profile's panes have their own partition, so a clear is that
   *  profile's alone. The pictures go too: a list of icons is a list of the sites they came from. */
  clearProfile(profileId: string): void {
    this.db.prepare("DELETE FROM browser_history WHERE profile_id = ?").run(profileId);
    this.db.prepare("DELETE FROM browser_favicons WHERE profile_id = ?").run(profileId);
  }

  private trim(profileId: string): void {
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM browser_history WHERE profile_id = ?").get(profileId) as { n: number };
    if (n <= BROWSER_HISTORY_MAX) return;
    this.db.prepare(`DELETE FROM browser_history WHERE profile_id = ? AND url IN (
      SELECT url FROM browser_history WHERE profile_id = ? ORDER BY last_visit_at ASC LIMIT ?)`).run(profileId, profileId, n - BROWSER_HISTORY_MAX);
    this.sweep(profileId);
  }

  /** Drop the pictures no page of this profile names any more. */
  private sweep(profileId: string): void {
    this.db.prepare(`DELETE FROM browser_favicons WHERE profile_id = ? AND digest NOT IN (
      SELECT favicon_digest FROM browser_history WHERE profile_id = ?)`).run(profileId, profileId);
  }
}
