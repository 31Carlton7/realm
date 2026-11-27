import { hljsIfLoaded } from "./rich-libs";
import { grammarFor } from "./highlight-names";

export { GRAMMARS, grammarFor, grammarForPath } from "./highlight-names";

/** Syntax highlighting for every fenced block, tool code preview and diff line in the transcript.
 *
 *  `highlight.js/lib/core` plus an explicit language list, never the full package: the full build is
 *  ~1MB of grammars for 190 languages. This list is what an agent working in this repo — and in the
 *  repos its user opens — actually emits. Even that is loaded after the window is up
 *  (`highlight-grammars.ts`, `rich-libs.ts`), so until it lands code is drawn uncoloured.
 *
 *  Nothing here ever calls `highlightAuto`. Guessing is slow (it runs every registered grammar) and
 *  it is wrong often enough to be worse than plain text: mis-coloured code reads as a different
 *  language, and the reader has no way to tell it was a guess. An unknown fence stays uncoloured. */

/** Past this many characters a block is a data dump, not code to read. Highlighting one costs more
 *  than the whole rest of a transcript render — and it re-runs on every streaming delta. */
const HIGHLIGHT_LIMIT = 40_000;

/** HTML-escaped `code`, with highlight.js token spans when the language is one we registered.
 *  Always returns markup safe to insert: highlight.js escapes what it does not tokenise, and the
 *  fallback path escapes by hand. The result still goes through DOMPurify with everything else — the
 *  sanitizer stays the single gate, not a thing this function is trusted to stand in for. */
export function highlightToHtml(code: string, lang: string | null): string {
  const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const name = lang ? grammarFor(lang) : null;
  if (!name || code.length > HIGHLIGHT_LIMIT) return escaped;
  // Not loaded yet: plain until it is, and the caller re-renders on `useRichLibs`.
  const hljs = hljsIfLoaded();
  if (!hljs) return escaped;
  try {
    return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
  } catch {
    // A grammar can throw on pathological input. Uncoloured code is a smaller failure than a
    // transcript that stops rendering.
    return escaped;
  }
}
