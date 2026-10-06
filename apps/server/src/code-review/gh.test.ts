import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { GhClient, ghRunner } from "./gh";
import { PATCH, fakeGh, pr, type GhFixture } from "./fake-gh.test-fakes";

/**
 * The `gh` adapter against a fake `gh` (scripts/fixtures/fake-gh.mjs): every call's argv and stdin
 * are recorded, so what Realm would send GitHub is asserted exactly — and nothing here can reach
 * GitHub, because the command is a script in a temp dir named by absolute path.
 */
const client = (fixture: GhFixture) => {
  const gh = fakeGh(fixture);
  return { gh, client: new GhClient(ghRunner(gh.command)) };
};
const ref = { owner: "acme", repo: "widgets", number: 42 };

describe("status — gh's three answers, and its absence", () => {
  it("reads the signed-in login from `gh api user`", async () => {
    const { gh, client: c } = client({ user: { login: "carlton" }, prs: {} });
    expect(await c.status()).toEqual({ state: "ready", login: "carlton", reason: null });
    expect(gh.calls().map((x) => x.args)).toEqual([["api", "user"]]);
  });

  it("reads exit 4 as signed out — the state Set up GitHub answers", async () => {
    const { client: c } = client({ auth: "signed-out", prs: {} });
    expect(await c.status()).toMatchObject({ state: "signed-out", login: null });
  });

  it("reads a dropped network as unreachable, not as signed out", async () => {
    // THE MUTANT: any failure read as signed-out sends a person offline to sign in again.
    const { client: c } = client({ auth: "offline", prs: {} });
    expect(await c.status()).toMatchObject({ state: "unreachable", reason: "error connecting to api.github.com" });
  });

  it("reads no gh at all as missing", async () => {
    const c = new GhClient(ghRunner(join(tempDir("realm-no-gh-"), "gh")));
    expect(await c.status()).toEqual({ state: "missing", login: null, reason: null });
  });
});

describe("search — a page of a list", () => {
  const fixture: GhFixture = {
    sections: { review: ["acme/widgets#42", "acme/site#7", "acme/api#3"] },
    prs: {
      "acme/widgets#42": pr("acme", "widgets", 42, { title: "Stream the tokenizer" }),
      "acme/site#7": pr("acme", "site", 7, { draft: true, author: null }),
      "acme/api#3": pr("acme", "api", 3, { state: "MERGED" }),
    },
  };

  it("asks GitHub's GraphQL search with the query, the page size and no cursor", async () => {
    const { gh, client: c } = client(fixture);
    await c.search("is:pr is:open user-review-requested:@me", 2, null);
    const [call] = gh.calls();
    expect(call!.args.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(call!.args).toContain("q=is:pr is:open user-review-requested:@me");
    expect(call!.args).toContain("first=2");
    // `-F` for the number: a `-f` would send "2" as a string and GitHub would refuse the variable.
    expect(call!.args[call!.args.indexOf("first=2") - 1]).toBe("-F");
    expect(call!.args.some((a) => a.startsWith("after="))).toBe(false);
  });

  it("reads rows and hands back GitHub's cursor for the next page", async () => {
    const { gh, client: c } = client(fixture);
    const first = await c.search("is:pr user-review-requested:@me", 2, null);
    expect(first.total).toBe(3);
    expect(first.prs.map((p) => p.ref)).toEqual([{ owner: "acme", repo: "widgets", number: 42 }, { owner: "acme", repo: "site", number: 7 }]);
    expect(first.prs[0]).toMatchObject({ title: "Stream the tokenizer", state: "open", draft: false, author: "mara", url: "https://github.com/acme/widgets/pull/42" });
    expect(first.prs[0]!.updatedAt).toBe(Date.parse("2026-10-03T10:00:00Z"));
    expect(first.prs[1]).toMatchObject({ draft: true, author: null });
    expect(first.nextCursor).toBe("o2");
    const second = await c.search("is:pr user-review-requested:@me", 2, first.nextCursor);
    expect(gh.calls()[1]!.args).toContain("after=o2");
    expect(second.prs.map((p) => p.ref.number)).toEqual([3]);
    expect(second.prs[0]!.state).toBe("merged");
    expect(second.nextCursor).toBeNull();
  });
});

describe("detail — one request, as the Summary tab reads it", () => {
  const view = {
    body: "## Why\n\nBecause.", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", reviewDecision: "CHANGES_REQUESTED",
    headRepositoryOwner: { login: "mara" }, additions: 12, deletions: 3, changedFiles: 2,
    reviewRequests: [{ __typename: "User", login: "carlton" }, { __typename: "Team", name: "Core", slug: "core" }],
    latestReviews: [{ author: { login: "jo" }, state: "CHANGES_REQUESTED" }, { author: { login: "carlton" }, state: "COMMENTED" }],
    comments: Array.from({ length: 7 }, (_, i) => ({ author: { login: "jo" }, body: `comment ${i}`, createdAt: "2026-10-04T10:00:00Z", url: `u${i}` })),
    statusCheckRollup: [
      { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/1" },
      { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: "", detailsUrl: "https://ci/2" },
      { __typename: "CheckRun", name: "e2e", status: "COMPLETED", conclusion: "TIMED_OUT" },
      { __typename: "StatusContext", context: "coverage", state: "FAILURE", targetUrl: "https://cov" },
    ],
  };

  it("asks `gh pr view` for the request by number and repository, for exactly the fields drawn", async () => {
    const { gh, client: c } = client({ prs: { "acme/widgets#42": pr("acme", "widgets", 42, { view }) } });
    await c.detail(ref);
    const args = gh.calls()[0]!.args;
    expect(args.slice(0, 5)).toEqual(["pr", "view", "42", "--repo", "acme/widgets"]);
    expect(args[5]).toBe("--json");
    expect(args[6]!.split(",")).toEqual(expect.arrayContaining(["body", "headRefOid", "mergeable", "reviewRequests", "latestReviews", "statusCheckRollup"]));
  });

  it("reads merge state, reviewers, comments and checks into the page's words", async () => {
    const { client: c } = client({ prs: { "acme/widgets#42": pr("acme", "widgets", 42, { view }) } });
    const d = await c.detail(ref);
    expect(d).toMatchObject({ body: "## Why\n\nBecause.", base: "main", head: "feature", headSha: "abc1234def5678abc1234def5678abc1234def56",
      mergeable: "conflicting", mergeState: "dirty", decision: "changes_requested", additions: 12, deletions: 3, changedFiles: 2 });
    // The head is in a fork of its own owner's: named, so the branch reads `mara:feature`.
    expect(d.headOwner).toBe("mara");
    // Asked again after reviewing, carlton is owed a review: the request wins over the old verdict.
    expect(d.reviewers).toEqual([
      { name: "carlton", team: false, state: "pending" },
      { name: "core", team: true, state: "pending" },
      { name: "jo", team: false, state: "changes_requested" },
    ]);
    expect(d.comments.total).toBe(7);
    expect(d.comments.recent.map((x) => x.body)).toEqual(["comment 2", "comment 3", "comment 4", "comment 5", "comment 6"]);
    expect(d.checks).toEqual([
      { name: "test", state: "success", url: "https://ci/1" },
      { name: "lint", state: "pending", url: "https://ci/2" },
      { name: "e2e", state: "failure", url: null },
      { name: "coverage", state: "failure", url: "https://cov" },
    ]);
  });

  it("names a request GitHub does not have", async () => {
    const { client: c } = client({ prs: {} });
    await expect(c.detail(ref)).rejects.toMatchObject({ code: "PR_NOT_FOUND" });
  });
});

describe("files — every page of the files endpoint, with its patches", () => {
  it("asks for every page the count implies, a hundred at a time", async () => {
    const files = Array.from({ length: 250 }, (_, i) => ({ filename: `src/f${i}.ts`, status: "modified", additions: 1, deletions: 1, patch: PATCH }));
    const { gh, client: c } = client({ prs: { "acme/widgets#42": pr("acme", "widgets", 42, { files }) } });
    const r = await c.files(ref, 250);
    expect(r.files.map((f) => f.file.path)).toEqual(files.map((f) => f.filename));
    expect(r.truncated).toBe(false);
    expect(gh.calls().map((x) => x.args).sort()).toEqual([1, 2, 3].map((p) => ["api", `repos/acme/widgets/pulls/42/files?per_page=100&page=${p}`]));
  });

  it("reads GitHub's statuses, renames and missing patches into the page's words", async () => {
    const files = [
      { filename: "a.ts", status: "removed", additions: 0, deletions: 4, patch: "@@ -1,4 +0,0 @@\n-a\n-b\n-c\n-d" },
      { filename: "b.ts", previous_filename: "old/b.ts", status: "renamed", additions: 0, deletions: 0 },
      { filename: "big.json", status: "modified", additions: 9000, deletions: 12 },
      { filename: "logo.png", status: "modified", additions: 0, deletions: 0 },
    ];
    const { client: c } = client({ prs: { "acme/widgets#42": pr("acme", "widgets", 42, { files }) } });
    const r = await c.files(ref, 4);
    expect(r.files.map((f) => f.file)).toEqual([
      { path: "a.ts", oldPath: null, status: "deleted", additions: 0, deletions: 4, patch: "text" },
      { path: "b.ts", oldPath: "old/b.ts", status: "renamed", additions: 0, deletions: 0, patch: "none" },
      // Counted, but GitHub sent no patch: the change is there, just too big to send.
      { path: "big.json", oldPath: null, status: "modified", additions: 9000, deletions: 12, patch: "too-large" },
      { path: "logo.png", oldPath: null, status: "modified", additions: 0, deletions: 0, patch: "none" },
    ]);
    expect(r.files[0]!.patch).toBe("@@ -1,4 +0,0 @@\n-a\n-b\n-c\n-d");
  });

  it("says when GitHub's own ceiling cut the list short", async () => {
    const { gh, client: c } = client({ prs: { "acme/widgets#42": pr("acme", "widgets", 42, { files: [] }) } });
    const r = await c.files(ref, 3500);
    expect(r.truncated).toBe(true);
    expect(gh.calls()).toHaveLength(30); // 3000 files, and not a page past them
  });
});

describe("fileLines — a file at the head, for opening an unchanged band", () => {
  it("asks the contents endpoint for the raw file at the head, every path segment escaped", async () => {
    const { gh, client: c } = client({ prs: { "acme/widgets#42": pr("acme", "widgets", 42, { contents: { "docs/a b#1.md": "one\ntwo\n" } }) } });
    expect(await c.fileLines(ref, "abc123", "docs/a b#1.md")).toEqual(["one", "two"]);
    expect(gh.calls()[0]!.args).toEqual(["api", "-H", "Accept: application/vnd.github.raw+json", "repos/acme/widgets/contents/docs/a%20b%231.md?ref=abc123"]);
  });

  it("answers null for a file the head does not have", async () => {
    const { client: c } = client({ prs: { "acme/widgets#42": pr("acme", "widgets", 42, { contents: {} }) } });
    expect(await c.fileLines(ref, "abc123", "gone.ts")).toBeNull();
  });
});

describe("submit — the one write, exactly as composed", () => {
  const review = {
    ref, headSha: "abc1234def5678abc1234def5678abc1234def56", event: "REQUEST_CHANGES" as const,
    body: "Two things before this lands — see the comments.\n\n\"Quoted\", $HOME and `ticks` stay as typed.",
    comments: [
      { path: "src/a.ts", line: 2, side: "RIGHT" as const, body: "Carry the partial token." },
      { path: "src/b.ts", line: 19, side: "LEFT" as const, body: "This removed the error." },
    ],
  };

  it("posts the review as one JSON body on stdin, to the reviews endpoint, and nothing else", async () => {
    const { gh, client: c } = client({ prs: {}, reviewId: 77 });
    const posted = await c.submit(review);
    expect(posted).toEqual({ id: 77, url: "https://github.com/acme/widgets/pull/42#pullrequestreview-77" });
    const calls = gh.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["api", "--method", "POST", "repos/acme/widgets/pulls/42/reviews", "--input", "-"]);
    // THE PAYLOAD, exactly: the event GitHub spells, the comment as typed, the head it was read at,
    // and each line comment on its side. A field added, renamed or dropped fails here.
    expect(JSON.parse(calls[0]!.stdin!)).toEqual({
      commit_id: "abc1234def5678abc1234def5678abc1234def56",
      event: "REQUEST_CHANGES",
      body: "Two things before this lands — see the comments.\n\n\"Quoted\", $HOME and `ticks` stay as typed.",
      comments: [
        { path: "src/a.ts", line: 2, side: "RIGHT", body: "Carry the partial token." },
        { path: "src/b.ts", line: 19, side: "LEFT", body: "This removed the error." },
      ],
    });
  });

  it("sends no comments key for a review with no line comments", async () => {
    const { gh, client: c } = client({ prs: {} });
    await c.submit({ ...review, event: "APPROVE", body: "Looks right.", comments: [] });
    expect(JSON.parse(gh.calls()[0]!.stdin!)).toEqual({ commit_id: review.headSha, event: "APPROVE", body: "Looks right." });
  });

  it("says what GitHub refused, in GitHub's words", async () => {
    const { client: c } = client({ prs: {}, refuseReview: { message: "Unprocessable Entity", errors: ["Pull request review thread line must be part of the diff"] } });
    await expect(c.submit(review)).rejects.toMatchObject({
      code: "REVIEW_REFUSED",
      message: "GitHub did not post the review: Unprocessable Entity — Pull request review thread line must be part of the diff",
    });
  });

  it("does not post as anyone when gh is signed out", async () => {
    const { client: c } = client({ auth: "signed-out", prs: {} });
    await expect(c.submit(review)).rejects.toMatchObject({ code: "GH_SIGNED_OUT" });
  });
});
