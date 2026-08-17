import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Db } from "../db/database";
import { ProfilesStore } from "./profiles";
import { SpacesStore } from "./spaces";
import { ProjectsStore } from "./projects";
import { ItemsStore } from "./items";
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
