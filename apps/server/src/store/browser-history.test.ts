import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { openDatabase } from "../db/database";
import { BROWSER_HISTORY_MAX, BrowserHistoryStore, HISTORY_TITLE_MAX, isHistoryUrl } from "./browser-history";

function store() {
  const db = openDatabase(join(tempDir("realm-db-"), "realm.db"));
  const profile = db.prepare("INSERT INTO profiles (id, name, icon, color, sort_order, created_at, updated_at) VALUES (?, ?, 'user', '#000000', 0, 1, 1)");
  profile.run("p1", "Work");
  profile.run("p2", "Home");
  return { db, history: new BrowserHistoryStore(db) };
}

describe("BrowserHistoryStore", () => {
  it("a second visit to a page is the same row, counted once more and moved to now", () => {
    const { history } = store();
    history.recordVisit("p1", "https://example.com/", "Example", 10);
    history.recordVisit("p1", "https://example.com/", "Example Domain", 20);
    expect(history.search("p1", "example", 10)).toEqual([{ url: "https://example.com/", title: "Example Domain", visits: 2, lastVisitAt: 20 }]);
  });

  it("a visit with no title keeps the title the page had", () => {
    const { history } = store();
    history.recordVisit("p1", "https://example.com/", "Example", 10);
    history.recordVisit("p1", "https://example.com/", "", 20);
    expect(history.search("p1", "example", 10)[0]!.title).toBe("Example");
  });

  it("ranks by how often, then by how recently", () => {
    /* THE mutant: order by recency alone. The page someone has opened forty times would then lose to
       whatever they glanced at a minute ago — which is not what the field's first row is for. */
    const { history } = store();
    for (let i = 0; i < 3; i++) history.recordVisit("p1", "https://docs.example/often", "Often", 10 + i);
    history.recordVisit("p1", "https://docs.example/recent", "Recent", 100);
    history.recordVisit("p1", "https://docs.example/older", "Older", 50);
    expect(history.search("p1", "docs", 10).map((p) => p.title)).toEqual(["Often", "Recent", "Older"]);
  });

  it("matches the address or the title, whatever the case", () => {
    const { history } = store();
    history.recordVisit("p1", "https://github.com/31Carlton7/realm", "Realm — a workspace", 10);
    history.recordVisit("p1", "https://news.example/", "Hacker news", 10);
    expect(history.search("p1", "GITHUB", 10).map((p) => p.url)).toEqual(["https://github.com/31Carlton7/realm"]);
    expect(history.search("p1", "workspace", 10).map((p) => p.url)).toEqual(["https://github.com/31Carlton7/realm"]);
    expect(history.search("p1", "   ", 10)).toEqual([]);
  });

  it("reads what was typed as text, never as a pattern", () => {
    /* `%` and `_` are LIKE's wildcards. Unescaped, "100%" would match every page with "100" in it and
       "a_b" would match "axb". */
    const { history } = store();
    history.recordVisit("p1", "https://shop.example/sale?off=100%25", "Everything 100% off", 10);
    history.recordVisit("p1", "https://shop.example/100-days", "100 days", 10);
    history.recordVisit("p1", "https://example.com/axb", "axb", 10);
    expect(history.search("p1", "100%", 10).map((p) => p.title)).toEqual(["Everything 100% off"]);
    expect(history.search("p1", "a_b", 10)).toEqual([]);
  });

  it("each profile sees only its own pages", () => {
    const { history } = store();
    history.recordVisit("p1", "https://work.example/", "Work", 10);
    history.recordVisit("p2", "https://home.example/", "Home", 10);
    expect(history.search("p1", "example", 10).map((p) => p.title)).toEqual(["Work"]);
    expect(history.search("p2", "example", 10).map((p) => p.title)).toEqual(["Home"]);
  });

  it("renaming a page renames its row and counts nothing", () => {
    const { history } = store();
    history.recordVisit("p1", "https://app.example/", "Loading…", 10);
    history.retitle("p1", "https://app.example/", "Inbox (3)");
    history.retitle("p1", "https://app.example/", "");
    expect(history.search("p1", "app", 10)).toEqual([{ url: "https://app.example/", title: "Inbox (3)", visits: 1, lastVisitAt: 10 }]);
  });

  it("holds a bounded title and a bounded number of pages, dropping the longest-unvisited first", () => {
    const { db, history } = store();
    history.recordVisit("p1", "https://long.example/", "x".repeat(HISTORY_TITLE_MAX * 2), 1);
    expect(history.search("p1", "long", 1)[0]!.title).toHaveLength(HISTORY_TITLE_MAX);
    const insert = db.prepare("INSERT INTO browser_history (profile_id, url, title, visit_count, last_visit_at) VALUES ('p1', ?, 't', 1, ?)");
    db.exec("BEGIN");
    for (let i = 0; i < BROWSER_HISTORY_MAX; i++) insert.run(`https://bulk.example/${i}`, 100 + i);
    db.exec("COMMIT");
    history.recordVisit("p1", "https://fresh.example/", "Fresh", 1_000_000);
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM browser_history WHERE profile_id = 'p1'").get() as { n: number };
    expect(n).toBe(BROWSER_HISTORY_MAX);
    // The oldest went (the long title at t=1, then bulk/0), the newest stayed.
    expect(history.search("p1", "long.example", 1)).toEqual([]);
    expect(history.search("p1", "fresh", 1)).toHaveLength(1);
  });

  it("recent lists the pages visited last, newest first, however often the others were", () => {
    /* THE mutant: rank them as search does, most visited first. The page opened forty times last
       month would head a list called Recently visited. */
    const { history } = store();
    for (let i = 0; i < 5; i++) history.recordVisit("p1", "https://often.example/", "Often", 10 + i);
    history.recordVisit("p1", "https://older.example/", "Older", 50);
    history.recordVisit("p1", "https://newest.example/", "Newest", 100);
    expect(history.recent("p1", 10).map((p) => p.title)).toEqual(["Newest", "Older", "Often"]);
  });

  it("recent breaks a tie on the millisecond toward the page gone back to more", () => {
    // THE mutant: recency alone. The tie then falls to whichever row was written first — "Once".
    const { history } = store();
    history.recordVisit("p1", "https://once.example/", "Once", 40);
    history.recordVisit("p1", "https://twice.example/", "Twice", 10);
    history.recordVisit("p1", "https://twice.example/", "Twice", 40);
    expect(history.recent("p1", 10).map((p) => [p.title, p.visits])).toEqual([["Twice", 2], ["Once", 1]]);
  });

  it("recent is one profile's own, and only as many as asked for", () => {
    const { history } = store();
    for (let i = 0; i < 4; i++) history.recordVisit("p1", `https://work.example/${i}`, `Work ${i}`, 10 + i);
    history.recordVisit("p2", "https://home.example/", "Home", 100);
    expect(history.recent("p1", 2).map((p) => p.title)).toEqual(["Work 3", "Work 2"]);
    expect(history.recent("p2", 10).map((p) => p.title)).toEqual(["Home"]);
    expect(history.recent("nobody", 10)).toEqual([]);
  });

  it("clearAll forgets every profile's pages", () => {
    const { history } = store();
    history.recordVisit("p1", "https://a.example/", "A", 1);
    history.recordVisit("p2", "https://b.example/", "B", 1);
    history.clearAll();
    expect(history.search("p1", "example", 10)).toEqual([]);
    expect(history.search("p2", "example", 10)).toEqual([]);
  });
});

describe("isHistoryUrl", () => {
  it("is an address someone could type back in, and nothing else", () => {
    expect(isHistoryUrl("https://example.com/a?b=c")).toBe(true);
    expect(isHistoryUrl("http://127.0.0.1:5173/")).toBe(true);
    // Realm's own bootstrap, and documents with no address.
    expect(isHistoryUrl("about:blank")).toBe(false);
    expect(isHistoryUrl("data:text/html,hi")).toBe(false);
    expect(isHistoryUrl("blob:https://example.com/abc")).toBe(false);
    expect(isHistoryUrl("")).toBe(false);
    // A credential in a URL is not a place to keep in a list.
    expect(isHistoryUrl("https://user:secret@example.com/")).toBe(false);
    expect(isHistoryUrl(`https://example.com/${"a".repeat(3_000)}`)).toBe(false);
  });
});
