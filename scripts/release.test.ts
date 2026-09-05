import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import {
  bumpPackageJsonText, bumpVersion, changelogEntries, entriesFromGh, missingArtifacts, nextStepsText,
  parseReleaseArgs, prEntryFromSubject, prependChangelog, release, renderStub,
} from "./release.mjs";

describe("parseReleaseArgs", () => {
  it("defaults to a patch, not a dry run", () => {
    expect(parseReleaseArgs([])).toEqual({ kind: "patch", dryRun: false });
  });
  it("--minor / --major pick the bump; --dry-run rides along", () => {
    expect(parseReleaseArgs(["--minor"])).toEqual({ kind: "minor", dryRun: false });
    expect(parseReleaseArgs(["--major", "--dry-run"])).toEqual({ kind: "major", dryRun: true });
  });
  it("refuses --minor with --major, and unknown flags", () => {
    expect(() => parseReleaseArgs(["--minor", "--major"])).toThrow(/exclusive/);
    expect(() => parseReleaseArgs(["--patch"])).toThrow(/unknown flag --patch/);
  });
});

describe("bumpVersion — the bump math, mutation-grade", () => {
  it("patch increments the last field only", () => {
    expect(bumpVersion("0.0.1", "patch")).toBe("0.0.2");
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(bumpVersion("0.0.9", "patch")).toBe("0.0.10"); // numeric, not lexicographic
  });
  it("minor increments the middle field and RESETS patch", () => {
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(bumpVersion("0.0.1", "minor")).toBe("0.1.0");
  });
  it("major increments the first field and RESETS both below it", () => {
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
    expect(bumpVersion("0.9.9", "major")).toBe("1.0.0");
  });
  it("refuses anything that isn't plain x.y.z", () => {
    expect(() => bumpVersion("1.2", "patch")).toThrow(/non-semver/);
    expect(() => bumpVersion("1.2.3-beta.1", "patch")).toThrow(/non-semver/);
    expect(() => bumpVersion("v1.2.3", "patch")).toThrow(/non-semver/);
  });
});

describe("bumpPackageJsonText — surgical, never a reformat", () => {
  it("replaces only the version value; every other byte survives", () => {
    const text = `{\n  "name": "@realm/desktop",\n  "version": "0.0.1",\n  "//dependencies": "intentionally none"\n}\n`;
    expect(bumpPackageJsonText(text, "0.0.2")).toBe(text.replace(`"version": "0.0.1"`, `"version": "0.0.2"`));
  });
  it("refuses zero or multiple version keys rather than guessing", () => {
    expect(() => bumpPackageJsonText(`{"name":"x"}`, "1.0.0")).toThrow(/found 0/);
    expect(() => bumpPackageJsonText(`{"version":"1","deps":{"version":"2"}}`, "1.0.0")).toThrow(/found 2/);
  });
});

describe("changelog degradation ladder (the named logic)", () => {
  it("PR-shaped subjects win: only they become entries, verbatim", () => {
    const r = changelogEntries(["Plan 13 — orchestration (#17)", "fixup lint", "Plan 14 — polish (#16)"]);
    expect(r).toEqual({ source: "pr-titles", entries: ["Plan 13 — orchestration (#17)", "Plan 14 — polish (#16)"] });
  });
  it("no PR-shaped subjects at all: degrade to plain commit subjects, merge noise dropped", () => {
    const r = changelogEntries(["fix the pty flake", "Merge branch 'main' into feat/x", "docs: notes"]);
    expect(r).toEqual({ source: "commit-subjects", entries: ["fix the pty flake", "docs: notes"] });
  });
  it("empty history degrades to empty entries, not a crash", () => {
    expect(changelogEntries([])).toEqual({ source: "commit-subjects", entries: [] });
  });
  it("prEntryFromSubject only matches a real trailing (#N)", () => {
    expect(prEntryFromSubject("Title (#12)")).toBe("Title (#12)");
    expect(prEntryFromSubject("Title (#12) plus")).toBeNull();
    expect(prEntryFromSubject("Title #12")).toBeNull();
    expect(prEntryFromSubject("(#12)")).toBeNull(); // a number with no title is not an entry
  });
});

describe("entriesFromGh", () => {
  const rows = [
    { number: 16, title: "Plan 14 — polish", mergedAt: "2026-08-20T10:00:00Z" },
    { number: 17, title: "Plan 13 — orchestration", mergedAt: "2026-08-30T10:00:00Z" },
    { number: 15, title: "Old one", mergedAt: "2026-08-01T10:00:00Z" },
  ];
  it("filters to strictly after sinceIso and sorts newest first", () => {
    expect(entriesFromGh(rows, "2026-08-10T00:00:00Z")).toEqual([
      "Plan 13 — orchestration (#17)",
      "Plan 14 — polish (#16)",
    ]);
  });
  it("a PR merged exactly AT the tag's instant is excluded — it was in the last release", () => {
    expect(entriesFromGh(rows, "2026-08-20T10:00:00Z")).toEqual(["Plan 13 — orchestration (#17)"]);
  });
  it("no previous tag (null since): everything, still newest first", () => {
    expect(entriesFromGh(rows, null)).toHaveLength(3);
    expect(entriesFromGh(rows, null)[0]).toBe("Plan 13 — orchestration (#17)");
  });
  it("malformed rows and non-array payloads degrade to nothing, not a crash", () => {
    expect(entriesFromGh([{ number: "x", title: 3 }, null, { title: "ok", number: 1, mergedAt: "2026-01-01T00:00:00Z" }] as never, null))
      .toEqual(["ok (#1)"]);
    expect(entriesFromGh({ not: "an array" } as never, null)).toEqual([]);
  });
});

describe("renderStub + prependChangelog", () => {
  it("stub carries version, date, provenance, and the entries as bullets", () => {
    const s = renderStub("0.0.2", "2026-09-01", ["A (#1)"], "pr-titles");
    expect(s).toContain("## v0.0.2 — 2026-09-01");
    expect(s).toContain("merged PR titles");
    expect(s).toContain("- A (#1)");
  });
  it("the commit-subjects provenance admits it degraded", () => {
    expect(renderStub("0.0.2", "2026-09-01", ["x"], "commit-subjects")).toContain("PR titles unavailable");
  });
  it("no entries still yields an honest fill-this-in bullet", () => {
    expect(renderStub("0.0.2", "2026-09-01", [], "commit-subjects")).toContain("fill this in");
  });
  it("first release creates the file with its header; later ones insert newest-first UNDER the header", () => {
    const first = prependChangelog(null, "## v0.0.2 — d\n\nbody\n");
    expect(first.startsWith("# Changelog\n\n## v0.0.2")).toBe(true);
    const second = prependChangelog(first, "## v0.0.3 — d\n\nbody3\n");
    expect(second.indexOf("## v0.0.3")).toBeLessThan(second.indexOf("## v0.0.2"));
    expect(second.startsWith("# Changelog\n")).toBe(true);
  });
  it("a headerless existing file survives on top of nothing lost", () => {
    const out = prependChangelog("old notes\n", "## v1 stub\n");
    expect(out.indexOf("## v1 stub")).toBeLessThan(out.indexOf("old notes"));
    expect(out).toContain("old notes");
  });
});

describe("missingArtifacts — version-matched by shape, not exact name", () => {
  it("all three present: nothing missing", () => {
    expect(missingArtifacts(["Realm-0.0.2-arm64.dmg", "Realm-0.0.2-arm64-mac.zip", "latest-mac.yml"], "0.0.2")).toEqual([]);
  });
  it("a stale version's dmg does NOT satisfy the new release", () => {
    const m = missingArtifacts(["Realm-0.0.1-arm64.dmg", "Realm-0.0.2-arm64-mac.zip", "latest-mac.yml"], "0.0.2");
    expect(m).toEqual(["a 0.0.2 .dmg"]);
  });
  it("each absence is named", () => {
    expect(missingArtifacts([], "0.0.2")).toEqual(["a 0.0.2 .dmg", "a 0.0.2 .zip", "latest-mac.yml"]);
  });
});

// Everything below is integration: a real scratch git repo on disk, with build and gh stubbed
// through the exec seam.

function realExec(cmd: string, args: string[], opts: { cwd?: string; timeout?: number; stdio?: unknown } = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
}

describe("release() end to end in a scratch repo (no pushing, no publishing — by construction)", () => {
  let root: string;
  const logs: string[] = [];
  const log = (s: string) => logs.push(s);

  /** exec that is REAL git, stubbed pnpm (drops fake artifacts) and gh (behaves as scripted). */
  const makeExec = (opts: { gh?: "ok" | "offline"; distFails?: boolean } = {}) =>
    (cmd: string, args: string[], o: { cwd?: string } = {}) => {
      if (cmd === "pnpm" && args[0] === "dist") {
        if (opts.distFails) throw new Error("electron-builder exploded");
        const version = JSON.parse(readFileSync(join(root, "apps", "desktop", "package.json"), "utf8")).version;
        const dir = join(root, "apps", "desktop", "release");
        mkdirSync(dir, { recursive: true });
        for (const f of [`Realm-${version}-arm64.dmg`, `Realm-${version}-arm64-mac.zip`, "latest-mac.yml"]) writeFileSync(join(dir, f), "artifact");
        return "";
      }
      if (cmd === "gh") {
        if (opts.gh === "ok") return JSON.stringify([{ number: 21, title: "Ship the thing", mergedAt: "2026-08-30T00:00:00Z" }]);
        throw new Error("gh: could not connect");
      }
      return realExec(cmd, args, o);
    };

  beforeEach(() => {
    logs.length = 0;
    root = tempDir("realm-release-");
    realExec("git", ["init", "-q", "-b", "main"], { cwd: root });
    realExec("git", ["config", "user.email", "t@t"], { cwd: root });
    realExec("git", ["config", "user.name", "t"], { cwd: root });
    mkdirSync(join(root, "apps", "desktop"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "apps/desktop/release/\n"); // as the real repo ignores it
    writeFileSync(join(root, "apps", "desktop", "package.json"), `{\n  "name": "@realm/desktop",\n  "version": "0.0.1"\n}\n`);
    realExec("git", ["add", "-A"], { cwd: root });
    realExec("git", ["commit", "-q", "-m", "Plan 13 — orchestration (#17)"], { cwd: root });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("bumps, writes the stub, builds, commits and tags LOCALLY — and prints the manual next steps", () => {
    const r = release({ root, argv: [], exec: makeExec({ gh: "offline" }), log });
    expect(r).toMatchObject({ next: "0.0.2", tag: "v0.0.2", source: "pr-titles", dryRun: false });
    expect(JSON.parse(readFileSync(join(root, "apps", "desktop", "package.json"), "utf8")).version).toBe("0.0.2");
    const cl = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    expect(cl).toContain("## v0.0.2");
    expect(cl).toContain("- Plan 13 — orchestration (#17)");
    expect(realExec("git", ["log", "-1", "--pretty=%s"], { cwd: root }).trim()).toBe("release: v0.0.2");
    expect(realExec("git", ["tag", "--list"], { cwd: root }).trim()).toBe("v0.0.2");
    expect(realExec("git", ["status", "--porcelain"], { cwd: root }).trim()).toBe(""); // everything committed
    const out = logs.join("\n");
    expect(out).toContain("nothing was pushed, nothing was published");
    expect(out).toContain("git push origin main && git push origin v0.0.2");
    expect(out).toContain("gh release create v0.0.2 --draft");
    expect(out).toContain("Realm-0.0.2-arm64.dmg");
  });

  it("gh answering takes the top rung: entries come from PR titles via gh", () => {
    const r = release({ root, argv: ["--minor"], exec: makeExec({ gh: "ok" }), log });
    expect(r.next).toBe("0.1.0");
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toContain("- Ship the thing (#21)");
  });

  it("dry run computes the same plan and writes NOTHING — no bump, no changelog, no commit, no tag", () => {
    const before = realExec("git", ["rev-parse", "HEAD"], { cwd: root }).trim();
    const r = release({ root, argv: ["--dry-run"], exec: makeExec({ gh: "offline" }), log });
    expect(r).toMatchObject({ next: "0.0.2", dryRun: true });
    expect(JSON.parse(readFileSync(join(root, "apps", "desktop", "package.json"), "utf8")).version).toBe("0.0.1");
    expect(() => readFileSync(join(root, "CHANGELOG.md"))).toThrow();
    expect(realExec("git", ["rev-parse", "HEAD"], { cwd: root }).trim()).toBe(before);
    expect(realExec("git", ["tag", "--list"], { cwd: root }).trim()).toBe("");
  });

  it("a dirty tree is refused before anything happens", () => {
    writeFileSync(join(root, "scratch.txt"), "x");
    expect(() => release({ root, argv: [], exec: makeExec({}), log })).toThrow(/not clean/);
  });

  it("a failed build leaves the bump in the tree but makes NO commit and NO tag, and says so", () => {
    expect(() => release({ root, argv: [], exec: makeExec({ distFails: true }), log })).toThrow(/NO commit or tag was made/);
    expect(JSON.parse(readFileSync(join(root, "apps", "desktop", "package.json"), "utf8")).version).toBe("0.0.2");
    expect(realExec("git", ["tag", "--list"], { cwd: root }).trim()).toBe("");
    expect(realExec("git", ["log", "-1", "--pretty=%s"], { cwd: root }).trim()).not.toContain("release:");
  });

  it("an existing tag for the target version is refused up front", () => {
    realExec("git", ["tag", "v0.0.2"], { cwd: root });
    expect(() => release({ root, argv: [], exec: makeExec({}), log })).toThrow(/v0\.0\.2 already exists/);
  });

  it("changelog entries only cover commits since the last tag", () => {
    const exec = makeExec({ gh: "offline" });
    release({ root, argv: [], exec, log }); // v0.0.2 tagged
    writeFileSync(join(root, "next.txt"), "y");
    realExec("git", ["add", "-A"], { cwd: root });
    realExec("git", ["commit", "-q", "-m", "New work after the release (#18)"], { cwd: root });
    release({ root, argv: [], exec, log }); // v0.0.3
    const cl = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const v3 = cl.slice(cl.indexOf("## v0.0.3"), cl.indexOf("## v0.0.2"));
    expect(v3).toContain("New work after the release (#18)");
    expect(v3).not.toContain("Plan 13"); // already released in v0.0.2
  });
});
