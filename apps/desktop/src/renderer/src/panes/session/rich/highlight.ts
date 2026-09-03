import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/** Syntax highlighting for every fenced block, tool code preview and diff line in the transcript.
 *
 *  `highlight.js/lib/core` plus an explicit language list, never the full package: the full build is
 *  ~1MB of grammars for 190 languages, and the renderer pays that on every cold start. This list is
 *  what an agent working in this repo — and in the repos its user opens — actually emits.
 *
 *  Nothing here ever calls `highlightAuto`. Guessing is slow (it runs every registered grammar) and
 *  it is wrong often enough to be worse than plain text: mis-coloured code reads as a different
 *  language, and the reader has no way to tell it was a guess. An unknown fence stays uncoloured. */
for (const [name, lang] of Object.entries({
  bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, lua,
  markdown, php, python, ruby, rust, scss, sql, swift, typescript, xml, yaml,
})) hljs.registerLanguage(name, lang);

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
  return hljs.getLanguage(name) ? name : null;
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
  try {
    return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
  } catch {
    // A grammar can throw on pathological input. Uncoloured code is a smaller failure than a
    // transcript that stops rendering.
    return escaped;
  }
}
