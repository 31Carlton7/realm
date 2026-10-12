import { hljsIfLoaded } from "./rich-libs";

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

/** The registered grammars (`highlight-grammars.ts`) and the aliases each one declares itself, so a
 *  fence label resolves without highlight.js loaded. A test holds this to highlight.js's own list. */
export const GRAMMARS: Record<string, readonly string[]> = {
  bash: ["sh", "zsh"], c: ["h"], cpp: ["cc", "c++", "h++", "hpp", "hh", "hxx", "cxx"], csharp: ["cs", "c#"],
  css: [], diff: ["patch"], dockerfile: ["docker"], go: ["golang"], ini: ["toml"], java: ["jsp"],
  javascript: ["js", "jsx", "mjs", "cjs"], json: ["jsonc", "json5"], kotlin: ["kt", "kts", "ktm", "ktx"],
  lua: ["pluto"], markdown: ["md", "mkdown", "mkd"], php: [], python: ["py", "gyp", "ipython"],
  ruby: ["rb", "gemspec", "podspec", "thor", "irb"], rust: ["rs"], scss: [], sql: [], swift: [],
  typescript: ["ts", "tsx", "mts", "cts"],
  xml: ["html", "xhtml", "rss", "atom", "xjb", "xsd", "xsl", "plist", "wsf", "svg"], yaml: ["yml"],
};
const KNOWN = new Set(Object.entries(GRAMMARS).flatMap(([name, aliases]) => [name, ...aliases]));

/** Fence labels agents write, mapped to the grammar that handles them. TSX/JSX go to their base
 *  language: highlight.js's typescript and javascript grammars both parse the XML sub-language. */
const ALIASES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript",
  sh: "bash", shell: "bash", zsh: "bash", console: "bash", "shell-session": "bash",
  py: "python", rb: "ruby", rs: "rust", kt: "kotlin", golang: "go",
  yml: "yaml", md: "markdown", html: "xml", svg: "xml", vue: "xml", plist: "xml",
  toml: "ini", conf: "ini", cfg: "ini", "c++": "cpp", h: "cpp", hpp: "cpp", cs: "csharp",
  postgres: "sql", psql: "sql", sqlite: "sql", patch: "diff",
  dockerfile: "dockerfile", containerfile: "dockerfile",
};

/** Past this many characters a block is a data dump, not code to read. Highlighting one costs more
 *  than the whole rest of a transcript render — and it re-runs on every streaming delta. */
const HIGHLIGHT_LIMIT = 40_000;

/** The registered grammar for a fence label, or null when there is none to use. */
export function grammarFor(lang: string): string | null {
  const key = lang.trim().toLowerCase();
  if (!key) return null;
  const name = ALIASES[key] ?? key;
  return KNOWN.has(name) ? name : null;
}

/** The language a path implies, for previews and diffs — which name a file rather than a fence. */
export function grammarForPath(path: string): string | null {
  const base = path.split(/[\\/]/).pop() ?? "";
  if (/^(Dockerfile|Containerfile)/i.test(base)) return "dockerfile";
  if (/^(Makefile|Justfile)/i.test(base)) return null; // registered grammar would be a lie; make is not in the list
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  return grammarFor(ext);
}

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
