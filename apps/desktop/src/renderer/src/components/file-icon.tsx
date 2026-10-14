import { Icon, type IconName } from "@realm/ui";
import { artifactTypeOf, documentKindFor, type ArtifactType } from "@realm/contracts";

/** One glyph per broad type. Coarse on purpose — a file browser's icon answers "what kind of thing
 *  is this" at a glance, and thirty glyphs answer it more slowly than seven. A list ROW wears the same
 *  mark as a card: the same file must not change glyph with the layout. The fallback for every file
 *  the logo table below has no answer for. */
export const TYPE_ICON: Record<ArtifactType, IconName> = {
  document: "documents", image: "image", video: "video", audio: "musicNote",
  data: "table", code: "code", other: "artifact",
};

/**
 * Extensions the pack has a mark of its own for. A language it draws wears its badge (the TS and JS
 * squares Codex leads its file links with, `{ }` for JSON, the HTML and CSS shields), a format it
 * spells wears the page with its letters, and a shell script the terminal it runs in.
 */
const BY_EXT: Record<string, IconName> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "fileReact", tsx: "fileReact",
  json: "fileJson", jsonc: "fileJson", json5: "fileJson", webmanifest: "fileJson",
  py: "python", pyi: "python", pyw: "python",
  html: "fileHtml", htm: "fileHtml",
  css: "fileCss", scss: "fileCss", sass: "fileCss", less: "fileCss",
  java: "java", php: "php", sql: "fileSql", pdf: "filePdf",
  xml: "fileXml", plist: "fileXml", svg: "fileSvg",
  zip: "fileZip", tar: "fileZip", gz: "fileZip", tgz: "fileZip", rar: "fileZip", "7z": "fileZip",
  sh: "terminal", bash: "terminal", zsh: "terminal", fish: "terminal", command: "terminal",
};

const nameOf = (path: string): string => path.split("/").pop()?.toLowerCase() ?? "";
const extOf = (name: string): string => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "");

/**
 * The mark a file wears wherever the transcript names it — a link in the prose, a row of a turn's
 * edits, the target of an edit's tool row: what KIND of file it is, before its name is read. Any
 * other source file is the page with `< >` on it, and everything else takes the Library's coarse
 * glyph for its type, so a picture named in a sentence and the same picture in the Library agree.
 */
export function fileIconFor(path: string): IconName {
  const name = nameOf(path);
  const own = BY_EXT[extOf(name)];
  if (own) return own;
  if (documentKindFor(name) === "code") return "fileCode";
  return TYPE_ICON[artifactTypeOf(extOf(name))];
}

/* ---- the file's own logo ------------------------------------------------------------------------ */

/**
 * Material Icon Theme's marks (MIT, `assets/file-icons/LICENSE`), the ones VS Code users already know
 * a file by: a `.ts` is the blue TS square, a `package.json` the green hexagon. A curated set rather
 * than the theme's nine hundred, because every one is bundled and a mark nobody meets is weight.
 * Vite inlines files this small as data: URLs, which the renderer's CSP already admits for images.
 */
const ASSETS = import.meta.glob<string>("../assets/file-icons/*.svg", { eager: true, import: "default" });
const asset = (id: string): string | undefined => ASSETS[`../assets/file-icons/${id}.svg`];

/**
 * Whole names first, because the name says more than the extension where it says anything at all:
 * `package.json` is the project's manifest, not just some JSON, and `Dockerfile` has no extension.
 */
const BY_NAME: Record<string, string> = {
  "package.json": "nodejs", "package-lock.json": "nodejs", ".nvmrc": "nodejs", ".node-version": "nodejs",
  ".npmrc": "npm", "pnpm-lock.yaml": "pnpm", "pnpm-workspace.yaml": "pnpm",
  "yarn.lock": "yarn", ".yarnrc": "yarn", ".yarnrc.yml": "yarn",
  "bun.lock": "bun", "bun.lockb": "bun", "bunfig.toml": "bun",
  "tsconfig.json": "tsconfig", "jsconfig.json": "tsconfig",
  dockerfile: "docker", containerfile: "docker", ".dockerignore": "docker",
  "docker-compose.yml": "docker", "docker-compose.yaml": "docker", "compose.yml": "docker", "compose.yaml": "docker",
  ".env": "tune",
  ".gitignore": "git", ".gitattributes": "git", ".gitmodules": "git", ".gitkeep": "git",
  license: "license", "license.md": "license", "license.txt": "license", licence: "license", copying: "license",
  readme: "readme", "readme.md": "readme", "readme.txt": "readme",
  changelog: "changelog", "changelog.md": "changelog",
  makefile: "makefile", gnumakefile: "makefile", "cmakelists.txt": "cmake",
  ".editorconfig": "editorconfig", "go.mod": "go-mod", "go.sum": "go-mod",
  "cargo.toml": "rust", "cargo.lock": "rust", gemfile: "ruby", "gemfile.lock": "ruby",
  "build.gradle": "gradle", "build.gradle.kts": "gradle", "settings.gradle": "gradle", "settings.gradle.kts": "gradle",
};

/** Families named by a stem whatever their extension or suffix: `vite.config.mts`, `tsconfig.node.json`,
 *  `.env.local`, `.eslintrc.cjs`, `Dockerfile.dev`. */
const BY_PATTERN: readonly [RegExp, string][] = [
  [/^tsconfig\..+\.json$/, "tsconfig"],
  [/^vite\.config\.[cm]?[jt]s$/, "vite"],
  [/^vitest\.(config|workspace)\.[cm]?[jt]s$/, "vitest"],
  [/^next\.config\.[cm]?[jt]s$/, "next"],
  [/^tailwind\.config\.[cm]?[jt]s$/, "tailwindcss"],
  [/^(\.eslintrc(\..+)?|eslint\.config\.[cm]?[jt]s)$/, "eslint"],
  [/^(\.prettierrc(\..+)?|prettier\.config\.[cm]?[jt]s)$/, "prettier"],
  [/^\.env\..+$/, "tune"],
  [/^(dockerfile|containerfile)\..+$/, "docker"],
];

const EXT_MARK: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "react_ts",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "react",
  json: "json", jsonc: "json", json5: "json", webmanifest: "json",
  md: "markdown", markdown: "markdown", mdx: "mdx",
  py: "python", pyi: "python", pyw: "python", ipynb: "jupyter",
  rs: "rust", go: "go", swift: "swift", kt: "kotlin", kts: "kotlin", java: "java",
  c: "c", h: "h", cpp: "cpp", cc: "cpp", cxx: "cpp", ino: "cpp", hpp: "hpp", hh: "hpp", hxx: "hpp",
  cs: "csharp", rb: "ruby", rake: "ruby", gemspec: "ruby", php: "php", pl: "perl", pm: "perl",
  lua: "lua", r: "r", dart: "dart", hs: "haskell", scala: "scala", sbt: "scala", ex: "elixir", exs: "elixir", zig: "zig",
  html: "html", htm: "html", css: "css", scss: "sass", sass: "sass", less: "less",
  vue: "vue", svelte: "svelte", astro: "astro", graphql: "graphql", gql: "graphql", prisma: "prisma",
  sh: "console", bash: "console", zsh: "console", fish: "console", ksh: "console", command: "console",
  ps1: "powershell", psm1: "powershell",
  yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml", plist: "xml", xsd: "xml", xsl: "xml", storyboard: "xml", xib: "xml",
  ini: "settings", cfg: "settings", conf: "settings", properties: "settings", env: "tune",
  sql: "database", svg: "svg", lock: "lock", proto: "proto", diff: "diff", patch: "diff",
  cmake: "cmake", gradle: "gradle", mk: "makefile", tex: "tex", latex: "tex",
  csv: "table", tsv: "table", xls: "table", xlsx: "table", numbers: "table",
  txt: "document", text: "document", rtf: "document", log: "log",
  pdf: "pdf", doc: "word", docx: "word", ppt: "powerpoint", pptx: "powerpoint",
  zip: "zip", tar: "zip", gz: "zip", tgz: "zip", rar: "zip", "7z": "zip", bz2: "zip", xz: "zip",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", heic: "image", heif: "image",
  bmp: "image", tif: "image", tiff: "image", ico: "image", avif: "image",
  mp4: "video", mov: "video", m4v: "video", webm: "video", mkv: "video", avi: "video",
  mp3: "audio", wav: "audio", m4a: "audio", aac: "audio", flac: "audio", ogg: "audio", aiff: "audio",
  pem: "certificate", crt: "certificate", cer: "certificate",
  ttf: "font", otf: "font", woff: "font", woff2: "font",
};

/** The mark's id in the vendored set, by name first and then by extension; null for a file the set
 *  has no mark for. Exported for the test that holds every id to a file that exists. */
export function fileMarkId(path: string): string | null {
  const name = nameOf(path);
  const byName = BY_NAME[name] ?? BY_PATTERN.find(([re]) => re.test(name))?.[1];
  if (byName) return byName;
  return EXT_MARK[extOf(name)] ?? null;
}

/** Every id the tables can answer, for that test. */
export const FILE_MARK_IDS: readonly string[] = [
  ...new Set([...Object.values(BY_NAME), ...BY_PATTERN.map(([, id]) => id), ...Object.values(EXT_MARK), "folder"]),
];

/**
 * A file's mark as a file manager draws it: its language's or its format's own logo in that logo's
 * own colour, by its name and then its extension — and Realm's coarse glyph for its type where the
 * set has none, so every file still wears something. The one mark the Library's tiles, the documents
 * pane's rows and the prompter's attachments share, so a file is recognised by the same shape in all
 * three.
 *
 * The colour is the file's signature, not a state: these are the hues a developer already reads a
 * file tree by, which is why they are allowed beside a palette that keeps green, orange and red for
 * state. A mark that has a darker drawing for light grounds (Next's, pnpm's, Bun's) wears it on the
 * light face; both are in the DOM and the stylesheet picks, so a mode flip needs no render.
 */
export function FileMark({ path, folder = false, size, type, className }: {
  path: string;
  /** A directory: the set's folder, whatever the name says — a folder called `photos.png` is a folder. */
  folder?: boolean;
  /** The glyph's box, in px. */
  size: number;
  /** The broad type, for the fallback glyph. Read off the extension when the caller does not know it. */
  type?: ArtifactType;
  className?: string;
}) {
  const id = folder ? "folder" : fileMarkId(path);
  const src = id ? asset(id) : undefined;
  const cls = `file-mark${className ? ` ${className}` : ""}`;
  if (!src) {
    const glyph: IconName = folder ? "folder" : TYPE_ICON[type ?? artifactTypeOf(extOf(nameOf(path)))];
    return <span className={cls} data-glyph=""><Icon name={glyph} size={size} /></span>;
  }
  const light = id ? asset(`${id}_light`) : undefined;
  // alt="" throughout: the mark sits beside the file's name everywhere it is drawn, and a screen
  // reader must not read "TypeScript" before every file.
  return (
    <span className={cls} data-mark={id} data-has-light={light ? "" : undefined}>
      <img className="file-mark-img" src={src} alt="" draggable={false} width={size} height={size} />
      {light && <img className="file-mark-img file-mark-light" src={light} alt="" draggable={false} width={size} height={size} />}
    </span>
  );
}
