import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentKind, ImportSource } from "@realm/contracts";
import { parseFrontmatter } from "../skills/frontmatter";
import { parseClaudeTranscript } from "./claude";
import { parseCodexRollout } from "./codex";
import { chainIds, parseCursorChain, parseCursorMeta } from "./cursor";
import { decodeClaudeProjectSlug, type ImportRoots } from "./sources";
import type { ParsedTranscript } from "./transcript";

/**
 * Finding what is on disk, and reading one of it.
 *
 * Discovery is a listing (cheap, total) and loading is a parse (expensive, per-item). They are
 * separate so `apply` can re-read exactly the transcripts it was asked for instead of holding the
 * whole scan in memory between two RPC calls — a preview the user leaves open for ten minutes must
 * not pin hundreds of megabytes, and re-reading is also what makes `apply` see a file that changed
 * since the scan rather than a stale copy of it.
 *
 * Every function here treats an unreadable file as an absence. A directory the user does not have, a
 * transcript truncated by a killed CLI, a Cursor store from a schema this build does not know: all of
 * them are `null`, counted, and reported — never a throw that costs the other 800 files their import.
 */

export type FoundSession = { key: string; source: ImportSource; agentKind: AgentKind; path: string };

const dirs = (path: string): string[] => {
  try { return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return []; }
};
const files = (path: string): string[] => {
  try { return readdirSync(path, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); }
  catch { return []; }
};
/** Text, or null. The one read every parser goes through, so "unreadable" has a single meaning. */
export const readText = (path: string): string | null => {
  try { return readFileSync(path, "utf8"); } catch { return null; }
};

/** `<claude>/projects/<slug>/<sessionId>.jsonl`. The nested `<slug>/<sessionId>/subagents/` trees are
 *  deliberately not walked: those are delegated-agent transcripts, which Realm models as their own
 *  sessions rather than as part of the parent's. */
export function findClaudeSessions(roots: ImportRoots): FoundSession[] {
  const base = join(roots.claude, "projects");
  return dirs(base).flatMap((slug) =>
    files(join(base, slug)).filter((f) => f.endsWith(".jsonl")).map((f) => {
      const path = join(base, slug, f);
      return { key: path, source: "claude" as const, agentKind: "claude" as AgentKind, path };
    }));
}

/** `<codex>/sessions/YYYY/MM/DD/rollout-*.jsonl` — walked by depth rather than by date parsing, so a
 *  layout change that adds or drops a level costs nothing. */
export function findCodexSessions(roots: ImportRoots): FoundSession[] {
  const out: FoundSession[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    for (const f of files(dir)) {
      if (f.endsWith(".jsonl")) { const path = join(dir, f); out.push({ key: path, source: "codex", agentKind: "codex", path }); }
    }
    for (const d of dirs(dir)) walk(join(dir, d), depth + 1);
  };
  walk(join(roots.codex, "sessions"), 0);
  return out;
}

/** Cursor keeps two stores in two shapes — `acp-sessions/<id>/` (what `cursor-agent acp` writes, i.e.
 *  the sessions Realm itself would have produced) and `chats/<hash>/<id>/`. Both are the same SQLite
 *  layout, so both are read the same way. The DIRECTORY is the key, because the session's identity is
 *  its folder and `store.db` is only where it happens to be kept. */
export function findCursorSessions(roots: ImportRoots): FoundSession[] {
  const out: FoundSession[] = [];
  const add = (dir: string) => {
    if (existsSync(join(dir, "store.db"))) out.push({ key: dir, source: "cursor", agentKind: "acp:cursor", path: dir });
  };
  for (const id of dirs(join(roots.cursor, "acp-sessions"))) add(join(roots.cursor, "acp-sessions", id));
  const chats = join(roots.cursor, "chats");
  for (const hash of dirs(chats)) for (const id of dirs(join(chats, hash))) add(join(chats, hash, id));
  return out;
}

/** One transcript, whichever source it came from. Null when it cannot be read or holds no
 *  conversation at all (an empty session the CLI created and the user abandoned). */
export function loadTranscript(found: FoundSession, now: number): ParsedTranscript | null {
  if (found.source === "claude") { const t = readText(found.path); return t === null ? null : parseClaudeTranscript(t, now); }
  if (found.source === "codex") { const t = readText(found.path); return t === null ? null : parseCodexRollout(t, now); }
  return loadCursor(found.path, now);
}

function loadCursor(dir: string, now: number): ParsedTranscript | null {
  let db: DatabaseSync | null = null;
  try {
    // Read-only, and on a URI so SQLite cannot create or upgrade anything: this is Cursor's live
    // database, possibly with Cursor running against it, and the import's whole posture is that the
    // agents' own files are never written.
    db = new DatabaseSync(`file:${join(dir, "store.db")}?mode=ro`, { readOnly: true, allowExtension: false });
    const metaRow = db.prepare("SELECT value FROM meta ORDER BY key LIMIT 1").get() as { value?: unknown } | undefined;
    const meta = typeof metaRow?.value === "string" ? parseCursorMeta(metaRow.value) : null;
    if (!meta) return null;
    const rootRow = db.prepare("SELECT data FROM blobs WHERE id = ?").get(meta.latestRootBlobId) as { data?: unknown } | undefined;
    if (!(rootRow?.data instanceof Uint8Array)) return null;
    const get = db.prepare("SELECT data FROM blobs WHERE id = ?");
    const messages: unknown[] = [];
    for (const id of chainIds(Buffer.from(rootRow.data))) {
      const row = get.get(id) as { data?: unknown } | undefined;
      if (!(row?.data instanceof Uint8Array)) continue;
      // A chain entry that is not JSON is a blob shape this build does not know. Skipped, not
      // guessed at — and never decrypted: `meta` carries a `blobEncryptionKey`, and reaching for it
      // would be reverse-engineering a format Cursor has not published.
      try { messages.push(JSON.parse(Buffer.from(row.data).toString("utf8"))); } catch { /* not a message */ }
    }
    const parsed = parseCursorChain(messages, meta, now);
    // `meta.json` beside the store is Cursor's own record of the directory, and it beats the cwd
    // mined out of the injected preamble.
    if (parsed && !parsed.cwd) {
      const metaJson = readText(join(dir, "meta.json"));
      if (metaJson) { try { const j: unknown = JSON.parse(metaJson); const c = (j as { cwd?: unknown }).cwd; if (typeof c === "string") parsed.cwd = c; } catch { /* keep empty */ } }
    }
    return parsed;
  } catch { return null; }
  finally { try { db?.close(); } catch { /* already gone */ } }
}

/** The cwd Cursor recorded for a session directory, without decoding its whole conversation — used by
 *  the scan's cheap pass. */
export function cursorMetaCwd(dir: string): string {
  const text = readText(join(dir, "meta.json"));
  if (!text) return "";
  try { const j: unknown = JSON.parse(text); const c = (j as { cwd?: unknown }).cwd; return typeof c === "string" ? c : ""; }
  catch { return ""; }
}

export type FoundMemory = { key: string; path: string; cwd: string;
  /** The raw `~/.claude/projects` directory name. Kept for the case where the decode fails: the slug
   *  still contains the words of the original path, which is enough for the profile fallback. */
  slug: string; files: number; bytes: number };

/**
 * `<claude>/projects/<slug>/memory/` — the memory tool's own folder: a `MEMORY.md` index beside one
 * file per fact.
 *
 * The project cwd is recovered by decoding the slug against the filesystem, which is ambiguous by
 * construction (see `decodeClaudeProjectSlug`). A slug that decodes to nothing real still yields a
 * folder worth importing, so it is kept with an empty cwd and simply has no path evidence to match
 * on — it lands in the catch-all rather than being dropped for a naming quirk.
 */
export function findClaudeMemories(roots: ImportRoots): FoundMemory[] {
  const base = join(roots.claude, "projects");
  const out: FoundMemory[] = [];
  for (const slug of dirs(base)) {
    const path = join(base, slug, "memory");
    const md = files(path).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
    if (md.length === 0) continue;
    let bytes = 0;
    for (const f of md) { try { bytes += statSync(join(path, f)).size; } catch { /* counted as zero */ } }
    // The decode reads real directories, so a project whose folder has since been moved or deleted
    // yields no cwd — the folder is still imported, it simply has no path evidence to match on and
    // falls to the profile catch-all. `slug` rides along so the fallback can still read a profile
    // name out of the text when the tree cannot be walked.
    out.push({ key: path, path, cwd: decodeClaudeProjectSlug(slug, dirs) ?? "", slug, files: md.length, bytes });
  }
  return out;
}

export type FoundSkill = { id: string; path: string; origin: string; name: string; description: string };

/**
 * Every user-level skill directory across every agent, as `<dir>/<id>/SKILL.md`.
 *
 * Unparseable frontmatter means the skill is NOT offered: Realm's own library lists a malformed skill
 * so the user can go fix it, but importing one would be copying a broken file into a second place for
 * them to fix it in. The source folder still has it.
 */
export function findSkills(roots: ImportRoots): FoundSkill[] {
  const roots2 = [
    { dir: join(roots.claude, "skills"), origin: "claude" },
    { dir: join(roots.codex, "skills"), origin: "codex" },
    ...roots.extraSkillDirs.map((dir) => ({ dir, origin: labelFor(dir) })),
  ];
  const out: FoundSkill[] = [];
  for (const { dir, origin } of roots2) {
    for (const id of dirs(dir)) {
      const path = join(dir, id, "SKILL.md");
      const text = readText(path);
      if (text === null) continue;
      const fm = parseFrontmatter(text);
      const name = fm?.name?.trim() ?? "";
      const description = fm?.description?.trim() ?? "";
      if (!name || !description) continue;
      out.push({ id, path, origin, name, description });
    }
  }
  return out;
}

/** `/Users/x/.agents/skills` → `agents`: the owning directory of the skills folder, minus the dot —
 *  which is what the user recognises the folder by. Structural rather than a regex over the whole
 *  path, so a fixture tree (or a `CLAUDE_CONFIG_DIR` somewhere without a dot-directory in it) gets a
 *  readable label instead of an absolute path. */
function labelFor(dir: string): string {
  return basename(dirname(dir)).replace(/^\./, "") || dir;
}
