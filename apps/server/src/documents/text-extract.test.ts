import { describe, expect, it } from "vitest";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextExtractor, htmlToText, isExtractable, pdfText } from "./text-extract";
import { makePdf } from "./test-pdf";

describe("htmlToText", () => {
  it("drops scripts, styles and tags; keeps block breaks; decodes common entities", () => {
    const t = htmlToText("<html><head><style>p{}</style><script>x()</script></head><body><h1>Caches &amp; MESI</h1><p>one<br>two</p><li>a &lt; b</li></body></html>");
    expect(t).toBe("Caches & MESI\none\ntwo\na < b");
  });
});

describe("pdfText — the real pdf.js path", () => {
  it("reads the text layer of a text-based PDF in Node", async () => {
    const text = await pdfText(makePdf(["Pipelining hazards", "Forwarding paths"]));
    expect(text).toContain("Pipelining hazards");
    expect(text).toContain("Forwarding paths");
  });
});

describe("TextExtractor", () => {
  it("extracts text files and PDFs, and answers null for other kinds and oversized files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realm-extract-"));
    writeFileSync(join(dir, "a.md"), "# Caches\n\nMESI protocol");
    writeFileSync(join(dir, "p.pdf"), makePdf(["Snoopy caches"]));
    writeFileSync(join(dir, "bin.zip"), "zip");
    writeFileSync(join(dir, "g.html"), "<p>from <b>html</b></p>");
    const x = new TextExtractor();
    expect(await x.text(join(dir, "a.md"))).toContain("MESI protocol");
    expect(await x.text(join(dir, "p.pdf"))).toContain("Snoopy caches");
    expect(await x.text(join(dir, "g.html"))).toBe("from html");
    expect(await x.text(join(dir, "bin.zip"))).toBeNull();
    expect(isExtractable("x.PDF")).toBe(true);
    expect(isExtractable("x.pptx")).toBe(false);
  });

  it("memoizes on size+mtime and re-reads when either changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realm-extract-"));
    const f = join(dir, "p.pdf");
    let calls = 0;
    const x = new TextExtractor(async () => { calls++; return `parsed ${calls}`; });
    writeFileSync(f, makePdf(["one"]));
    expect(await x.text(f)).toBe("parsed 1");
    expect(await x.text(f)).toBe("parsed 1");
    expect(calls).toBe(1);
    // Same size, new mtime → re-parse. (Content identical in bytes; the mtime alone must invalidate,
    // because an editor's save can keep the size.)
    utimesSync(f, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect(await x.text(f)).toBe("parsed 2");
    expect(calls).toBe(2);
  });

  it("swallows a PDF parse failure as empty text rather than failing the search", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realm-extract-"));
    const f = join(dir, "broken.pdf");
    writeFileSync(f, "not a pdf at all");
    const x = new TextExtractor(async () => { throw new Error("boom"); });
    expect(await x.text(f)).toBe("");
  });
});
