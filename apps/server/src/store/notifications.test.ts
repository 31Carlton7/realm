import { describe, expect, it, beforeEach } from "vitest";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { openDatabase, type Db } from "../db/database";
import { NotificationsStore, type NotificationInsert } from "./notifications";

let db: Db; let store: NotificationsStore;

const row = (extra: Partial<NotificationInsert> = {}): NotificationInsert =>
  ({ category: "session_done", spaceId: null, sessionId: null, refId: null, title: "t", body: null, ...extra });

beforeEach(() => {
  db = openDatabase(join(tempDir("realm-notifstore-"), "realm.db"));
  store = new NotificationsStore(db);
});

/** Force a row's created_at so ordering tests don't depend on Date.now ties. */
const at = (id: string, createdAt: number) => db.prepare("UPDATE notifications SET created_at = ? WHERE id = ?").run(createdAt, id);

describe("NotificationsStore — feed order and pagination", () => {
  it("lists newest first, with id as the total-order tiebreak inside one millisecond", () => {
    const a = store.create(row({ title: "a" })); at(a.id, 100);
    const b = store.create(row({ title: "b" })); at(b.id, 200);
    const c = store.create(row({ title: "c" })); at(c.id, 200);
    const { notifications } = store.list({ cursor: null, limit: 10 });
    // b and c share a millisecond: their mutual order is the id tiebreak (plain ULIDs carry no
    // same-ms order — see mcp.ts's cursor comment), but both strictly precede the older row.
    expect(notifications.map((n) => n.title).slice(0, 2).sort()).toEqual(["b", "c"]);
    expect(notifications.map((n) => n.title)[2]).toBe("a");
    expect([...notifications].map((n) => n.id)).toEqual([...notifications].sort((x, y) => y.createdAt - x.createdAt || (x.id > y.id ? -1 : 1)).map((n) => n.id));
  });

  it("pages by keyset cursor without skipping or repeating across a same-millisecond boundary", () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) { const n = store.create(row({ title: `n${i}` })); at(n.id, i < 3 ? 100 : 200); ids.push(n.id); }
    const first = store.list({ cursor: null, limit: 2 });
    expect(first.nextCursor).not.toBeNull();
    const second = store.list({ cursor: first.nextCursor, limit: 2 });
    const third = store.list({ cursor: second.nextCursor, limit: 2 });
    const seen = [...first.notifications, ...second.notifications, ...third.notifications].map((n) => n.id);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toHaveLength(5);
    // A short page is the end of the feed.
    expect(third.notifications).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
  });

  it("treats a mangled cursor as the first page rather than throwing", () => {
    store.create(row());
    expect(store.list({ cursor: "not-a-cursor", limit: 10 }).notifications).toHaveLength(1);
    expect(store.list({ cursor: "NaN:xyz", limit: 10 }).notifications).toHaveLength(1);
  });

  it("a full page that ends the feed still returns a cursor whose next page is empty (honest end)", () => {
    store.create(row());
    const first = store.list({ cursor: null, limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    const second = store.list({ cursor: first.nextCursor, limit: 1 });
    expect(second.notifications).toHaveLength(0);
    expect(second.nextCursor).toBeNull();
  });
});

describe("NotificationsStore — read/acted lifecycle", () => {
  it("unreadCount counts read_at IS NULL and nothing else — the one derivation site", () => {
    const a = store.create(row());
    store.create(row());
    expect(store.unreadCount()).toBe(2);
    store.markRead([a.id]);
    expect(store.unreadCount()).toBe(1);
    // acted has no bearing on unread: resolving does not read.
    const c = store.create(row({ category: "permission", refId: "req1" }));
    store.resolve(c.id, "Allowed");
    expect(store.unreadCount()).toBe(2);
  });

  it("markRead flips only named unread rows and reports how many actually changed", () => {
    const a = store.create(row()); const b = store.create(row());
    expect(store.markRead([a.id, "01ARZ3NDEKTSV4RRFFQ69G5FAV"])).toBe(1); // unknown id: no-op, not an error
    expect(store.markRead([a.id])).toBe(0); // already read
    expect(store.get(b.id)!.readAt).toBeNull();
  });

  it("markAllRead flips the whole feed regardless of space — the feed is global", () => {
    store.create(row({ spaceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }));
    store.create(row({ spaceId: "01BX5ZZKBKACTAV9WEVGEMMVRZ" }));
    store.create(row({ spaceId: null }));
    expect(store.markAllRead()).toBe(3);
    expect(store.unreadCount()).toBe(0);
  });

  it("findOpen sees only unacted rows for the key; findUnread only unread ones", () => {
    const a = store.create(row({ category: "mcp_health", refId: "srv1" }));
    expect(store.findOpen("mcp_health", "srv1")?.id).toBe(a.id);
    expect(store.findOpen("mcp_health", "srv2")).toBeNull();
    expect(store.findOpen("permission", "srv1")).toBeNull(); // the key is category AND refId
    store.resolve(a.id, "Recovered");
    expect(store.findOpen("mcp_health", "srv1")).toBeNull();
    expect(store.findUnread("mcp_health", "srv1")?.id).toBe(a.id);
    store.markRead([a.id]);
    expect(store.findUnread("mcp_health", "srv1")).toBeNull();
  });

  it("absorb refreshes words in place without touching created_at or read state", () => {
    const a = store.create(row({ category: "mcp_health", refId: "srv1", body: "Connection failed" }));
    at(a.id, 100);
    store.markRead([a.id]);
    const after = store.absorb(a.id, { title: "srv1", body: "Circuit open after repeated failures" });
    expect(after.body).toBe("Circuit open after repeated failures");
    expect(after.createdAt).toBe(100);
    expect(after.readAt).not.toBeNull();
  });

  it("reopen bumps created_at, resets acted per its argument, and keeps the row's identity", () => {
    const a = store.create(row({ category: "mcp_health", refId: "srv1" }));
    store.resolve(a.id, "Recovered"); at(a.id, 100);
    const re = store.reopen(a.id, { title: "srv1", body: "Connection failed", acted: false });
    expect(re.id).toBe(a.id);
    expect(re.actedAt).toBeNull();
    expect(re.createdAt).toBeGreaterThan(100);
    const re2 = store.reopen(a.id, { title: "srv1", body: "again", acted: true });
    expect(re2.actedAt).not.toBeNull();
  });

  it("listOpenForSession returns only that session's unacted rows of the category", () => {
    store.create(row({ category: "permission", sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", refId: "r1" }));
    const other = store.create(row({ category: "permission", sessionId: "01BX5ZZKBKACTAV9WEVGEMMVRZ", refId: "r2" }));
    const acted = store.create(row({ category: "permission", sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", refId: "r3" }));
    store.resolve(acted.id, "Denied");
    const open = store.listOpenForSession("permission", "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(open.map((n) => n.refId)).toEqual(["r1"]);
    expect(open.some((n) => n.id === other.id)).toBe(false);
  });
});
