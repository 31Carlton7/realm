import { describe, expect, it } from "vitest";
import type { ProjectFileList } from "@realm/contracts";
import { MENTION_FILES_TTL_MS, MentionFiles } from "./mention-files";

/** The `@` list's Files group over a scripted listing — what git says is in the checkout. */
function setup(paths: string[]) {
  let clock = 0;
  let listings = 0;
  let fail = false;
  const files = new MentionFiles({
    now: () => clock,
    search: {
      listFiles: async (): Promise<ProjectFileList> => {
        listings++;
        if (fail) throw new Error("git went away");
        return { paths, truncated: false, source: "git" };
      },
    },
  });
  return { files, advance: (ms: number) => { clock += ms; }, listings: () => listings, failNext: (v: boolean) => { fail = v; } };
}

describe("the @ list's files", () => {
  it("never offers a file that holds secrets, even one git lists", async () => {
    const s = setup(["src/env.ts", ".env", "apps/web/.env.local", ".env.example", "deploy/site.pem", "README.md"]);
    const all = (await s.files.files("/repo", "", 20)).hits.map((h) => h.path);
    // THE listed-anyway mutant: hand the ranker git's list as it came.
    expect(all).toEqual(["src/env.ts", ".env.example", "README.md"]);
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
