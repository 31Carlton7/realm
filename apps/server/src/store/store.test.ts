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
import { emptyLayout } from "@realm/contracts";

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
