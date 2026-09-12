import { describe, expect, it } from "vitest";
import {
  PROJECT_FILES_LIMIT_MAX, ProjectFileHitSchema, ProjectGrepHitSchema,
  fuzzyMatch, isWordBoundary, markPositions, matchPath, rankPaths,
} from "./project-search";

/** The order is the assertion throughout: `rankPaths` is only ever right or wrong about which path a
 *  person meant, and every test below names a pair it must not get backwards. */
const order = (paths: string[], query: string) => rankPaths(paths, query, 50).map((h) => h.path);
const first = (paths: string[], query: string) => order(paths, query)[0];

describe("isWordBoundary", () => {
  it("finds the starts a path actually has", () => {
    expect(isWordBoundary("src/rpc.ts", 0)).toBe(true);   // the beginning
    expect(isWordBoundary("src/rpc.ts", 4)).toBe(true);   // after a slash
    expect(isWordBoundary("src/rpc.ts", 8)).toBe(true);   // after a dot
    expect(isWordBoundary("DocumentsPane", 9)).toBe(true); // a camel hump
    expect(isWordBoundary("plan-22", 5)).toBe(true);      // a digit run
    expect(isWordBoundary("src/rpc.ts", 5)).toBe(false);  // an interior character
  });
  it("does not call every character of an ACRONYM a hump", () => {
    // "RPCServer": the C is upper after an upper, which is inside the acronym, not a new word.
    expect(isWordBoundary("RPCServer", 1)).toBe(false);
    expect(isWordBoundary("RPCServer", 2)).toBe(false);
  });
});

describe("fuzzyMatch", () => {
  it("returns null when the query is not a subsequence at all", () => {
    expect(fuzzyMatch("src/rpc.ts", "zzz")).toBeNull();
    expect(fuzzyMatch("abc", "cba")).toBeNull(); // order matters; a bag of letters is not a match
  });
  it("matches case-insensitively", () => {
    expect(fuzzyMatch("DocumentsPane.tsx", "documentspane")).not.toBeNull();
    expect(fuzzyMatch("documentspane.tsx", "DOCUMENTSPANE")).not.toBeNull();
  });
  it("retries from a later start rather than spending a character on the first occurrence", () => {
    // The mutant this catches: a single greedy pass. It spends the `r` on "se**r**ver" and then has to
    // find `p` and `c` scattered to the right, scoring far below the contiguous "rpc" it walked past.
    const m = fuzzyMatch("apps/server/src/rpc/methods.ts", "rpc")!;
    expect(m.positions).toEqual([16, 17, 18]);
  });
  it("stops retrying once a start can no longer reach the end of the query", () => {
    // Three `a`s, but only the first has "bc" after it. A matcher that kept walking would return null
    // from a later start and lose the real one.
    expect(fuzzyMatch("abcaa", "abc")!.positions).toEqual([0, 1, 2]);
  });
  it("scores a contiguous run above the same characters scattered", () => {
    expect(fuzzyMatch("search", "sea")!.score).toBeGreaterThan(fuzzyMatch("sxexax", "sea")!.score);
  });
  it("counts separator-delimited letters as word starts, not as a scattered match", () => {
    // `s_e_a` is three word starts and outranks the contiguous run inside one word. That is the
    // intended reading — `s_e_a` is how a snake_case identifier abbreviates — and it is stated here
    // so a later "make contiguity win" change has to argue with it rather than silently flip it.
    expect(fuzzyMatch("s_e_a", "sea")!.score).toBeGreaterThan(fuzzyMatch("search", "sea")!.score);
  });
  it("scores word starts above an interior run of the same length", () => {
    // "d" + "p" as two word starts, against "dp" sitting inside one word.
    expect(fuzzyMatch("docs/pane", "dp")!.score).toBeGreaterThan(fuzzyMatch("adptx", "dp")!.score);
  });
  it("prefers the case the user typed, without requiring it", () => {
    const exact = fuzzyMatch("Pane", "Pane")!.score;
    const loose = fuzzyMatch("pane", "Pane")!.score;
    expect(exact).toBeGreaterThan(loose);
    expect(loose).toBeGreaterThan(0);
  });
  it("caps the gap penalty so a deep match still scores above nothing", () => {
    // 200 characters of vendored path before the match. Uncapped, this goes negative and sorts below
    // paths that matched worse.
    expect(fuzzyMatch(`${"x".repeat(200)}/target`, "target")!.score).toBeGreaterThan(0);
  });
  it("treats an empty query as a match with no positions", () => {
    expect(fuzzyMatch("anything", "")).toEqual({ score: 0, positions: [] });
  });
});

describe("markPositions", () => {
  it("merges adjacent positions into one run", () => {
    expect(markPositions("rpc.ts", [0, 1, 2])).toEqual([
      { text: "rpc", match: true }, { text: ".ts", match: false },
    ]);
  });
  it("alternates plain and matched across a scattered match", () => {
    expect(markPositions("a/b/c", [0, 2, 4])).toEqual([
      { text: "a", match: true }, { text: "/", match: false },
      { text: "b", match: true }, { text: "/", match: false },
      { text: "c", match: true },
    ]);
  });
  it("reconstructs the original text exactly", () => {
    const path = "apps/server/src/rpc/methods.ts";
    const m = matchPath(path, "rpcmeth")!;
    expect(markPositions(path, m.positions).map((s) => s.text).join("")).toBe(path);
  });
  it("marks nothing for an empty match", () => {
    expect(markPositions("rpc.ts", [])).toEqual([{ text: "rpc.ts", match: false }]);
  });
});

describe("matchPath", () => {
  it("scores a file-name match above a directory match of the same characters", () => {
    const base = matchPath("packages/contracts/src/rpc.ts", "rpc")!;
    const dir = matchPath("apps/server/src/rpc/methods.ts", "rpc")!;
    expect(base.score).toBeGreaterThan(dir.score);
  });
  it("reports positions in the FULL path even when the file name won", () => {
    const path = "packages/contracts/src/rpc.ts";
    const m = matchPath(path, "rpc")!;
    expect(m.positions).toEqual([path.indexOf("rpc.ts"), path.indexOf("rpc.ts") + 1, path.indexOf("rpc.ts") + 2]);
  });
  it("falls back to the whole path when the file name cannot hold the query", () => {
    const m = matchPath("apps/server/src/app.ts", "serverapp")!;
    expect(m.positions[0]).toBe(5); // the `s` of "server", not something inside "app.ts"
  });
  it("handles a path with no directory at all", () => {
    expect(matchPath("README.md", "readme")!.positions).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("rankPaths", () => {
  const TREE = [
    "apps/desktop/src/renderer/src/rpc/client.ts",
    "apps/server/src/rpc/methods.ts",
    "apps/server/src/rpc/server.ts",
    "packages/contracts/src/rpc.ts",
    "packages/contracts/src/search.ts",
    "apps/desktop/src/renderer/src/panes/documents/DocumentsPane.tsx",
    "apps/desktop/src/renderer/src/panes/documents/RichTextEditor.tsx",
    "docs/plan-22.md",
    "README.md",
  ];

  it("puts the file NAMED by the query first", () => {
    expect(first(TREE, "rpc")).toBe("packages/contracts/src/rpc.ts");
    expect(first(TREE, "readme")).toBe("README.md");
    expect(first(TREE, "methods")).toBe("apps/server/src/rpc/methods.ts");
  });
  it("ranks camel initials onto the component they abbreviate", () => {
    expect(first(TREE, "dp")).toBe("apps/desktop/src/renderer/src/panes/documents/DocumentsPane.tsx");
    expect(first(TREE, "rte")).toBe("apps/desktop/src/renderer/src/panes/documents/RichTextEditor.tsx");
  });
  it("reads a directory fragment plus a name the way it is typed", () => {
    expect(first(TREE, "rpcmethods")).toBe("apps/server/src/rpc/methods.ts");
    expect(first(TREE, "documentspane")).toBe("apps/desktop/src/renderer/src/panes/documents/DocumentsPane.tsx");
  });
  it("drops every path the query is not a subsequence of", () => {
    expect(order(TREE, "zzzz")).toEqual([]);
    expect(order(TREE, "rpc")).not.toContain("README.md");
  });
  it("breaks a tie by the shorter path, then alphabetically", () => {
    const same = ["src/a/b/c/index.ts", "src/index.ts", "lib/index.ts"];
    // All three match "index" identically inside the file name, so only the tie-break can order them.
    expect(order(same, "index")).toEqual(["lib/index.ts", "src/index.ts", "src/a/b/c/index.ts"]);
  });
  it("is a total order — the same input ranks the same way every time", () => {
    const a = order(TREE, "src");
    const b = order([...TREE].reverse(), "src");
    expect(a).toEqual(b);
  });
  it("returns the list unranked and unreordered for an empty query", () => {
    expect(rankPaths(TREE, "", 3).map((h) => h.path)).toEqual(TREE.slice(0, 3));
    expect(rankPaths(TREE, "   ", 3).map((h) => h.path)).toEqual(TREE.slice(0, 3));
    expect(rankPaths(TREE, "", 3)[0]!.segments).toEqual([{ text: TREE[0], match: false }]);
  });
  it("honours the limit and never exceeds the wire maximum", () => {
    expect(rankPaths(TREE, "s", 2)).toHaveLength(2);
    expect(rankPaths(TREE, "s", 1000).length).toBeLessThanOrEqual(PROJECT_FILES_LIMIT_MAX);
    expect(rankPaths(TREE, "s", -5)).toEqual([]);
  });
  it("marks the characters it matched, and only those", () => {
    const hit = rankPaths(TREE, "rpc", 1)[0]!;
    expect(hit.segments.filter((s) => s.match).map((s) => s.text).join("")).toBe("rpc");
    expect(hit.segments.map((s) => s.text).join("")).toBe(hit.path);
  });
  it("emits hits the wire schema accepts", () => {
    for (const hit of rankPaths(TREE, "rpc", 5)) expect(ProjectFileHitSchema.parse(hit)).toEqual(hit);
  });
  it("ranks a large candidate list without pathological cost", () => {
    // 20k plausible paths, the ranker's own candidate ceiling. This is a bound check, not a
    // benchmark: it fails if someone reaches for an O(query x text) table per candidate.
    const many = Array.from({ length: 20_000 }, (_, i) => `packages/gen/src/module${i}/handler${i}.ts`);
    const started = Date.now();
    const hits = rankPaths([...many, "src/handler.ts"], "handler", 5);
    expect(hits[0]!.path).toBe("src/handler.ts");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("grep hit shape", () => {
  it("refuses a zero line number — editors and git both count from one", () => {
    expect(ProjectGrepHitSchema.safeParse({ path: "a.ts", line: 0, segments: [] }).success).toBe(false);
    expect(ProjectGrepHitSchema.safeParse({ path: "a.ts", line: 1, segments: [{ text: "x", match: true }] }).success).toBe(true);
  });
});
