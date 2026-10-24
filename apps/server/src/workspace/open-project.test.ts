import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { openDatabase } from "../db/database";
import { EnvironmentsStore } from "../store/environments";
import { ProfilesStore } from "../store/profiles";
import { ProjectsStore } from "../store/projects";
import { SpacesStore } from "../store/spaces";
import { openProject, type OpenProjectDeps } from "./open-project";

let d: OpenProjectDeps;
beforeEach(() => {
  const home = tempDir("realm-openproj-");
  const db = openDatabase(join(home, "realm.db"));
  d = { profiles: new ProfilesStore(db), spaces: new SpacesStore(db, home), projects: new ProjectsStore(db), environments: new EnvironmentsStore(db) };
  d.profiles.create({ name: "Personal", icon: "user", color: "#000" });
});

describe("openProject", () => {
  it("makes a space named after the folder, a project and a checkout environment — once", () => {
    const repo = tempDir("realm-repo-");
    const first = openProject(d, { path: repo });
    expect(first.createdSpace).toBe(true);
    expect(first.space.name).toBe(basename(realpathSync(repo)));
    expect(first.project).toMatchObject({ spaceId: first.space.id, rootPath: realpathSync(repo) });
    expect(first.environment).toMatchObject({ spaceId: first.space.id, path: realpathSync(repo), kind: "checkout" });

    const again = openProject(d, { path: repo });
    expect(again.createdSpace).toBe(false);
    expect([again.space.id, again.project.id, again.environment.id]).toEqual([first.space.id, first.project.id, first.environment.id]);
    expect(d.spaces.listAll()).toHaveLength(1);
  });

  it("treats a symlinked path as the checkout it points at", () => {
    const repo = tempDir("realm-repo-");
    const link = join(tempDir("realm-link-"), "via-link");
    symlinkSync(repo, link);
    expect(openProject(d, { path: link }).project.id).toBe(openProject(d, { path: repo }).project.id);
  });

  it("puts the project in the space it was asked for, separately from one elsewhere", () => {
    const repo = tempDir("realm-repo-");
    const elsewhere = openProject(d, { path: repo });
    const space = d.spaces.create({ profileId: d.profiles.list()[0]!.id, name: "Mine", icon: "folder" });
    const here = openProject(d, { path: repo, spaceId: space.id });
    expect(here.createdSpace).toBe(false);
    expect(here.space.id).toBe(space.id);
    expect(here.project.id).not.toBe(elsewhere.project.id);
    expect(openProject(d, { path: repo, spaceId: space.id }).project.id).toBe(here.project.id);
  });

  it("refuses a relative path, a file and a missing folder", () => {
    const dir = tempDir("realm-repo-");
    writeFileSync(join(dir, "f.txt"), "x");
    mkdirSync(join(dir, "sub"));
    expect(() => openProject(d, { path: "sub" })).toThrow(expect.objectContaining({ code: "PATH_NOT_ABSOLUTE" }));
    expect(() => openProject(d, { path: join(dir, "f.txt") })).toThrow(expect.objectContaining({ code: "PATH_NOT_DIRECTORY" }));
    expect(() => openProject(d, { path: join(dir, "missing") })).toThrow(expect.objectContaining({ code: "PATH_NOT_DIRECTORY" }));
    expect(d.spaces.listAll()).toHaveLength(0);
  });
});
