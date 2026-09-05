import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { assignRootKeys, pluginRoots, scan, scanRoots, tildify, type ScanRoot } from "./discovery";

let home: string;

/** A skill directory with a valid SKILL.md, under an arbitrary root. */
const skill = (root: string, id: string) => {
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, "SKILL.md"), `---\nname: ${id}\ndescription: does ${id}.\n---\n`);
};

const write = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
};

beforeEach(() => { home = tempDir("realm-discovery-"); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const library = () => join(home, "Realm", "skills");
const roots = (extra?: { projectDir?: string; extraRoots?: string[] }) =>
  scanRoots({ home, libraryRoot: library(), ...extra });

describe("scanRoots", () => {
  it("finds the per-user agent directories that exist, and invents none that do not", () => {
    skill(join(home, ".claude", "skills"), "a");
    skill(join(home, ".codex", "skills"), "b");
    const keys = roots().map((r) => r.key);
    expect(keys).toEqual(["library", "claude", "codex"]);
    // `.agents` and `.cursor` are absent from disk, so absent from the scan — an empty root that does
    // not exist would show the user a folder Realm invented.
    expect(keys).not.toContain("agents");
    expect(keys).not.toContain("cursor");
  });

  it("puts the library first, which is what keeps library ids bare", () => {
    skill(library(), "mac");
    skill(join(home, ".agents", "skills"), "other");
    expect(roots()[0]!.kind).toBe("library");
    expect(scan(roots()).map((e) => e.id)).toEqual(["mac", "agents.other"]);
  });

  it("keys a project's directories apart from the user's — same basename, different tree", () => {
    const project = join(home, "repo");
    skill(join(home, ".claude", "skills"), "a");
    skill(join(project, ".claude", "skills"), "b");
    const found = scan(roots({ projectDir: project }));
    // The named mutant is keying both `claude`, which would collide two unrelated trees into one id
    // space and let a repo's skill inherit a user skill's enabled state.
    expect(found.map((e) => e.id)).toEqual(["claude.a", "project-claude.b"]);
  });

  it("takes user-added directories, and refuses relative or missing ones", () => {
    const extra = join(home, "elsewhere");
    skill(extra, "custom");
    expect(scan(roots({ extraRoots: [extra] })).map((e) => e.id)).toEqual(["elsewhere.custom"]);
    // A relative path would resolve against the server's cwd — not a directory the user ever picked.
    expect(roots({ extraRoots: ["relative/path"] }).some((r) => r.kind === "extra")).toBe(false);
    expect(roots({ extraRoots: [join(home, "nope")] }).some((r) => r.kind === "extra")).toBe(false);
  });
});

describe("scan", () => {
  it("deduplicates by realpath, first root wins", () => {
    // The real shape on this machine: ~/.claude/skills is a field of symlinks into ~/.agents/skills.
    // Listing both would double every row and give one directory two independent toggles.
    skill(join(home, ".agents", "skills"), "shared");
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    symlinkSync(join(home, ".agents", "skills", "shared"), join(home, ".claude", "skills", "shared"), "dir");
    const found = scan(roots());
    expect(found).toHaveLength(1);
    // `.agents` is listed before `.claude` precisely so the survivor is keyed at the directory the
    // file really lives in — the one that survives unlinking Claude.
    expect(found[0]!.id).toBe("agents.shared");
  });

  it("skips a directory with no SKILL.md outside the library, but keeps one inside it", () => {
    mkdirSync(join(library(), "half-made"), { recursive: true });
    mkdirSync(join(home, ".agents", "skills", "not-a-skill"), { recursive: true });
    // The library folder is the user's own: a broken skill there has to be listed, with a reason, or
    // a typo in frontmatter becomes silence. Someone else's stray folder is not Realm's to report.
    expect(scan(roots()).map((e) => e.id)).toEqual(["half-made"]);
  });

  it("skips names that could not be addressed as an id", () => {
    skill(join(home, ".agents", "skills"), "fine");
    mkdirSync(join(home, ".agents", "skills", "has space"), { recursive: true });
    writeFileSync(join(home, ".agents", "skills", "has space", "SKILL.md"), "---\nname: x\ndescription: y\n---\n");
    expect(scan(roots()).map((e) => e.id)).toEqual(["agents.fine"]);
  });

  it("gives every entry a unique id even when two roots hold the same name", () => {
    skill(join(home, ".agents", "skills"), "find-skills");
    skill(join(home, ".codex", "skills"), "find-skills");
    const found = scan(roots());
    expect(found.map((e) => e.id)).toEqual(["agents.find-skills", "codex.find-skills"]);
    expect(new Set(found.map((e) => e.id)).size).toBe(found.length);
  });
});

describe("pluginRoots", () => {
  const manifest = (plugins: Record<string, string>) =>
    write(join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: Object.fromEntries(Object.entries(plugins).map(([k, p]) => [k, [{ installPath: p }]])) }));

  it("reads installed_plugins.json rather than globbing the cache", () => {
    const live = join(home, ".claude", "plugins", "cache", "mkt", "figma", "2.2.96");
    const stale = join(home, ".claude", "plugins", "cache", "mkt", "figma", "2.2.90");
    skill(join(live, "skills"), "figma-use");
    skill(join(stale, "skills"), "figma-use");
    manifest({ "figma@mkt": live });
    // The cache is a history, not an inventory. Globbing it surfaced 36 name collisions on the author's
    // machine, every one of them a stale version or an uninstalled plugin.
    expect(pluginRoots(home).map((r) => r.path)).toEqual([join(live, "skills")]);
    expect(scan(roots()).map((e) => e.id)).toEqual(["figma.figma-use"]);
  });

  it("drops a plugin the user switched off in settings.json", () => {
    const p = join(home, ".claude", "plugins", "cache", "mkt", "vercel", "1.0.0");
    skill(join(p, "skills"), "nextjs");
    manifest({ "vercel@mkt": p });
    write(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "vercel@mkt": false } }));
    expect(pluginRoots(home)).toEqual([]);
  });

  it("treats an absent enabledPlugins as nothing-switched-off, not everything-off", () => {
    const p = join(home, ".claude", "plugins", "cache", "mkt", "vercel", "1.0.0");
    skill(join(p, "skills"), "nextjs");
    manifest({ "vercel@mkt": p });
    write(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
    expect(pluginRoots(home)).toHaveLength(1);
  });

  it("survives a manifest that is missing, empty, or not JSON at all", () => {
    expect(pluginRoots(home)).toEqual([]);
    write(join(home, ".claude", "plugins", "installed_plugins.json"), "{ not json");
    expect(pluginRoots(home)).toEqual([]);
    write(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "x@y": [] } }));
    expect(pluginRoots(home)).toEqual([]);
  });

  it("skips a plugin whose install path is gone", () => {
    manifest({ "ghost@mkt": join(home, "nowhere") });
    expect(pluginRoots(home)).toEqual([]);
  });
});

describe("assignRootKeys", () => {
  it("suffixes a repeat rather than letting two roots share an id space", () => {
    const input: ScanRoot[] = [
      { kind: "extra", key: "skills", label: "a", path: "/a" },
      { kind: "extra", key: "skills", label: "b", path: "/b" },
      { kind: "extra", key: "skills", label: "c", path: "/c" },
    ];
    expect(assignRootKeys(input).map((r) => r.key)).toEqual(["skills", "skills-2", "skills-3"]);
  });
});

describe("tildify", () => {
  it("shortens a path under home and leaves anything else alone", () => {
    expect(tildify("/Users/x/.agents/skills", "/Users/x")).toBe("~/.agents/skills");
    expect(tildify("/Users/x", "/Users/x")).toBe("~");
    expect(tildify("/opt/skills", "/Users/x")).toBe("/opt/skills");
    // A sibling that merely starts with the same characters is not inside home.
    expect(tildify("/Users/xavier/skills", "/Users/x")).toBe("/Users/xavier/skills");
  });
});
