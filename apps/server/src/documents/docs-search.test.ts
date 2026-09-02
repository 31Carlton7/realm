import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreOf, searchDocs, walkFiles } from "./docs-search";
import { TextExtractor } from "./text-extract";
import { makePdf } from "./test-pdf";

function course() {
  const root = mkdtempSync(join(tmpdir(), "realm-course-"));
  mkdirSync(join(root, "lectures"));
  mkdirSync(join(root, "guides"));
  mkdirSync(join(root, "slides"));
  mkdirSync(join(root, "node_modules", "x"), { recursive: true });
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "lectures", "2026-09-01-pipelining.md"), "# Pipelining\n\nHazards: structural, data, control. Forwarding fixes most data hazards.");
  writeFileSync(join(root, "lectures", "2026-09-03-caches.md"), "# Caches\n\nDirect-mapped vs set-associative. A hazard here is thrashing.");
  writeFileSync(join(root, "guides", "hazards.html"), "<h1>Hazards guide</h1><p>data hazard, control hazard, structural hazard</p>");
  writeFileSync(join(root, "slides", "l4.pdf"), makePdf(["Pipeline hazards and forwarding"]));
  writeFileSync(join(root, "slides", "scanned-hazards.pdf"), "%PDF-1.4 garbage");
  writeFileSync(join(root, "node_modules", "x", "hazard.md"), "hazard hazard hazard");
  writeFileSync(join(root, ".git", "hazard.md"), "hazard");
  writeFileSync(join(root, ".hidden-hazard.md"), "hazard");
  writeFileSync(join(root, "photo.png"), "png");
  return root;
}

describe("walkFiles", () => {
  it("lists extractable files only, skipping hidden entries and build folders", async () => {
    const root = course();
    const { files, truncated } = await walkFiles(root);
    expect(truncated).toBe(false);
    expect(files).toEqual([
      "guides/hazards.html", "lectures/2026-09-01-pipelining.md", "lectures/2026-09-03-caches.md",
      "slides/l4.pdf", "slides/scanned-hazards.pdf",
    ]);
  });
  it("scopes to a subdirectory and refuses an escaping one", async () => {
    const root = course();
    expect((await walkFiles(root, "lectures")).files).toHaveLength(2);
    await expect(walkFiles(root, "../")).rejects.toThrow(/escapes|relative/);
  });
});

describe("searchDocs", () => {
  it("ranks a file whose path and text both match above a text-only match, with snippets", async () => {
    const root = course();
    const x = new TextExtractor(async () => "Pipeline hazards and forwarding"); // pdf seam: no parse in this test
    const r = await searchDocs(root, "hazard", x);
    expect(r.hits[0]!.path).toBe("guides/hazards.html"); // path bonus + three occurrences
    expect(r.hits.map((h) => h.path)).toContain("slides/l4.pdf");
    expect(r.hits.find((h) => h.path === "slides/l4.pdf")!.kind).toBe("pdf");
    const first = r.hits[0]!.snippet;
    expect(first.some((s) => s.match && s.text.toLowerCase() === "hazard")).toBe(true);
    expect(r.scanned).toBe(5);
  });

  it("requires every token, and honours dir and limit", async () => {
    const root = course();
    const x = new TextExtractor(async () => "");
    expect((await searchDocs(root, "forwarding structural", x)).hits.map((h) => h.path)).toEqual(["lectures/2026-09-01-pipelining.md"]);
    expect((await searchDocs(root, "hazard", x, { dir: "lectures" })).hits.map((h) => h.path).every((p) => p.startsWith("lectures/"))).toBe(true);
    expect((await searchDocs(root, "hazard", x, { limit: 1 })).hits).toHaveLength(1);
    expect((await searchDocs(root, "   ", x)).hits).toEqual([]);
  });

  it("still finds a scanned PDF (no text layer) by its filename", async () => {
    const root = course();
    const x = new TextExtractor(async () => "");
    const r = await searchDocs(root, "scanned", x);
    expect(r.hits.map((h) => h.path)).toEqual(["slides/scanned-hazards.pdf"]);
    expect(r.hits[0]!.snippet).toEqual([{ text: "slides/scanned-hazards.pdf", match: true }]);
  });

  it("reads real PDF text through the default extractor", async () => {
    const root = course();
    const r = await searchDocs(root, "forwarding", new TextExtractor());
    expect(r.hits.map((h) => h.path)).toEqual(expect.arrayContaining(["slides/l4.pdf", "lectures/2026-09-01-pipelining.md"]));
  });
});

describe("scoreOf", () => {
  it("rewards occurrences and a path match, damped by length", () => {
    const short = scoreOf("a.md", "hazard hazard", ["hazard"]);
    const long = scoreOf("a.md", `hazard hazard ${"x".repeat(200_000)}`, ["hazard"]);
    const pathy = scoreOf("hazard.md", "hazard hazard", ["hazard"]);
    expect(short).toBeGreaterThan(long);
    expect(pathy).toBeGreaterThan(short);
    expect(scoreOf("a.md", "nothing", ["hazard"])).toBe(0);
  });
});
