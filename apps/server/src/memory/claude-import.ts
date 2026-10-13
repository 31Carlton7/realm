import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  MEMORY_DOC_MAX, MEMORY_REPO_ENTRY_MAX, MEMORY_REPO_INDEX_FILE,
  applyMemoryEdit, memoryEntryProblem, wikiLinkFor, withIndexLink, type MemoryEntry,
} from "@realm/contracts";
import { secretShapeIn } from "./secret-shapes";

/** One project's Claude memory as Realm copied it: `<home>/memory/imported/<spaceId>/<project>/`. */
export type ClaudeMemorySource = { project: string; dir: string };

export type ClaudeImportPlan = {
  /** Repo-relative path → full content, for every file the import adds or extends. Empty when the
   *  repo already holds everything. */
  writes: Map<string, string>;
  projects: number;
  files: number;
  entries: number;
  skipped: { file: string; reason: string }[];
};

/** `- [Title](file.md) — what it is`: a line of Claude's own memory index. */
const INDEX_LINE = /^\s*[-*+]\s+\[([^\]]+)\]\(\.?\/?([^)\s]+\.md)\)\s*(?:[—–:-]+\s*)?(.*)$/;

/**
 * What importing these projects into the repo at `repo` would write — computed from disk, written by
 * nobody here. For each project:
 *
 * - every fact file goes to `imported/<project>/<file>` unless that path is already in the repo (the
 *   repo's copy may have been edited since, and an import never overwrites);
 * - its links are rewritten to the spec's root-relative form, `[[imported/<project>/<name>]]`, since a
 *   sibling link means nothing from the repo's root;
 * - `imported/<project>.md` gets one entry per fact whose link it does not hold yet, carrying the
 *   index's own title and description, `source` = the file it came from, and `added` = the date Claude
 *   last changed it — and is linked from `MEMORY.md`'s index.
 *
 * A file holding something shaped like a credential, or too long to be a memory file, is left out
 * and named in `skipped`.
 */
export function planClaudeImport(sources: ClaudeMemorySource[], repo: string, today: string): ClaudeImportPlan {
  const writes = new Map<string, string>();
  const skipped: ClaudeImportPlan["skipped"] = [];
  let index = readOr(join(repo, MEMORY_REPO_INDEX_FILE), "");
  const indexBefore = index;
  let projects = 0;
  let files = 0;
  let entries = 0;
  for (const src of sources) {
    let names: string[];
    try { names = readdirSync(src.dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== MEMORY_REPO_INDEX_FILE).map((e) => e.name).sort(); }
    catch { continue; }
    if (names.length === 0) continue;
    const described = describedIn(readOr(join(src.dir, MEMORY_REPO_INDEX_FILE), ""));
    const folder = `imported/${src.project}`;
    const topicRel = `${folder}.md`;
    const topicBefore = existsSync(join(repo, topicRel)) ? readOr(join(repo, topicRel), "") : null;
    let topic = topicBefore ?? "";
    let touched = false;
    for (const name of names) {
      const from = join(src.dir, name);
      const rel = `${folder}/${name}`;
      const link = wikiLinkFor(rel);
      const raw = readOr(from, "");
      const secret = secretShapeIn(raw);
      if (secret) { skipped.push({ file: from, reason: `it looks like it holds ${secret}` }); continue; }
      if (raw.length > MEMORY_DOC_MAX) { skipped.push({ file: from, reason: `it is longer than ${MEMORY_DOC_MAX} characters` }); continue; }
      if (!existsSync(join(repo, rel))) {
        writes.set(rel, rootRelativeLinks(raw, folder, names));
        files++;
        touched = true;
      }
      if (topic.includes(link)) continue;
      const entry = entryFor(name, raw, described.get(name), link, from, today);
      if (!entry) { skipped.push({ file: from, reason: "its title would not read back as one entry" }); continue; }
      const r = applyMemoryEdit(topic, { op: "add", entry }, { isIndex: false, title: `Claude memory: ${src.project}` });
      if (!r.ok || !r.changed) continue;
      topic = r.content;
      entries++;
      touched = true;
    }
    if (topic !== (topicBefore ?? "")) writes.set(topicRel, topic);
    if (touched) projects++;
    index = withIndexLink(index, topicRel);
  }
  if (writes.size > 0 && index !== indexBefore) writes.set(MEMORY_REPO_INDEX_FILE, index);
  return { writes, projects, files, entries, skipped };
}

/** Claude's index, as file → "Title — description". */
function describedIn(index: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of index.split("\n")) {
    const m = INDEX_LINE.exec(line);
    if (!m) continue;
    const [, title, file, rest] = m;
    out.set(file!.split("/").at(-1)!, rest!.trim() ? `${title!.trim()} — ${rest!.trim()}` : title!.trim());
  }
  return out;
}

/** One fact as an entry: what the index (or the file's own frontmatter) says it is, then its link. */
function entryFor(name: string, raw: string, described: string | undefined, link: string, from: string, today: string): MemoryEntry | null {
  const front = frontmatter(raw);
  const modified = /^\d{4}-\d{2}-\d{2}/.exec(front.get("modified") ?? "")?.[0];
  const meta = { source: from, added: modified ?? today };
  const about = described ?? front.get("description") ?? front.get("name") ?? name.replace(/\.md$/, "");
  const room = MEMORY_REPO_ENTRY_MAX - link.length - 200;
  const text = (s: string): string => `${s.length > room ? `${s.slice(0, room - 1).trimEnd()}…` : s} (${link})`;
  for (const candidate of [text(oneLine(about)), text(name.replace(/\.md$/, ""))]) {
    const entry = { text: candidate, meta };
    if (memoryEntryProblem(entry) === null) return entry;
  }
  return null;
}

/** The `key: value` lines of a leading `---` block, flattened (nested keys included). */
function frontmatter(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const m = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!m) return out;
  for (const line of m[1]!.split("\n")) {
    const kv = /^\s*([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv && kv[2]!.trim() !== "" && !out.has(kv[1]!)) out.set(kv[1]!, kv[2]!.trim());
  }
  return out;
}

/** Sibling links — `[[name]]` and `[Title](name.md)` — as links from the repo's root. */
function rootRelativeLinks(raw: string, folder: string, names: string[]): string {
  const siblings = new Set(names.map((n) => n.replace(/\.md$/, "")));
  return raw
    .replace(/\[\[([^[\]/]+?)\]\]/g, (m, n: string) => (siblings.has(n.trim()) ? wikiLinkFor(`${folder}/${n.trim()}.md`) : m))
    .replace(/\[([^\]]+)\]\(\.?\/?([^)\s/]+)\.md\)/g, (m, title: string, n: string) => (siblings.has(n) ? `${title} (${wikiLinkFor(`${folder}/${n}.md`)})` : m));
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").replace(/[[\]]/g, "").trim();

function readOr(p: string, fallback: string): string {
  try { return readFileSync(p, "utf8"); } catch { return fallback; }
}
