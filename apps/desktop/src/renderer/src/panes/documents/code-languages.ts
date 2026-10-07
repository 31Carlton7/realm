/**
 * Path → which grammar the code editor highlights it with.
 *
 * Two tables decide what happens to a source file, and they answer different questions on purpose:
 *
 *  - `documentKindFor` (packages/contracts) decides whether a file is a `code` DOCUMENT at all. It is
 *    pure, content-blind and shared with the server, because it has to run on a directory listing
 *    where nothing has been read.
 *  - this one decides which CodeMirror grammar a `code` document gets. It cannot live beside the
 *    other: every value here is a lazy import of a renderer-only package, and contracts is imported
 *    by the server.
 *
 * The split is safe in one direction and only one: a file the contracts table calls `code` and this
 * table has never heard of opens in the editor with no highlighting, which is a degradation a person
 * can read. The reverse — a grammar here for an extension contracts does not route to `code` — is
 * simply unreachable, and the two lists below that are NOT code (`md`, `html`, `tex`) are here for
 * exactly that reason: they are claimed by richer editors, and are listed so a reader can see the
 * overlap is deliberate rather than an omission.
 */

/** A grammar this editor can load. `text` is the honest answer for a file that is text and nothing
 *  more — it still gets the editor, the search panel and the undo history, just no colours. */
export type CodeLanguage =
  | "javascript" | "jsx" | "typescript" | "tsx"
  | "json" | "markdown" | "css" | "html" | "xml"
  | "python" | "shell" | "yaml" | "toml"
  | "rust" | "go" | "c" | "cpp" | "java" | "kotlin" | "scala" | "csharp" | "objectivec" | "dart"
  | "swift" | "ruby" | "php" | "perl" | "lua" | "r" | "haskell"
  | "sql" | "dockerfile" | "properties" | "diff" | "protobuf"
  | "text";

/**
 * Extension (lowercased, after the last dot) → grammar.
 *
 * Written out rather than derived from the grammar names, because the interesting entries are the
 * ones where they disagree: `mjs` is JavaScript, `h` is C rather than C++ (a header that is really
 * C++ still parses, where a C file forced through the C++ grammar does not), and `scss`/`less` take
 * the CSS grammar knowingly — it stops at their nesting syntax, and a file that highlights for nine
 * tenths of its length beats a file that is grey.
 */
const BY_EXTENSION: Record<string, CodeLanguage> = {
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx",
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  json: "json", jsonc: "json", json5: "json", webmanifest: "json",
  // Claimed by the rich editor as `doc`; here so the overlap is visible, and for a future source view.
  md: "markdown", markdown: "markdown", mdx: "markdown",
  css: "css", scss: "css", less: "css", sass: "css",
  // Claimed by the guide preview as `html`, for the same reason as `md` above.
  html: "html", htm: "html", vue: "html", svelte: "html",
  xml: "xml", svg: "xml", xsd: "xml", xsl: "xml", plist: "xml", storyboard: "xml", xib: "xml",
  py: "python", pyi: "python", pyw: "python",
  sh: "shell", bash: "shell", zsh: "shell", ksh: "shell", fish: "shell", command: "shell",
  yaml: "yaml", yml: "yaml",
  toml: "toml",
  rs: "rust",
  go: "go",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp", ino: "cpp",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  scala: "scala", sbt: "scala",
  cs: "csharp",
  m: "objectivec", mm: "objectivec",
  dart: "dart",
  swift: "swift",
  rb: "ruby", rake: "ruby", gemspec: "ruby",
  php: "php",
  pl: "perl", pm: "perl",
  lua: "lua",
  r: "r",
  hs: "haskell",
  sql: "sql",
  dockerfile: "dockerfile",
  ini: "properties", cfg: "properties", conf: "properties", properties: "properties", env: "properties",
  editorconfig: "properties", gitconfig: "properties",
  diff: "diff", patch: "diff",
  proto: "protobuf",
  // Text with no grammar. Listed rather than left to the fallback so the difference between "Realm
  // knows this is text" and "Realm has never seen this extension" stays a fact in the table.
  txt: "text", text: "text", log: "text",
  // `.lock` is TOML in Cargo, YAML-ish in yarn and JSON in npm. Guessing one of the three colours
  // two thirds of lockfiles wrong; plain text colours none of them wrong.
  lock: "text",
  gitignore: "text", gitattributes: "text", npmrc: "text", nvmrc: "text", prettierignore: "text",
  eslintignore: "text", dockerignore: "text", csv: "text", tsv: "text",
};

/** The extension `documentKindFor` would read: lowercased, after the last dot, "" when there is none. */
export function extensionOf(path: string): string {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
}

/**
 * Which grammar to load for a path, or `"text"` for one this table does not recognise.
 *
 * Never null. By the time a path reaches the code editor the decision that it IS a code document has
 * already been made — by `documentKindFor`, over on the contracts side — so returning null here
 * would only give the editor a second way to refuse a file it has already agreed to open.
 */
export function codeLanguageFor(path: string): CodeLanguage {
  return BY_EXTENSION[extensionOf(path)] ?? "text";
}

/** Every grammar the table can ask for, for the loader's exhaustiveness test. */
export const CODE_LANGUAGES: readonly CodeLanguage[] = [...new Set(Object.values(BY_EXTENSION))].sort();
