import type { DocumentKind } from "./entities";

/**
 * The largest file the document pane will open (2 MiB). The editors hold the whole text in memory in
 * the renderer and re-serialize it on every save, so this is a responsiveness ceiling, not a storage
 * one. Files above it are listed by the picker but refuse to open, with the size shown — silently
 * opening a 40 MB CSV and freezing the window is the failure this prevents.
 */
export const DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;

/** Extensions the sheet editor claims. Kept separate so `documents.list` can filter with the same set. */
const SHEET_EXT = new Set(["csv", "tsv"]);

/**
 * Path → editor, by extension alone. Deliberately pure and content-blind so it can run on a directory
 * listing where nothing has been read yet.
 *
 * The one case extension cannot settle is **slides**: a Marp deck is a `.md` file, indistinguishable
 * from a document until you read its front-matter. This function therefore answers "doc" for every
 * plain `.md`, and `refineDocumentKind` promotes it once the text is in hand. The naming conventions
 * `*.slides.md` and `*.deck.md` are honoured here as an explicit opt-in that does not need a read —
 * which is what lets the picker show the right icon before opening anything.
 */
export function documentKindFor(path: string): DocumentKind {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (ext === "tex") return "latex";
  if (SHEET_EXT.has(ext)) return "sheet";
  if (ext === "md" || ext === "markdown") {
    return /\.(slides|deck)\.(md|markdown)$/.test(name) ? "slides" : "doc";
  }
  return "unsupported";
}

/**
 * Second pass, once the text exists: a `.md` whose YAML front-matter sets `marp: true` is a deck, not
 * a document. Only ever promotes `doc` → `slides`; every other kind is returned untouched, so this is
 * safe to call unconditionally after a read.
 *
 * The front-matter must be the very first thing in the file (Marp's own rule), so the scan is bounded
 * to the leading block rather than searching the whole document — a `marp: true` line quoted inside a
 * code fence halfway down a report must not silently turn it into a presentation.
 */
export function refineDocumentKind(kind: DocumentKind, text: string): DocumentKind {
  if (kind !== "doc") return kind;
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  const frontMatter = m?.[1];
  if (frontMatter === undefined) return kind;
  return /^\s*marp\s*:\s*true\s*$/m.test(frontMatter) ? "slides" : kind;
}

/** The starting content for each kind, used by `documents.createFile`. */
export function documentTemplate(kind: DocumentKind, title: string): string {
  switch (kind) {
    case "doc": return `# ${title}\n\n`;
    case "sheet": return "A,B,C\n,,\n";
    case "slides": return `---\nmarp: true\n---\n\n# ${title}\n\n---\n\n## Next slide\n`;
    case "latex": return `\\documentclass{article}\n\n\\title{${title}}\n\\author{}\n\n\\begin{document}\n\\maketitle\n\n\\end{document}\n`;
    default: return "";
  }
}
