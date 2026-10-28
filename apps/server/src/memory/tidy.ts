import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  MEMORY_REPO_ENTRY_MAX, MEMORY_REPO_INDEX_FILE, applyMemoryEdit, formatMemoryEntry, memoryEntryProblem, memoryLearningKey,
  memoryLearningOn, parseMemoryEntry, type MemoryEntry,
} from "@realm/contracts";
import type { MemoryTidyInput, TidyFile } from "@realm/adapters";
import { LEARNED_AUTHOR } from "./extract";
import type { RepoOwner } from "./repo";
import { secretShapeIn } from "./secret-shapes";
import type { MemorySink, SpaceFolder } from "./sink";

/** How often a profile's memory is tidied. */
export const TIDY_EVERY_MS = 7 * 24 * 60 * 60_000;
/** How long the indexes a session is handed may grow before tidying comes early — and how soon after
 *  the last pass it may. A store that one pass could not shrink must not buy a call every hour. */
export const TIDY_INDEX_MAX = 32_000;
export const TIDY_SOONEST_MS = 24 * 60 * 60_000;
/** A file changed this recently is somebody's work in progress — a session saving, the user editing —
 *  and the tidy pass leaves it, and anything that would change it, alone. */
export const TIDY_RECENT_MS = 60 * 60_000;
/** The most one pass may delete, as a share of the facts in the store (files and root entries). */
export const TIDY_DELETE_FRACTION = 0.2;
export const TIDY_COMMIT_MESSAGE = "Tidy memory";

const TIDY_TICK_MS = 60 * 60_000;
/** What of each fact file the model is shown, and of the store in all. Whole folders are shown or none,
 *  so duplicates inside a folder are always seen together. */
const TIDY_FILE_SHOWN_MAX = 1_500;
const TIDY_SHOWN_MAX = 60_000;
const OPERATIONS_MAX = 20;

const tidiedAtKey = (profileId: string): string => `memory.tidiedAt:${profileId}`;

/** Thrown inside the store's lock when files the pass would change were written while it was planned. */
class MemoryMovedOn extends Error {
  constructor(readonly paths: string[]) { super(`${paths.join(", ")} changed while the pass was planned`); }
}

// ─── The store as the pass sees it ────────────────────────────────────────────────────────────────

/** One file as the pass read it. `text` is "" for a file that was not there, which `exists` tells apart
 *  from an empty one — the difference matters when the pass checks nobody wrote it since. */
type Doc = { path: string; text: string; exists: boolean; mtimeMs: number };
export type Fact = Doc & { folder: string; name: string; type: string | null; description: string | null };
export type TidySnapshot = { root: Doc; folders: { folder: string; index: Doc; facts: Fact[] }[] };

const indexPathOf = (folder: string): string => `spaces/${folder}/${MEMORY_REPO_INDEX_FILE}`;

function readDoc(repoPath: string, path: string): Doc {
  try { return { path, text: readFileSync(join(repoPath, path), "utf8"), exists: true, mtimeMs: statSync(join(repoPath, path)).mtimeMs }; }
  catch { return { path, text: "", exists: false, mtimeMs: 0 }; }
}

/** The root index and, for each folder, its index and its fact files — read from disk, written by nobody here. */
export function readSnapshot(repoPath: string, folders: readonly string[]): TidySnapshot {
  return {
    root: readDoc(repoPath, MEMORY_REPO_INDEX_FILE),
    folders: folders.map((folder) => {
      let names: string[] = [];
      try {
        names = readdirSync(join(repoPath, "spaces", folder), { withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== MEMORY_REPO_INDEX_FILE).map((e) => e.name).sort();
      } catch { /* a folder recorded but not made yet holds nothing */ }
      const facts = names.map((n) => {
        const doc = readDoc(repoPath, `spaces/${folder}/${n}`);
        const f = factFields(doc.text);
        return { ...doc, folder, name: n.replace(/\.md$/, ""), type: f.type, description: f.description };
      });
      return { folder, index: readDoc(repoPath, indexPathOf(folder)), facts };
    }),
  };
}

const FRONT = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

const unquote = (v: string): string => {
  const t = v.trim();
  if (t.startsWith('"')) { try { return String(JSON.parse(t)); } catch { return t.slice(1, -1); } }
  return t.startsWith("'") && t.endsWith("'") ? t.slice(1, -1) : t;
};

/** A fact file in Claude's own format: `name`, `description` and `metadata.type` up top, then the fact. */
export function factFields(text: string): { description: string | null; type: string | null; front: string | null; body: string } {
  const m = FRONT.exec(text);
  if (!m) return { description: null, type: null, front: null, body: text };
  const front = m[1]!;
  const description = /^description:[ \t]*(.*)$/m.exec(front)?.[1];
  const type = /^(?:[ \t]+)?type:[ \t]*(.*)$/m.exec(front)?.[1];
  return { description: description ? unquote(description) : null, type: type ? unquote(type) : null, front, body: text.slice(m[0].length) };
}

/** The fact file with a new description and body, every other header line kept as it was. */
function rewriteFact(text: string, name: string, description: string, body: string): string {
  const f = factFields(text);
  const line = `description: ${JSON.stringify(description)}`;
  const front = f.front === null ? `name: ${name}\n${line}`
    : /^description:.*$/m.test(f.front) ? f.front.replace(/^description:.*$/m, line)
    : `${f.front}\n${line}`;
  return `---\n${front}\n---\n\n${body.trim()}\n`;
}

/** Every link on a line: `[[wiki]]` targets and `(file.md)` Markdown targets, `./` dropped. */
const linksIn = (line: string): string[] =>
  [...line.matchAll(/\[\[([^[\]]+)\]\]|\]\(([^)\s]+)\)/g)].map((m) => (m[1] ?? m[2]!).replace(/^\.\//, ""));

/** A root line that links a space's folder index: the root's table of contents, not a fact. */
const linksFolder = (line: string): boolean => linksIn(line).some((l) => /^spaces\/[^/]+\/MEMORY(?:\.md)?$/.test(l));

/** Whether a line links this fact: its folder index by file name, the root by its path from the top. */
const linksFact = (line: string, fact: { folder: string; name: string }, from: "index" | "root"): boolean =>
  linksIn(line).some((l) => (from === "index" ? l === `${fact.name}.md` : l === `spaces/${fact.folder}/${fact.name}` || l === `spaces/${fact.folder}/${fact.name}.md`));

const oneLine = (s: string): string => s.replace(/\s+/g, " ").replace(/[[\]]/g, "").trim();

// ─── The plan ─────────────────────────────────────────────────────────────────────────────────────

const OneLine = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\r\n]/.test(s), "must be one line");
const Path = z.string().trim().min(1).max(300);
const Body = z.string().trim().min(1).max(4_000);
const TidyOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("merge"), into: Path, from: z.array(Path).min(1).max(10), description: OneLine(200), body: Body }),
  z.object({ op: z.literal("rewrite"), path: Path, description: OneLine(200), body: Body }),
  z.object({ op: z.literal("delete"), path: Path, why: z.string().max(500).optional() }),
  z.object({ op: z.literal("promote"), path: Path, line: OneLine(300) }),
  z.object({ op: z.literal("line"), file: Path, line: z.string().min(1).max(2 * MEMORY_REPO_ENTRY_MAX), to: OneLine(MEMORY_REPO_ENTRY_MAX).nullable() }),
]);
export type TidyOp = z.infer<typeof TidyOpSchema>;
const TidyPlanSchema = z.object({ operations: z.array(TidyOpSchema).max(OPERATIONS_MAX) });

/** The model's plan, or why it is refused — the extraction's rule: JSON, a fence forgiven, nothing else. */
export function parseTidyPlan(raw: string): { ok: true; operations: TidyOp[] } | { ok: false; error: string } {
  const text = raw.trim().replace(/^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/, "$1").trim();
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { ok: false, error: "the plan is not JSON" }; }
  const r = TidyPlanSchema.safeParse(json);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    return { ok: false, error: `${issue.path.join(".") || "plan"}: ${issue.message}` };
  }
  return { ok: true, operations: r.data.operations };
}

/**
 * The repo's files as one pass changes them, in memory. Every rule the pass keeps is checked here,
 * against what is on disk: an operation that breaks one is dropped whole, with its reason, and the
 * rest of the plan still applies.
 */
export class TidyDraft {
  private content = new Map<string, string | null>();
  private facts = new Map<string, Fact>();
  /** The fact files the model was shown; null until `showOnly`, which means all of them. */
  private shown: Set<string> | null = null;
  private deleted = 0;
  readonly cap: number;

  constructor(private snap: TidySnapshot, private now: number, private today: string) {
    for (const f of snap.folders) for (const x of f.facts) this.facts.set(x.path, x);
    const rootEntries = snap.root.text.split("\n").filter((l) => parseMemoryEntry(l) !== null && !linksFolder(l)).length;
    this.cap = Math.floor(TIDY_DELETE_FRACTION * (this.facts.size + rootEntries));
  }

  get(path: string): string | null {
    if (this.content.has(path)) return this.content.get(path)!;
    if (path === MEMORY_REPO_INDEX_FILE) return this.snap.root.text;
    const folder = this.snap.folders.find((f) => f.index.path === path);
    if (folder) return folder.index.text;
    return this.facts.get(path)?.text ?? null;
  }

  /** What changed against the disk: path → new content, or null to delete. */
  changes(): Map<string, string | null> {
    const out = new Map<string, string | null>();
    for (const [path, text] of this.content) if (text !== this.read(path)) out.set(path, text);
    return out;
  }

  /**
   * The files this pass would change whose text is no longer what the pass read: somebody wrote them
   * while the plan was being made — an agent saving, Claude's own memory, the person. `current` is
   * what the store holds now, null for a file that is not there. Asked inside the store's lock, just
   * before the pass is written, so a write that lands during the model call is never written over.
   */
  drifted(current: (path: string) => string | null): string[] {
    return [...this.changes().keys()].filter((path) => current(path) !== this.read(path));
  }

  /** A file as the pass read it, or null when it was not there. */
  private read(path: string): string | null {
    const doc = this.doc(path);
    return doc?.exists ? doc.text : null;
  }

  private doc(path: string): Doc | undefined {
    if (path === MEMORY_REPO_INDEX_FILE) return this.snap.root;
    return this.snap.folders.find((f) => f.index.path === path)?.index ?? this.facts.get(path);
  }

  private mtime(path: string): number { return this.doc(path)?.mtimeMs ?? 0; }

  recent(path: string): boolean { return this.now - this.mtime(path) < TIDY_RECENT_MS; }

  /** Only these files may be changed: a plan may not act on a file it did not see whole. */
  showOnly(paths: Iterable<string>): void { this.shown = new Set(paths); }

  /**
   * The deterministic step: a fact that is plainly about the person gets a root entry linking it, so
   * every space sees it — a `user` fact (who they are), or a `feedback` fact more than one space learned
   * under the same name (it held in each, so it is theirs, not one project's). None for a name the root
   * already links — which, as entries are added, also keeps it to one per name. A `feedback` fact one
   * space holds may be that project's convention or the person's habit: the model's call, not this step's.
   */
  promote(): number {
    if (this.recent(MEMORY_REPO_INDEX_FILE)) return 0;
    const all = [...this.facts.values()];
    let promoted = 0;
    for (const x of all) {
      const aboutThePerson = x.type === "user" || (x.type === "feedback" && all.filter((y) => y.name === x.name && y.type === "feedback").length > 1);
      if (aboutThePerson && this.linkFromRoot(x, x.description ?? x.name) === null) promoted++;
    }
    return promoted;
  }

  /** A root entry saying `what` and linking the fact, with where it came from — or why there is none:
   *  the root already links a fact of that name, the line looks like a secret, or it would not read
   *  back as one entry. */
  private linkFromRoot(x: Fact, what: string): string | null {
    const root = this.get(MEMORY_REPO_INDEX_FILE) ?? "";
    if ([...this.facts.values()].some((y) => y.name === x.name && root.split("\n").some((l) => linksFact(l, y, "root")))) return "the top MEMORY.md already links it";
    const entry: MemoryEntry = { text: `${oneLine(what)} ([[spaces/${x.folder}/${x.name}]])`, meta: { source: `spaces/${x.folder}/${x.name}.md`, added: this.today } };
    if (secretShapeIn(entry.text)) return "it looks like it holds a secret";
    const problem = memoryEntryProblem(entry);
    if (problem) return problem;
    const r = applyMemoryEdit(root, { op: "add", entry }, { isIndex: true, title: "Memory" });
    if (!r.ok) return r.error;
    this.content.set(MEMORY_REPO_INDEX_FILE, r.content);
    return null;
  }

  /** One operation of the model's plan, or the reason it was dropped. */
  apply(op: TidyOp): string | null {
    if (op.op === "line") return this.line(op);
    if (op.op === "promote") {
      // The model's half of the promotion: a fact this step could not call the person's.
      const x = this.facts.get(op.path);
      if (!x) return "it names a file that is not a fact in a folder in use";
      if (this.shown && !this.shown.has(op.path)) return "it names a file the plan did not see whole";
      if (this.get(op.path) === null) return "an earlier operation deleted a file it names";
      if (this.recent(MEMORY_REPO_INDEX_FILE)) return "a file it would change was changed in the last hour";
      return this.linkFromRoot(x, op.line);
    }
    const paths = op.op === "merge" ? [op.into, ...op.from] : [op.path];
    if (new Set(paths).size !== paths.length) return "it names one file twice";
    const facts = paths.map((p) => this.facts.get(p));
    if (facts.some((x) => !x)) return "it names a file that is not a fact in a folder in use";
    if (this.shown && paths.some((p) => !this.shown!.has(p))) return "it names a file the plan did not see whole";
    if (paths.some((p) => this.get(p) === null)) return "an earlier operation deleted a file it names";
    const [first, ...rest] = facts as Fact[];
    if (rest.some((x) => x.folder !== first!.folder)) return "it merges facts from different spaces";
    const goes = op.op === "merge" ? rest : op.op === "delete" ? [first!] : [];
    const index = indexPathOf(first!.folder);
    const rootLinks = goes.some((x) => (this.get(MEMORY_REPO_INDEX_FILE) ?? "").split("\n").some((l) => linksFact(l, x, "root")));
    const touched = [...paths, index, ...(rootLinks ? [MEMORY_REPO_INDEX_FILE] : [])];
    if (touched.some((p) => this.recent(p))) return "a file it would change was changed in the last hour";
    if (op.op !== "delete" && secretShapeIn(`${op.description}\n${op.body}`)) return "it looks like it holds a secret";
    if (this.deleted + goes.length > this.cap) return `it would take this pass past its ${this.cap} deletions`;

    if (op.op !== "delete") {
      this.content.set(first!.path, rewriteFact(this.get(first!.path)!, first!.name, op.description, op.body));
      this.editLines(index, (l) => (linksFact(l, first!, "index") ? l.replace(/(\]\((?:\.\/)?[^)\s]+\.md\)).*$/, `$1 — ${op.description}`) : l));
    }
    for (const x of goes) {
      this.content.set(x.path, null);
      this.editLines(index, (l) => (linksFact(l, x, "index") ? null : l));
      if (rootLinks) this.editLines(MEMORY_REPO_INDEX_FILE, (l) => (linksFact(l, x, "root") ? null : l));
    }
    this.deleted += goes.length;
    return null;
  }

  /** An index line shortened or corrected, or a root line removed. A line keeps every link it had: a
   *  shorter line that lost its link would orphan the file it pointed at. */
  private line(op: Extract<TidyOp, { op: "line" }>): string | null {
    const isRoot = op.file === MEMORY_REPO_INDEX_FILE;
    if (!isRoot && !this.snap.folders.some((f) => f.index.path === op.file)) return "it names a file that is not an index in use";
    if (this.recent(op.file)) return "a file it would change was changed in the last hour";
    const text = this.get(op.file) ?? "";
    const at = text.split("\n").flatMap((l, i) => (l.trim() === op.line.trim() ? [i] : []));
    if (at.length !== 1) return at.length === 0 ? "no line reads like that" : "more than one line reads like that";
    const before = text.split("\n")[at[0]!]!;
    const entry = parseMemoryEntry(before);
    if (op.to === null) {
      if (!isRoot) return "an index line goes with its file — delete the file instead";
      if (!entry) return "only an entry can be removed, not a heading";
      if (linksFolder(before)) return "it would unlink a space's folder";
      if (this.deleted + 1 > this.cap) return `it would take this pass past its ${this.cap} deletions`;
      this.editLines(op.file, (l, i) => (i === at[0] ? null : l));
      this.deleted += 1;
      return null;
    }
    const kept = new Set(linksIn(op.to));
    if (linksIn(before).some((l) => !kept.has(l))) return "it drops a link";
    if (secretShapeIn(op.to)) return "it looks like it holds a secret";
    let after = op.to;
    if (entry) {
      const next = parseMemoryEntry(/^[-*+]\s/.test(op.to) ? op.to : `- ${op.to}`);
      if (!next) return "it is not a line of the index";
      // An entry keeps where it came from: a shorter line that dropped `[source: …; added: …]` would
      // lose the provenance the spec asks every entry to carry.
      const meta = Object.keys(next.meta).length > 0 ? next.meta : entry.meta;
      const e = { text: next.text, meta };
      if (isRoot && memoryEntryProblem(e)) return memoryEntryProblem(e)!;
      after = formatMemoryEntry(e);
    }
    this.editLines(op.file, (l, i) => (i === at[0] ? after : l));
    return null;
  }

  private editLines(path: string, f: (line: string, i: number) => string | null): void {
    const text = this.get(path);
    if (text === null) return;
    const lines = text.split("\n").map(f).filter((l): l is string => l !== null);
    this.content.set(path, lines.join("\n"));
  }
}

/**
 * The files the model is shown: whole folders, largest first, while the budget lasts, with the indexes
 * counted against the same budget. A file longer than `TIDY_FILE_SHOWN_MAX` is shown cut, for context,
 * and left out of `whole` — the files a plan may act on.
 */
export function shownFiles(snap: TidySnapshot, indexChars: number): { files: TidyFile[]; whole: string[] } {
  let room = TIDY_SHOWN_MAX - indexChars;
  const files: TidyFile[] = [];
  const whole: string[] = [];
  for (const f of [...snap.folders].sort((a, b) => b.facts.length - a.facts.length || a.folder.localeCompare(b.folder))) {
    const shown = f.facts.map((x) => ({ path: x.path, text: x.text.length > TIDY_FILE_SHOWN_MAX ? `${x.text.slice(0, TIDY_FILE_SHOWN_MAX)}\n[cut]` : x.text }));
    const size = shown.reduce((n, x) => n + x.path.length + x.text.length, 0);
    if (size > room) continue;
    files.push(...shown);
    whole.push(...f.facts.filter((x) => x.text.length <= TIDY_FILE_SHOWN_MAX).map((x) => x.path));
    room -= size;
  }
  return { files, whole };
}

// ─── The pass, and when it runs ───────────────────────────────────────────────────────────────────

export type TidyOutcome =
  | { ran: false; why: string }
  | { ran: true; writes: Map<string, string | null>; promoted: number; applied: number; dropped: { op: TidyOp; why: string }[]; rejected?: string; sha: string | null };

export type MemoryTidierDeps = {
  profileIds: () => string[];
  spaceIdsOf: (profileId: string) => string[];
  /** Whether the store has chosen a folder for this space (`spaceFolderSettingKey`). Only those spaces
   *  are asked for theirs, so the pass never allocates one. */
  folderRecorded: (spaceId: string) => boolean;
  sink: MemorySink;
  settings: { get(key: string): unknown; set(key: string, value: unknown): void };
  /** The billed call. The tidier exists only where one is wired (`billedGenerators`). */
  generate: (input: MemoryTidyInput) => Promise<string>;
  available?: () => boolean | Promise<boolean>;
  now?: () => number;
  today?: () => string;
  onTidied?: (owner: RepoOwner) => void;
  onError?: (line: string) => void;
};

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Keeps each profile's memory repo tidy: about once a week, or sooner once the indexes a session is
 * handed grow past `TIDY_INDEX_MAX`. One pass is a deterministic step — facts about the person,
 * promoted to the root so every space sees them — then one model call proposing merges, rewrites,
 * deletions and shorter index lines, validated against the disk and applied with the first step as
 * ONE commit, "Tidy memory". That commit is the undo, and the Memory page's log shows it.
 *
 * The model may promote a fact too — one this step could not call the person's, such as a single
 * space's feedback about how they work — under the same rules as the rest of its plan.
 *
 * It never touches a file changed in the last hour, never deletes more than `TIDY_DELETE_FRACTION` of
 * the store in one pass, and keeps to the extraction's gating: the profile's switch, the scripted
 * agent's harness (no tidier is made there), and only the folders of spaces whose memory is in use.
 */
export class MemoryTidier {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = new Set<string>();
  private unavailable = false;
  private closed = false;

  constructor(private d: MemoryTidierDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { for (const id of this.d.profileIds()) this.check(id); }, TIDY_TICK_MS);
    this.timer.unref?.();
  }

  close(): void {
    this.closed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Tidy the profile if it is due. The first time a profile is seen only starts its clock: a store
   *  just imported is all files changed in the last hour, and a pass then would be spent on nothing. */
  check(profileId: string): void {
    if (this.closed || this.inFlight.has(profileId) || !memoryLearningOn(this.d.settings.get(memoryLearningKey(profileId)))) return;
    const now = this.now();
    const last = this.d.settings.get(tidiedAtKey(profileId));
    if (typeof last !== "number") { this.d.settings.set(tidiedAtKey(profileId), now); return; }
    const since = now - last;
    const due = since >= TIDY_EVERY_MS || (since >= TIDY_SOONEST_MS && this.indexChars(profileId) > TIDY_INDEX_MAX);
    if (due) void this.tidy(profileId).catch((e) => this.fail(profileId, e));
  }

  /** The longest set of indexes one of the profile's sessions is handed: the root and its space's folder. */
  indexChars(profileId: string): number {
    const places = this.places(profileId);
    if (places.length === 0) return 0;
    const size = (path: string): number => { try { return readFileSync(path, "utf8").length; } catch { return 0; } };
    return size(join(places[0]!.repoPath, MEMORY_REPO_INDEX_FILE)) + Math.max(0, ...places.map((p) => size(join(p.dir, MEMORY_REPO_INDEX_FILE))));
  }

  /** One pass. `dryRun` plans everything and writes nothing — not even the time of the attempt. */
  async tidy(profileId: string, o: { dryRun?: boolean } = {}): Promise<TidyOutcome> {
    const skip = (why: string): TidyOutcome => ({ ran: false, why });
    if (this.closed) return skip("closed");
    if (this.unavailable) return skip("no model on this machine");
    if (this.inFlight.has(profileId)) return skip("already tidying");
    if (!memoryLearningOn(this.d.settings.get(memoryLearningKey(profileId)))) return skip("off");
    const places = this.places(profileId);
    if (places.length === 0) return skip("no memory in use");
    const { owner, repoPath } = places[0]!;
    const now = this.now();
    const lastClock = this.d.settings.get(tidiedAtKey(profileId));
    this.inFlight.add(profileId);
    try {
      // The attempt is the clock, whatever comes of it: a pass that fails must not be retried hourly.
      if (!o.dryRun) this.d.settings.set(tidiedAtKey(profileId), now);
      if (this.d.available) {
        let ok = false;
        try { ok = await this.d.available(); } catch { ok = false; }
        if (!ok) { this.unavailable = true; return skip("no model on this machine"); }
      }
      const snap = readSnapshot(repoPath, places.map((p) => p.folder));
      const draft = new TidyDraft(snap, now, this.d.today?.() ?? isoDay(now));
      const promoted = draft.promote();
      // The model sees the indexes as the deterministic step left them, so it can tidy those lines too.
      const indexView = [MEMORY_REPO_INDEX_FILE, ...snap.folders.map((f) => f.index.path)].map((path) => ({ path, text: draft.get(path) ?? "" }));
      const { files, whole } = shownFiles(snap, indexView.reduce((n, f) => n + f.text.length, 0));
      draft.showOnly(whole);

      let rejected: string | undefined;
      const dropped: { op: TidyOp; why: string }[] = [];
      let applied = 0;
      let raw: string | null = null;
      try { raw = await this.d.generate({ indexes: indexView, files }); }
      catch (e) { this.fail(profileId, e); rejected = "the call failed"; }
      if (this.closed) return skip("closed");
      if (raw !== null) {
        const plan = parseTidyPlan(raw);
        if (!plan.ok) rejected = plan.error;
        else for (const op of plan.operations) {
          const why = draft.apply(op);
          if (why) dropped.push({ op, why }); else applied++;
        }
      }
      if (rejected) this.d.onError?.(`[memory] tidy for profile ${profileId}: the plan was refused (${rejected}); only the deterministic step applies`);
      const writes = draft.changes();
      if (o.dryRun || writes.size === 0) return { ran: true, writes, promoted, applied, dropped, rejected, sha: null };
      let out;
      try {
        // Checked inside the store's lock, against what is there now: the model call takes a while, and
        // a fact saved during it must not be written over by a plan made from the files before it.
        out = await this.d.sink.writeBatch(owner, (repo) => {
          const moved = draft.drifted((path) => { try { return readFileSync(join(repo, path), "utf8"); } catch { return null; } });
          if (moved.length > 0) throw new MemoryMovedOn(moved);
          return writes;
        }, TIDY_COMMIT_MESSAGE, LEARNED_AUTHOR);
      } catch (e) {
        if (!(e instanceof MemoryMovedOn)) throw e;
        // Nothing of the pass is written, and the clock goes back, so the next hourly check plans again
        // from the files as they are now.
        this.d.settings.set(tidiedAtKey(profileId), lastClock);
        this.d.onError?.(`[memory] tidy for profile ${profileId}: ${e.message}; nothing written, trying again at the next check`);
        return skip(`memory changed during the pass: ${e.paths.join(", ")}`);
      }
      this.d.onTidied?.(owner);
      return { ran: true, writes, promoted, applied, dropped, rejected, sha: out.sha };
    } finally {
      this.inFlight.delete(profileId);
    }
  }

  /** The folders of the profile's spaces whose memory is in use — only spaces the store has already
   *  chosen a folder for, and of those only the ones `spaceFolderFor` still answers for. */
  private places(profileId: string): SpaceFolder[] {
    const out: SpaceFolder[] = [];
    for (const spaceId of this.d.spaceIdsOf(profileId)) {
      if (!this.d.folderRecorded(spaceId)) continue;
      const p = this.d.sink.spaceFolderFor(spaceId);
      if (p && p.owner.scope === "profile" && p.owner.id === profileId && !out.some((x) => x.folder === p.folder)) out.push(p);
    }
    return out;
  }

  private now(): number { return (this.d.now ?? Date.now)(); }

  private fail(profileId: string, e: unknown): void {
    this.d.onError?.(`[memory] tidy for profile ${profileId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
