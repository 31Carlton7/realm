import { describe, expect, it } from "vitest";
import { fileCandidates, markFileRefs, normalizePath, parseFileRef, touchedFiles, upgradeFileRef } from "./file-links";
import { renderMarkdownWithPaths } from "./Markdown";
import type { Block } from "./transcript-model";

const ctx = { cwd: "/w/app", root: "/w/app", known: new Set<string>() };
const marked = (md: string) => {
  const div = document.createElement("div");
  div.innerHTML = renderMarkdownWithPaths(md);
  return [...div.querySelectorAll<HTMLElement>("[data-file-ref]")].map((el) =>
    ({ tag: el.tagName.toLowerCase(), ref: el.getAttribute("data-file-ref"), line: el.getAttribute("data-file-line"), text: el.textContent }));
};

describe("reading a file reference", () => {
  it("takes the ways agents write a file and a line", () => {
    expect(parseFileRef("web/lib/orgs.ts")).toEqual({ ref: "web/lib/orgs.ts", line: null });
    expect(parseFileRef("web/lib/orgs.ts:83")).toEqual({ ref: "web/lib/orgs.ts", line: 83 });
    expect(parseFileRef("web/lib/orgs.ts:83:5")).toEqual({ ref: "web/lib/orgs.ts", line: 83 });
    expect(parseFileRef("/w/app/web/lib/orgs.ts#L83-L90")).toEqual({ ref: "/w/app/web/lib/orgs.ts", line: 83 });
    expect(parseFileRef("./src/x.tsx")).toEqual({ ref: "./src/x.tsx", line: null });
    expect(parseFileRef("auto-compact.ts")).toEqual({ ref: "auto-compact.ts", line: null });
    expect(parseFileRef(".github/workflows/ci.yml")).toEqual({ ref: ".github/workflows/ci.yml", line: null });
  });

  it("refuses what only looks like one: a URL, a sentence, a version, a call", () => {
    for (const not of ["https://x.dev/a.ts", "npm run build", "v1.2", "getOrgMembership()", "a/b", "id"]) {
      expect(parseFileRef(not), not).toBeNull();
    }
  });
});

describe("marking the places a file might be named", () => {
  it("marks inline code, a local link and a path in running text — with Codex's (line N) absorbed", () => {
    expect(marked("The change is in web/lib/orgs.ts (line 83): `getOrgMembership()` selects `id`.")).toEqual([
      { tag: "span", ref: "web/lib/orgs.ts", line: "83", text: "web/lib/orgs.ts (line 83)" },
    ]);
    expect(marked("See `web/lib/orgs.ts:83` and [auto-compact.ts](web/lib/agent/auto-compact.ts#L67).")).toEqual([
      { tag: "code", ref: "web/lib/orgs.ts", line: "83", text: "web/lib/orgs.ts:83" },
      { tag: "a", ref: "web/lib/agent/auto-compact.ts", line: "67", text: "auto-compact.ts" },
    ]);
  });

  it("leaves a sentence's own full stop out of the path", () => {
    expect(marked("I edited src/app.ts.")).toMatchObject([{ ref: "src/app.ts", text: "src/app.ts" }]);
  });

  it("takes a bare name in prose only when it is a kind of file Realm opens", () => {
    // "e.g." has no extension anything opens; "package.json" does, and the disk will decide.
    expect(marked("Update package.json, e.g. the scripts.").map((m) => m.ref)).toEqual(["package.json"]);
  });

  it("never reaches into a code block, a heading or a web link", () => {
    expect(marked("```\nsrc/a.ts\n```\n\n# src/b.ts\n\n[docs](https://example.com/c.ts)")).toEqual([]);
  });

  it("marks an absolute path already made a button, without cutting it again", () => {
    const div = document.createElement("div");
    div.innerHTML = renderMarkdownWithPaths("Wrote /w/app/notes/plan.md today.");
    expect(div.querySelector("button.md-path")!.getAttribute("data-file-ref")).toBe("/w/app/notes/plan.md");
    expect(div.querySelectorAll("[data-file-ref]")).toHaveLength(1);
    expect(markFileRefs(div)).toBe(1); // idempotent on its own output's shape: one candidate, re-marked
  });
});

describe("what a mark could mean", () => {
  it("resolves from where the agent stands, then from the checkout's root", () => {
    expect(fileCandidates("lib/orgs.ts", { ...ctx, cwd: "/w/app/web" })).toEqual(["/w/app/web/lib/orgs.ts", "/w/app/lib/orgs.ts"]);
    expect(fileCandidates("../README.md", { ...ctx, cwd: "/w/app/web" })).toEqual(["/w/app/README.md"]);
  });

  it("never names anything outside the checkout, under the home folder, or of a kind nothing opens", () => {
    expect(fileCandidates("/etc/passwd.txt", ctx)).toEqual([]);
    expect(fileCandidates("../../outside.ts", ctx)).toEqual([]);
    expect(fileCandidates("~/notes.md", ctx)).toEqual([]);
    expect(fileCandidates("build/app.exe", ctx)).toEqual([]);
  });

  it("matches a bare name to the one touched file that carries it, and to none when two do", () => {
    const one = new Set(["/w/app/web/lib/agent/auto-compact.ts"]);
    expect(fileCandidates("auto-compact.ts", { ...ctx, known: one })).toEqual(["/w/app/auto-compact.ts", "/w/app/web/lib/agent/auto-compact.ts"]);
    const two = new Set(["/w/app/a/index.ts", "/w/app/b/index.ts"]);
    expect(fileCandidates("index.ts", { ...ctx, known: two })).toEqual(["/w/app/index.ts"]);
  });

  it("normalises the way a filesystem does, and refuses to climb past the top", () => {
    expect(normalizePath("/a/./b//c/../d.ts")).toBe("/a/b/d.ts");
    expect(normalizePath("/../x")).toBeNull();
  });
});

describe("the link a confirmed mark becomes", () => {
  const upgraded = (html: string, path: string) => {
    const div = document.createElement("div");
    div.innerHTML = html;
    upgradeFileRef(div.querySelector<HTMLElement>("[data-file-ref]")!, path, "/w/app");
    return div.querySelector<HTMLElement>(".md-file")!;
  };

  it("leads with the file type's mark, says the line in words, and names the file it opens", () => {
    const link = upgraded(`<code data-file-ref="web/lib/orgs.ts" data-file-line="83">web/lib/orgs.ts:83</code>`, "/w/app/web/lib/orgs.ts");
    expect(link.getAttribute("role")).toBe("link");
    expect(link.tabIndex).toBe(0);
    expect(link.getAttribute("data-file")).toBe("/w/app/web/lib/orgs.ts");
    expect(link.getAttribute("data-line")).toBe("83");
    expect(link.textContent).toBe("web/lib/orgs.ts (line 83)");
    expect(link.title).toBe("Open web/lib/orgs.ts at line 83");
    expect(link.querySelector("svg.md-file-mark")).not.toBeNull();
  });

  it("keeps a link's own words, and says an absolute path from the checkout's root", () => {
    expect(upgraded(`<a href="x" data-file-ref="web/x/auto-compact.ts" data-file-line="67">auto-compact.ts</a>`, "/w/app/web/x/auto-compact.ts").textContent)
      .toBe("auto-compact.ts (line 67)");
    expect(upgraded(`<button data-file-ref="/w/app/notes/plan.md">/w/app/notes/plan.md</button>`, "/w/app/notes/plan.md").textContent)
      .toBe("notes/plan.md");
  });
});

describe("the files a session touched", () => {
  it("collects every edited, written or read path, and the files a turn was measured to change", () => {
    const tool = (name: string, input: Record<string, unknown>): Block =>
      ({ kind: "tool", toolUseId: name, name, input, result: { content: "", isError: false }, ts: 0 });
    const found = touchedFiles([
      tool("Edit", { file_path: "/w/app/web/lib/orgs.ts" }),
      tool("Write", { file_path: "notes/new.md" }),
      tool("apply_patch", { changes: [{ path: "/w/app/src/a.ts" }, { path: "src/b.ts" }] }),
      tool("Bash", { command: "ls" }),
    ], { 5: { checkpointId: "c", settledAt: 5, root: "/w/app", afterTree: "t", totalFiles: 1,
      files: [{ path: "gen/out.ts", oldPath: null, status: "added", additions: 1, deletions: 0 }] } }, "/w/app");
    expect([...found].sort()).toEqual(["/w/app/gen/out.ts", "/w/app/notes/new.md", "/w/app/src/a.ts", "/w/app/src/b.ts", "/w/app/web/lib/orgs.ts"]);
  });
});
