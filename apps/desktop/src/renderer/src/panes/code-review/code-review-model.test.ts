import { describe, expect, it } from "vitest";
import type { Finding, PrDetail, PrFile, PrSummary } from "@realm/contracts";
import type { AgentProbe } from "../../state/store";
import {
  EMPTY_DRAFT, age, appendPage, canSubmit, checksFact, dropComment, isKept, isOwnRequest, keepFinding, keepSummary, mergeFact,
  postsLine, readQuery, reviewBlocked, reviewPayload, reviewerRows,
} from "./code-review-model";
import { fileTree, filterFiles, treeRows } from "./file-tree";

const ref = { owner: "acme", repo: "widgets", number: 42 };
const row = (number: number, owner = "acme"): PrSummary => ({
  ref: { owner, repo: "widgets", number }, title: `#${number}`, url: "", state: "open", draft: false, author: "mara", createdAt: 0, updatedAt: 0,
});

describe("the column", () => {
  it("dates a row in a few characters", () => {
    const now = Date.UTC(2026, 9, 5);
    expect([0, 59_000, 5 * 60_000, 3 * 3_600_000, 2 * 86_400_000, 150 * 86_400_000, 800 * 86_400_000].map((d) => age(now - d, now)))
      .toEqual(["now", "now", "5m", "3h", "2d", "5mo", "2y"]);
  });

  it("reads a pasted link as an address and anything else as words", () => {
    expect(readQuery("  ")).toEqual({ kind: "none" });
    expect(readQuery("https://github.com/acme/widgets/pull/42/files")).toEqual({ kind: "ref", ref });
    expect(readQuery("acme/widgets#42")).toEqual({ kind: "ref", ref });
    expect(readQuery(" tokenizer stream ")).toEqual({ kind: "search", query: "tokenizer stream" });
  });

  it("adds a further page without listing a request twice, whatever case its name came back in", () => {
    // THE MUTANT: a plain concat — a request updated between the two reads sorts into both pages.
    const held = [row(1), row(2)];
    expect(appendPage(held, { prs: [row(2, "ACME"), row(3)], nextCursor: null, total: 3 }).map((p) => p.ref.number)).toEqual([1, 2, 3]);
  });
});

describe("the request's facts", () => {
  const base = { state: "open", draft: false, mergeable: "mergeable", mergeState: "clean", decision: null, base: "main" } as const;
  it("says whether it can merge, reading mergeable and the merge state together", () => {
    expect(mergeFact(base)).toEqual({ tone: "ok", text: "Can merge without conflicts" });
    expect(mergeFact({ ...base, mergeable: "conflicting", mergeState: "dirty" }).tone).toBe("bad");
    expect(mergeFact({ ...base, mergeable: "unknown" }).text).toBe("GitHub is still checking whether it can merge");
    // No conflicts is not "can merge" while a review is owed.
    expect(mergeFact({ ...base, mergeState: "blocked", decision: "review_required" })).toEqual({ tone: "wait", text: "Blocked until it has an approving review" });
    expect(mergeFact({ ...base, mergeState: "behind" }).text).toBe("Behind main; needs updating before it can merge");
    expect(mergeFact({ ...base, state: "merged" }).text).toBe("Merged");
  });

  it("counts checks by what they need from you, failures first", () => {
    expect(checksFact([])).toEqual({ tone: "quiet", text: "No checks" });
    expect(checksFact([{ state: "success" }, { state: "failure" }, { state: "pending" }, { state: "skipped" }]))
      .toEqual({ tone: "bad", text: "1 failed · 1 running · 1 passed · 1 skipped" });
    expect(checksFact([{ state: "success" }, { state: "pending" }]).tone).toBe("wait");
  });

  it("knows the author's own request, in any case", () => {
    expect(isOwnRequest({ author: "Carlton" } as PrDetail, "carlton")).toBe(true);
    expect(isOwnRequest({ author: "mara" } as PrDetail, "carlton")).toBe(false);
    expect(isOwnRequest({ author: null } as PrDetail, "carlton")).toBe(false);
  });
});

describe("the reviewer", () => {
  const probed = (kind: AgentProbe["kind"], models?: { id: string; label: string }[]): AgentProbe =>
    ({ kind, available: true, version: "1", loggedIn: true, reason: null, ...(models ? { models } : {}) });
  const luna = { id: "gpt-6-luna", label: "GPT-6 Luna" };
  const probe = [probed("codex", [luna]), probed("acp:cursor", [luna, { id: "composer-2", label: "Composer 2" }]), probed("fake")];

  it("is offered only what a read-only reviewer can run, by the routes that can run it", () => {
    const rows = reviewerRows({ kind: "claude", model: null, agentProbe: probe, favorites: [] });
    // Claude's models, Codex's and the scripted agent's — never one only Cursor runs, which `review`
    // would refuse. THE MUTANT: the rows unfiltered.
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(["claude", "codex", "fake"]));
    expect(rows.some((r) => r.label === "Composer 2")).toBe(false);
    // GPT-6 Luna runs through Codex and through Cursor; a reviewer is offered Codex alone, so the
    // picker's row draws no Cursor route beside it. THE MUTANT: routes left as modelRows gave them.
    expect(rows.find((r) => r.label === "GPT-6 Luna")).toMatchObject({ kind: "codex", harnesses: ["codex"], alternates: [] });
    // The pick is the one row ticked; the scripted agent's, added after, never is.
    expect(rows.filter((r) => r.selected).map((r) => r.label)).toEqual(["Claude Fable 5.1"]);
  });

  it("lists the scripted agent once, and only where this Realm runs one", () => {
    expect(reviewerRows({ kind: "claude", model: null, agentProbe: probe.slice(0, 2), favorites: [] }).some((r) => r.kind === "fake")).toBe(false);
    const own = reviewerRows({ kind: "fake", model: null, agentProbe: probe, favorites: [] });
    expect(own.filter((r) => r.kind === "fake").map((r) => [r.label, r.selected])).toEqual([["Fake", true]]);
  });

  it("says why a review cannot start now, or nothing when it can", () => {
    expect(reviewBlocked({ changedFiles: 3 }, true, false)).toBeNull();
    expect(reviewBlocked({ changedFiles: 3 }, true, true)).toBe("A review of this pull request is running — its findings land here when it is done");
    expect(reviewBlocked(null, true, false)).toBe("Nothing to review until the pull request has been read");
    // THE MUTANT: a request with nothing in its diff sent to a reviewer anyway.
    expect(reviewBlocked({ changedFiles: 0 }, true, false)).toBe("This pull request changes no files, so there is nothing to review");
    expect(reviewBlocked({ changedFiles: 3 }, false, false)).toBe("There is no space to run the review in yet");
  });
});

describe("the review being written", () => {
  const anchored: Finding = { id: "f1", path: "src/a.ts", line: 14, side: "RIGHT", body: "Carry the partial token.", anchored: true };
  const loose: Finding = { id: "f2", path: "README.md", line: 400, side: "RIGHT", body: "Still says it buffers.", anchored: false };

  it("keeps an anchored finding as a line comment and a loose one as a paragraph of the comment, each once", () => {
    let d = keepFinding(EMPTY_DRAFT, anchored);
    d = keepFinding(d, anchored);
    expect(d.comments).toEqual([{ id: "f1", path: "src/a.ts", line: 14, side: "RIGHT", body: "Carry the partial token.", from: "finding" }]);
    d = keepFinding({ ...d, body: "Close.  " }, loose);
    expect(d.body).toBe("Close.\n\n**README.md, line 400** — Still says it buffers.");
    expect(keepFinding(d, loose)).toBe(d);
    expect(isKept(d, "f1") && isKept(d, "f2")).toBe(true);
    expect(dropComment(d, "f1").comments).toEqual([]);
  });

  it("opens the comment with the reviewer's summary only where it is not already there", () => {
    const d = keepSummary({ ...EMPTY_DRAFT, body: "My words." }, "The summary.");
    expect(d.body).toBe("The summary.\n\nMy words.");
    expect(keepSummary(d, "The summary.")).toBe(d);
  });

  it("posts exactly what was written: the event, the comment as typed, each kept line on its side", () => {
    const d = { ...keepFinding(EMPTY_DRAFT, anchored), event: "REQUEST_CHANGES" as const, body: "  Two things.\n" };
    // THE MUTANT: trimming the comment, or dropping `side` — GitHub then hangs a LEFT line on RIGHT.
    expect(reviewPayload(ref, "abc1234", d)).toEqual({
      ref, headSha: "abc1234", event: "REQUEST_CHANGES", body: "  Two things.\n",
      comments: [{ path: "src/a.ts", line: 14, side: "RIGHT", body: "Carry the partial token." }],
    });
  });

  it("says what Submit will post, and refuses an empty comment", () => {
    expect(canSubmit({ ...EMPTY_DRAFT, body: " \n" })).toBe(false);
    const d = { ...keepFinding(EMPTY_DRAFT, anchored), event: "APPROVE" as const, body: "LGTM" };
    expect(postsLine(ref, d, "carlton")).toBe("Posts an approval with 1 line comment to acme/widgets#42 as @carlton.");
    expect(postsLine(ref, { ...EMPTY_DRAFT, body: "x" }, null)).toBe("Posts a comment to acme/widgets#42.");
  });
});

describe("the file tree", () => {
  const f = (path: string, additions = 1, deletions = 0): PrFile => ({ path, oldPath: null, status: "modified", additions, deletions, patch: "text" });
  const files = [f("README.md", 8, 8), f("lib/src/ui/views/a.dart", 40, 23), f("lib/src/ui/views/b.dart", 23, 30), f("lib/main.dart", 6, 6), f("test/w_test.dart", 83, 21)];

  it("puts folders first, folds a single-child chain into one row, and sums each folder's lines", () => {
    const tree = fileTree(files);
    expect(tree.map((n) => n.name)).toEqual(["lib", "test", "README.md"]);
    const lib = tree[0] as Extract<(typeof tree)[number], { kind: "dir" }>;
    expect(lib).toMatchObject({ additions: 69, deletions: 59 });
    // `src/ui/views` holds only itself all the way down: one row, not three.
    expect(lib.children.map((n) => n.name)).toEqual(["src/ui/views", "main.dart"]);
  });

  it("lists rows depth first, leaving out what a folded folder holds", () => {
    const tree = fileTree(files);
    expect(treeRows(tree, new Set()).map((r) => `${r.depth}:${r.node.name}`)).toEqual([
      "0:lib", "1:src/ui/views", "2:a.dart", "2:b.dart", "1:main.dart", "0:test", "1:w_test.dart", "0:README.md",
    ]);
    expect(treeRows(tree, new Set(["lib"])).map((r) => r.node.name)).toEqual(["lib", "test", "w_test.dart", "README.md"]);
  });

  it("filters on every word of the query, anywhere in the path", () => {
    expect(filterFiles(files, "VIEWS b.d").map((x) => x.path)).toEqual(["lib/src/ui/views/b.dart"]);
    expect(filterFiles(files, "  ")).toHaveLength(5);
  });
});
