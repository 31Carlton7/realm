import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative } from "node:path";
import {
  MEMORY_DOC_MAX, MEMORY_EXTERNAL_UNCONFIRMED, MEMORY_LIBRARY_GROUP_LABEL, MEMORY_REPO_INDEX_FILE, memoryLibraryId, parseMemoryLibraryId, wikiLinkTarget, withIndexLink,
  withoutIndexLink, type MemoryLibraryEntry, type MemoryLibraryFile, type MemoryLibraryReader, type MemoryLibrarySource, type MemoryLibraryType,
} from "@realm/contracts";
import { decodeClaudeProjectSlug } from "../import/sources";
import { RpcError } from "../store/rows";
import type { SettingsStore } from "../store/settings";
import { claudeFact, claudeFactFile, claudeIndexTarget, withClaudeIndexLine, withoutClaudeIndexLine } from "./claude-facts";
import { readSpaceFolder, SPACES_DIR, type MemoryRepoService, type RepoOwner } from "./repo";
import { MemorySearch } from "./search";
import { AGENTS_FILE_MARKER, type MemoryService } from "./service";
import { spaceFolderSettingKey } from "./sink";

/** One space as the library sees it: its name, its profile, and the folders it works in. */
export type LibrarySpace = { id: string; profileId: string; name: string; folders: readonly string[] };

export type MemoryLibraryDeps = {
  home: string;
  /** The machine's home, where `~/.cursor` and `~/.gemini` are. Null reads neither: a test that names no home. */
  userHome: string | null;
  /** Claude's config folder (`~/.claude`, or `CLAUDE_CONFIG_DIR`), and Codex's (`CODEX_HOME`); null reads none. */
  claudeDir: string | null;
  codexHome: string | null;
  settings: SettingsStore;
  profiles: () => readonly { id: string; name: string }[];
  spaces: () => readonly LibrarySpace[];
  repos: Pick<MemoryRepoService, "config" | "activeFor" | "writeBatch" | "saveSpaceMemory" | "spaceFolderFor">;
  docs: Pick<MemoryService, "docPath" | "profileDocPath" | "set" | "setProfile" | "profileDocEnabled" | "sourcesFor">;
  /** The instruction files the latest Codex session in a space said it loaded, or null before one has. */
  codexReported?: (spaceId: string) => string[] | null;
  /** Move a file to the Trash. */
  trash: (path: string) => Promise<void>;
  /** After a write, with the spaces whose memory it changed — none for a file outside Realm. */
  onChanged?: (spaceIds: string[]) => void;
};

/**
 * One place memory files are kept, with what the library needs to list them and to act on one: the
 * folder its files are relative to and how to find them. `owner` is a Realm repo's; `doc` maps a memory
 * document's file to whose it is.
 */
type Source = MemoryLibrarySource & {
  root: string;
  files: () => string[];
  owner: RepoOwner | null;
  profileId: string | null;
  docs?: Map<string, { profileId: string } | { spaceId: string }>;
  /** Where in the source a file sits, when that says something. */
  folderOf?: (rel: string) => string | null;
};

const MD = /\.md$/i;
const RULES = /\.mdc?$/i;
/** How deep a walk goes under a source's root — a repo's folders, a rules folder's subfolders. */
const WALK_DEPTH = 6;
const DESCRIPTION_MAX = 200;

const short = (text: string, n = 60): string => (text.length <= n ? text : `${text.slice(0, n - 1).trimEnd()}…`);
const hashOf = (p: string): string => createHash("sha1").update(p).digest("hex").slice(0, 12);
const within = (child: string, parent: string): boolean => {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
const realOr = (p: string): string => { try { return realpathSync(p); } catch { return p; } };
/** A listing worked out once per source object — each call builds its sources afresh, so it is never stale. */
const once = (list: () => string[]): (() => string[]) => { let held: string[] | null = null; return () => (held ??= list()); };
const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** "Realm", "Realm and Stora", "Realm, Stora and Ops". */
const listed = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * Files under `root` that `keep` accepts, by path from the root: plain files, and links to files that
 * stay inside the root. A folder that is a link is never followed, nor is `.git`.
 */
function walk(root: string, keep: (rel: string) => boolean, depth = WALK_DEPTH): string[] {
  const out: string[] = [];
  const realRoot = realOr(root);
  const visit = (dir: string, rel: string, left: number): void => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
      const abs = join(dir, e.name);
      if (e.isDirectory()) { if (left > 0) visit(abs, childRel, left - 1); continue; }
      if (!keep(childRel)) continue;
      if (e.isFile() || (e.isSymbolicLink() && insideAsFile(abs, realRoot))) out.push(childRel);
    }
  };
  visit(root, "", depth);
  return out.sort();
}

/** A link that leads to a file inside `realRoot` — anything else is an escape, and is left out. */
function insideAsFile(abs: string, realRoot: string): boolean {
  try { return statSync(abs).isFile() && within(realpathSync(abs), realRoot); } catch { return false; }
}

/** The files of `names` that are in `root`, by the same rule `walk` uses. */
function present(root: string, names: readonly string[]): string[] {
  const realRoot = realOr(root);
  return names.filter((n) => {
    const abs = join(root, n);
    try { return lstatSync(abs).isSymbolicLink() ? insideAsFile(abs, realRoot) : statSync(abs).isFile(); } catch { return false; }
  });
}

/**
 * A leading `---` block as key/value pairs in file order, and the text after it. A key nested under a
 * map is `parent.key` (Claude keeps `type` as `metadata.type`); a list's items are left out. Values are
 * read the way YAML writes a scalar: bare, or quoted in either quote.
 */
export function readFrontmatter(text: string): { fields: { key: string; value: string }[]; body: string } {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { fields: [], body: text };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end === -1) return { fields: [], body: text };
  const fields: { key: string; value: string }[] = [];
  let parent: string | null = null;
  for (const line of lines.slice(1, end)) {
    const m = /^(\s*)([A-Za-z_][\w.-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const nested = m[1]!.length > 0 && parent !== null;
    const value = unquote(m[3]!.trim());
    if (!nested) parent = value === "" ? m[2]! : null;
    if (value !== "") fields.push({ key: nested ? `${parent}.${m[2]}` : m[2]!, value });
  }
  return { fields, body: lines.slice(end + 1).join("\n").replace(/^\n+/, "") };
}

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith("\"") && v.endsWith("\"")) { try { return String(JSON.parse(v)); } catch { return v.slice(1, -1); } }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** The first line of prose: past headings, rules and blank lines, with Markdown's marks off. */
function firstProse(body: string): string | null {
  let fenced = false;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) { fenced = !fenced; continue; }
    if (fenced || line === "" || /^#{1,6}\s/.test(line) || /^(-{3,}|\*{3,}|_{3,})$/.test(line) || line.startsWith("<!--")) continue;
    const text = line.replace(/^>\s*/, "").replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "")
      .replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").trim();
    if (text !== "") return short(text, DESCRIPTION_MAX);
  }
  return null;
}

const fieldOf = (fields: { key: string; value: string }[], ...keys: string[]): string | null =>
  keys.map((k) => fields.find((f) => f.key === k)?.value).find((v) => v !== undefined && v !== "") ?? null;

/**
 * The memory library: every Markdown memory file an agent on this Mac reads, listed by where it is
 * kept, and read, written, made and deleted through the rules of the place it is kept in.
 *
 * - **Realm's repos** are written the way the agent tools write them (`MemoryRepoService.writeBatch` and
 *   `saveSpaceMemory`): one commit per change, staged by path, with `MEMORY.md`'s index line kept in step
 *   — added for a new memory, rewritten for a renamed one, dropped for a deleted one.
 * - **Realm's memory documents** go through `MemoryService`, so a space's managed `AGENTS.md` follows.
 * - **Everything else** is an agent's own file, outside Realm. It is written only with the person's
 *   yes (`confirmExternal`), deleted only to the Trash, and an `AGENTS.md` Realm manages is read-only
 *   here — Realm rewrites it from the space's document.
 *
 * Nothing is reachable but a file a discovered source lists: an id names a source and a path inside it,
 * the path is checked against that source's own listing, and its real path must stay inside the
 * source's folder, so a link cannot lead out of it.
 */
export class MemoryLibrary {
  private readonly finder = new MemorySearch();

  constructor(private d: MemoryLibraryDeps) {}

  // ─── Sources ──────────────────────────────────────────────────────────────────────────────────

  /** Every source of one profile that exists, Realm's first, each with how many files it holds. */
  sources(profileId: string): MemoryLibrarySource[] {
    return this.sourcesOf(profileId).map((s) => this.publicSource(s, s.files().length)).filter((s) => s.count > 0 || s.creatable);
  }

  private publicSource(s: Source, count: number): MemoryLibrarySource {
    return { id: s.id, group: s.group, label: s.label, path: s.path, spaceId: s.spaceId, external: s.external, creatable: s.creatable, count, pointed: s.pointed, by: s.by };
  }

  private sourcesOf(profileId: string): Source[] {
    const profile = this.d.profiles().find((p) => p.id === profileId);
    if (!profile) return [];
    const spaces = this.d.spaces().filter((sp) => sp.profileId === profileId);
    return [...this.realmSources(profile, spaces), ...this.agentSources(spaces)];
  }

  /** The source an id names, whichever profile shows it. */
  private source(sourceId: string): Source {
    for (const p of this.d.profiles()) {
      const s = this.sourcesOf(p.id).find((x) => x.id === sourceId);
      if (s) return s;
    }
    throw new RpcError("MEMORY_FILE_NOT_FOUND", `there is no memory source ${sourceId} on this Mac`);
  }

  private realmSources(profile: { id: string; name: string }, spaces: readonly LibrarySpace[]): Source[] {
    const out: Source[] = [];
    const usedIn = (path: string) => spaces.filter((sp) => this.d.repos.activeFor(sp.id).some((r) => r.path === path));
    const repoSource = (owner: RepoOwner, label: string, spaceId: string | null): void => {
      const cfg = this.d.repos.config(owner);
      if (!cfg || !existsSync(join(cfg.path, ".git")) || !existsSync(join(cfg.path, MEMORY_REPO_INDEX_FILE))) return;
      const readers = usedIn(cfg.path);
      const where = this.whereIn(readers, spaces);
      out.push({
        id: owner.scope === "profile" ? `realm-repo-profile-${owner.id}` : `realm-repo-space-${owner.id}`,
        group: "realm", label, path: cfg.path, spaceId, external: false, creatable: true, count: 0,
        pointed: readers.length > 0,
        by: readers.length === 0 ? "No space uses it now: the memory tools are off, or each space turned it off."
          : `Sessions in ${where} start with its MEMORY.md and reach the rest through Realm's memory tools.`,
        root: cfg.path, files: once(() => walk(cfg.path, (rel) => MD.test(rel))), owner, profileId: profile.id,
        folderOf: (rel) => this.repoFolderLabel(rel, owner.scope === "profile" ? profile.id : null, spaces),
      });
    };
    repoSource({ scope: "profile", id: profile.id }, "Memory repo", null);
    for (const sp of spaces) repoSource({ scope: "space", id: sp.id }, `${sp.name}'s repo`, sp.id);

    const root = join(this.d.home, "memory");
    const docs = new Map<string, { profileId: string } | { spaceId: string }>([[basename(this.d.docs.profileDocPath(profile.id)), { profileId: profile.id }]]);
    for (const sp of spaces) docs.set(basename(this.d.docs.docPath(sp.id)), { spaceId: sp.id });
    out.push({
      id: `realm-docs-${profile.id}`, group: "realm", label: "Memory documents", path: root, spaceId: null,
      external: false, creatable: false, count: 0, pointed: true,
      by: "Realm puts them at the start of every new session: the profile's in each space that keeps it, a space's in its own.",
      root, files: once(() => present(root, [...docs.keys()])), owner: null, profileId: profile.id, docs,
    });
    return out;
  }

  private agentSources(spaces: readonly LibrarySpace[]): Source[] {
    const out: Source[] = [];
    const add = (s: Omit<Source, "count" | "creatable" | "owner" | "profileId" | "external"> & { external?: boolean }): void => {
      out.push({ count: 0, creatable: false, owner: null, profileId: null, external: true, ...s, files: once(s.files) });
    };
    const claude = this.d.claudeDir;
    const codex = this.d.codexHome;
    const cursorRules = this.d.userHome ? join(this.d.userHome, ".cursor", "rules") : null;
    const gemini = this.d.userHome ? join(this.d.userHome, ".gemini") : null;
    /* A space whose folder IS the home folder holds the user files under the same names; they are the
       user source's, listed once. */
    const userFiles = new Set([claude && join(claude, "CLAUDE.md"), codex && join(codex, "AGENTS.md")].filter((p): p is string => !!p).map(realOr));
    const folders = spaces.flatMap((sp) => sp.folders.filter(isDir).map((f, i, all) => ({ sp, folder: f, label: all.length > 1 ? `${sp.name} · ${basename(f)}` : sp.name })));

    if (claude) {
      add({ id: "claude-user", group: "claude", label: "User memory", path: join(claude, "CLAUDE.md"), spaceId: null, pointed: true,
        by: "Claude Code loads it in every session.", root: claude, files: () => present(claude, ["CLAUDE.md"]) });
      const projects = join(claude, "projects");
      const decoded = new Map<string, string | null>();
      add({
        id: "claude-projects", group: "claude", label: "Project memory", path: projects, spaceId: null, pointed: false,
        by: "What Claude keeps when it runs outside Realm. In Realm, Claude keeps its memory in the memory repo, and Realm brings these in.",
        root: projects,
        files: () => {
          let names: string[] = [];
          try { names = readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return []; }
          return names.flatMap((n) => walk(join(projects, n, "memory"), (rel) => MD.test(rel) && !rel.includes("/"), 0).map((f) => `${n}/memory/${f}`));
        },
        folderOf: (rel) => {
          const project = rel.split("/")[0]!;
          if (!decoded.has(project)) decoded.set(project, decodeClaudeProjectSlug(project, (dir) => { try { return readdirSync(dir); } catch { return []; } }));
          const path = decoded.get(project);
          return path ? basename(path) : project;
        },
      });
    }
    for (const f of folders) {
      const names = present(f.folder, ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"]).filter((n) => !userFiles.has(realOr(join(f.folder, n))));
      if (names.length === 0) continue;
      add({ id: `claude-folder-${hashOf(f.folder)}`, group: "claude", label: f.label, path: f.folder, spaceId: f.sp.id, pointed: true,
        by: `Claude Code loads them in ${f.sp.name}.`, root: f.folder, files: () => names });
    }
    if (codex) {
      add({ id: "codex-user", group: "codex", label: "User instructions", path: join(codex, "AGENTS.md"), spaceId: null, pointed: true,
        by: "Codex loads it in every session.", root: codex, files: () => present(codex, ["AGENTS.md"]) });
    }
    for (const f of folders) {
      const names = present(f.folder, ["AGENTS.md"]).filter((n) => !userFiles.has(realOr(join(f.folder, n))));
      if (names.length === 0) continue;
      const managed = this.managedAgentsFile(join(f.folder, "AGENTS.md"));
      add({ id: `codex-folder-${hashOf(f.folder)}`, group: "codex", label: f.label, path: join(f.folder, "AGENTS.md"), spaceId: f.sp.id, pointed: true,
        by: managed ? `Codex loads it in ${f.sp.name}. Realm writes it from ${f.sp.name}'s memory document.` : `Codex loads it in ${f.sp.name}.`,
        root: f.folder, files: () => names });
    }
    if (cursorRules) {
      add({ id: "cursor-user", group: "cursor", label: "User rules", path: cursorRules, spaceId: null, pointed: true,
        by: "Cursor loads the rules that apply in every project.", root: cursorRules, files: () => walk(cursorRules, (rel) => RULES.test(rel)),
        folderOf: (rel) => (rel.includes("/") ? dirname(rel) : null) });
    }
    for (const f of folders) {
      const rules = join(f.folder, ".cursor", "rules");
      if (!isDir(rules) || (cursorRules && realOr(rules) === realOr(cursorRules))) continue;
      add({ id: `cursor-folder-${hashOf(f.folder)}`, group: "cursor", label: f.label, path: rules, spaceId: f.sp.id, pointed: true,
        by: `Cursor loads the ones that apply in ${f.sp.name}.`, root: rules, files: () => walk(rules, (rel) => RULES.test(rel)),
        folderOf: (rel) => (rel.includes("/") ? dirname(rel) : null) });
    }
    if (gemini) {
      add({ id: "gemini-user", group: "gemini", label: "User memory", path: join(gemini, "GEMINI.md"), spaceId: null, pointed: true,
        by: "Gemini CLI loads it in every session.", root: gemini, files: () => present(gemini, ["GEMINI.md"]) });
    }
    return out.filter((s) => s.files().length > 0);
  }

  private managedAgentsFile(path: string): boolean {
    try { return readFileSync(path, "utf8").startsWith(AGENTS_FILE_MARKER); } catch { return false; }
  }

  /** The space whose folder of the profile's repo a path is in, by its name — or the folder itself. */
  private repoFolderLabel(rel: string, profileId: string | null, spaces: readonly LibrarySpace[]): string | null {
    const dir = posix.dirname(rel);
    if (dir === ".") return null;
    const parts = dir.split("/");
    if (profileId !== null && parts[0] === SPACES_DIR && parts.length >= 2) {
      const sp = this.spaceOfFolder(parts[1]!, profileId, spaces);
      if (sp) return parts.length === 2 ? sp.name : `${sp.name}/${parts.slice(2).join("/")}`;
    }
    return dir;
  }

  private spaceOfFolder(folder: string, profileId: string, spaces: readonly LibrarySpace[]): LibrarySpace | null {
    return spaces.find((sp) => {
      const rec = readSpaceFolder(this.d.settings.get(spaceFolderSettingKey(sp.id)));
      return rec !== null && rec.folder === folder && (rec.profileId === null || rec.profileId === profileId);
    }) ?? null;
  }

  /** "every space" when it is all of them, otherwise their names. */
  private whereIn(readers: readonly LibrarySpace[], all: readonly LibrarySpace[]): string {
    return all.length > 1 && readers.length === all.length ? "every space" : listed(readers.map((r) => r.name));
  }

  private profileName(profileId: string): string { return this.d.profiles().find((p) => p.id === profileId)?.name ?? "the profile"; }

  // ─── Listing ──────────────────────────────────────────────────────────────────────────────────

  /** Every file of one source, or of all of a profile's, newest first; with a query, best match first. */
  list(profileId: string, o: { sourceId?: string; query?: string } = {}): MemoryLibraryEntry[] {
    const sources = this.sourcesOf(profileId).filter((s) => o.sourceId === undefined || s.id === o.sourceId);
    const entries = sources.flatMap((s) => s.files().map((rel) => this.entryOf(s, rel)).filter((e): e is MemoryLibraryEntry => e !== null));
    const query = o.query?.trim() ?? "";
    if (query === "") return entries.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
    const byPath = new Map(entries.map((e) => [e.path, e]));
    const out: MemoryLibraryEntry[] = [];
    const seen = new Set<string>();
    const hits = this.finder.searchFiles(entries.map((e) => ({ root: sources.find((s) => s.id === e.sourceId)!.root, abs: e.path })), query, 400);
    for (const h of hits) {
      const e = byPath.get(join(h.repo, h.path));
      if (!e || seen.has(e.id)) continue;
      seen.add(e.id);
      out.push({ ...e, match: h.text });
    }
    // A word still being typed — "cam" on the way to "campaign" — matches names before the ranking can.
    const q = query.toLowerCase();
    for (const e of entries) {
      if (seen.has(e.id)) continue;
      if (e.title.toLowerCase().includes(q) || (e.description ?? "").toLowerCase().includes(q) || e.rel.toLowerCase().includes(q)) out.push(e);
    }
    return out;
  }

  private entryOf(s: Source, rel: string): MemoryLibraryEntry | null {
    const abs = join(s.root, rel);
    let st;
    try { st = statSync(abs); } catch { return null; }
    let text = "";
    try { text = readFileSync(abs, "utf8"); } catch { return null; }
    return this.describe(s, rel, abs, text, st.mtimeMs, st.size);
  }

  private describe(s: Source, rel: string, abs: string, text: string, updatedAt: number, size: number): MemoryLibraryEntry {
    const { fields, body } = readFrontmatter(text);
    const doc = s.docs?.get(rel);
    const heading = /^#{1,6}\s+(.+)$/m.exec(body)?.[1]?.trim() ?? null;
    const name = basename(rel);
    const title = doc ? this.docTitle(doc)
      : name === MEMORY_REPO_INDEX_FILE ? MEMORY_REPO_INDEX_FILE
      : fieldOf(fields, "name") ?? heading ?? name.replace(/\.mdc?$/i, "");
    return {
      id: memoryLibraryId(s.id, rel), sourceId: s.id, path: abs, rel, title,
      description: fieldOf(fields, "description") ?? (s.owner && rel === MEMORY_REPO_INDEX_FILE ? "The index every session here starts with" : firstProse(body)),
      type: fieldOf(fields, "type", "metadata.type"),
      folder: doc ? null : s.folderOf?.(rel) ?? null,
      updatedAt, size, match: null,
    };
  }

  private docTitle(doc: { profileId: string } | { spaceId: string }): string {
    if ("profileId" in doc) return this.profileName(doc.profileId);
    return this.d.spaces().find((sp) => sp.id === doc.spaceId)?.name ?? "A space";
  }

  // ─── Reading ──────────────────────────────────────────────────────────────────────────────────

  /** One file whole. `profileId` says whose spaces count as its readers when every profile shares it. */
  read(id: string, profileId: string | null = null): MemoryLibraryFile {
    const { s, rel, abs } = this.resolve(id);
    const st = statSync(abs);
    const text = readFileSync(abs, "utf8");
    const entry = this.describe(s, rel, abs, text, st.mtimeMs, st.size);
    const { fields, body } = readFrontmatter(text);
    const managed = s.group === "codex" && s.spaceId !== null && this.managedAgentsFile(abs);
    const rules = this.rulesOf(s, rel);
    return {
      ...entry, text, body, frontmatter: fields, links: this.linksOf(s, rel, body), readBy: this.readersOf(s, rel, profileId),
      external: s.external, writable: !managed && rules.writable, deletable: !managed && rules.deletable,
      note: managed ? "Realm writes this file from the space's memory document, so edit that instead." : rules.note,
    };
  }

  private rulesOf(s: Source, rel: string): { writable: boolean; deletable: boolean; note: string | null } {
    if (s.docs) return { writable: true, deletable: false, note: null };
    if (s.owner && rel === MEMORY_REPO_INDEX_FILE) return { writable: true, deletable: false, note: null };
    return { writable: true, deletable: true, note: null };
  }

  /** Each `[[link]]` (from the source's root, as the repo's index writes them) and each relative `.md`
   *  link (from the file's own folder, as Claude's index writes them), with the memory it opens. */
  private linksOf(s: Source, rel: string, body: string): MemoryLibraryFile["links"] {
    const files = new Set(s.files());
    const out = new Map<string, string | null>();
    const idOf = (target: string | null): string | null => (target !== null && files.has(target) ? memoryLibraryId(s.id, target) : null);
    for (const m of body.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
      if (!out.has(m[1]!)) out.set(m[1]!, idOf(wikiLinkTarget(m[1]!)));
    }
    for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) {
      const href = m[1]!;
      if (out.has(href) || /^[a-z][a-z0-9+.-]*:|^[/#]/i.test(href) || !/\.mdc?$/i.test(href.split("#")[0]!)) continue;
      const target = posix.normalize(posix.join(posix.dirname(rel), href.split("#")[0]!));
      out.set(href, target.startsWith("..") ? null : idOf(target));
    }
    return [...out].map(([target, id]) => ({ target, id }));
  }

  /**
   * Who loads a file, from the same model `memory.sources` answers a session with: Claude's CLAUDE.md
   * files as the CLI reads them for each space's folder, the files a Codex session reported, the repos
   * and documents each space's sessions start with. A file no agent in Realm reads has no readers.
   */
  private readersOf(s: Source, rel: string, profileId: string | null): MemoryLibraryReader[] {
    const whose = s.profileId ?? (s.spaceId === null ? profileId : this.d.spaces().find((sp) => sp.id === s.spaceId)?.profileId ?? null);
    const spaces = this.d.spaces().filter((sp) => whose === null || sp.profileId === whose);
    const named = (list: readonly LibrarySpace[]): string => `in ${this.whereIn(list, spaces)}`;
    if (s.owner) {
      const users = spaces.filter((sp) => this.d.repos.activeFor(sp.id).some((r) => r.path === s.root));
      if (users.length === 0) return [];
      const parts = rel.split("/");
      if (s.owner.scope === "profile" && parts[0] === SPACES_DIR && parts.length >= 3) {
        const sp = this.spaceOfFolder(parts[1]!, s.owner.id, users);
        if (!sp) return [];
        if (parts.length === 3 && parts[2] === MEMORY_REPO_INDEX_FILE) return [{ who: "Every agent", where: `in ${sp.name}`, how: "at the start of every session" }];
        return [{ who: "Claude", where: `in ${sp.name}`, how: "as its own memory" }, { who: "Other agents", where: `in ${sp.name}`, how: "through Realm's memory tools" }];
      }
      return rel === MEMORY_REPO_INDEX_FILE
        ? [{ who: "Every agent", where: named(users), how: "at the start of every session" }]
        : [{ who: "Every agent", where: named(users), how: "through Realm's memory tools" }];
    }
    const doc = s.docs?.get(rel);
    if (doc) {
      const users = "spaceId" in doc ? spaces.filter((sp) => sp.id === doc.spaceId) : spaces.filter((sp) => this.d.docs.profileDocEnabled(sp.id));
      return users.length === 0 ? [] : [{ who: "Every agent", where: named(users), how: "at the start of every session" }];
    }
    const abs = realOr(join(s.root, rel));
    const loaders = (kind: "claude" | "codex"): LibrarySpace[] => spaces.filter((sp) => sp.folders.some((cwd) => {
      const reported = kind === "codex" ? this.d.codexReported?.(sp.id) ?? null : null;
      const files = this.d.docs.sourcesFor({ kind, spaceId: sp.id, cwd, skillsInjected: false, reported }).sources.filter((f) => f.exists).map((f) => realOr(f.path));
      // Codex says what it loaded only once a session has started; before that, the folder's own file is the one it would.
      if (kind === "codex" && reported === null) files.push(...[join(cwd, "AGENTS.md"), ...(this.d.codexHome ? [join(this.d.codexHome, "AGENTS.md")] : [])].map(realOr));
      return files.includes(abs);
    }));
    const as = (who: string, list: readonly LibrarySpace[], how: string | null): MemoryLibraryReader[] => (list.length === 0 ? [] : [{ who, where: named(list), how }]);
    switch (s.group) {
      case "claude":
        if (s.id === "claude-projects") return [{ who: "Claude", where: "outside Realm", how: "in that project's sessions" }];
        return as("Claude", loaders("claude"), null);
      case "codex": return as("Codex", loaders("codex"), null);
      case "cursor": return as("Cursor", s.spaceId === null ? spaces : spaces.filter((sp) => sp.id === s.spaceId), "where a rule applies");
      case "gemini": return as("Gemini", spaces, null);
      default: return [];
    }
  }

  /** A file a source lists, by id — its source, its path from the source's root and its absolute path —
   *  or a refusal. The real path must stay inside the source's folder. */
  private resolve(id: string): { s: Source; rel: string; abs: string } {
    const parsed = parseMemoryLibraryId(id);
    if (!parsed) throw new RpcError("MEMORY_FILE_NOT_FOUND", `${id} is not a memory`);
    const s = this.source(parsed.sourceId);
    const rel = parsed.rel;
    if (isAbsolute(rel) || rel.split(/[\\/]/).some((p) => p === ".." || p.toLowerCase() === ".git") || !s.files().includes(rel)) {
      throw new RpcError("MEMORY_FILE_NOT_FOUND", `${rel} is not one of the memory files in ${s.path}`);
    }
    const abs = join(s.root, rel);
    if (!within(realOr(abs), realOr(s.root))) throw new RpcError("MEMORY_PATH", `${rel} leads outside ${s.path}`);
    return { s, rel, abs };
  }

  // ─── Writing ──────────────────────────────────────────────────────────────────────────────────

  /** Replace a file's text — see the class comment for how each kind of source takes it. */
  async write(id: string, text: string, confirmExternal = false): Promise<MemoryLibraryEntry> {
    const { s, rel, abs } = this.resolve(id);
    if (text.length > MEMORY_DOC_MAX) throw new RpcError("MEMORY_FILE_TOO_LARGE", `a memory file is capped at ${MEMORY_DOC_MAX} characters`);
    const doc = s.docs?.get(rel);
    if (doc) {
      if ("profileId" in doc) this.d.docs.setProfile(doc.profileId, text);
      else this.d.docs.set(doc.spaceId, text);
      this.d.onChanged?.("spaceId" in doc ? [doc.spaceId] : this.spaceIdsOf(doc.profileId));
    } else if (s.owner) {
      const owner = s.owner;
      const { fields } = readFrontmatter(text);
      const name = fieldOf(fields, "name");
      const hook = fieldOf(fields, "description");
      const dir = posix.dirname(rel);
      const folderIndex = dir === "." ? null : `${dir}/${MEMORY_REPO_INDEX_FILE}`;
      await this.d.repos.writeBatch(owner, (repo) => {
        const writes = new Map<string, string | null>([[rel, text]]);
        // A fact renamed or redescribed keeps its line in its folder's index saying so.
        const index = folderIndex && folderIndex !== rel ? readOr(join(repo, folderIndex)) : null;
        if (index && name && hook && index.split("\n").some((l) => claudeIndexTarget(l) === basename(rel))) {
          writes.set(folderIndex!, withClaudeIndexLine(index, basename(rel), name, hook));
        }
        return writes;
      }, `Update ${rel}`);
      this.d.onChanged?.(this.spaceIdsOfOwner(owner));
    } else {
      this.mayChangeOutside(s, rel, abs, confirmExternal, "write");
      writeFileSync(abs, text);
      this.d.onChanged?.([]);
    }
    return this.entryOf(s, rel)!;
  }

  /**
   * A new memory in a Realm repo, in the frontmatter the repo's folders keep (`claudeFact`): in a
   * space's folder of the profile's repo — its file and its line in the folder's index, the folder
   * linked from the root — or at a repo's root, linked from `MEMORY.md`'s index. One commit either way.
   */
  async create(o: { sourceId: string; spaceId?: string; name: string; description: string; type: MemoryLibraryType; body: string }): Promise<MemoryLibraryEntry> {
    const s = this.source(o.sourceId);
    if (!s.owner || !s.creatable) throw new RpcError("MEMORY_READ_ONLY", `new memories go in a Realm memory repo, not ${s.path}`);
    const name = o.name.trim();
    const description = o.description.trim();
    if (!name || !description || /[\r\n]/.test(name + description)) throw new RpcError("MEMORY_ENTRY_INVALID", "a memory needs a one-line name and a one-line description");
    const file = claudeFactFile(name);
    if (o.spaceId !== undefined) {
      const at = this.d.repos.spaceFolderFor(o.spaceId);
      if (!at || at.repoPath !== s.root) throw new RpcError("MEMORY_REPO_NONE", "that space keeps no folder in this memory repo");
      const rel = `${SPACES_DIR}/${at.folder}/${file}`;
      if (existsSync(join(s.root, rel))) throw new RpcError("MEMORY_EXISTS", `a memory named ${file} is already in ${at.folder}'s folder — open it, or choose another name`);
      await this.d.repos.saveSpaceMemory(o.spaceId, { name, description, type: o.type, body: o.body });
      this.d.onChanged?.(this.spaceIdsOfOwner(s.owner));
      return this.entryOf(s, rel)!;
    }
    if (existsSync(join(s.root, file))) throw new RpcError("MEMORY_EXISTS", `a memory named ${file} is already in this repo — open it, or choose another name`);
    await this.d.repos.writeBatch(s.owner, (repo) => new Map([
      [file, claudeFact({ name, description, type: o.type, body: o.body })],
      [MEMORY_REPO_INDEX_FILE, withIndexLink(readOr(join(repo, MEMORY_REPO_INDEX_FILE)) ?? "", file)],
    ]), `Remember ${short(name)}`);
    this.d.onChanged?.(this.spaceIdsOfOwner(s.owner));
    return this.entryOf(s, file)!;
  }

  /** Delete a file: from a Realm repo with its index lines, as one commit; outside Realm, to the Trash. */
  async delete(id: string, confirmExternal = false): Promise<{ trashed: boolean }> {
    const { s, rel, abs } = this.resolve(id);
    if (s.docs?.has(rel)) throw new RpcError("MEMORY_READ_ONLY", "a memory document is emptied in its editor, never deleted");
    if (s.owner) {
      if (rel === MEMORY_REPO_INDEX_FILE) throw new RpcError("MEMORY_INDEX_WHOLE", "MEMORY.md is the index every session reads — edit it rather than delete it");
      const owner = s.owner;
      const dir = posix.dirname(rel);
      const folderIndex = dir === "." ? null : `${dir}/${MEMORY_REPO_INDEX_FILE}`;
      await this.d.repos.writeBatch(owner, (repo) => {
        const writes = new Map<string, string | null>([[rel, null]]);
        const root = readOr(join(repo, MEMORY_REPO_INDEX_FILE));
        if (root !== null) writes.set(MEMORY_REPO_INDEX_FILE, withoutIndexLink(root, rel));
        const index = folderIndex && folderIndex !== rel ? readOr(join(repo, folderIndex)) : null;
        if (index !== null) writes.set(folderIndex!, withoutClaudeIndexLine(index, basename(rel)));
        return writes;
      }, `Forget ${rel}`);
      this.d.onChanged?.(this.spaceIdsOfOwner(owner));
      return { trashed: false };
    }
    this.mayChangeOutside(s, rel, abs, confirmExternal, "delete");
    await this.d.trash(abs);
    this.d.onChanged?.([]);
    return { trashed: true };
  }

  /** The refusals for a file outside Realm: the person has not said yes, or Realm manages it. */
  private mayChangeOutside(s: Source, rel: string, abs: string, confirmed: boolean, verb: "write" | "delete"): void {
    if (s.group === "codex" && s.spaceId !== null && this.managedAgentsFile(abs)) {
      throw new RpcError("MEMORY_READ_ONLY", "Realm writes this AGENTS.md from the space's memory document — edit that instead");
    }
    if (!confirmed) {
      throw new RpcError(MEMORY_EXTERNAL_UNCONFIRMED, `${abs} is ${MEMORY_LIBRARY_GROUP_LABEL[s.group]}'s own file, outside Realm — ${verb === "write" ? "writing" : "deleting"} it needs your yes first`);
    }
    if (lstatSync(abs).isSymbolicLink() && verb === "delete") throw new RpcError("MEMORY_PATH", `${rel} is a link; delete what it points at in the Finder`);
  }

  private spaceIdsOf(profileId: string): string[] { return this.d.spaces().filter((sp) => sp.profileId === profileId).map((sp) => sp.id); }

  private spaceIdsOfOwner(o: RepoOwner): string[] { return o.scope === "space" ? [o.id] : this.spaceIdsOf(o.id); }
}

const readOr = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };
