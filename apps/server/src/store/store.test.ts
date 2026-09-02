import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Db } from "../db/database";
import { ProfilesStore } from "./profiles";
import { SpacesStore } from "./spaces";
import { ProjectsStore } from "./projects";
import { ItemsStore } from "./items";
import { TerminalsStore } from "./terminals";
import { EnvironmentsStore } from "./environments";
import { SessionsStore } from "./sessions";
import { NotFoundError, RpcError } from "./rows";
import { emptyLayout, type Layout } from "@realm/contracts";

let db: Db; let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "realm-home-"));
  db = openDatabase(join(home, "realm.db"));
});

describe("ProfilesStore", () => {
  it("creates, lists in sort order, updates, deletes", () => {
    const s = new ProfilesStore(db);
    const a = s.create({ name: "Work", icon: "briefcase", color: "#000" });
    const b = s.create({ name: "School", icon: "cap", color: "#111" });
    expect(s.list().map((p) => p.name)).toEqual(["Work", "School"]);
    expect(s.update({ id: b.id, sortOrder: -1 }).sortOrder).toBe(-1);
    expect(s.list()[0]!.name).toBe("School");
    s.delete(a.id);
    expect(s.list()).toHaveLength(1);
  });
});

describe("SpacesStore", () => {
  it("creates a space with a folder on disk under <home>/<profile>/<space>", () => {
    const profiles = new ProfilesStore(db); const spaces = new SpacesStore(db, home);
    const p = profiles.create({ name: "Work", icon: "x", color: "#000" });
    const sp = spaces.create({ profileId: p.id, name: "Versed", icon: "folder" });
    expect(sp.folderPath).toBe(join(home, "work", "versed"));
    expect(existsSync(sp.folderPath)).toBe(true);
    expect(sp.layout).toBeNull();
  });
  it("slugifies names and dedupes folder collisions", () => {
    const profiles = new ProfilesStore(db); const spaces = new SpacesStore(db, home);
    const p = profiles.create({ name: "My Work!", icon: "x", color: "#000" });
    const a = spaces.create({ profileId: p.id, name: "Cider App", icon: "f" });
    const b = spaces.create({ profileId: p.id, name: "Cider App", icon: "f" });
    expect(a.folderPath).toBe(join(home, "my-work", "cider-app"));
    expect(b.folderPath).toBe(join(home, "my-work", "cider-app-2"));
  });
  it("stores and returns layout", () => {
    const profiles = new ProfilesStore(db); const spaces = new SpacesStore(db, home);
    const p = profiles.create({ name: "W", icon: "x", color: "#000" });
    const sp = spaces.create({ profileId: p.id, name: "S", icon: "f" });
    const layout = emptyLayout();
    expect(spaces.setLayout(sp.id, layout).layout).toEqual(layout);
    expect(spaces.get(sp.id)?.layout).toEqual(layout);
  });
  it("delete cascades to projects and items", () => {
    const profiles = new ProfilesStore(db); const spaces = new SpacesStore(db, home);
    const projects = new ProjectsStore(db); const items = new ItemsStore(db);
    const p = profiles.create({ name: "W", icon: "x", color: "#000" });
    const sp = spaces.create({ profileId: p.id, name: "S", icon: "f" });
    projects.create({ spaceId: sp.id, name: "repo", rootPath: "/tmp/repo", defaultBranch: "main" });
    items.create({ spaceId: sp.id, kind: "terminal", title: "zsh", refId: sp.id });
    spaces.delete(sp.id);
    expect(projects.list(sp.id)).toEqual([]);
    expect(items.list(sp.id)).toEqual([]);
  });
  it("assigns a color on create, lists globally in sort order, reorders", () => {
    const profiles = new ProfilesStore(db); const spaces = new SpacesStore(db, home);
    const p = profiles.create({ name: "W", icon: "x", color: "#000" });
    const a = spaces.create({ profileId: p.id, name: "A", icon: "f" });
    const b = spaces.create({ profileId: p.id, name: "B", icon: "f" });
    expect(a.color).toMatch(/^#/);
    expect(spaces.listAll().map((s) => s.id)).toEqual([a.id, b.id]);
    spaces.reorder([b.id, a.id]);
    expect(spaces.listAll().map((s) => s.id)).toEqual([b.id, a.id]);
    expect(spaces.update({ id: a.id, color: "#ff0000" }).color).toBe("#ff0000");
  });
});

describe("SpacesStore layout robustness", () => {
  it("returns layout null (and still lists) when layout_json is corrupt", () => {
    const profiles = new ProfilesStore(db); const spaces = new SpacesStore(db, home);
    const p = profiles.create({ name: "W", icon: "x", color: "#000" });
    const sp = spaces.create({ profileId: p.id, name: "S", icon: "f" });
    db.prepare("UPDATE spaces SET layout_json = ? WHERE id = ?").run(JSON.stringify({ type: "split", id: "x", dir: "row", sizes: [100], children: [] }), sp.id);
    expect(spaces.get(sp.id)?.layout).toBeNull();
    expect(spaces.list(p.id)).toHaveLength(1);
    db.prepare("UPDATE spaces SET layout_json = ? WHERE id = ?").run("{not json", sp.id);
    expect(spaces.list(p.id)[0]!.layout).toBeNull();
  });
});

describe("SpacesStore pane groups", () => {
  const mk = () => {
    const profiles = new ProfilesStore(db); const spaces = new SpacesStore(db, home);
    const p = profiles.create({ name: "W", icon: "x", color: "#000" });
    return { spaces, sp: spaces.create({ profileId: p.id, name: "S", icon: "f" }) };
  };
  const leaf = (itemId: string | null): Layout => ({ type: "leaf", id: "L1", itemId });

  // Migration v17 does no backfill: a space that predates groups derives its set on READ, so what it
  // shows must be exactly the arrangement it had — one group, named Main, holding that layout.
  it("derives a single Main group from a pre-groups layout, with no groups_json written", () => {
    const { spaces, sp } = mk();
    db.prepare("UPDATE spaces SET layout_json = ? WHERE id = ?").run(JSON.stringify(leaf("i1")), sp.id);
    const got = spaces.get(sp.id)!;
    expect(got.groups!.groups).toHaveLength(1);
    expect(got.groups!.groups[0]!.name).toBe("Main");
    expect(got.groups!.groups[0]!.layout).toEqual(leaf("i1"));
    expect(got.layout).toEqual(leaf("i1")); // the old field keeps its old answer
    expect((db.prepare("SELECT groups_json FROM spaces WHERE id = ?").get(sp.id) as { groups_json: string | null }).groups_json).toBeNull();
  });

  // A pure read that returns different data each call would hand two spaces.list() calls two
  // different ids for the same group — and the renderer seeds its state from exactly that.
  it("derives the same group id on every read", () => {
    const { spaces, sp } = mk();
    expect(spaces.get(sp.id)!.groups).toEqual(spaces.get(sp.id)!.groups);
    expect(spaces.get(sp.id)!.groups!.activeGroupId).toBe(sp.id);
  });

  it("setGroups round-trips the whole set and keeps layout_json on the ACTIVE group", () => {
    const { spaces, sp } = mk();
    const groups = {
      groups: [
        { id: "01ARZ3NDEKTSV4RRFFQ69G5F01", name: "Ship", layout: leaf("i1"), zoomedLeafId: "L1" },
        { id: "01ARZ3NDEKTSV4RRFFQ69G5F02", name: "Read", layout: leaf("i2"), zoomedLeafId: null },
      ],
      activeGroupId: "01ARZ3NDEKTSV4RRFFQ69G5F02",
    };
    const saved = spaces.setGroups(sp.id, groups);
    expect(saved.groups).toEqual(groups);
    expect(saved.layout).toEqual(leaf("i2")); // derived from the ACTIVE group
    expect(spaces.get(sp.id)!.groups).toEqual(groups);
    // The kept-in-step column is what an older build (and spaces.setLayout) would read.
    const row = db.prepare("SELECT layout_json FROM spaces WHERE id = ?").get(sp.id) as { layout_json: string };
    expect(JSON.parse(row.layout_json)).toEqual(leaf("i2"));
  });

  it("setLayout replaces the ACTIVE group's tree and leaves the others alone", () => {
    const { spaces, sp } = mk();
    spaces.setGroups(sp.id, {
      groups: [
        { id: "01ARZ3NDEKTSV4RRFFQ69G5F01", name: "Ship", layout: leaf("i1"), zoomedLeafId: null },
        { id: "01ARZ3NDEKTSV4RRFFQ69G5F02", name: "Read", layout: leaf("i2"), zoomedLeafId: null },
      ],
      activeGroupId: "01ARZ3NDEKTSV4RRFFQ69G5F01",
    });
    const got = spaces.setLayout(sp.id, leaf("i9"));
    expect(got.groups!.groups.map((g) => g.layout)).toEqual([leaf("i9"), leaf("i2")]);
    expect(got.layout).toEqual(leaf("i9"));
  });

  it("degrades corrupt groups_json to the layout-derived default rather than to a broken space", () => {
    const { spaces, sp } = mk();
    db.prepare("UPDATE spaces SET layout_json = ?, groups_json = ? WHERE id = ?")
      .run(JSON.stringify(leaf("i1")), "{not json", sp.id);
    expect(spaces.get(sp.id)!.groups!.groups[0]!.layout).toEqual(leaf("i1"));
    db.prepare("UPDATE spaces SET groups_json = ? WHERE id = ?").run(JSON.stringify({ groups: "nope" }), sp.id);
    expect(spaces.get(sp.id)!.groups!.groups[0]!.layout).toEqual(leaf("i1"));
  });
});

describe("parent checks", () => {
  it("items.create and projects.create throw NotFoundError for unknown space", () => {
    const items = new ItemsStore(db); const projects = new ProjectsStore(db);
    const bogus = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    expect(() => items.create({ spaceId: bogus, kind: "terminal", title: "t", refId: bogus })).toThrow(NotFoundError);
    expect(() => projects.create({ spaceId: bogus, name: "r", rootPath: "/tmp", defaultBranch: "main" })).toThrow(NotFoundError);
  });
});

describe("TerminalsStore", () => {
  it("inserts, lists by space, deletes idempotently", () => {
    const profiles = new ProfilesStore(db); const spaces = new SpacesStore(db, home); const terms = new TerminalsStore(db);
    const p = profiles.create({ name: "W", icon: "x", color: "#000" });
    const sp = spaces.create({ profileId: p.id, name: "S", icon: "f" });
    terms.insert({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", spaceId: sp.id, cwd: sp.folderPath, shell: "/bin/sh" });
    terms.insert({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAW", spaceId: sp.id, cwd: sp.folderPath, shell: "/bin/sh" });
    expect(terms.listBySpace(sp.id).map((t) => t.id).sort()).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FAV", "01ARZ3NDEKTSV4RRFFQ69G5FAW"]);
    terms.delete("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(() => terms.delete("01ARZ3NDEKTSV4RRFFQ69G5FAV")).not.toThrow();
    expect(terms.listBySpace(sp.id)).toHaveLength(1);
  });
});

describe("ItemsStore", () => {
  it("appends with increasing sortOrder and updates", () => {
    const profiles = new ProfilesStore(db); const spaces = new SpacesStore(db, home); const items = new ItemsStore(db);
    const p = profiles.create({ name: "W", icon: "x", color: "#000" });
    const sp = spaces.create({ profileId: p.id, name: "S", icon: "f" });
    const a = items.create({ spaceId: sp.id, kind: "terminal", title: "a", refId: sp.id });
    const b = items.create({ spaceId: sp.id, kind: "terminal", title: "b", refId: sp.id });
    expect(b.sortOrder).toBeGreaterThan(a.sortOrder);
    expect(items.update({ id: a.id, title: "renamed", pinned: true }).pinned).toBe(true);
    expect(items.get(a.id)?.title).toBe("renamed");
  });
  it("archiving keeps the row in its space's list and takes it out of the cross-space one", () => {
    const profiles = new ProfilesStore(db); const spaces = new SpacesStore(db, home); const items = new ItemsStore(db);
    const p = profiles.create({ name: "W", icon: "x", color: "#000" });
    const sp = spaces.create({ profileId: p.id, name: "S", icon: "f" });
    const a = items.create({ spaceId: sp.id, kind: "session", title: "shelved", refId: sp.id });
    const b = items.create({ spaceId: sp.id, kind: "session", title: "live", refId: sp.id });
    expect(a.archived).toBe(false); // nothing is born archived

    expect(items.update({ id: a.id, archived: true }).archived).toBe(true);
    // `list` is what the sidebar's Archived section is drawn from, so it must still carry the row —
    // filtering here would leave the user no way to unarchive.
    expect(items.list(sp.id).map((x) => [x.title, x.archived])).toEqual([["shelved", true], ["live", false]]);
    // `listAll` is the palette's jump list, and that is exactly what archiving opts out of.
    expect(items.listAll().map((x) => x.title)).toEqual([b.title]);

    // An unrelated update must not silently clear the flag — `archived ?? cur.archived`, not `?? false`.
    expect(items.update({ id: a.id, title: "renamed" }).archived).toBe(true);
    expect(items.update({ id: a.id, archived: false }).archived).toBe(false);
    expect(items.listAll().map((x) => x.title).sort()).toEqual(["live", "renamed"]);
  });
  it("moveToSpace re-homes the item, appended after the destination's existing items", () => {
    const profiles = new ProfilesStore(db); const spaces = new SpacesStore(db, home); const items = new ItemsStore(db);
    const p = profiles.create({ name: "W", icon: "x", color: "#000" });
    const a = spaces.create({ profileId: p.id, name: "A", icon: "f" });
    const b = spaces.create({ profileId: p.id, name: "B", icon: "f" });
    items.create({ spaceId: b.id, kind: "terminal", title: "existing", refId: b.id });
    const it = items.create({ spaceId: a.id, kind: "terminal", title: "moving", refId: a.id });
    const moved = items.moveToSpace(it.id, b.id);
    expect(moved.spaceId).toBe(b.id);
    expect(items.list(b.id).map((x) => x.title)).toEqual(["existing", "moving"]);
    expect(items.list(a.id)).toHaveLength(0);
    expect(() => items.moveToSpace(it.id, "01ARZ3NDEKTSV4RRFFQ69G5FAV")).toThrow(NotFoundError);
    expect(() => items.moveToSpace("01ARZ3NDEKTSV4RRFFQ69G5FAV", b.id)).toThrow(NotFoundError);
  });
});

describe("EnvironmentsStore", () => {
  const space = () => {
    const p = new ProfilesStore(db).create({ name: "W", icon: "x", color: "#000" });
    return new SpacesStore(db, home).create({ profileId: p.id, name: "S", icon: "f" });
  };

  it("ensurePrimary is get-or-create at the space folder — two callers never make two primaries", () => {
    const envs = new EnvironmentsStore(db); const sp = space();
    const a = envs.ensurePrimary(sp.id);
    expect(a).toMatchObject({ spaceId: sp.id, path: sp.folderPath, kind: "primary", branch: null, portBlockStart: null });
    expect(envs.ensurePrimary(sp.id).id).toBe(a.id);
    expect(envs.list(sp.id)).toHaveLength(1);
  });

  it("ensureAt is get-or-create by path, and is per space", () => {
    const envs = new EnvironmentsStore(db);
    const a = space(); const b = space();
    const one = envs.ensureAt(a.id, "/tmp/repo", "checkout");
    expect(envs.ensureAt(a.id, "/tmp/repo", "checkout").id).toBe(one.id);
    // Same path in a different space is a different environment: environments belong to a space.
    expect(envs.ensureAt(b.id, "/tmp/repo", "checkout").id).not.toBe(one.id);
    expect(envs.list(a.id).map((e) => e.path)).toEqual(["/tmp/repo"]);
  });

  it("rejects an environment for an unknown space", () => {
    expect(() => new EnvironmentsStore(db).create({ spaceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", path: "/tmp", kind: "worktree" })).toThrow(NotFoundError);
    expect(() => new EnvironmentsStore(db).ensurePrimary("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toThrow(NotFoundError);
  });

  it("deleting the last session leaves the environment standing; removing it is explicit and refused while in use", () => {
    const envs = new EnvironmentsStore(db); const sessions = new SessionsStore(db); const sp = space();
    const wt = envs.create({ spaceId: sp.id, path: "/tmp/wt", kind: "worktree" });
    const s = sessions.create({ spaceId: sp.id, projectId: null, agentKind: "fake", model: null, effort: null, permissionMode: "default", environmentId: wt.id, title: "t" });
    expect(envs.sessionCount(wt.id)).toBe(1);
    expect(() => envs.delete(wt.id)).toThrow(/1 session still runs here/);
    sessions.delete(s.id);
    // The policy: nothing removed it implicitly — the checkout outlives the task that used it.
    expect(envs.get(wt.id)).not.toBeNull();
    envs.delete(wt.id);
    expect(envs.get(wt.id)).toBeNull();
  });

  it("refuses to remove a space's primary checkout, and 404s an unknown id", () => {
    const envs = new EnvironmentsStore(db); const sp = space();
    const primary = envs.ensurePrimary(sp.id);
    expect(() => envs.delete(primary.id)).toThrow(RpcError);
    expect(() => envs.delete(primary.id)).toThrow(/primary checkout cannot be removed/);
    expect(envs.get(primary.id)).not.toBeNull();
    expect(() => envs.delete("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toThrow(NotFoundError);
  });

  it("space delete cascades to its environments", () => {
    const envs = new EnvironmentsStore(db); const spaces = new SpacesStore(db, home); const sp = space();
    envs.ensurePrimary(sp.id); envs.create({ spaceId: sp.id, path: "/tmp/wt", kind: "worktree" });
    spaces.delete(sp.id);
    expect(envs.list(sp.id)).toEqual([]);
  });
});
