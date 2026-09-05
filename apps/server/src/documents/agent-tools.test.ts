import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { emptyGuideProgress, recordGuideAttempt, type DocumentEntry } from "@realm/contracts";
import { DOCS_PROVIDER_NAME, createDocsAgentProvider, type DocsAgentToolsDeps } from "./agent-tools";
import { TextExtractor } from "./text-extract";

function harness(o: { enabled?: boolean } = {}) {
  const root = tempDir("realm-docs-tools-");
  mkdirSync(join(root, "lectures"));
  writeFileSync(join(root, "lectures", "2026-09-01-pipelining.md"), "# Pipelining\n\nforwarding fixes data hazards");
  writeFileSync(join(root, "lectures", "2026-09-03-caches.md"), "# Caches\n\nthrashing");
  const opened: string[] = [];
  let progress = emptyGuideProgress();
  const deps: DocsAgentToolsDeps = {
    mcp: { providerEnabled: () => o.enabled ?? true },
    extractor: new TextExtractor(async () => ""),
    rootForSpace: (spaceId) => (spaceId === "s1" ? root : null),
    listForSpace: async (_s, dir): Promise<DocumentEntry[]> => (dir === "lectures"
      ? [{ path: "lectures/2026-09-01-pipelining.md", name: "2026-09-01-pipelining.md", isDir: false, size: 40 }]
      : [{ path: "lectures", name: "lectures", isDir: true, size: 0 }]),
    openPath: async (p) => { opened.push(p.path); return { documentsId: "d1", itemId: "i1", environmentId: "e1" }; },
    progressForSpace: async () => progress,
  };
  const provider = createDocsAgentProvider(deps);
  const ctx = { sessionId: "sess", spaceId: "s1" };
  const call = async (tool: string, args: unknown) => {
    const r = await provider.call(ctx, tool, args);
    return { text: r.content.map((c) => ("text" in c ? c.text : "")).join(""), isError: r.isError };
  };
  return { provider, ctx, call, opened, setProgress: (p: typeof progress) => { progress = p; } };
}

describe("realm-docs provider", () => {
  it("lists four tools when enabled and none when the space turned it off", async () => {
    const on = harness();
    expect((await on.provider.tools(on.ctx)).map((t) => t.name)).toEqual(["docs_search", "docs_list", "docs_open", "docs_progress"]);
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
});
