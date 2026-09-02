import { describe, it, expect } from "vitest";
import type { Environment, Profile, Project, Space } from "@realm/contracts";
import { MATCH_MAX_HOPS, matchSpace, type MatchWorld } from "./match";

const T = { createdAt: 0, updatedAt: 0 };
const space = (id: string, name: string, folderPath: string, profileId = "P1"): Space => ({
  id, profileId, name, icon: "folder", color: "#000000", sortOrder: 0, folderPath,
  layout: null, activeItemId: null, ...T,
});
const env = (id: string, spaceId: string, path: string): Environment => ({
  id, spaceId, path, branch: null, kind: "checkout", portBlockStart: null, ...T,
});
const project = (id: string, spaceId: string, name: string, rootPath: string): Project => ({
  id, spaceId, name, rootPath, defaultBranch: "main", ...T,
});
const profile = (id: string, name: string, sortOrder: number): Profile => ({ id, name, icon: "user", color: "#000000", sortOrder, ...T });

const PROFILES = [profile("P1", "Work", 0), profile("P2", "School", 1), profile("P3", "Personal", 2)];
const world = (over: Partial<MatchWorld> = {}): MatchWorld => ({ spaces: [], environments: [], projects: [], profiles: PROFILES, ...over });

describe("matchSpace — evidence order", () => {
  const versed = space("S1", "Versed", "/Users/me/Realm/work/versed");
  const realm = space("S2", "Realm", "/Users/me/Realm/work/realm");

  it("an environment at the cwd wins", () => {
    const m = matchSpace("/Users/me/Realm/work/realm", world({ spaces: [versed, realm], environments: [env("E1", "S2", "/Users/me/Realm/work/realm")] }));
    expect(m).toMatchObject({ spaceId: "S2", reason: "environment" });
  });

  it("a project root at the cwd wins when no environment is there", () => {
    const m = matchSpace("/Users/me/Projects/realm", world({ spaces: [versed, realm], projects: [project("PR1", "S2", "realm", "/Users/me/Projects/realm")] }));
    expect(m).toMatchObject({ spaceId: "S2", reason: "project" });
  });

  it("the space's own folder matches", () => {
    expect(matchSpace("/Users/me/Realm/work/versed", world({ spaces: [versed] }))).toMatchObject({ spaceId: "S1", reason: "space-folder" });
  });

  it("a directory named after a space matches, case- and punctuation-insensitively", () => {
    const csci = space("S3", "CSCI 360", "/Users/me/Realm/school/csci-360");
    const m = matchSpace("/Users/me/Desktop/csci_360", world({ spaces: [csci] }));
    expect(m).toMatchObject({ spaceId: "S3", reason: "basename" });
  });

  it("a `<name>-worktrees` sibling belongs to the space it is named after", () => {
    const m = matchSpace("/Users/me/Projects/realm-worktrees/durable-runs", world({ spaces: [realm] }));
    expect(m).toMatchObject({ spaceId: "S2", reason: "basename" });
  });

  it("does not treat `/a/realm-worktrees` as inside `/a/realm` (segment-aware containment)", () => {
    // The project root is `/Users/me/Projects/realm`; a naive prefix test would swallow the sibling
    // `realm-worktrees` tree into it, which would then also outrank the directory-name rule.
    const solo = space("S9", "Nothing", "/Users/me/Realm/work/nothing");
    const m = matchSpace("/Users/me/Projects/realm-worktrees/x", world({ spaces: [solo], projects: [project("PR1", "S9", "realm", "/Users/me/Projects/realm")] }));
    expect(m.spaceId).toBeNull();
  });
});

describe("matchSpace — most specific location wins", () => {
  // The regression this feature was rebuilt around. On the developer's machine a `Project` row
  // registered `~/Desktop/Home` — an ancestor of essentially everything — to one space, and a matcher
  // that ordered RULES without ordering PATHS filed 255 of 290 transcripts under it.
  const home = project("PR1", "S2", "Home", "/Users/me/Desktop/Home");
  const versed = space("S1", "Versed", "/Users/me/Realm/work/versed");
  const realm = space("S2", "Realm", "/Users/me/Realm/work/realm");
  const w = world({ spaces: [versed, realm], projects: [home] });

  it("a directory named after a space beats a project root five levels up", () => {
    expect(matchSpace("/Users/me/Desktop/Home/Work/Projects/versed", w)).toMatchObject({ spaceId: "S1", reason: "basename" });
  });

  it("an over-broad ancestor beyond the hop bound is not used at all", () => {
    expect(matchSpace("/Users/me/Desktop/Home/Work/Projects/stora/ravens", w).spaceId).toBeNull();
    expect(matchSpace("/Users/me/Desktop/Home/Work/Projects", w).spaceId).toBeNull();
  });

  it("containment still works within the bound", () => {
    // Exactly at the cwd, and exactly one hop up — a session in `repo/packages` belongs to `repo`.
    expect(matchSpace("/Users/me/Desktop/Home", w)).toMatchObject({ spaceId: "S2", reason: "project" });
    expect(matchSpace("/Users/me/Desktop/Home/Work", w)).toMatchObject({ spaceId: "S2", reason: "project" });
    expect(MATCH_MAX_HOPS).toBe(1);
  });
});

describe("matchSpace — ties are refused, never broken", () => {
  it("two spaces named the same produce no match", () => {
    const a = space("S1", "Notes", "/Users/me/Realm/a/notes");
    const b = space("S2", "notes", "/Users/me/Realm/b/notes2");
    expect(matchSpace("/Users/me/Desktop/notes", world({ spaces: [a, b] })).spaceId).toBeNull();
  });

  it("two spaces registering the same project root produce no match", () => {
    const a = space("S1", "A", "/Users/me/Realm/a");
    const b = space("S2", "B", "/Users/me/Realm/b");
    const w = world({ spaces: [a, b], projects: [project("P1", "S1", "shared", "/Users/me/repo"), project("P2", "S2", "shared", "/Users/me/repo")] });
    expect(matchSpace("/Users/me/repo", w).spaceId).toBeNull();
  });

  it("two environments of the SAME space at one path are not a tie", () => {
    const a = space("S1", "A", "/Users/me/Realm/a");
    const w = world({ spaces: [a], environments: [env("E1", "S1", "/Users/me/repo"), env("E2", "S1", "/Users/me/repo")] });
    expect(matchSpace("/Users/me/repo", w)).toMatchObject({ spaceId: "S1", reason: "environment" });
  });

  it("evidence pointing at a deleted space is ignored", () => {
    const w = world({ spaces: [], environments: [env("E1", "GONE", "/Users/me/repo")] });
    expect(matchSpace("/Users/me/repo", w).spaceId).toBeNull();
  });
});

describe("matchSpace — profile fallback", () => {
  it("reads a profile name from anywhere in the path, not just the bounded walk", () => {
    const m = matchSpace("/Users/me/Desktop/Home/School/SP26-EE-451/hw3", world());
    expect(m).toMatchObject({ spaceId: null, fallbackProfileId: "P2", reason: "fallback" });
    expect(m.evidence).toContain("School");
  });

  it("defaults to the first profile by sort order, and says so", () => {
    const m = matchSpace("/Users/me/Downloads", world());
    expect(m.fallbackProfileId).toBe("P1");
    expect(m.evidence).toContain("no path evidence");
  });

  it("an empty cwd still falls back rather than failing", () => {
    expect(matchSpace("", world())).toMatchObject({ fallbackProfileId: "P1", reason: "fallback" });
  });

  it("with no profiles at all there is nowhere to put anything", () => {
    expect(matchSpace("/Users/me/x", world({ profiles: [] }))).toMatchObject({ spaceId: null, fallbackProfileId: null, reason: "none" });
  });

  it("an ambiguous profile name matches nothing rather than guessing", () => {
    const w = world({ profiles: [profile("P1", "Work", 0), profile("P2", "work", 1)] });
    expect(matchSpace("/Users/me/Work/x", w).evidence).toContain("no path evidence");
  });
});
