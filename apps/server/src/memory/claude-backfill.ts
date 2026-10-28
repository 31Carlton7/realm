import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { CLAUDE_PROJECT_LEFT_OUT, MEMORY_DOC_MAX, MEMORY_REPO_INDEX_FILE, withIndexLink, type MemoryClaudeBackfill } from "@realm/contracts";
import { decodeClaudeProjectSlug } from "../import/sources";
import { RpcError } from "../store/rows";
import type { SettingsStore } from "../store/settings";
import { claudeIndexTarget, mergeClaudeIndex } from "./claude-facts";
import { SPACES_DIR, type MemoryRepoService, type RepoOwner } from "./repo";
import { secretShapeIn } from "./secret-shapes";

/**
 * Claude's own memory, brought into Realm's: every `~/.claude/projects/<project>/memory` folder is
 * matched to the space that works in that project, and its files are copied — as they are, in the
 * same format — into that space's folder of the profile's repo. `~/.claude` is only ever read.
 *
 * It runs at boot and then every few minutes, so memory a Claude run outside Realm keeps still flows
 * in. A small manifest per profile (`memory.claudeBackfill:<profileId>`: repo path → the file it was
 * copied from and that file's hash) is what makes it safe to repeat:
 *
 * - a file new to the repo is copied;
 * - a copy nobody has touched since, whose source then changed in `~/.claude`, is updated;
 * - a copy changed in the repo since (Claude in Realm edits these files too) is never overwritten,
 *   and neither is a file of that name another project put there — both are named in `skipped`;
 * - a copy removed from the repo stays removed until its source changes again.
 *
 * A project that no space works in, or that several do, is reported, never guessed at, until someone
 * places it by hand (`memory.claudeProjectSpace:<project>`: a space, or left out) — a choice that wins
 * over matching, ties included. One in a temporary folder (a test run, a scratch copy) is passed over.
 *
 * What stays out is listed once per version of it (`memory.claudeBackfillShown:<profileId>`): once the
 * Memory page has shown a file as left out, later runs leave it off the list until it changes.
 */

/** Claude's name for a project's folder: every character but a letter or a digit made a dash — the
 *  CLI's own `sanitizePath`. A name past 200 characters it cuts there and ends with a hash. */
export function claudeProjectName(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

const NAME_MAX = 200;
/** What two names are compared by: a name the CLI cut is known only up to the cut. */
const nameKey = (name: string): string => (name.length > NAME_MAX ? name.slice(0, NAME_MAX) : name);

/**
 * The folder Claude keys a session's memory by: the git root above `cwd` — for a linked worktree, the
 * main checkout's — or `cwd` itself outside git. The CLI's own rule, so a space that works in a
 * worktree finds the memory Claude kept for the repository.
 */
export function claudeProjectRoot(cwd: string): string {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) return mainCheckout(dir, dotGit);
    if (dirname(dir) === dir) return resolve(cwd);
  }
}

/** The main checkout a linked worktree belongs to — read the way git links them (`.git` names the
 *  worktree's gitdir, whose `commondir` names the repository's) — or `root` for anything else. */
function mainCheckout(root: string, dotGit: string): string {
  try {
    if (statSync(dotGit).isDirectory()) return root;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (!m) return root;
    const gitDir = resolve(root, m[1]!.trim());
    const common = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
    if (dirname(gitDir) !== join(common, "worktrees")) return root;
    return basename(common) === ".git" ? dirname(common) : common;
  } catch { return root; }
}

export type BackfillSpace = { id: string; profileId: string; name: string; paths: readonly string[] };
export type ProjectMatch = { spaceId: string } | { reason: string };

const realOr = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

/**
 * Which space each Claude project belongs to. A project is named for a folder a space works in — any
 * of its environments (its own folder, a checkout, a worktree) — or for that folder's git root, which
 * is what Claude names it by inside a repository. The folder itself is the stronger claim: a space
 * working in `realm` owns `realm`'s memory over a space that only has a worktree of it. Two spaces
 * with the same claim is no answer.
 */
export function matchClaudeProjects(names: readonly string[], spaces: readonly BackfillSpace[]): Map<string, ProjectMatch> {
  const exact = new Map<string, Set<string>>();
  const viaRoot = new Map<string, Set<string>>();
  const claim = (m: Map<string, Set<string>>, path: string, spaceId: string): void => {
    const k = nameKey(claudeProjectName(path));
    if (!m.has(k)) m.set(k, new Set());
    m.get(k)!.add(spaceId);
  };
  for (const sp of spaces) {
    for (const p of sp.paths) {
      if (!p || !isAbsolute(p)) continue;
      const real = realOr(p);
      claim(exact, p, sp.id);
      claim(exact, real, sp.id);
      claim(viaRoot, claudeProjectRoot(real), sp.id);
    }
  }
  const nameOf = (id: string): string => spaces.find((s) => s.id === id)?.name ?? id;
  const out = new Map<string, ProjectMatch>();
  for (const name of names) {
    const ids = exact.get(nameKey(name)) ?? viaRoot.get(nameKey(name));
    if (!ids) out.set(name, { reason: "no space works in that folder" });
    else if (ids.size > 1) out.set(name, { reason: `${[...ids].map(nameOf).join(" and ")} ${ids.size === 2 ? "both" : "all"} work there` });
    else out.set(name, { spaceId: [...ids][0]! });
  }
  return out;
}

/** The temporary folders of this Mac, where a Claude project is a test run or a scratch copy. */
export const TEMPORARY_ROOTS: readonly string[] = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders", tmpdir()];

const isUnder = (name: string, roots: readonly string[]): boolean =>
  roots.some((r) => { const k = claudeProjectName(r.replace(/\/+$/, "")); return name === k || name.startsWith(`${k}-`); });

const readOr = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A Claude memory folder's fact files: its own `.md` files, never its index, never a link. */
function factFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md") && e.name !== MEMORY_REPO_INDEX_FILE)
      .map((e) => e.name).sort();
  } catch { return []; }
}

/** One project's memory folder as one hash: each fact file's name and contents. */
function folderHash(dir: string): string {
  return sha(factFiles(dir).map((n) => `${n}\0${sha(readOr(join(dir, n)) ?? "")}`).join("\n"));
}

/** The folder a project's name stands for, where it still exists — what the Memory page calls it. */
function projectPath(project: string): string | null {
  return decodeClaudeProjectSlug(project, (dir) => { try { return readdirSync(dir); } catch { return []; } });
}

/** The manifest of one profile's copies: repo path → the file it was copied from, and its hash then. */
type Manifest = Record<string, { source: string; hash: string }>;
const manifestKey = (profileId: string): string => `memory.claudeBackfill:${profileId}`;
/** A person's own answer for one Claude project: the space its memory goes to, or left out. */
export const claudeProjectChoiceKey = (project: string): string => `memory.claudeProjectSpace:${project}`;
/** Each file the Memory page has shown as left out, and the version of it that was shown. */
const shownKey = (profileId: string): string => `memory.claudeBackfillShown:${profileId}`;

/** A file (or a whole project) left where it is, why, and which version of it. */
type Skip = MemoryClaudeBackfill["skipped"][number] & { hash: string };

/**
 * What bringing these projects into their space folders writes to the repo at `repo`, worked out from
 * disk (the rules are on the module). Projects are taken in order, each seeing what the ones before it
 * planned, so two projects that land in one folder never overwrite each other.
 */
export function planBackfill(repo: string, projectsDir: string, folders: ReadonlyMap<string, readonly string[]>, before: Manifest) {
  const writes = new Map<string, string | null>();
  const manifest: Manifest = { ...before };
  const skipped: Skip[] = [];
  let imported = 0;
  let updated = 0;
  const now = (rel: string): string | null => (writes.has(rel) ? writes.get(rel)! : readOr(join(repo, rel)));
  const rootBefore = now(MEMORY_REPO_INDEX_FILE) ?? "";
  let root = rootBefore;
  for (const [folder, projects] of folders) {
    const at = `${SPACES_DIR}/${folder}`;
    const indexRel = `${at}/${MEMORY_REPO_INDEX_FILE}`;
    for (const project of projects) {
      const src = join(projectsDir, project, "memory");
      for (const name of factFiles(src)) {
        const from = join(src, name);
        const rel = `${at}/${name}`;
        const text = readOr(from);
        if (text === null) continue;
        const hash = sha(text);
        const secret = secretShapeIn(text);
        if (secret) { skipped.push({ file: from, reason: `it looks like it holds ${secret}, and memory never holds credentials`, hash }); continue; }
        if (text.length > MEMORY_DOC_MAX) { skipped.push({ file: from, reason: `it is longer than ${MEMORY_DOC_MAX} characters`, hash }); continue; }
        const known = manifest[rel];
        const here = now(rel);
        if (here === null) {
          if (known?.source === from && known.hash === hash) continue; // removed from the repo since: it stays removed
          writes.set(rel, text);
          imported++;
        } else if (here === text) {
          // Already there, word for word — from an earlier run, or written by Claude in Realm.
        } else if (known?.source === from && sha(here) === known.hash) {
          writes.set(rel, text);
          updated++;
        } else {
          skipped.push({ file: from, reason: known && known.source !== from ? `${rel} holds another Claude project's file of that name` : `${rel} has changed in the repo since it was copied`, hash });
          continue;
        }
        manifest[rel] = { source: from, hash };
      }
      // The project's index lines join the folder's, for the files the folder now holds.
      const index = readOr(join(src, MEMORY_REPO_INDEX_FILE));
      if (index === null) continue;
      const lines = index.split("\n").filter((l) => { const t = claudeIndexTarget(l); return t === null || (!t.includes("/") && now(`${at}/${t}`) !== null); });
      const merged = mergeClaudeIndex(now(indexRel) ?? "", lines.join("\n"));
      if (merged !== (now(indexRel) ?? "")) writes.set(indexRel, merged);
    }
    if (now(indexRel) !== null) root = withIndexLink(root, indexRel);
  }
  if (writes.size > 0 && root !== rootBefore) writes.set(MEMORY_REPO_INDEX_FILE, root);
  const total = Object.keys(manifest).filter((rel) => now(rel) !== null).length;
  return { writes, manifest, skipped, imported, updated, total };
}

/** How often memory Claude keeps outside Realm is looked for: a few hundred small files read and
 *  hashed, nothing written unless something changed. */
export const CLAUDE_BACKFILL_EVERY_MS = 5 * 60_000;

export const NEVER_RUN: MemoryClaudeBackfill = { imported: 0, updated: 0, total: 0, unmatched: [], chosen: [], skipped: [], error: null, sha: null, at: null };

const biggestFirst = (a: { project: string; files: number }, b: { project: string; files: number }): number => b.files - a.files || a.project.localeCompare(b.project);

export class ClaudeMemoryBackfill {
  private last = new Map<string, MemoryClaudeBackfill>();
  /** The last run's list of what stayed out, by profile, with the version of each — what `seen` records. */
  private listed = new Map<string, Skip[]>();
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private d: {
    /** The Claude config folder whose `projects/` is read: `~/.claude`, or `CLAUDE_CONFIG_DIR`. */
    claudeDir: string;
    repos: Pick<MemoryRepoService, "spaceFolderFor" | "writeBatch" | "config">;
    settings: SettingsStore;
    /** Every space, with every folder it works in. */
    spaces: () => BackfillSpace[];
    profileIds: () => string[];
    /** Folders whose projects are passed over. A test names its own; the app takes this Mac's. */
    temporaryRoots?: readonly string[];
    /** After a run committed to a profile's repo, so the rows on screen show it. */
    onChanged?: (owner: RepoOwner) => void;
  }) {}

  /** What the last run did for one profile; before the first, that nothing has run. */
  result(profileId: string): MemoryClaudeBackfill { return this.last.get(profileId) ?? NEVER_RUN; }

  /**
   * The last run's result as the Memory page shows it. What it lists as left out counts as shown from
   * here: the next run lists a file again only once it has changed. Until a page has asked, nothing is
   * taken off the list, so a file left out overnight is still there in the morning.
   */
  seen(profileId: string): MemoryClaudeBackfill {
    const listed = this.listed.get(profileId) ?? [];
    const shown = this.shownOf(profileId);
    if (listed.some((s) => shown[s.file] !== s.hash)) {
      for (const s of listed) shown[s.file] = s.hash;
      this.d.settings.set(shownKey(profileId), shown);
    }
    return this.result(profileId);
  }

  /**
   * Place one Claude project by hand: its memory goes into this space of the profile, or — `"skip"` —
   * stays in Claude's folder. Then a run, so the choice is honoured now, and what it did.
   */
  async choose(profileId: string, project: string, into: string): Promise<MemoryClaudeBackfill> {
    if (into !== CLAUDE_PROJECT_LEFT_OUT && this.d.spaces().find((s) => s.id === into)?.profileId !== profileId) {
      throw new RpcError("NOT_FOUND", "that space is not one of this profile's");
    }
    this.d.settings.set(claudeProjectChoiceKey(project), into);
    await this.runAgain();
    return this.seen(profileId);
  }

  /** Run once any run already going has finished: that one was planned before whatever the caller just
   *  changed — a project placed, a file written in Claude's folder. */
  async runAgain(): Promise<void> {
    await this.running;
    await this.run();
  }

  private shownOf(profileId: string): Record<string, string> {
    const v = this.d.settings.get(shownKey(profileId));
    return v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, string>) } : {};
  }

  /** Run now — or, while a run is going, wait for that one. Never throws: a failure is the result's `error`. */
  run(): Promise<void> {
    this.running ??= this.runOnce()
      .catch((e) => { console.error(`[memory] Claude's memory not brought in: ${e instanceof Error ? e.message : String(e)}`); })
      .finally(() => { this.running = null; });
    return this.running;
  }

  /** Run every `everyMs` from now on. Unref'd: a sweep never keeps a finished process alive. */
  start(everyMs: number): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => { void this.run(); }, everyMs);
    this.timer.unref?.();
  }

  /** For good: a boot still on its way to `start` does not start it after the app has closed. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async runOnce(): Promise<void> {
    const projectsDir = join(this.d.claudeDir, "projects");
    let names: string[] = [];
    try { names = readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { /* no Claude here */ }
    names = names.filter((n) => existsSync(join(projectsDir, n, "memory", MEMORY_REPO_INDEX_FILE)) || factFiles(join(projectsDir, n, "memory")).length > 0);
    const memoryOf = (n: string): string => join(projectsDir, n, "memory");
    const temporary = this.d.temporaryRoots ?? TEMPORARY_ROOTS;
    const passedOver: Skip[] = names.filter((n) => isUnder(n, temporary))
      .map((n) => ({ file: join(projectsDir, n), reason: "it is a temporary folder, not a project", hash: folderHash(memoryOf(n)) }));
    const live = names.filter((n) => !isUnder(n, temporary));
    const spaces = this.d.spaces();
    // A person's choice comes first, ties included; matching answers only for the rest.
    const choices = new Map<string, string>();
    for (const n of live) {
      const c = this.d.settings.get(claudeProjectChoiceKey(n));
      if (typeof c === "string") choices.set(n, c);
    }
    const matches = matchClaudeProjects(live.filter((n) => !choices.has(n)), spaces);
    const project = (n: string) => ({ project: n, path: projectPath(n), files: factFiles(memoryOf(n)).length });
    const unmatched: MemoryClaudeBackfill["unmatched"] = [];
    const chosen: (MemoryClaudeBackfill["chosen"][number] & { profileId: string | null })[] = [];
    const placed = new Map<string, string>();
    for (const n of live) {
      const choice = choices.get(n);
      if (choice === CLAUDE_PROJECT_LEFT_OUT) { chosen.push({ ...project(n), spaceId: null, profileId: null }); continue; }
      if (choice !== undefined) {
        const sp = spaces.find((s) => s.id === choice);
        // A space since deleted is no answer: the project is asked about again, never guessed at.
        if (!sp) { unmatched.push({ ...project(n), reason: "the space it was brought into is gone" }); continue; }
        chosen.push({ ...project(n), spaceId: sp.id, profileId: sp.profileId });
        placed.set(n, sp.id);
        continue;
      }
      const m = matches.get(n)!;
      if ("reason" in m) unmatched.push({ ...project(n), reason: m.reason });
      else placed.set(n, m.spaceId);
    }
    unmatched.sort(biggestFirst);
    chosen.sort(biggestFirst);
    const byProfile = new Map<string, { owner: RepoOwner; folders: Map<string, string[]> }>();
    /** By profile: projects whose space keeps no memory in Realm (no repo, or turned off there). */
    const offIn = new Map<string, Skip[]>();
    for (const [n, spaceId] of placed) {
      const at = this.d.repos.spaceFolderFor(spaceId);
      if (!at) {
        const sp = spaces.find((s) => s.id === spaceId)!;
        offIn.set(sp.profileId, [...(offIn.get(sp.profileId) ?? []), { file: memoryOf(n), reason: `${sp.name} keeps no memory in Realm`, hash: folderHash(memoryOf(n)) }]);
        continue;
      }
      const group = byProfile.get(at.owner.id) ?? { owner: at.owner, folders: new Map<string, string[]>() };
      group.folders.set(at.folder, [...(group.folders.get(at.folder) ?? []), n]);
      byProfile.set(at.owner.id, group);
    }
    const at = Date.now();
    for (const profileId of this.d.profileIds()) {
      const manifest = (this.d.settings.get(manifestKey(profileId)) ?? {}) as Manifest;
      const group = byProfile.get(profileId);
      const repo = this.d.repos.config({ scope: "profile", id: profileId })?.path;
      const kept = Object.keys(manifest).filter((rel) => repo !== undefined && existsSync(join(repo, rel))).length;
      const mine = chosen.filter((c) => c.profileId === null || c.profileId === profileId).map(({ profileId: _, ...c }) => c);
      const base: MemoryClaudeBackfill = { ...NEVER_RUN, total: kept, unmatched, chosen: mine, at };
      const outside = [...passedOver, ...(offIn.get(profileId) ?? [])];
      if (!group) { this.settle(profileId, base, outside, true); continue; }
      // Planned inside the repo's lock, from the files as they are then; the manifest moves only once
      // the commit has landed.
      const planned: { plan?: ReturnType<typeof planBackfill> } = {};
      try {
        const out = await this.d.repos.writeBatch(group.owner, (dir) => (planned.plan = planBackfill(dir, projectsDir, group.folders, manifest)).writes, "Bring in memory Claude kept outside Realm");
        const p = planned.plan!;
        this.d.settings.set(manifestKey(profileId), p.manifest);
        this.settle(profileId, { ...base, imported: p.imported, updated: p.updated, total: p.total, sha: out.sha }, [...outside, ...p.skipped], true);
        if (out.changed) this.d.onChanged?.(group.owner);
      } catch (e) {
        // What the plan found left out still stands; with no plan, what is not known is not forgotten.
        this.settle(profileId, { ...base, error: e instanceof Error ? e.message : String(e) }, [...outside, ...(planned.plan?.skipped ?? [])], planned.plan !== undefined);
      }
    }
  }

  /**
   * Record one profile's run. Of what stayed out, only what the Memory page has not shown yet — or has
   * changed since — is listed. `whole` says the run saw everything that is left out now, so a file
   * no longer among it is forgotten, and is shown again if it is ever left out again.
   */
  private settle(profileId: string, result: MemoryClaudeBackfill, left: Skip[], whole: boolean): void {
    const shown = this.shownOf(profileId);
    if (whole) {
      const now = new Set(left.map((s) => s.file));
      const kept = Object.fromEntries(Object.entries(shown).filter(([file]) => now.has(file)));
      if (Object.keys(kept).length !== Object.keys(shown).length) this.d.settings.set(shownKey(profileId), kept);
    }
    const fresh = left.filter((s) => shown[s.file] !== s.hash);
    this.listed.set(profileId, fresh);
    this.last.set(profileId, { ...result, skipped: fresh.map(({ file, reason }) => ({ file, reason })) });
  }
}
