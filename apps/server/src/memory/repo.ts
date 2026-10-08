import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  MEMORY_DOC_MAX, MEMORY_REPO_INDEX_FILE, MEMORY_REPO_INDEX_MAX, MEMORY_REPO_INITIAL_INDEX,
  amrRepoSourceLink, applyMemoryEdit, githubRepoOf, memoryEntryProblem, parseMemoryEntry, wikiLinkTarget, withIndexLink,
  type MemoryClaudeImport, type MemoryEntry, type MemoryRemoteCheck, type MemoryRepoCommit, type MemoryRepoScope, type MemoryRepoState, type MemoryRepoSync,
} from "@realm/contracts";
import type { GhRun } from "../code-review/gh";
import { RpcError } from "../store/rows";
import type { SettingsStore } from "../store/settings";
import { GIT_DIFF_FLAGS, gitCapture, gitReason, type GitResult, type GitRun } from "../workspace/git-exec";
import { planClaudeImport, type ClaudeMemorySource } from "./claude-import";
import { secretShapeIn } from "./secret-shapes";

export { secretShapeIn };

/** Whose a repo is: a profile's (the user's own, inherited by its spaces) or one space's (a team's). */
export type RepoOwner = { scope: MemoryRepoScope; id: string };
/** A repo one space's sessions use, and whose it is. */
export type ActiveRepo = { scope: MemoryRepoScope; ownerId: string; path: string };

/** Which repo an owner uses. `push` is on only with `pushRemote`: the URL the user turned sync on
 *  for, after Realm checked (or the user confirmed) that it is private. A remote changed under it
 *  afterwards is a different remote, and nothing is pushed there until it is checked in turn. */
const repoKey = (o: RepoOwner): string => `memory.repo:${o.scope}:${o.id}`;
/** Per-space opt-OUT of the profile's repo, stored as the disable so absence means inherit — the
 *  profile document's rule (`memory.profileDocDisabled`), for the same reason. */
const inheritDisabledKey = (spaceId: string): string => `memory.repoInheritDisabled:${spaceId}`;

type RepoConfig = { path: string; push: boolean; pushRemote: string | null };

/** A pull or push talks to a network: long enough for a slow one, short enough that an unreachable
 *  remote reads as offline rather than as a hang. A save never waits on it past `ensureWritable`. */
const SYNC_TIMEOUT_MS = 20_000;

/** Every write goes through a commit Realm makes itself, with an identity passed per command (never
 *  the user's global config), no signing prompt, and no hooks — an attached repo's `.git/hooks` is
 *  code Realm did not choose to run. */
const commitConfig = (name: string): string[] => [
  "-c", `user.name=${name}`, "-c", "user.email=realm@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
];

/** How much of one file `memory_read` hands back, and of one `memory_write_file`. */
const READ_MAX = 100_000;
const SEARCH_HITS_MAX = 60;
const SEARCH_FILE_MAX = 1_000_000;
const DIFF_MAX = 4_000;

const within = (child: string, parent: string): boolean => {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

/** `p` with symlinks resolved as far as it exists — `/var` and `/private/var` are one place, and a
 *  folder not made yet is judged by the folder it will be made in. */
const realish = (p: string): string => {
  let head = p;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) return p;
    tail.unshift(basename(head));
    head = up;
  }
  return join(realpathSync(head), ...tail);
};

/** Why a synced repo is refusing saves, as the row says it. */
const DIVERGED_REASON = "this repo and its remote have both changed since they last matched — Realm never merges memory, so saving is paused until you resolve it in Terminal";

/** The cheap test `activeFor` makes: a git folder with `MEMORY.md` at its top. */
const looksLikeRepo = (p: string): boolean => existsSync(join(p, ".git")) && existsSync(join(p, MEMORY_REPO_INDEX_FILE));

const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const short = (text: string, n = 60): string => (text.length <= n ? text : `${text.slice(0, n - 1).trimEnd()}…`);

export type MemoryRepoDeps = {
  home: string;
  settings: SettingsStore;
  git?: GitRun;
  /** Space → profile, the same seam MemoryService takes, and a profile's spaces (whose imported
   *  Claude memory a profile repo takes in). Unwired, no space has a profile's repo. */
  scopes?: { profileIdOf(spaceId: string): string | null; spaceIdsOf?(profileId: string): string[] };
  /** Folders a memory repo may never be inside: every space's checkouts, the agents' own config
   *  folders, Realm's install. The spec's first rule is that memory lives apart from the project. */
  forbiddenRoots?: () => string[];
  /** Where a repo goes when Realm's own folder is inside one of those roots — a home kept inside a
   *  project folder that is also a space. Unset, there is no second place and the guard's refusal
   *  stands. */
  fallbackRoot?: string;
  /** Whether the space has the memory tools. Off, the repo neither travels into a session nor takes
   *  writes there — one predicate, so the injected index can never mention tools that are not there. */
  toolsEnabled?: (spaceId: string) => boolean;
  /** The name on Realm's commits. */
  committerName?: () => Promise<string>;
  today?: () => string;
  /** `gh`, for asking GitHub whether a remote is private. Unwired, every remote is "unknown" and only
   *  the user's own confirmation turns sync on. */
  gh?: GhRun;
  /** After a pull or push settles, so the rows on screen show where the repo stands. */
  onSynced?: (owner: RepoOwner) => void;
  /** How long one fetch or push may take before it counts as offline. */
  syncTimeoutMs?: number;
};

export type MemoryEditOutcome = { changed: boolean; file: string; line: string | null; sha: string | null; diff: string };

/**
 * A profile's memory repo: an Agent Memory Repo (github.com/AgentMemoryRepo/agentmemoryrepo) that
 * agents in every engine write through Realm's memory tools.
 *
 * The spec leaves its git discipline to the model; here it is enforced in one place, because a model
 * gets it wrong and several sessions write one repo at once:
 *
 * - **Clean before writing.** `status --porcelain` must be empty or the write is refused with the
 *   paths in the way. Reading works on a dirty repo.
 * - **Staged by path.** `git add -- <the files this edit touched>`, committed with the same pathspec.
 *   Never `-A`, never `.`, never a push, never a reset of anything but the index on a failed commit.
 * - **One writer per repo.** An in-process lock serializes edits, so two sessions saving at once
 *   make two commits rather than one tangled one.
 * - **Inside the repo.** A path is resolved against the repo, `..` and `.git` are refused, and the
 *   real path is checked again so a symlink cannot lead out of it.
 * - **No secrets.** Token shapes are refused before anything is written.
 *
 * Every git call goes through `GitRun` (and so `GIT_HARDENING`), injectable for tests.
 */
export class MemoryRepoService {
  private readonly git: GitRun;
  private readonly locks = new Map<string, Promise<unknown>>();
  /** The latest sync of each repo still running or queued, by owner key — what `whenSynced` awaits. */
  private readonly syncing = new Map<string, Promise<void>>();
  /** How each repo's last pull or push went, by path: in memory, since a restart retries anyway. */
  private readonly syncNotes = new Map<string, { error: string | null; at: number | null }>();
  private name: string | null = null;

  constructor(private d: MemoryRepoDeps) {
    this.git = d.git ?? gitCapture;
  }

  /** Where a repo is made when no path is given: under Realm's home, never in a project. */
  defaultPath(owner: RepoOwner): string { return join(this.d.home, "memory", "repos", `${owner.scope}-${owner.id}`); }

  /**
   * Where a repo made without a path goes: under Realm's home, or — when that home sits inside a
   * folder a memory repo may not live in (a space's folder holds it) — the fallback root, so making a
   * repo never dead-ends on where Realm happens to be installed. An existing repo at the default stays
   * where it is. Null when neither place is allowed: the person has to choose a folder.
   */
  placeFor(owner: RepoOwner): { path: string; moved: boolean } | null {
    const first = this.resolvePath(this.defaultPath(owner));
    if (this.forbiddenBy(first) === null) return { path: first, moved: false };
    if (!this.d.fallbackRoot) return null;
    const second = this.resolvePath(join(this.d.fallbackRoot, `${owner.scope}-${owner.id}`));
    return this.forbiddenBy(second) === null ? { path: second, moved: true } : null;
  }

  config(owner: RepoOwner): RepoConfig | null {
    const v = this.d.settings.get(repoKey(owner)) as Partial<RepoConfig> | null | undefined;
    if (!v || typeof v.path !== "string") return null;
    const pushRemote = typeof v.pushRemote === "string" ? v.pushRemote : null;
    return { path: v.path, push: v.push === true && pushRemote !== null, pushRemote };
  }

  inheritedIn(spaceId: string): boolean { return this.d.settings.get(inheritDisabledKey(spaceId)) !== true; }

  setInherited(spaceId: string, enabled: boolean): void { this.d.settings.set(inheritDisabledKey(spaceId), !enabled); }

  /**
   * The repos a session in this space uses, the space's own first: a team repo the space attached,
   * then its profile's unless the space opted out — and none at all where the space has the memory
   * tools off. Only folders that still look like a memory repo count. Sync and filesystem-only,
   * because a session's context is composed synchronously; the full git check is made when the repo
   * is created or attached, and again before every write.
   */
  activeFor(spaceId: string): ActiveRepo[] {
    if (this.d.toolsEnabled && !this.d.toolsEnabled(spaceId)) return [];
    const out: ActiveRepo[] = [];
    const own = this.config({ scope: "space", id: spaceId });
    if (own && looksLikeRepo(own.path)) out.push({ scope: "space", ownerId: spaceId, path: own.path });
    const profileId = this.d.scopes?.profileIdOf(spaceId) ?? null;
    const prof = profileId === null ? null : this.config({ scope: "profile", id: profileId });
    if (prof && profileId !== null && this.inheritedIn(spaceId) && looksLikeRepo(prof.path) && !out.some((r) => r.path === prof.path)) {
      out.push({ scope: "profile", ownerId: profileId, path: prof.path });
    }
    return out;
  }

  /** Each active repo's `MEMORY.md` as one session receives it: whole up to `MEMORY_REPO_INDEX_MAX`,
   *  cut after that — the cap is per repo, so a team's long index never crowds out the user's. */
  indexesFor(spaceId: string): { scope: MemoryRepoScope; path: string; index: string; truncated: boolean }[] {
    const out: { scope: MemoryRepoScope; path: string; index: string; truncated: boolean }[] = [];
    for (const repo of this.activeFor(spaceId)) {
      let index: string;
      try { index = readFileSync(join(repo.path, MEMORY_REPO_INDEX_FILE), "utf8"); } catch { continue; }
      const truncated = index.length > MEMORY_REPO_INDEX_MAX;
      out.push({ scope: repo.scope, path: repo.path, index: truncated ? index.slice(0, MEMORY_REPO_INDEX_MAX) : index, truncated });
    }
    return out;
  }

  // ─── Create, attach, detach ───────────────────────────────────────────────────────────────────

  /** Idempotent: a missing or empty folder becomes a repo with the spec's seed `MEMORY.md`; a valid
   *  memory repo is reused as it is; anything else is refused and left untouched. */
  async create(owner: RepoOwner, path?: string): Promise<MemoryRepoState> {
    if (path === undefined && !this.placeFor(owner)) {
      const root = this.forbiddenBy(this.resolvePath(this.defaultPath(owner)))!;
      const second = this.d.fallbackRoot ? ` Its second place, ${this.d.fallbackRoot}, is inside one of them too.` : "";
      throw new RpcError("MEMORY_REPO_FORBIDDEN", `Realm keeps memory repos in its own folder, ${this.d.home}, but that folder is inside ${root}, which one of your spaces works in, and a memory repo has to stay apart from your projects.${second} Choose a folder outside your projects to keep it in.`);
    }
    const p = path === undefined ? this.placeFor(owner)!.path : this.resolvePath(path);
    this.guard(p);
    const empty = !existsSync(p) || (statSync(p).isDirectory() && readdirSync(p).length === 0);
    if (empty) {
      mkdirSync(p, { recursive: true });
      await this.must(p, ["init", "-q"]);
      writeFileSync(join(p, MEMORY_REPO_INDEX_FILE), MEMORY_REPO_INITIAL_INDEX);
      await this.must(p, ["add", "--", MEMORY_REPO_INDEX_FILE]);
      await this.must(p, [...commitConfig(await this.committer()), "commit", "-q", "-m", "Create memory repo", "--", MEMORY_REPO_INDEX_FILE]);
    } else {
      const why = await this.invalidReason(p);
      if (why) throw new RpcError("MEMORY_REPO_NOT_EMPTY", `${p} already holds something that is not a memory repo (${why}); pick an empty folder, or attach a memory repo`);
    }
    this.d.settings.set(repoKey(owner), { path: p, push: false, pushRemote: null } satisfies RepoConfig);
    return (await this.state(owner))!;
  }

  /** Use a memory repo that already exists. Writes nothing to it, and never syncs it until asked. */
  async attach(owner: RepoOwner, path: string): Promise<MemoryRepoState> {
    const p = this.resolvePath(path);
    this.guard(p);
    const why = await this.invalidReason(p);
    if (why) throw new RpcError("MEMORY_REPO_INVALID", `${p} is not a memory repo: ${why}`);
    this.d.settings.set(repoKey(owner), { path: p, push: false, pushRemote: null } satisfies RepoConfig);
    return (await this.state(owner))!;
  }

  /** Forget the owner's repo. The folder, its files and its history stay where they are. */
  detach(owner: RepoOwner): void { this.d.settings.set(repoKey(owner), null); }

  // ─── State ────────────────────────────────────────────────────────────────────────────────────

  async state(owner: RepoOwner, spaceId?: string): Promise<MemoryRepoState | null> {
    const cfg = this.config(owner);
    if (!cfg) return null;
    const exists = existsSync(cfg.path);
    const invalid = exists ? await this.invalidReason(cfg.path) : "the folder is gone";
    const note = this.syncNotes.get(this.noteKey(cfg.path));
    const base: MemoryRepoState = {
      path: cfg.path, scope: owner.scope, ownerId: owner.id, exists, valid: invalid === null, clean: false, uncommitted: [],
      head: null, lastCommitAt: null, lastCommitSubject: null, remote: null, pushEnabled: cfg.push,
      sync: cfg.push ? "queued" : "off", ahead: 0, behind: 0, syncError: note?.error ?? null, lastSyncAt: note?.at ?? null,
      indexChars: 0, inheritedHere: spaceId === undefined || owner.scope === "space" ? null : this.inheritedIn(spaceId), reason: invalid,
    };
    if (invalid !== null) return base;
    const dirty = await this.uncommitted(cfg.path);
    const last = await this.log(owner, 1);
    const remote = await this.remoteOf(cfg.path);
    const sync = await this.standing(cfg);
    let indexChars = 0;
    try { indexChars = readFileSync(join(cfg.path, MEMORY_REPO_INDEX_FILE), "utf8").length; } catch { /* checked by invalidReason */ }
    const reason = dirty.length > 0 ? `${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"} — agents save again once the repo is clean`
      : sync.sync === "diverged" ? DIVERGED_REASON
      : null;
    return {
      ...base, clean: dirty.length === 0, uncommitted: dirty.slice(0, 20),
      head: last[0]?.sha.slice(0, 7) ?? null, lastCommitAt: last[0]?.at ?? null, lastCommitSubject: last[0]?.subject ?? null,
      remote, indexChars, ...sync, reason,
    };
  }

  async log(owner: RepoOwner, limit: number): Promise<MemoryRepoCommit[]> {
    const cfg = this.config(owner);
    if (!cfg || !existsSync(cfg.path)) return [];
    const r = await this.git(cfg.path, ["log", `-n${Math.max(1, Math.min(100, limit))}`, "--format=%H%x1f%ct%x1f%s"]);
    if (r.code !== 0) return [];
    return r.stdout.split("\n").filter(Boolean).map((l) => {
      const [sha, ct, subject] = l.split("\x1f");
      return { sha: sha!, at: Number(ct) * 1000, subject: subject ?? "" };
    });
  }

  /** Who last committed a file, and when — a team record's "last changed by". The author is the
   *  name the commit was made under: the person's, or a team role's (`edit`/`writeFile`'s `author`). */
  async lastChange(repo: string, rel: string): Promise<{ author: string; at: number } | null> {
    const r = await this.git(repo, ["log", "-n1", "--format=%an%x1f%ct", "--", this.relPath(rel)]);
    const [author, ct] = r.code === 0 ? r.stdout.trim().split("\x1f") : [];
    return author && ct ? { author, at: Number(ct) * 1000 } : null;
  }

  // ─── Reading ──────────────────────────────────────────────────────────────────────────────────

  /** One file (or a folder's listing) of the repo, by path or `[[link]]`. Allowed on a dirty repo. */
  read(repo: string, link: string): string {
    // A bare folder name is a folder, not a link to `<name>.md`.
    const bare = link.trim().replace(/^\[\[|\]\]$/g, "").replace(/\/+$/, "");
    const folder = bare !== "" && !bare.split("/").includes("..") && existsSync(join(repo, bare)) && statSync(join(repo, bare)).isDirectory();
    const rel = folder ? this.checkedRel(bare) : this.relPath(link);
    const abs = this.inside(repo, rel);
    if (!existsSync(abs)) throw new RpcError("MEMORY_FILE_NOT_FOUND", `${rel} is not in the memory repo — memory_index lists what is linked, memory_search finds the rest`);
    if (statSync(abs).isDirectory()) {
      const names = readdirSync(abs, { withFileTypes: true }).filter((e) => e.name !== ".git").map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
      return names.length > 0 ? names.join("\n") : "(empty folder)";
    }
    const text = readFileSync(abs, "utf8");
    return text.length > READ_MAX ? `${text.slice(0, READ_MAX)}\n\n[cut at ${READ_MAX} characters of ${text.length}]` : text;
  }

  /** Lines of the repo's text files holding every word of `query`, case-insensitively — a walk in
   *  this process, never a shell `grep` over a string an agent wrote. */
  search(repo: string, query: string): { path: string; line: number; text: string }[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const hits: { path: string; line: number; text: string }[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (hits.length >= SEARCH_HITS_MAX) return;
        if (e.name === ".git" || e.isSymbolicLink()) continue;
        const abs = join(dir, e.name);
        if (e.isDirectory()) { walk(abs); continue; }
        if (!e.isFile() || statSync(abs).size > SEARCH_FILE_MAX) continue;
        const buf = readFileSync(abs);
        if (buf.subarray(0, 8000).includes(0)) continue;
        const rel = relative(repo, abs).split(sep).join("/");
        const relHit = words.every((w) => rel.toLowerCase().includes(w));
        buf.toString("utf8").split("\n").forEach((text, i) => {
          if (hits.length >= SEARCH_HITS_MAX) return;
          const lower = text.toLowerCase();
          if (words.every((w) => lower.includes(w)) || (relHit && i === 0)) hits.push({ path: rel, line: i + 1, text: short(text.trim(), 300) });
        });
      }
    };
    walk(repo);
    return hits;
  }

  // ─── Writing ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Add, replace or remove one entry in one Markdown file, as one commit. An `add` or `replace` is
   * stamped with the calling session and (unless the caller gave one) today's date — the model cannot
   * forget the provenance the spec recommends, or forge another session's. A new topic file is
   * linked from `MEMORY.md`'s index in the same commit.
   */
  async edit(owner: RepoOwner, o: { file?: string; op: "add" | "replace" | "remove"; entry?: string; match?: string; sessionId: string; author?: string }): Promise<MemoryEditOutcome> {
    const cfg = this.mustConfig(owner);
    const repo = cfg.path;
    const rel = this.relPath(o.file ?? MEMORY_REPO_INDEX_FILE);
    if (!rel.toLowerCase().endsWith(".md")) throw new RpcError("MEMORY_NOT_MARKDOWN", `${rel} is not a Markdown file — entries go in .md files; use memory_write_file for anything else`);
    let entry: MemoryEntry | null = null;
    if (o.op !== "remove") {
      const raw = (o.entry ?? "").trim();
      const parsed = parseMemoryEntry(/^[-*+]\s/.test(raw) ? raw : `- ${raw}`)!;
      // `source` is always the calling session's — a session cannot cite another one as the place a
      // fact was learned. `added` may be given (a fact carried over from elsewhere keeps its date).
      const { source: _given, added, ...rest } = parsed.meta;
      entry = { text: parsed.text, meta: { ...rest, source: amrRepoSourceLink(o.sessionId), added: added ?? (this.d.today ?? today)() } };
      const problem = memoryEntryProblem(entry);
      if (problem) throw new RpcError("MEMORY_ENTRY_INVALID", problem);
      const secret = secretShapeIn(raw);
      if (secret) throw new RpcError("MEMORY_SECRET", `that looks like ${secret}; memory never holds credentials — save where it is kept instead, never the value`);
    }
    if (o.op !== "add" && !(o.match ?? "").trim()) throw new RpcError("MEMORY_ENTRY_INVALID", "say which entry to change: give its text in `replaces`");
    const out = await this.locked(repo, async () => {
      await this.ensureWritable(repo, cfg);
      const abs = this.inside(repo, rel);
      const before = existsSync(abs) ? readFileSync(abs, "utf8") : null;
      if (before === null && o.op !== "add") throw new RpcError("MEMORY_FILE_NOT_FOUND", `${rel} is not in the memory repo`);
      const isIndex = rel === MEMORY_REPO_INDEX_FILE;
      const edit = o.op === "add" ? { op: "add" as const, entry: entry! }
        : o.op === "replace" ? { op: "replace" as const, match: o.match!, entry: entry! }
        : { op: "remove" as const, match: o.match! };
      const r = applyMemoryEdit(before ?? "", edit, { isIndex, title: basename(rel, ".md") });
      if (!r.ok) throw new RpcError("MEMORY_NO_MATCH", `${rel}: ${r.error}`);
      if (!r.changed) return { changed: false, file: rel, line: null, sha: null, diff: "" };
      const writes = new Map<string, string>([[rel, r.content]]);
      if (before === null && !isIndex) writes.set(MEMORY_REPO_INDEX_FILE, withIndexLink(this.readOrEmpty(repo, MEMORY_REPO_INDEX_FILE), rel));
      const verb = o.op === "add" ? "Remember" : o.op === "replace" ? "Update" : "Forget";
      const what = o.op === "remove" ? (parseMemoryEntry(o.match!)?.text ?? o.match!) : entry!.text;
      const out = await this.commitFiles(repo, writes, `${verb} ${short(what)}`, o.author);
      return { changed: true, file: rel, line: entry ? `- ${entry.text}` : null, ...out };
    });
    if (out.changed) void this.queueSync(owner);
    return out;
  }

  /** A whole non-entry file — a saved query, a script, a long note — as one commit. Never MEMORY.md,
   *  which only changes an entry at a time. */
  async writeFile(owner: RepoOwner, link: string, content: string, author?: string): Promise<MemoryEditOutcome> {
    const cfg = this.mustConfig(owner);
    const repo = cfg.path;
    const rel = this.relPath(link);
    if (rel === MEMORY_REPO_INDEX_FILE) throw new RpcError("MEMORY_INDEX_WHOLE", "MEMORY.md changes an entry at a time — use memory_save and memory_remove");
    if (content.length > MEMORY_DOC_MAX) throw new RpcError("MEMORY_FILE_TOO_LARGE", `a memory file is capped at ${MEMORY_DOC_MAX} characters`);
    const secret = secretShapeIn(content);
    if (secret) throw new RpcError("MEMORY_SECRET", `that looks like it holds ${secret}; memory never holds credentials`);
    const out = await this.locked(repo, async () => {
      await this.ensureWritable(repo, cfg);
      const abs = this.inside(repo, rel);
      const before = existsSync(abs) ? readFileSync(abs, "utf8") : null;
      if (before === content) return { changed: false, file: rel, line: null, sha: null, diff: "" };
      const writes = new Map<string, string>([[rel, content]]);
      if (before === null) writes.set(MEMORY_REPO_INDEX_FILE, withIndexLink(this.readOrEmpty(repo, MEMORY_REPO_INDEX_FILE), rel));
      const out = await this.commitFiles(repo, writes, `${before === null ? "Save" : "Update"} ${rel}`, author);
      return { changed: true, file: rel, line: null, ...out };
    });
    if (out.changed) void this.queueSync(owner);
    return out;
  }

  // ─── Claude memory import ─────────────────────────────────────────────────────────────────────

  /**
   * The Claude CLI memory Realm already copied for the owner's spaces (`<home>/memory/imported/
   * <spaceId>/<project>/`, never `~/.claude` itself), as this repo's own: each fact file copied to
   * `imported/<project>/`, and one entry per fact in `imported/<project>.md` — linked from the
   * index — with `source` naming the file it came from.
   *
   * Additive and idempotent: a file already in the repo is never overwritten, an entry whose link is
   * already there is never added again, so a second run adds nothing. `dryRun` is the row's preview:
   * the same plan, counted, nothing written.
   */
  async importClaude(owner: RepoOwner, o: { dryRun: boolean }): Promise<MemoryClaudeImport> {
    const cfg = this.mustConfig(owner);
    const repo = cfg.path;
    const sources = this.claudeSources(owner);
    const plan = () => planClaudeImport(sources, repo, (this.d.today ?? today)());
    const counts = (p: ReturnType<typeof plan>) => ({ projects: p.projects, files: p.files, entries: p.entries, skipped: p.skipped });
    if (o.dryRun) return { ...counts(plan()), sha: null };
    const out = await this.locked(repo, async () => {
      await this.ensureWritable(repo, cfg);
      const p = plan();
      if (p.writes.size === 0) return { ...counts(p), sha: null };
      const message = `Import ${p.entries} memor${p.entries === 1 ? "y" : "ies"} from Claude`;
      const { sha } = await this.commitFiles(repo, p.writes, message);
      return { ...counts(p), sha };
    });
    if (out.sha !== null) void this.queueSync(owner);
    return out;
  }

  /** The imported Claude project folders a repo takes in: one space's for a space repo, every space
   *  of the profile's for a profile repo. One folder per project name — the first space's wins. */
  private claudeSources(owner: RepoOwner): ClaudeMemorySource[] {
    const spaceIds = owner.scope === "space" ? [owner.id] : this.d.scopes?.spaceIdsOf?.(owner.id) ?? [];
    const out = new Map<string, ClaudeMemorySource>();
    for (const spaceId of spaceIds) {
      const base = join(this.d.home, "memory", "imported", spaceId);
      let names: string[] = [];
      try { names = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { continue; }
      for (const name of names) if (!out.has(name)) out.set(name, { project: name, dir: join(base, name) });
    }
    return [...out.values()];
  }

  // ─── Sync ─────────────────────────────────────────────────────────────────────────────────────

  /** Point the repo's `origin` at `url`. Sync goes off with it: Realm pushes only to a remote it was
   *  told is private, and this is a different one. */
  async setRemote(owner: RepoOwner, url: string): Promise<MemoryRepoState> {
    const cfg = this.mustConfig(owner);
    const u = url.trim();
    // A leading dash would be read as an option by `git remote`; whitespace is never part of a URL.
    if (u === "" || u.startsWith("-") || /\s/.test(u)) throw new RpcError("MEMORY_REMOTE_URL", "give the remote's URL, such as git@github.com:you/memory.git");
    await this.locked(cfg.path, async () => {
      const names = (await this.git(cfg.path, ["remote"])).stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      await this.must(cfg.path, names.includes("origin") ? ["remote", "set-url", "origin", u] : ["remote", "add", "origin", u]);
    });
    this.d.settings.set(repoKey(owner), { path: cfg.path, push: false, pushRemote: null } satisfies RepoConfig);
    this.syncNotes.delete(this.noteKey(cfg.path));
    return (await this.state(owner))!;
  }

  /**
   * Whether the repo's remote is private, as far as Realm can tell: GitHub answers for a GitHub
   * remote through `gh`; anything else, or a `gh` that cannot answer (not installed, signed out, no
   * access), is `unknown` — then only the user's own word turns sync on.
   */
  async checkRemote(owner: RepoOwner): Promise<MemoryRemoteCheck> {
    const cfg = this.mustConfig(owner);
    const remote = await this.remoteOf(cfg.path);
    if (!remote) return { remote: null, verdict: "unknown", detail: "this repo has no remote" };
    const gh = githubRepoOf(remote);
    if (!gh) return { remote, verdict: "unknown", detail: "Realm can only ask GitHub whether a repository is private" };
    if (!this.d.gh) return { remote, verdict: "unknown", detail: "GitHub's gh command is not available to Realm" };
    let r;
    try { r = await this.d.gh(["api", `repos/${gh.owner}/${gh.repo}`, "--jq", ".private"], { timeoutMs: this.d.syncTimeoutMs ?? SYNC_TIMEOUT_MS }); }
    catch (e) { return { remote, verdict: "unknown", detail: `GitHub did not answer: ${e instanceof Error ? e.message : String(e)}` }; }
    if (r.code === 127) return { remote, verdict: "unknown", detail: "GitHub's gh command is not installed" };
    const answer = r.stdout.trim();
    if (r.code === 0 && answer === "true") return { remote, verdict: "private", detail: `GitHub says ${gh.owner}/${gh.repo} is private` };
    if (r.code === 0 && answer === "false") return { remote, verdict: "public", detail: `GitHub says ${gh.owner}/${gh.repo} is public` };
    const why = `${r.stderr}\n${r.stdout}`.split("\n").map((l) => l.trim()).find(Boolean) ?? `gh exited ${r.code}`;
    return { remote, verdict: "unknown", detail: `gh could not look up ${gh.owner}/${gh.repo}: ${why}` };
  }

  /**
   * Turn sync on or off. On needs a remote, refuses one GitHub says is public whatever the user
   * says, and refuses one Realm cannot check unless the user confirmed it is private. The first pull
   * and push run in the background: the network never holds up the switch.
   */
  async setSync(owner: RepoOwner, enabled: boolean, confirmPrivate = false): Promise<MemoryRepoState> {
    const cfg = this.mustConfig(owner);
    if (!enabled) {
      this.d.settings.set(repoKey(owner), { path: cfg.path, push: false, pushRemote: null } satisfies RepoConfig);
      this.syncNotes.delete(this.noteKey(cfg.path));
      return (await this.state(owner))!;
    }
    const check = await this.checkRemote(owner);
    if (check.remote === null) throw new RpcError("MEMORY_REMOTE_NONE", "this memory repo has no remote to sync with — add one first");
    if (check.verdict === "public") throw new RpcError("MEMORY_REMOTE_PUBLIC", `${check.detail}; memory only ever syncs to a private remote`);
    if (check.verdict === "unknown" && !confirmPrivate) {
      throw new RpcError("MEMORY_REMOTE_UNCONFIRMED", `${check.detail}, so confirm the remote is private before Realm pushes memory to it`);
    }
    this.d.settings.set(repoKey(owner), { path: cfg.path, push: true, pushRemote: check.remote } satisfies RepoConfig);
    void this.queueSync(owner);
    return (await this.state(owner))!;
  }

  /**
   * Pull (fast-forward only) and push, behind any save in flight. Never rejects: a failure is the
   * repo's `syncError`, and the commits wait for the next save or boot. Resolves once it has run.
   */
  queueSync(owner: RepoOwner): Promise<void> {
    const cfg = this.config(owner);
    if (!cfg?.push) return Promise.resolve();
    const run = this.locked(cfg.path, () => this.syncNow(cfg))
      .catch((e) => { this.note(cfg.path, e instanceof Error ? e.message : String(e)); })
      .then(() => { this.d.onSynced?.(owner); });
    this.syncing.set(repoKey(owner), run);
    void run.finally(() => { if (this.syncing.get(repoKey(owner)) === run) this.syncing.delete(repoKey(owner)); });
    return run;
  }

  /** The sync a save started, if it is still running — for a caller (a test, the row's Retry) that
   *  wants the outcome rather than the save's own answer. */
  async whenSynced(owner: RepoOwner): Promise<void> { await this.syncing.get(repoKey(owner)); }

  /** "Retry now": sync, then say where the repo stands. */
  async sync(owner: RepoOwner): Promise<MemoryRepoState> {
    this.mustConfig(owner);
    await this.queueSync(owner);
    return (await this.state(owner))!;
  }

  /** One pull and, if there is anything to send, one push. The caller holds the repo's lock. */
  private async syncNow(cfg: RepoConfig): Promise<void> {
    if ((await this.invalidReason(cfg.path)) !== null) return;
    const pulled = await this.pull(cfg);
    if (pulled !== "ok") return;
    await this.push(cfg);
  }

  /**
   * Fetch, then fast-forward if the remote is ahead and the tree is clean. Never a merge, a rebase
   * or a reset: when both sides have moved, the answer is "diverged" and the user merges by hand.
   * "offline" is any fetch that did not go through; the error is noted on the repo.
   */
  private async pull(cfg: RepoConfig): Promise<"ok" | "diverged" | "offline"> {
    const t = await this.target(cfg);
    if (typeof t === "string") { this.note(cfg.path, t); return "offline"; }
    // The usual remote-tracking refspec, spelled out so a remote without one still fetches. Its `+`
    // moves only Realm's copy of the remote's branch; nothing here ever rewrites the remote.
    const fetched = await this.network(cfg.path, ["fetch", "-q", "--no-tags", t.remote, `+refs/heads/${t.branch}:refs/remotes/${t.remote}/${t.branch}`]);
    if (fetched.code !== 0 && !/couldn't find remote ref/i.test(fetched.stderr)) { this.note(cfg.path, gitReason(fetched)); return "offline"; }
    const c = await this.counts(cfg.path, t);
    if (c.behind > 0 && c.ahead > 0) { this.note(cfg.path, null); return "diverged"; }
    if (c.behind > 0 && (await this.uncommitted(cfg.path)).length === 0) {
      const ff = await this.git(cfg.path, [...commitConfig(await this.committer()), "merge", "-q", "--ff-only", t.tracking]);
      if (ff.code !== 0) { this.note(cfg.path, gitReason(ff)); return "offline"; }
    }
    this.note(cfg.path, null);
    return "ok";
  }

  /** Push what the remote lacks — never forced. A refusal means someone pushed first: fetch again,
   *  and push once more only if this side is still just ahead. */
  private async push(cfg: RepoConfig): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await this.target(cfg);
      if (typeof t === "string") { this.note(cfg.path, t); return; }
      if ((await this.counts(cfg.path, t)).ahead === 0) { this.note(cfg.path, null); return; }
      const pushed = await this.network(cfg.path, ["-c", "core.hooksPath=/dev/null", "push", "-q", t.remote, `HEAD:refs/heads/${t.branch}`]);
      if (pushed.code === 0) {
        // Realm's copy of the remote branch follows a push only where the remote has a fetch refspec.
        await this.git(cfg.path, ["update-ref", t.tracking, "HEAD"]);
        this.note(cfg.path, null);
        return;
      }
      if (!/\[rejected\]|non-fast-forward|fetch first/i.test(pushed.stderr)) { this.note(cfg.path, gitReason(pushed)); return; }
      if ((await this.pull(cfg)) !== "ok") return;
    }
  }

  /** Where a repo stands against its remote, from what is already on disk — no network. */
  private async standing(cfg: RepoConfig): Promise<{ sync: MemoryRepoSync; ahead: number; behind: number }> {
    if (!cfg.push) return { sync: "off", ahead: 0, behind: 0 };
    const t = await this.target(cfg);
    if (typeof t === "string") return { sync: "queued", ahead: 0, behind: 0 };
    const c = await this.counts(cfg.path, t);
    return { sync: c.behind > 0 && c.ahead > 0 ? "diverged" : c.ahead > 0 ? "queued" : "synced", ...c };
  }

  /** The remote sync uses — the one whose URL the user turned sync on for — and the branch. A string
   *  says why there is none: the remote was removed or changed since, or HEAD is detached. */
  private async target(cfg: RepoConfig): Promise<{ remote: string; branch: string; tracking: string } | string> {
    const urls = await this.git(cfg.path, ["config", "--get-regexp", "^remote\\..*\\.url$"]);
    const remote = urls.stdout.split("\n").map((l) => /^remote\.(.+)\.url (.*)$/.exec(l)).find((m) => m && m[2]!.trim() === cfg.pushRemote)?.[1];
    if (!remote) return `the remote changed since sync was turned on — turn it on again for ${cfg.pushRemote}`;
    const head = await this.git(cfg.path, ["symbolic-ref", "-q", "--short", "HEAD"]);
    const branch = head.stdout.trim();
    if (head.code !== 0 || branch === "") return "the repo is not on a branch";
    return { remote, branch, tracking: `refs/remotes/${remote}/${branch}` };
  }

  /** Commits only this side has, and only the remote's side has, as of the last fetch. A remote
   *  branch never fetched (an empty remote) lacks every local commit. */
  private async counts(repo: string, t: { tracking: string }): Promise<{ ahead: number; behind: number }> {
    const has = await this.git(repo, ["rev-parse", "-q", "--verify", `${t.tracking}^{commit}`]);
    if (has.code !== 0) {
      const all = await this.git(repo, ["rev-list", "--count", "HEAD"]);
      return { ahead: Number(all.stdout.trim()) || 0, behind: 0 };
    }
    const lr = await this.git(repo, ["rev-list", "--left-right", "--count", `${t.tracking}...HEAD`]);
    const [behind, ahead] = lr.stdout.trim().split(/\s+/).map(Number);
    return { ahead: ahead || 0, behind: behind || 0 };
  }

  /** A git call that crosses the network: its own timeout, and a timeout or spawn failure is an
   *  answer ("offline"), not a throw. */
  private async network(cwd: string, args: string[]): Promise<GitResult> {
    try { return await this.git(cwd, args, { timeoutMs: this.d.syncTimeoutMs ?? SYNC_TIMEOUT_MS }); }
    catch (e) { return { code: 1, stdout: "", stderr: `the remote did not answer (${e instanceof Error ? e.message : String(e)})` }; }
  }

  private note(path: string, error: string | null): void {
    this.syncNotes.set(this.noteKey(path), { error, at: Date.now() });
  }

  private noteKey(path: string): string { return existsSync(path) ? realpathSync(path) : path; }

  // ─── Internals ────────────────────────────────────────────────────────────────────────────────

  private resolvePath(p: string): string {
    const expanded = p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
    if (!isAbsolute(expanded)) throw new RpcError("MEMORY_REPO_PATH", "give the memory repo's full path");
    return resolve(expanded);
  }

  /** The spec's rule that memory is never inside a project, plus the folders Realm never writes. */
  private guard(p: string): void {
    const root = this.forbiddenBy(p);
    if (root !== null) throw new RpcError("MEMORY_REPO_FORBIDDEN", `A memory repo cannot live inside ${root}: it is one of your projects or an agent's own folder, and memory stays apart from both. Choose a folder outside it.`);
  }

  /** The forbidden folder `p` is inside, or null. */
  private forbiddenBy(p: string): string | null {
    const real = realish(p);
    for (const root of this.d.forbiddenRoots?.() ?? []) if (within(real, realish(root))) return root;
    return null;
  }

  /** Why `p` is not a memory repo, or null: the spec's own test — its top level is `p` itself, and
   *  `MEMORY.md` sits there. */
  private async invalidReason(p: string): Promise<string | null> {
    if (!existsSync(p) || !statSync(p).isDirectory()) return "the folder is gone";
    const r = await this.git(p, ["rev-parse", "--show-toplevel"]);
    if (r.code !== 0) return "it is not a git repository";
    if (realish(r.stdout.trim()) !== realish(p)) return `it is inside the git repository at ${r.stdout.trim()}, not one of its own`;
    if (!existsSync(join(p, MEMORY_REPO_INDEX_FILE))) return "it has no MEMORY.md at its top";
    return null;
  }

  private async uncommitted(repo: string): Promise<string[]> {
    const r = await this.git(repo, ["status", "--porcelain", "--untracked-files=all"]);
    if (r.code !== 0) throw new RpcError("MEMORY_REPO_GIT", gitReason(r));
    return r.stdout.split("\n").filter(Boolean).map((l) => l.slice(3));
  }

  private async remoteOf(repo: string): Promise<string | null> {
    const names = await this.git(repo, ["remote"]);
    const first = names.stdout.split("\n").map((s) => s.trim()).find((s) => s === "origin") ?? names.stdout.split("\n").map((s) => s.trim()).find(Boolean);
    if (!first) return null;
    const url = await this.git(repo, ["remote", "get-url", first]);
    return url.code === 0 ? url.stdout.trim() : null;
  }

  /**
   * Clean, and — where sync is on — level with the remote: a fast-forward pull first, so a save lands
   * on top of what other machines saved. Offline is no reason to refuse a save (the push waits); a
   * remote that has moved while this side has too is, because only a person should merge memory.
   */
  private async ensureWritable(repo: string, cfg?: RepoConfig): Promise<void> {
    const why = await this.invalidReason(repo);
    if (why) throw new RpcError("MEMORY_REPO_INVALID", `${repo} is not a memory repo: ${why}`);
    const dirty = await this.uncommitted(repo);
    if (dirty.length > 0) {
      throw new RpcError("MEMORY_REPO_DIRTY",
        `the memory repo at ${repo} has uncommitted changes, so nothing was saved (the spec's rule: clean before writing). Tell the user these need committing or removing first: ${dirty.slice(0, 10).join(", ")}${dirty.length > 10 ? ` and ${dirty.length - 10} more` : ""}`);
    }
    if (!cfg?.push) return;
    const pulled = await this.pull(cfg);
    if (pulled === "diverged" || (pulled === "offline" && (await this.standing(cfg)).sync === "diverged")) {
      throw new RpcError("MEMORY_REPO_DIVERGED",
        `nothing was saved: the memory repo at ${repo} and its remote have both changed since they last matched, and Realm never merges memory. Tell the user to resolve it in Terminal (cd into the repo, git pull, merge, commit); saving resumes after that.`);
    }
  }

  /** A repo-relative path from a path or a `[[link]]`, refused when it could reach outside. */
  private relPath(link: string): string {
    const target = wikiLinkTarget(link);
    if (target === null) throw new RpcError("MEMORY_PATH", "give a path inside the memory repo, such as projects/payments or [[projects/payments]]");
    return this.checkedRel(target);
  }

  private checkedRel(target: string): string {
    const parts = target.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
    if (isAbsolute(target) || parts.some((s) => s === ".." || s.toLowerCase() === ".git")) {
      throw new RpcError("MEMORY_PATH", `${target} is outside the memory repo — paths start at its root and stay in it`);
    }
    return parts.join("/");
  }

  /** The absolute path of `rel`, after checking that what is ON DISK there resolves inside the repo:
   *  a symlink in the repo pointing at `~/.ssh` is refused, for reads and writes alike. */
  private inside(repo: string, rel: string): string {
    const abs = join(repo, rel);
    const root = realpathSync(repo);
    // `realish` resolves every link on the way, so a symlink anywhere in the path is judged by where it lands.
    if (!within(realish(abs), root)) {
      throw new RpcError("MEMORY_PATH", `${rel} leads outside the memory repo`);
    }
    return abs;
  }

  private readOrEmpty(repo: string, rel: string): string {
    try { return readFileSync(join(repo, rel), "utf8"); } catch { return ""; }
  }

  /** Write the files, stage exactly them, commit exactly them. A failed commit puts every file back
   *  as it was and unstages them — the tree is left as clean as the write found it. */
  private async commitFiles(repo: string, writes: Map<string, string>, message: string, author?: string): Promise<{ sha: string; diff: string }> {
    const before = new Map<string, string | null>();
    for (const rel of writes.keys()) before.set(rel, existsSync(join(repo, rel)) ? readFileSync(join(repo, rel), "utf8") : null);
    const paths = [...writes.keys()];
    try {
      for (const [rel, content] of writes) {
        mkdirSync(dirname(join(repo, rel)), { recursive: true });
        writeFileSync(join(repo, rel), content);
      }
      await this.must(repo, ["add", "--", ...paths]);
      await this.must(repo, [...commitConfig(author?.trim() || await this.committer()), "commit", "-q", "-m", message, "--", ...paths]);
    } catch (e) {
      for (const [rel, content] of before) {
        if (content === null) rmSync(join(repo, rel), { force: true });
        else writeFileSync(join(repo, rel), content);
      }
      await this.git(repo, ["reset", "-q", "--", ...paths]);
      throw e;
    }
    const sha = (await this.git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    const show = await this.git(repo, ["show", ...GIT_DIFF_FLAGS, "--format=", "HEAD"], { maxBytes: 64 * 1024 });
    return { sha, diff: short(show.stdout, DIFF_MAX) };
  }

  private mustConfig(owner: RepoOwner): RepoConfig {
    const cfg = this.config(owner);
    if (!cfg) throw new RpcError("MEMORY_REPO_NONE", owner.scope === "space" ? "this space has no memory repo of its own" : "this profile has no memory repo");
    return cfg;
  }

  private async must(cwd: string, args: string[]): Promise<void> {
    const r = await this.git(cwd, args);
    if (r.code !== 0) throw new RpcError("MEMORY_REPO_GIT", `git ${args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? ""} failed: ${gitReason(r)}`);
  }

  private async committer(): Promise<string> {
    if (this.name === null) this.name = (await this.d.committerName?.())?.trim() || "Realm";
    return this.name;
  }

  /** Serialize writes per repo. The chain survives a failed write, so one refusal never wedges the
   *  next save. Keyed by the real path, so two spellings of one folder share one lock. */
  private async locked<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const key = existsSync(repo) ? realpathSync(repo) : repo;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    try { return await run; } finally { if (this.locks.get(key) === tail) this.locks.delete(key); }
  }
}
