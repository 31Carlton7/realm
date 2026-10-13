import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { emptyGuideProgress, recordGuideAttempt, type DocumentEntry } from "@realm/contracts";
import { DOCS_PROVIDER_NAME, createDocsAgentProvider, type DocsAgentToolsDeps } from "./agent-tools";
import { TextExtractor } from "./text-extract";
import { namedInRoot } from "./paths";

function harness(o: { enabled?: boolean; panes?: ReturnType<DocsAgentToolsDeps["panesForSpace"]> } = {}) {
  const root = tempDir("realm-docs-tools-");
  mkdirSync(join(root, "lectures"));
  writeFileSync(join(root, "lectures", "2026-09-01-pipelining.md"), "# Pipelining\n\nforwarding fixes data hazards");
  writeFileSync(join(root, "lectures", "2026-09-03-caches.md"), "# Caches\n\nthrashing");
  const opened: string[] = [];
  const openedBy: (string | undefined)[] = [];
  let progress = emptyGuideProgress();
  const extractor = new TextExtractor(async () => "page one of the deck\npage two");
  const deps: DocsAgentToolsDeps = {
    mcp: { providerEnabled: () => o.enabled ?? true },
    extractor,
    rootForSpace: (spaceId) => (spaceId === "s1" ? root : null),
    listForSpace: async (_s, dir): Promise<DocumentEntry[]> => (dir === "lectures"
      ? [{ path: "lectures/2026-09-01-pipelining.md", name: "2026-09-01-pipelining.md", isDir: false, size: 40 }]
      : [{ path: "lectures", name: "lectures", isDir: true, size: 0 }]),
    openPath: async (p) => { opened.push(p.path); openedBy.push(p.openedBy); return { documentsId: "d1", itemId: "i1", environmentId: "e1" }; },
    progressForSpace: async () => progress,
    readForSpace: async (_s, path) => {
      const { rel, abs } = namedInRoot(root, path);
      return { path: rel, text: await extractor.text(abs) };
    },
    panesForSpace: () => o.panes ?? [],
  };
  const provider = createDocsAgentProvider(deps);
  const ctx = { sessionId: "sess", spaceId: "s1" };
  const call = async (tool: string, args: unknown) => {
    const r = await provider.call(ctx, tool, args);
    return { text: r.content.map((c) => ("text" in c ? c.text : "")).join(""), isError: r.isError };
  };
  return { root, provider, ctx, call, opened, openedBy, setProgress: (p: typeof progress) => { progress = p; } };
}

describe("realm-docs provider", () => {
  it("lists its tools when enabled and none when the space turned it off", async () => {
    const on = harness();
    expect((await on.provider.tools(on.ctx)).map((t) => t.name)).toEqual(["docs_search", "docs_list", "docs_open", "docs_read", "docs_state", "docs_progress"]);
    expect(on.provider.name).toBe(DOCS_PROVIDER_NAME);
    const off = harness({ enabled: false });
    expect(await off.provider.tools(off.ctx)).toEqual([]);
    expect((await off.call("docs_search", { query: "x" })).isError).toBe(true);
  });

  it("docs_search returns ranked paths with snippets, and says so when nothing matches", async () => {
    const h = harness();
    const r = await h.call("docs_search", { query: "forwarding" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("1 hit");
    expect(r.text).toContain("lectures/2026-09-01-pipelining.md");
    expect(r.text).toContain("[forwarding]");
    const none = await h.call("docs_search", { query: "quantum", dir: "lectures" });
    expect(none.isError).toBe(false);
    expect(none.text).toMatch(/No file under lectures mentions all of: quantum/);
    expect((await h.call("docs_search", {})).isError).toBe(true);
  });

  it("docs_list renders directories with a trailing slash and files with sizes", async () => {
    const h = harness();
    expect((await h.call("docs_list", {})).text).toBe("lectures/");
    expect((await h.call("docs_list", { dir: "/lectures/" })).text).toBe("lectures/2026-09-01-pipelining.md (40 bytes)");
  });

  it("docs_open goes through openPath and reports the workspace", async () => {
    const h = harness();
    const r = await h.call("docs_open", { path: "/lectures/2026-09-01-pipelining.md" });
    expect(r.isError).toBe(false);
    expect(h.opened).toEqual(["lectures/2026-09-01-pipelining.md"]);
    expect(h.openedBy).toEqual(["sess"]);
    expect(r.text).toContain("Opened lectures/2026-09-01-pipelining.md");
    expect((await h.call("docs_open", {})).isError).toBe(true);
  });

  it("docs_progress summarises per-topic history and names weak topics", async () => {
    const h = harness();
    expect((await h.call("docs_progress", { path: "guides/g.html" })).text).toMatch(/No attempts recorded/);
    let p = emptyGuideProgress();
    p = recordGuideAttempt(p, "caches", { at: 1, correct: 1, total: 4 });
    p = recordGuideAttempt(p, "pipelining", { at: 1, correct: 4, total: 4 });
    h.setProgress(p);
    const r = await h.call("docs_progress", { path: "guides/g.html" });
    expect(r.text).toContain("- caches: best 25%, last 25%, 1 attempt");
    expect(r.text).toContain("- pipelining: best 100%, last 100%, 1 attempt");
    expect(r.text).toContain("Weak topics (last < 80%): caches");
  });

  it("names the tool list on an unknown tool and never throws", async () => {
    const h = harness();
    const r = await h.call("docs_nope", {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("docs_search");
  });

  it("docs_read reads a file a page of numbered lines at a time, and says where the next page starts", async () => {
    const h = harness();
    writeFileSync(join(h.root, "long.md"), Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    const first = await h.call("docs_read", { path: "long.md" });
    expect(first.isError).toBe(false);
    expect(first.text).toContain("long.md — lines 1–200 of 450:");
    expect(first.text).toContain("    1| line 1\n");
    expect(first.text).toContain("  200| line 200\nMore: docs_read with offset 201.");
    const last = await h.call("docs_read", { path: join(h.root, "long.md"), offset: 401, limit: 100 });
    expect(last.text).toContain("long.md — lines 401–450 of 450:");
    expect(last.text).not.toContain("More:");
    expect((await h.call("docs_read", { path: "long.md", offset: 999 })).text).toBe("long.md has 450 lines, so there is nothing from line 999.");
  });

  it("docs_read reads a PDF's text, refuses an image with where to look instead, and a path outside the folder", async () => {
    const h = harness();
    writeFileSync(join(h.root, "deck.pdf"), "%PDF-1.4");
    expect((await h.call("docs_read", { path: "deck.pdf" })).text).toContain("    2| page two");
    writeFileSync(join(h.root, "shot.png"), Buffer.alloc(3 * 1024 * 1024));
    const png = await h.call("docs_read", { path: "shot.png" });
    expect(png.isError).toBe(true);
    expect(png.text).toContain("cannot be read as text");
    expect(png.text).toContain("docs_open shows it");
    const out = await h.call("docs_read", { path: "../../etc/passwd" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("escapes the workspace root");
  });

  it("docs_state names the open tabs and the one showing", async () => {
    const h = harness({ panes: [{ title: "Documents", root: "/spaces/s1", openPaths: ["notes.md", "guides/g.html"], activePath: "guides/g.html" }] });
    const r = await h.call("docs_state", {});
    expect(r.text).toContain(`Documents pane "Documents" over /spaces/s1:\n  - notes.md\n  - guides/g.html (showing)`);
    expect((await harness().call("docs_state", {})).text).toContain("no Documents pane yet");
  });
});
