import { describe, expect, it } from "vitest";
import type { ProjectFileList } from "@realm/contracts";
import { MENTION_FILES_TTL_MS, MentionFiles, porcelainPaths, tourOrder } from "./mention-files";
import type { GitRun } from "./git-exec";

/** The `@` list's Files group over a scripted listing — what git says is in the checkout. */
function setup(paths: string[], status: string | null = null) {
  let clock = 0;
  let listings = 0;
  let fail = false;
  const statusCalls: string[][] = [];
  const git: GitRun = async (_cwd, args) => { statusCalls.push(args); return { code: status === null ? 128 : 0, stdout: status ?? "", stderr: "" }; };
  const files = new MentionFiles({
    now: () => clock, git,
    search: {
      listFiles: async (): Promise<ProjectFileList> => {
        listings++;
        if (fail) throw new Error("git went away");
        return { paths, truncated: false, source: "git" };
      },
    },
  });
  return { files, advance: (ms: number) => { clock += ms; }, listings: () => listings, failNext: (v: boolean) => { fail = v; }, statusCalls };
}

describe("the @ list's files", () => {
  it("leads a bare @ with what the checkout has changed, and puts hidden paths last", async () => {
    const s = setup([".github/ci.yml", ".gitignore", "README.md", "src/a.ts", "src/b.ts", "src/c.ts"], " M src/c.ts\0?? .gitignore\0R  src/b.ts\0src/old.ts\0");
    // THE listing-order mutant: the first four files git happens to list, dotfiles first.
    expect((await s.files.files("/repo", "", 8)).hits.map((h) => h.path)).toEqual(["src/b.ts", "src/c.ts", "README.md", "src/a.ts", ".gitignore", ".github/ci.yml"]);
    // Asked once per listing, and never for a typed query, which ranks instead.
    await s.files.files("/repo", "", 8);
    await s.files.files("/repo", "a", 8);
    expect(s.statusCalls).toHaveLength(1);
    expect(s.statusCalls[0]).toEqual(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  });

  it("reads git status's paths — a rename's new name, never its old one", () => {
    expect(porcelainPaths(" M src/a.ts\0R  new.ts\0old.ts\0?? notes/x.md\0")).toEqual(["src/a.ts", "new.ts", "notes/x.md"]);
    expect(porcelainPaths("")).toEqual([]);
    expect(tourOrder(["b", "a"], new Set())).toEqual(["b", "a"]); // nothing changed: git's order, as listed
  });

  it("never offers a file that holds secrets, even one git lists", async () => {
    const s = setup(["src/env.ts", ".env", "apps/web/.env.local", ".env.example", "deploy/site.pem", "README.md"]);
    const all = (await s.files.files("/repo", "", 20)).hits.map((h) => h.path);
    // THE listed-anyway mutant: hand the ranker git's list as it came.
    expect(all).toEqual(["src/env.ts", "README.md", ".env.example"]);
    expect((await s.files.files("/repo", "env", 20)).hits.map((h) => h.path)).not.toContain(".env");
  });

  it("ranks with ⌘P's ranker — a name that starts with the query over letters scattered down a path", async () => {
    const s = setup(["src/a/u/t/h.ts", "src/server/auth.ts"]);
    expect((await s.files.files("/repo", "auth", 8)).hits.map((h) => h.path)).toEqual(["src/server/auth.ts", "src/a/u/t/h.ts"]);
  });

  it("reads a checkout once per burst of typing, and again once the burst is over", async () => {
    const s = setup(["a.ts"]);
    await Promise.all([s.files.files("/repo", "a", 8), s.files.files("/repo", "a.", 8)]);
    await s.files.files("/repo", "a.t", 8);
    expect(s.listings()).toBe(1);
    s.advance(MENTION_FILES_TTL_MS);
    await s.files.files("/repo", "a.ts", 8);
    expect(s.listings()).toBe(2);
    await s.files.files("/other", "", 8);
    expect(s.listings()).toBe(3);
  });

  it("does not keep a failed listing — the next keystroke asks again", async () => {
    const s = setup(["a.ts"]);
    s.failNext(true);
    await expect(s.files.files("/repo", "a", 8)).rejects.toThrow(/git went away/);
    s.failNext(false);
    expect((await s.files.files("/repo", "a", 8)).hits.map((h) => h.path)).toEqual(["a.ts"]);
  });
});
