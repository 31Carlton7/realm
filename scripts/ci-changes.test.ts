import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { touchesDesktop } from "./ci-changes.mjs";

describe("touchesDesktop", () => {
  it("skips a pull request that only changes the website, the docs or the repo's prose", () => {
    expect(touchesDesktop(["site/app/page.tsx", "site/content/changelog.ts"])).toBe(false);
    expect(touchesDesktop(["docs/architecture/README.md", "docs/images/models.png"])).toBe(false);
    expect(touchesDesktop(["README.md", "CONTRIBUTING.md", "design.md", "AGENTS.md", "CLAUDE.md"])).toBe(false);
    expect(touchesDesktop([".github/ISSUE_TEMPLATE/bug.yml"])).toBe(false);
  });

  it("runs for any change to the app, its packages, scripts or the workflow", () => {
    for (const f of [
      "apps/desktop/src/renderer/src/App.tsx", "apps/server/src/main.ts", "packages/contracts/src/platform.ts",
      "services/relay/src/core.ts", "scripts/release.mjs", ".github/workflows/build-desktop.yml",
      ".github/actions/setup/action.yml", "package.json", "pnpm-lock.yaml", "tsconfig.base.json", "vitest.config.ts",
    ]) expect(touchesDesktop([f]), f).toBe(true);
  });

  it("runs for the files outside the packages that the app ships or the suite reads", () => {
    // What's New is tested against the real changelog, the icon tests read resources/, skills/ is bundled
    // into the app, and the remote fixtures and the iPhone's palette tests read apps/ios.
    for (const f of [
      "CHANGELOG.md", "resources/icon.png", "skills/realm/SKILL.md", "apps/ios/RealmKit/Tests/Fixtures/swift-vectors.json",
      "apps/ios/scripts/palette.mjs", "LICENSE", "THIRD-PARTY-NOTICES.md",
    ]) expect(touchesDesktop([f]), f).toBe(true);
  });

  it("ignores only those top-level folders and files, not ones that share a name or a prefix", () => {
    for (const f of [
      "apps/server/src/docs/paths.ts", "apps/desktop/site/x.ts", "packages/remote/README.md", "sites/x.ts", "docs.ts",
      "site.config.ts", "README.md.ts",
    ]) expect(touchesDesktop([f]), f).toBe(true);
  });

  it("runs when one file of many is a real change", () => {
    expect(touchesDesktop(["README.md", "docs/platforms.md", "apps/desktop/src/main/index.ts"])).toBe(true);
  });

  it("runs when it was handed no files at all", () => {
    expect(touchesDesktop([])).toBe(true);
  });
});

describe("the script", () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), "ci-changes.mjs");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
  const write = (root: string, path: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `${path}\n`);
  };

  /** A repo whose main has moved on since the branch left it, as a pull request's base usually has. */
  function repo(branchFiles: string[], mainFiles: string[]) {
    const root = tempDir("realm-ci-changes-");
    git(root, "init", "-q", "-b", "main");
    write(root, "apps/desktop/src/a.ts");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "start");
    git(root, "checkout", "-q", "-b", "pr");
    for (const f of branchFiles) write(root, f);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "the pull request");
    git(root, "checkout", "-q", "main");
    for (const f of mainFiles) write(root, f);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "main moves on");
    return { root, base: git(root, "rev-parse", "main"), head: git(root, "rev-parse", "pr") };
  }

  function run(env: Record<string, string>, cwd: string) {
    const out = join(tempDir("realm-ci-changes-out-"), "output");
    writeFileSync(out, "");
    execFileSync(process.execPath, [script], { cwd, env: { ...process.env, ...env, GITHUB_OUTPUT: out }, encoding: "utf8" });
    return readFileSync(out, "utf8");
  }

  it("judges the pull request by its own changes, not by what main changed since it branched", () => {
    // The mutant: a two-dot diff, BASE..HEAD, which also counts main's own commits as the pull request's.
    const { root, base, head } = repo(["docs/platforms.md"], ["apps/desktop/src/b.ts"]);
    expect(run({ BASE: base, HEAD: head }, root)).toBe("desktop=false\n");
  });

  it("runs the pipeline for a pull request that changes code", () => {
    const { root, base, head } = repo(["docs/platforms.md", "apps/desktop/src/b.ts"], ["README.md"]);
    expect(run({ BASE: base, HEAD: head }, root)).toBe("desktop=true\n");
  });

  it("runs everything when there is no base, as on a push to main or a run by hand", () => {
    const { root } = repo(["docs/platforms.md"], ["README.md"]);
    expect(run({ BASE: "" }, root)).toBe("desktop=true\n");
  });
});
