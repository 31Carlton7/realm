import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Db } from "../db/database";
import { ShipsStore, type ShipInsert } from "./ships";

let db: Db; let store: ShipsStore;

const row = (extra: Partial<ShipInsert> = {}): ShipInsert =>
  ({ environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", spaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA0", branch: "main",
    sha: "abc123", subject: "a change", prUrl: null, pushState: "pushed", ...extra });

beforeEach(() => {
  db = openDatabase(join(mkdtempSync(join(tmpdir(), "realm-shipstore-")), "realm.db"));
  store = new ShipsStore(db);
});

/** Force a row's created_at so ordering tests don't depend on Date.now ties. */
const at = (id: string, createdAt: number) => db.prepare("UPDATE ships SET created_at = ? WHERE id = ?").run(createdAt, id);

describe("ShipsStore — record", () => {
  it("round-trips every column, including the nullable ones", () => {
    const s = store.record(row({ branch: null, prUrl: "https://github.com/o/r/pull/7", pushState: "rejected" }));
    const { ships } = store.list({ spaceId: s.spaceId, cursor: null, limit: 10 });
    expect(ships).toHaveLength(1);
    expect(ships[0]).toMatchObject({ id: s.id, environmentId: s.environmentId, spaceId: s.spaceId,
      branch: null, sha: "abc123", subject: "a change", prUrl: "https://github.com/o/r/pull/7", pushState: "rejected" });
    expect(ships[0]!.createdAt).toBeGreaterThan(0);
  });
});

describe("ShipsStore — per-space listing (the named W1 mutant: rows crossing spaces)", () => {
  it("lists only the asked-for space's ships, however the timestamps interleave", () => {
    const a = store.record(row({ spaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA1", subject: "s1 old" })); at(a.id, 100);
    const b = store.record(row({ spaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA2", subject: "s2 mid" })); at(b.id, 200);
    const c = store.record(row({ spaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA1", subject: "s1 new" })); at(c.id, 300);
    const s1 = store.list({ spaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA1", cursor: null, limit: 10 });
    expect(s1.ships.map((s) => s.subject)).toEqual(["s1 new", "s1 old"]);
    const s2 = store.list({ spaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA2", cursor: null, limit: 10 });
    expect(s2.ships.map((s) => s.subject)).toEqual(["s2 mid"]);
  });

  it("an unknown space lists nothing (the RPC layer, not the store, turns that into NOT_FOUND)", () => {
    store.record(row());
    expect(store.list({ spaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA9", cursor: null, limit: 10 }).ships).toEqual([]);
  });
});

describe("ShipsStore — feed order and pagination (the notifications cursor, verbatim)", () => {
  it("lists newest first with id as the same-millisecond tiebreak", () => {
    const a = store.record(row({ subject: "a" })); at(a.id, 100);
    const b = store.record(row({ subject: "b" })); at(b.id, 200);
    const c = store.record(row({ subject: "c" })); at(c.id, 200);
    const { ships } = store.list({ spaceId: a.spaceId, cursor: null, limit: 10 });
    expect(ships.map((s) => s.subject).slice(0, 2).sort()).toEqual(["b", "c"]);
    expect(ships.map((s) => s.subject)[2]).toBe("a");
  });

  it("pages by keyset cursor without skipping or repeating across a same-millisecond boundary", () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) { const s = store.record(row({ subject: `n${i}` })); at(s.id, i < 3 ? 100 : 200); ids.push(s.id); }
    const spaceId = row().spaceId;
    const first = store.list({ spaceId, cursor: null, limit: 2 });
    expect(first.nextCursor).not.toBeNull();
    const second = store.list({ spaceId, cursor: first.nextCursor, limit: 2 });
    const third = store.list({ spaceId, cursor: second.nextCursor, limit: 2 });
    const seen = [...first.ships, ...second.ships, ...third.ships].map((s) => s.id);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toHaveLength(5);
    expect(third.ships).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
  });

  it("the cursor never leaks another space's rows into a page", () => {
    // Same timestamps in two spaces: paging space A with a cursor cut mid-millisecond must still
    // only ever answer space A.
    for (let i = 0; i < 3; i++) { const s = store.record(row({ spaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA1" })); at(s.id, 100); }
    for (let i = 0; i < 3; i++) { const s = store.record(row({ spaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA2" })); at(s.id, 100); }
    const first = store.list({ spaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA1", cursor: null, limit: 2 });
    const second = store.list({ spaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA1", cursor: first.nextCursor, limit: 10 });
    for (const s of [...first.ships, ...second.ships]) expect(s.spaceId).toBe("01ARZ3NDEKTSV4RRFFQ69G5FA1");
    expect(first.ships.length + second.ships.length).toBe(3);
  });

  it("treats a mangled cursor as the first page rather than throwing", () => {
    const s = store.record(row());
    expect(store.list({ spaceId: s.spaceId, cursor: "not-a-cursor", limit: 10 }).ships).toHaveLength(1);
    expect(store.list({ spaceId: s.spaceId, cursor: "NaN:xyz", limit: 10 }).ships).toHaveLength(1);
  });
});
