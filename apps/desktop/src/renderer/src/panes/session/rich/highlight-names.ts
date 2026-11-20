/** Which highlight.js grammar a fence label or a path names, apart from highlight.js itself, so main can
 *  colour a file for a PDF with the names the transcript uses. */

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
