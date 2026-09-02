import { z } from "zod";
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
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "pdf") return "pdf";
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
    case "html": return guideTemplate(title);
    default: return "";
  }
}

/**
 * The starting content for a study guide (Plan 22 W1): a self-contained page that already uses the
 * guide runtime's markup (`rg-quiz`, `rg-steps`, `rg-reveal`), so the first thing an author sees is
 * a working quiz rather than an empty body. The runtime and stylesheet are NOT linked here — the
 * preview server injects them when it serves the file, so the file stays portable: opened in any
 * browser it is a plain, readable page, just without the interactive parts.
 */
export function guideTemplate(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="realm-helpers" content="katex">
<title>${escapeHtml(title)}</title>
</head>
<body>
<main class="rg-guide">
<h1>${escapeHtml(title)}</h1>
<p class="rg-lede">One-paragraph orientation: what this guide covers and what you should be able to do afterwards.</p>

<section class="rg-quiz" data-topic="${slugify(title) || "topic"}">
<h2>Check yourself</h2>
<div class="rg-question" data-answer="b">
<p>Replace this with a question.</p>
<ol class="rg-options">
<li>A wrong option</li>
<li>The right option</li>
<li>Another wrong option</li>
</ol>
<div class="rg-explain">Why the right option is right.</div>
</div>
<button class="rg-check">Check answers</button>
</section>

<footer class="rg-sources">
<h2>Sources</h2>
<ul><li>Which lecture, slide deck or notes this guide was built from.</li></ul>
</footer>
</main>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** A filesystem- and id-safe lowercase slug: letters, digits and single hyphens. Empty for input
 *  with no word characters, so callers must supply their own fallback. */
export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

// ---------------------------------------------------------------------------------------------------
// Guide progress (Plan 22 W1)
//
// A guide's quiz results live in a SIDECAR next to the guide — `.<name>.progress.json` — the same
// ignorable-sidecar convention Plan 17 chose for sheet metadata: the guide itself stays a clean,
// portable HTML file, and a consumer that ignores the sidecar still has a correct document. The
// sandboxed frame has no storage of its own (an opaque origin has no localStorage), so the runtime
// reports through postMessage and the pane writes the sidecar over RPC.

export const GUIDE_PROGRESS_MAX_ATTEMPTS = 50;

export const GuideAttemptSchema = z.object({ at: z.number().int(), correct: z.number().int().nonnegative(), total: z.number().int().positive() });
export type GuideAttempt = z.infer<typeof GuideAttemptSchema>;

/** Per-topic history, newest last. `best` is derived on write so a reader never has to fold. */
export const GuideTopicProgressSchema = z.object({
  attempts: z.array(GuideAttemptSchema),
  best: z.number().min(0).max(1),
  last: z.number().min(0).max(1),
});
export type GuideTopicProgress = z.infer<typeof GuideTopicProgressSchema>;

export const GuideProgressSchema = z.object({
  version: z.literal(1),
  topics: z.record(z.string(), GuideTopicProgressSchema),
});
export type GuideProgress = z.infer<typeof GuideProgressSchema>;

export const emptyGuideProgress = (): GuideProgress => ({ version: 1, topics: {} });

/** `guides/cache.html` → `guides/.cache.html.progress.json`. Hidden (dot-prefixed) so the file
 *  picker never lists it and a directory of guides reads as a directory of guides. */
export function progressSidecarPath(guidePath: string): string {
  const i = guidePath.lastIndexOf("/");
  const dir = i >= 0 ? guidePath.slice(0, i + 1) : "";
  const name = guidePath.slice(i + 1);
  return `${dir}.${name}.progress.json`;
}

/** Fold one attempt in. Pure, returns a new object; the history is capped so a sidecar cannot grow
 *  without bound under a guide someone retakes every day for a semester. */
export function recordGuideAttempt(p: GuideProgress, topic: string, attempt: GuideAttempt): GuideProgress {
  const prev = p.topics[topic] ?? { attempts: [], best: 0, last: 0 };
  const attempts = [...prev.attempts, attempt].slice(-GUIDE_PROGRESS_MAX_ATTEMPTS);
  const score = attempt.correct / attempt.total;
  return { version: 1, topics: { ...p.topics, [topic]: { attempts, best: Math.max(prev.best, score), last: score } } };
}

/** Topics whose LAST attempt scored under `threshold` — what "review what you got wrong" reads. */
export function weakTopics(p: GuideProgress, threshold = 0.8): string[] {
  return Object.entries(p.topics).filter(([, t]) => t.last < threshold).map(([k]) => k).sort();
}
