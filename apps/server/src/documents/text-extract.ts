import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

/**
 * Plain text out of the files a course folder holds (Plan 22 W2), for `docs_search`.
 *
 * Text formats are read as-is (HTML is stripped to its text). PDFs — slide decks, problem sets,
 * papers, the bulk of what a course actually hands out — go through pdf.js's text layer, which is
 * the same extraction a browser's find-in-page uses: real for text-based PDFs, empty for scanned
 * ones (no OCR here; a scanned deck reports no text rather than garbage).
 *
 * Extraction is memoized on `(path, size, mtime)`. A PDF's text is the expensive part of every
 * search and the file rarely changes, so the second search of a course pays nothing for the deck
 * the first one parsed. The cache is bounded by entry count and total characters so a folder of
 * fifty decks cannot grow the server without limit.
 */

export const TEXT_EXTS = new Set(["md", "markdown", "txt", "text", "html", "htm", "csv", "tsv", "tex", "json", "yaml", "yml", "rst", "org", "log"]);
export const PDF_EXT = "pdf";

/** Largest text file read (matches the document pane's own ceiling) and largest PDF parsed. */
export const TEXT_MAX_BYTES = 2 * 1024 * 1024;
export const PDF_MAX_BYTES = 40 * 1024 * 1024;
/** Pages and characters per PDF, so a 900-page textbook is sampled rather than swallowed. */
export const PDF_MAX_PAGES = 300;
export const PDF_MAX_CHARS = 800_000;

export const isExtractable = (path: string): boolean => {
  const ext = extname(path).slice(1).toLowerCase();
  return TEXT_EXTS.has(ext) || ext === PDF_EXT;
};

type Entry = { size: number; mtimeMs: number; text: string };
const CACHE_MAX_ENTRIES = 400;
const CACHE_MAX_CHARS = 30_000_000;

export class TextExtractor {
  private cache = new Map<string, Entry>();
  private chars = 0;
  /** Seam for tests and for a build without pdf.js: replace the PDF reader wholesale. */
  constructor(private pdf: (buf: Buffer) => Promise<string> = pdfText) {}

  /** `null` when the file is not a kind this extracts, or exceeds its size ceiling. Throws on I/O. */
  async text(abs: string): Promise<string | null> {
    const ext = extname(abs).slice(1).toLowerCase();
    const isPdf = ext === PDF_EXT;
    if (!isPdf && !TEXT_EXTS.has(ext)) return null;
    const st = await stat(abs);
    if (!st.isFile()) return null;
    if (st.size > (isPdf ? PDF_MAX_BYTES : TEXT_MAX_BYTES)) return null;
    const hit = this.cache.get(abs);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.text;
    let text: string;
    if (isPdf) {
      const buf = await readFile(abs);
      try { text = await this.pdf(buf); } catch { text = ""; }
    } else {
      text = await readFile(abs, "utf8");
      if (ext === "html" || ext === "htm") text = htmlToText(text);
    }
    this.remember(abs, { size: st.size, mtimeMs: st.mtimeMs, text });
    return text;
  }

  private remember(abs: string, e: Entry): void {
    const old = this.cache.get(abs);
    if (old) { this.chars -= old.text.length; this.cache.delete(abs); }
    this.cache.set(abs, e);
    this.chars += e.text.length;
    // Evict oldest-inserted first. Map iteration is insertion order, and re-inserting on refresh
    // (above) keeps a recently re-read file young.
    for (const [k, v] of this.cache) {
      if (this.cache.size <= CACHE_MAX_ENTRIES && this.chars <= CACHE_MAX_CHARS) break;
      this.cache.delete(k); this.chars -= v.text.length;
    }
  }
}

/** Tags stripped, scripts and styles dropped, the handful of entities prose actually uses decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

/**
 * pdf.js text layer, page by page, joined with blank lines so a snippet never runs across a page
 * break as if it were one sentence. Loaded lazily: the module is a few megabytes and most searches
 * never touch a PDF.
 */
export async function pdfText(buf: Buffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true, verbosity: 0 }).promise;
  try {
    const pages = Math.min(doc.numPages, PDF_MAX_PAGES);
    const out: string[] = [];
    let chars = 0;
    for (let p = 1; p <= pages && chars < PDF_MAX_CHARS; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let line = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        line += item.str;
        if (item.hasEOL) line += "\n"; else line += " ";
      }
      const text = line.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
      out.push(text);
      chars += text.length;
      page.cleanup();
    }
    return out.join("\n\n");
  } finally {
    await doc.destroy();
  }
}
