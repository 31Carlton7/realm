import { describe, expect, it } from "vitest";
import { writeFileSync, utimesSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { QUICKLOOK_MAX_BYTES, QuickLookRenderer } from "./quicklook";

/**
 * The renderer is driven through its `render` seam rather than through `qlmanage`: what is worth
 * pinning is the CACHING and the refusals, and shelling out to macOS in a unit test would make the
 * suite depend on which Quick Look generators the machine happens to have installed.
 *
 * The named mutants:
 *   - a cache keyed on the path alone          → "an edit in place"
 *   - a failed render remembered as an answer  → "a generator that declined"
 *   - two frames costing two renders           → "one render for two askers"
 */

const PNG = Buffer.from("\x89PNG\r\n\x1a\n-not-really-but-nonempty");

function fixture(bytes = "hello") {
  const dir = tempDir("realm-ql-");
  const abs = join(dir, "report.docx");
  writeFileSync(abs, bytes);
  return abs;
}

/** A `render` that writes what a generator would, and counts how often it was asked. */
function fake(out: Buffer | null = PNG) {
  const calls: string[] = [];
  return {
    calls,
    render: async (abs: string, outDir: string) => {
      calls.push(abs);
      if (out) await writeFile(join(outDir, "report.docx.png"), out);
    },
  };
}

describe("QuickLookRenderer", () => {
  it("renders once and serves the same bytes afterwards", async () => {
    const f = fake();
    const r = new QuickLookRenderer({ render: f.render });
    const abs = fixture();
    expect(await r.png(abs)).toEqual(PNG);
    expect(await r.png(abs)).toEqual(PNG);
    expect(f.calls).toHaveLength(1);
  });

  it("re-renders after an edit in place — the key is the file's mtime and size, not its path", async () => {
    // An agent rewriting a `.docx` keeps the path. A cache keyed on the path alone would keep
    // serving the version from before the edit, which is exactly the stale view this replaces.
    const f = fake();
    const r = new QuickLookRenderer({ render: f.render });
    const abs = fixture("hello");
    await r.png(abs);
    writeFileSync(abs, "hello, again — longer");
    await r.png(abs);
    expect(f.calls).toHaveLength(2);
  });

  it("notices a rewrite that changed the bytes but not the length", async () => {
    // Same size, new mtime. Size alone would miss this, and it is the common shape of a find-replace.
    const f = fake();
    const r = new QuickLookRenderer({ render: f.render });
    const abs = fixture("aaaaa");
    await r.png(abs);
    writeFileSync(abs, "bbbbb");
    utimesSync(abs, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    await r.png(abs);
    expect(f.calls).toHaveLength(2);
  });

  it("costs one render for two askers", async () => {
    // Two frames mounting at once — a split with the same file open twice, or a re-render mid-fetch.
    const f = fake();
    const r = new QuickLookRenderer({ render: f.render });
    const abs = fixture();
    const [a, b] = await Promise.all([r.png(abs), r.png(abs)]);
    expect(a).toEqual(PNG);
    expect(b).toEqual(PNG);
    expect(f.calls).toHaveLength(1);
  });

  it("answers null for a generator that declined, and does not remember the failure as an answer", async () => {
    // A password-protected document, or a format with no generator installed. The next ask has to
    // try again — the file may have been fixed since.
    const f = fake(null);
    const r = new QuickLookRenderer({ render: f.render });
    const abs = fixture();
    expect(await r.png(abs)).toBeNull();
    expect(await r.png(abs)).toBeNull();
    expect(f.calls).toHaveLength(2);
  });

  it("answers null when the generator throws — a missing qlmanage is not an error to raise", async () => {
    // On a machine that is not a Mac there is no `qlmanage` at all, and the honest answer is the
    // same one a crashed generator gets: no preview.
    const r = new QuickLookRenderer({ render: async () => { throw new Error("spawn qlmanage ENOENT"); } });
    expect(await r.png(fixture())).toBeNull();
  });

  it("answers null for a file that is not there, and for one too large to be worth a page of", async () => {
    const f = fake();
    const r = new QuickLookRenderer({ render: f.render });
    expect(await r.png("/definitely/not/here.docx")).toBeNull();
    const dir = tempDir("realm-ql-");
    const big = join(dir, "huge.pptx");
    writeFileSync(big, Buffer.alloc(QUICKLOOK_MAX_BYTES + 1));
    expect(await r.png(big)).toBeNull();
    // Neither reached the generator.
    expect(f.calls).toEqual([]);
  });

  it("holds a bounded number of renders", async () => {
    // A picture per open tab is fine; a picture per file a workspace has ever shown is not.
    const f = fake();
    const r = new QuickLookRenderer({ render: f.render });
    const files = Array.from({ length: 10 }, (_, i) => fixture(`doc ${i}`));
    for (const abs of files) await r.png(abs);
    expect(f.calls).toHaveLength(10);
    // The most recent is still held…
    await r.png(files[9]!);
    expect(f.calls).toHaveLength(10);
    // …and the oldest has been let go.
    await r.png(files[0]!);
    expect(f.calls).toHaveLength(11);
  });

  it("clear() lets everything go", async () => {
    const f = fake();
    const r = new QuickLookRenderer({ render: f.render });
    const abs = fixture();
    await r.png(abs);
    r.clear();
    await r.png(abs);
    expect(f.calls).toHaveLength(2);
  });
});
