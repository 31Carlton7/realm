import {
  artifactTypeOf, basenameOf, documentExtension, documentKindFor, extOf,
  type ArtifactType, type DocumentKind, type LibraryEntry,
} from "@realm/contracts";
import type { FileProvenance } from "../../components/FilePreview";

/**
 * The documents pane's home, as data: the files it lists, where each one sits relative to the pane,
 * and what a typed name would make.
 *
 * Pure, so the rules a person reads off the screen — which row opens in the pane, which goes to the
 * preview, what a name with no extension means — are tested without a window.
 */

/** One file on the home. Every section's rows are this, so a row reads and opens the same way
 *  whichever list it is in; what differs is `detail`, the one thing each list knows. */
export type HomeFile = {
  key: string;
  /** As the record has it: the path the agent named, the file the user attached. */
  path: string;
  name: string;
  /** Relative to the pane's root when the file lies inside it — the shape the pane opens. Null for a
   *  file somewhere the pane cannot reach, which opens in the preview instead. */
  rel: string | null;
  /** Absolute, for what the OS is handed: an attachment, the Finder, a thumbnail. Null for a relative
   *  path with no root to resolve it against. */
  abs: string | null;
  type: ArtifactType;
  /** The quiet half of the row: the folder it is in, that it was attached, or the session it came from. */
  detail: string;
  /** When it was last touched, where the list knows. A checkout's file names carry no time. */
  ts: number | null;
  /** Where it came from, for a row out of the Library index — what the preview's provenance line says. */
  from: FileProvenance | null;
};

const trimSlashes = (p: string): string => p.replace(/\/+$/, "");

/**
 * Where a recorded path sits relative to the pane's root.
 *
 * An absolute path inside the root opens as a tab; one outside it is a file the pane cannot reach
 * (another space's checkout, a download the user attached), and keeps only its absolute form. A
 * RELATIVE path is what an agent writes for a file in its own working directory, which is the
 * checkout the pane is rooted at — unless it climbs out with `..`, or it is a `~/` path, which only
 * main can expand.
 */
export function placeFile(path: string, root: string | null): { rel: string | null; abs: string | null } {
  const top = root ? trimSlashes(root) : null;
  if (path.startsWith("/")) {
    const rel = top && path.startsWith(`${top}/`) ? path.slice(top.length + 1) : null;
    return { rel: rel || null, abs: path };
  }
  if (path.startsWith("~")) return { rel: null, abs: null };
  const rel = path.replace(/^(\.\/)+/, "");
  if (rel === "" || rel.split("/").includes("..")) return { rel: null, abs: null };
  return { rel, abs: top ? `${top}/${rel}` : null };
}

/** A checkout's own name, as its folder is called: what "In yooo" and New's open row say. */
export const folderName = (root: string): string => trimSlashes(root).split("/").pop() || root;

/** `/Users/<name>/x` as `~/x` — how a person reads a path under their home on a Mac. */
export const tildePath = (p: string): string => p.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");

/** The folder part of a path, "" when there is none. */
const folderOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/**
 * A row's quiet half, for a file the session made or was given: the folder it is in, relative to the
 * checkout when it is in it — nothing at all at the checkout's top, where the name is the whole path
 * — or `~`-shortened when it is elsewhere. An attachment says so instead: where a pasted picture was
 * written is a fact about Realm, not about the file.
 */
export function sessionDetail(e: Pick<LibraryEntry, "kind">, place: { rel: string | null; abs: string | null }, path: string): string {
  if (e.kind === "upload") return "Attached";
  if (place.rel !== null) return folderOf(place.rel);
  return tildePath(folderOf(place.abs ?? path));
}

/** The Library index's rows as the home lists them. `detail` is the list's to decide. */
export function homeFilesOf(entries: readonly LibraryEntry[], root: string | null,
  detail: (e: LibraryEntry, place: { rel: string | null; abs: string | null }) => string): HomeFile[] {
  return entries.map((e) => {
    const place = placeFile(e.path, root);
    return {
      key: e.id, path: e.path, name: e.name, ...place, type: artifactTypeOf(e.ext), detail: detail(e, place), ts: e.ts,
      from: { sessionId: e.sessionId, spaceId: e.spaceId, sessionTitle: e.sessionTitle, kind: e.kind },
    };
  });
}

/** A checkout file name hit (`project.files`) as the home lists it: always inside the root, which is
 *  where the search ran. */
export function checkoutFileOf(rel: string, root: string): HomeFile {
  const name = basenameOf(rel);
  return {
    key: `checkout:${rel}`, path: rel, name, rel, abs: `${trimSlashes(root)}/${rel}`,
    type: artifactTypeOf(extOf(name)), detail: folderOf(rel), ts: null, from: null,
  };
}

/** The same file listed by two sections is one file: the later section drops it. Keyed on where the
 *  file IS, so a relative and an absolute spelling of one path agree. */
export function withoutShown(files: readonly HomeFile[], shown: ReadonlySet<string>): HomeFile[] {
  return files.filter((f) => !shown.has(identityOf(f)));
}
export const identityOf = (f: Pick<HomeFile, "abs" | "path">): string => f.abs ?? f.path;

/** The first case-insensitive run of `query` in `name`, for the row to mark — or null. */
export function matchRun(name: string, query: string): { before: string; match: string; after: string } | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const at = name.toLowerCase().indexOf(q);
  if (at < 0) return null;
  return { before: name.slice(0, at), match: name.slice(at, at + q.length), after: name.slice(at + q.length) };
}

/**
 * The languages "Code file…" offers, in the order a person reaches for them. Each extension is one the
 * code editor claims (`documentKindFor` → `code`) and has a grammar for — `home-model.test.ts` holds
 * both, so this list can never offer a file that opens grey or opens somewhere else.
 *
 * A short list of what people write, not the editor's whole table: every other extension is still a
 * name away, typed into the same field.
 */
export const CODE_FILE_LANGUAGES: readonly { label: string; ext: string }[] = [
  { label: "TypeScript", ext: "ts" },
  { label: "TypeScript React", ext: "tsx" },
  { label: "JavaScript", ext: "js" },
  { label: "Python", ext: "py" },
  { label: "Swift", ext: "swift" },
  { label: "Go", ext: "go" },
  { label: "Rust", ext: "rs" },
  { label: "Shell script", ext: "sh" },
  { label: "JSON", ext: "json" },
  { label: "YAML", ext: "yaml" },
  { label: "CSS", ext: "css" },
  { label: "SQL", ext: "sql" },
  { label: "Ruby", ext: "rb" },
  { label: "Java", ext: "java" },
  { label: "Kotlin", ext: "kt" },
  { label: "C", ext: "c" },
  { label: "C++", ext: "cpp" },
  { label: "C#", ext: "cs" },
  { label: "PHP", ext: "php" },
  { label: "Lua", ext: "lua" },
  { label: "TOML", ext: "toml" },
  { label: "Plain text", ext: "txt" },
];

/** What a non-code kind opens as, said the way the New menu names it. */
const KIND_WORDS: Partial<Record<DocumentKind, string>> = {
  doc: "Opens as a document", sheet: "Opens as a spreadsheet", slides: "Opens as a presentation",
  latex: "Opens as LaTeX", html: "Opens as a study guide",
};

/** What a typed file name would make: a file of some kind, or the reason it cannot be made here. */
export type NewFilePlan =
  | { ok: true; name: string; kind: DocumentKind; says: string }
  | { ok: false; says: string };

/**
 * Read a typed name as a file to make, the editor following its extension: `server.go` is Go in the
 * code editor, `notes.md` a document, `q3.csv` a sheet.
 *
 * Null for a name with no extension, which is not refused — it is a name still waiting for its
 * language. Refused: a path (a new file is made at the top of the folder, which is the one place the
 * pane can be sure exists), a kind Realm has no editor for, and the ones it only shows (a PDF, a
 * picture, an Office file), which are opened, never written here.
 */
export function planNewFile(input: string, taken: ReadonlySet<string> = new Set()): NewFilePlan | null {
  const name = input.trim();
  if (!name) return null;
  if (name.includes("/")) return { ok: false, says: "A name, not a path. New files go at the top of this folder." };
  // A dotfile's whole name after the dot is its extension as the editor reads it (`.gitignore`).
  const ext = documentExtension(name) || (name.startsWith(".") ? name.slice(1) : "");
  if (!ext) return null;
  if (taken.has(name.toLowerCase())) return { ok: false, says: `${name} is already in this folder.` };
  const kind = documentKindFor(name);
  if (kind === "unsupported") return { ok: false, says: `Realm has no editor for .${ext} files.` };
  if (kind === "pdf" || kind === "preview") return { ok: false, says: `A .${ext} file opens here, but is not written here.` };
  if (kind === "code") {
    const language = CODE_FILE_LANGUAGES.find((l) => l.ext === extOf(name))?.label;
    return { ok: true, name, kind, says: language ? `Opens in the code editor as ${language}` : "Opens in the code editor" };
  }
  return { ok: true, name, kind, says: KIND_WORDS[kind] ?? "Opens here" };
}

/** `untitled.py` from `untitled.ts`: the same stem with another language's extension. */
export function withExtension(name: string, ext: string): string {
  const current = documentExtension(name);
  const stem = current ? name.slice(0, name.length - current.length - 1) : name.trim();
  return `${stem || "untitled"}.${ext}`;
}
