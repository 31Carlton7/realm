import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  IMPORTED_SPACE_NAME, SkillIdSchema, withImportedMemory,
  type ImportMatch, type ImportMemoryCandidate, type ImportOutcome, type ImportResult, type ImportScan,
  type ImportSessionCandidate, type ImportSkillCandidate, type ImportSourceReport, type Space,
} from "@realm/contracts";
import type { Db } from "../db/database";
import type { RpcServer } from "../rpc/server";
import type { EnvironmentsStore } from "../store/environments";
import type { ItemsStore } from "../store/items";
import type { ProfilesStore } from "../store/profiles";
import type { ProjectsStore } from "../store/projects";
import type { SessionEventsStore, SessionsStore } from "../store/sessions";
import type { SettingsStore } from "../store/settings";
import type { SpacesStore } from "../store/spaces";
import type { MemoryService } from "../memory/service";
import { skillsRoot } from "../skills/service";
import { RpcError } from "../store/rows";
import {
  cursorMetaCwd, findClaudeMemories, findClaudeSessions, findCodexSessions, findCursorSessions, findSkills,
  loadTranscript, readText, type FoundSession,
} from "./discover";
import { matchSpace, type MatchWorld } from "./match";
import { defaultRoots, isScratchPath, type ImportRoots } from "./sources";

/**
 * Every source key already imported.
 *
 * `providerSessionId` is the natural dedup key and is used first, but it is NOT sufficient: a
 * transcript whose recorded directory is gone imports as an archive with NO provider link (so it
 * cannot advertise a resume it could not perform), which leaves nothing on the row tying it back to
 * its file. Without this set those sessions re-imported on every single run — 31 duplicates on the
 * second run against real data, before anyone had done anything wrong.
 *
 * A settings row rather than a column: it needs no migration, it is exactly the same shape as
 * `skills.bundledInstalled` ("things installed once, by id"), and it survives the row being deleted —
 * which is right for install-once, and is why re-importing something deliberately removed takes
 * clearing this key rather than happening by accident on the next scan.
 */
const IMPORTED_KEYS = "import.sources";

/** What `apply` was asked to bring in. Every entry is a `key` from a scan plus, for the two kinds
 *  that live in a space, the space the user settled on — so a preview the user re-targeted is
 *  honoured, and `apply` never re-runs the matcher behind their back. */
export type ImportSelection = {
  sessions: { key: string; spaceId: string | null; profileId: string | null }[];
  memories: { key: string; spaceId: string | null; profileId: string | null }[];
  skills: string[];
};

export type ImportDeps = {
  home: string;
  /** For the per-session transaction below — the stores share this connection. */
  db: Db;
  rpc: RpcServer;
  spaces: SpacesStore;
  profiles: ProfilesStore;
  projects: ProjectsStore;
  environments: EnvironmentsStore;
  sessions: SessionsStore;
  events: SessionEventsStore;
  items: ItemsStore;
  settings: SettingsStore;
  memory: MemoryService;
  /** Overridable as a unit so tests read a fixture tree — never the developer's own `~/.claude`. */
  roots?: ImportRoots;
  now?: () => number;
};

/**
 * Bringing the agent CLIs' own history into Realm — transcripts, memory folders and skills.
 *
 * Two operations, and the split between them is the feature's safety property: **`scan` writes
 * nothing.** It opens files, matches candidates to spaces and answers; no space, session, environment
 * or file is created by looking. Only `apply` writes, and only for the keys it is handed. So the list
 * the user approves is exactly the work that happens.
 *
 * The other invariant, stated in the contract and enforced here: the agents' directories are opened
 * read-only and never written, moved or cleaned up. Everything produced lands in Realm's database or
 * under Realm's own home.
 */
export class ImportService {
  private readonly roots: ImportRoots;
  private readonly now: () => number;

  constructor(private d: ImportDeps) {
    this.roots = d.roots ?? defaultRoots();
    this.now = d.now ?? Date.now;
  }

  // ---------------------------------------------------------------- scan

  scan(): ImportScan {
    const now = this.now();
    const world = this.world();
    // Every provider session id already in the database, read ONCE: the dedup question is asked of
    // every one of ~1100 candidates, and a query each would be 1100 round trips to answer something
    // a single set answers exactly.
    const known = this.d.sessions.providerSessionIds();
    const done = this.importedKeys();

    const found: FoundSession[] = [
      ...findClaudeSessions(this.roots), ...findCodexSessions(this.roots), ...findCursorSessions(this.roots),
    ];
    const sessions: ImportSessionCandidate[] = [];
    const unreadable = { claude: 0, codex: 0, cursor: 0 };
    for (const f of found) {
      // Cursor keeps its cwd in a sibling `meta.json`, so a scratch session can be recognised without
      // opening its SQLite store at all. Worth the special case: 1048 of those directories exist on
      // this machine and all but 21 are empty shells.
      if (f.source === "cursor") {
        const quick = cursorMetaCwd(f.path);
        if (quick && isScratchPath(quick) && !existsSync(join(f.path, "store.db"))) continue;
      }
      const t = loadTranscript(f, now);
      if (!t) { unreadable[f.source]++; continue; }
      sessions.push({
        key: f.key, source: f.source, agentKind: f.agentKind,
        providerSessionId: t.providerSessionId, path: f.path, cwd: t.cwd,
        cwdExists: t.cwd !== "" && existsSync(t.cwd),
        title: t.title || "Untitled session",
        messages: t.messages, startedAt: t.startedAt, updatedAt: t.updatedAt,
        fromRealm: t.fromRealm, scratch: isScratchPath(t.cwd),
        imported: known.has(t.providerSessionId) || done.has(f.key),
        duplicate: false, // decided below, once every candidate sharing an id can be compared
        match: matchSpace(t.cwd, world),
      });
    }
    markDuplicates(sessions);
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);

    const memories: ImportMemoryCandidate[] = findClaudeMemories(this.roots).map((m) => {
      // A slug whose directory no longer exists cannot be decoded against the filesystem, but it
      // still SPELLS the original path. Matching on the dashes-as-slashes reading recovers the
      // profile ("…-Desktop-Home-School-SP26-EE-451" is School's, whatever became of the folder),
      // and it is safe for the space rules too: those compare resolved real paths, which a
      // reconstructed one cannot collide with, leaving only the directory-name rule — which is
      // reading the same words a human would.
      const match = matchSpace(m.cwd || m.slug.replace(/-/g, "/"), world);
      return {
        key: m.key, source: "claude" as const, path: m.path, cwd: m.cwd, files: m.files, bytes: m.bytes,
        imported: match.spaceId !== null && existsSync(this.memoryDestination(match.spaceId, m.path)),
        match,
      };
    });
    memories.sort((a, b) => b.files - a.files);

    // One row per skill ID, not per copy: the same `frontend-design` sits in four agents' folders,
    // and offering it four times would be four ways to import one directory. Origins are collected so
    // the row can say where it was seen; the first is what gets copied.
    const byId = new Map<string, ImportSkillCandidate>();
    for (const s of findSkills(this.roots)) {
      if (!SkillIdSchema.safeParse(s.id).success) continue;
      const existing = byId.get(s.id);
      if (existing) { if (!existing.origins.includes(s.origin)) existing.origins.push(s.origin); continue; }
      byId.set(s.id, {
        key: s.id, origins: [s.origin], path: s.path, name: s.name, description: s.description,
        imported: existsSync(join(skillsRoot(this.d.home), s.id)),
      });
    }
    const skills = [...byId.values()].sort((a, b) => a.key.localeCompare(b.key));

    const report = (source: "claude" | "codex" | "cursor", root: string, note: string | null): ImportSourceReport => {
      const mine = sessions.filter((s) => s.source === source);
      const dupes = mine.filter((s) => s.duplicate).length;
      return {
        source, root, available: existsSync(root),
        // The count that matters is CONVERSATIONS, not files — a source whose 241 files are 71
        // threads should say 71, with the difference named rather than left to be discovered.
        sessions: mine.length - dupes,
        unreadable: unreadable[source],
        note: dupes === 0 ? note
          : [note, `${mine.length} files hold ${mine.length - dupes} conversations: this CLI rewrites a whole thread each time it is resumed, so only the fullest copy of each is offered.`]
            .filter((x): x is string => Boolean(x)).join(" "),
      };
    };
    return {
      sessions, memories, skills,
      sources: [
        report("claude", this.roots.claude, null),
        report("codex", this.roots.codex, null),
        report("cursor", this.roots.cursor,
          "Cursor stores no per-message timestamps, so imported Cursor turns are stamped in order from the session's creation time."),
      ],
    };
  }

  /** The live rows the matcher reasons over. Rebuilt per scan — a cached world would answer with
   *  spaces the user deleted while the preview was open. */
  private world(): MatchWorld {
    const spaces = this.d.spaces.listAll();
    return {
      spaces, profiles: this.d.profiles.list(),
      environments: spaces.flatMap((s) => this.d.environments.list(s.id)),
      projects: spaces.flatMap((s) => this.d.projects.list(s.id)),
    };
  }

  // --------------------------------------------------------------- apply

  apply(selection: ImportSelection): ImportResult {
    const now = this.now();
    const created: ImportResult["spacesCreated"] = [];
    // Catch-all spaces are made at most once per profile per apply, and reused within it — two
    // homeless sessions from the same profile must land in one "Imported" space, not two.
    const fallbacks = new Map<string, Space>();
    const ensureFallback = (profileId: string): Space => {
      const cached = fallbacks.get(profileId);
      if (cached) return cached;
      const existing = this.d.spaces.list(profileId).find((s) => s.name === IMPORTED_SPACE_NAME);
      const space = existing ?? this.d.spaces.create({ profileId, name: IMPORTED_SPACE_NAME, icon: "folder" });
      if (!existing) created.push({ id: space.id, profileId, name: space.name });
      fallbacks.set(profileId, space);
      return space;
    };
    const target = (spaceId: string | null, profileId: string | null): Space => {
      if (spaceId) {
        const s = this.d.spaces.get(spaceId);
        if (!s) throw new RpcError("NOT_FOUND", `space ${spaceId} no longer exists`);
        return s;
      }
      if (profileId) {
        if (!this.d.profiles.get(profileId)) throw new RpcError("NOT_FOUND", `profile ${profileId} no longer exists`);
        return ensureFallback(profileId);
      }
      throw new RpcError("IMPORT_NO_TARGET", "this candidate has no space and no profile to fall back to");
    };

    // The on-disk index, built ONCE for the whole apply. Re-deriving it per selected session would
    // re-`readdir` every project directory for each of ~150 imports, which is the same answer many
    // hundreds of times over.
    const index = new Map(this.allFound().map((f) => [f.key, f]));
    // The dedup set is likewise read once and then MAINTAINED as rows are written: two scans of the
    // same conversation (Claude keeps one file per session, but a resumed Codex thread can be logged
    // twice) must not both import, and re-reading the column per session would be the slow way to
    // learn the same thing.
    const known = this.d.sessions.providerSessionIds();
    const done = this.importedKeys();
    const touchedSpaces = new Set<string>(), touchedMemory = new Set<string>();

    const sessions = selection.sessions.map((sel) => this.importSession(sel, { target, index, known, done, touchedSpaces, now }));
    // One write, after the batch: the set is a single settings blob, and rewriting it per session
    // would be hundreds of JSON round trips to record the same list.
    if (sessions.some((o) => o.state === "imported")) this.d.settings.set(IMPORTED_KEYS, [...done].sort());
    const memories = selection.memories.map((sel) => this.importMemory(sel, target, touchedMemory));
    const skills = selection.skills.map((id) => this.importSkill(id));

    // Broadcast once, after everything: an import of 150 sessions must not make the renderer refetch
    // its item list 150 times.
    if (created.length > 0) this.d.rpc.broadcast("spaces.changed", {});
    for (const spaceId of touchedSpaces) this.d.rpc.broadcast("items.changed", { spaceId });
    for (const spaceId of touchedMemory) this.d.rpc.broadcast("memory.changed", { spaceId });
    // A new library entry changes every space's skill list, because an imported skill is written with
    // no scope and so reaches all of them.
    if (skills.some((s) => s.state === "imported")) for (const s of this.d.spaces.listAll()) this.d.rpc.broadcast("skills.changed", { spaceId: s.id });

    return { sessions, memories, skills, spacesCreated: created };
  }

  /**
   * One transcript → one session row, its sidebar item, and its events.
   *
   * `providerSessionId` is carried over ONLY when the recorded cwd still exists, which is what makes
   * an imported session resumable: `SessionService.ensureLive` passes it to the adapter as `resume`,
   * so the next message continues the real CLI conversation with its own context intact. Where the
   * directory is gone, resuming would fail inside the CLI with nothing Realm could say about it, so
   * the link is left off and the session imports as history — the difference the preview showed as
   * `cwdExists`.
   */
  private importSession(
    sel: { key: string; spaceId: string | null; profileId: string | null },
    ctx: { target: (s: string | null, p: string | null) => Space; index: Map<string, FoundSession>; known: Set<string>; done: Set<string>; touchedSpaces: Set<string>; now: number },
  ): ImportOutcome {
    const out = (state: ImportOutcome["state"], detail: string, refId: string | null = null): ImportOutcome => ({ key: sel.key, state, refId, detail });
    // The key must have come from a scan. A client-invented path finds nothing here and is refused,
    // which is what keeps `apply` from being a "read any file on this machine into my database" call.
    const found = ctx.index.get(sel.key);
    if (!found) return out("skipped", "no longer on disk");
    if (ctx.done.has(sel.key)) return out("skipped", "already imported");
    const t = loadTranscript(found, ctx.now);
    if (!t) return out("skipped", "could not be read");
    if (ctx.known.has(t.providerSessionId)) return out("skipped", "already imported");

    let space: Space;
    try { space = ctx.target(sel.spaceId, sel.profileId); }
    catch (e) { return out("failed", e instanceof Error ? e.message : String(e)); }

    // The session runs where it ran. A cwd that still exists becomes a `checkout` environment — the
    // kind that says "the user's own directory, which Realm did not create and will never remove" —
    // and a cwd that is gone falls back to the space's primary, because a session must have an
    // environment and pointing one at a missing directory would break every read of its `cwd`.
    const cwdExists = t.cwd !== "" && existsSync(t.cwd);
    const env = cwdExists ? this.d.environments.ensureAt(space.id, t.cwd, "checkout") : this.d.environments.ensurePrimary(space.id);
    const title = clipTitle(t.title || "Imported session");

    // One session, one transaction. A transcript is thousands of INSERTs, and a failure partway
    // through an untransacted run would leave a session row advertising a conversation it only has
    // half of — worse than not importing it, because nothing afterwards can tell the difference. It
    // also keeps the write off the FTS index and the events table as one commit rather than
    // thousands, which matters because this can run against a database a live Realm is using.
    let session: { id: string };
    this.d.db.exec("BEGIN");
    try {
      session = this.d.sessions.create({
        spaceId: space.id, projectId: null, agentKind: found.agentKind,
        model: t.model, effort: null, permissionMode: "default", environmentId: env.id, title,
        // Recorded as the row's origin so the Tasks lens and any later audit can tell an imported
        // conversation from one that happened in Realm. No parent session: nothing dispatched it.
        dispatchedBy: { kind: "import", sessionId: null },
      });
      let lastSeq = 0;
      for (const ev of t.events) lastSeq = this.d.events.append(session.id, ev).seq;
      this.d.sessions.update({
        id: session.id, lastEventSeq: lastSeq,
        providerSessionId: cwdExists ? t.providerSessionId : null,
        // `ended` rather than `idle`: the conversation is over as far as Realm is concerned. A resume
        // is still one message away — `ensureLive` does not consult status — but the sidebar must not
        // present a year-old transcript as a session sitting there waiting.
        status: "ended",
      });
      this.d.items.create({ spaceId: space.id, kind: "session", title, refId: session.id });
      this.d.db.exec("COMMIT");
    } catch (e) {
      this.d.db.exec("ROLLBACK");
      return out("failed", e instanceof Error ? e.message : String(e));
    }
    ctx.known.add(t.providerSessionId);
    ctx.done.add(sel.key);
    ctx.touchedSpaces.add(space.id);
    return out("imported", cwdExists ? `${t.messages} messages, resumable` : `${t.messages} messages, archive (cwd is gone)`, session.id);
  }

  /**
   * One project memory folder → files under Realm's home, plus an index in the space's memory doc.
   *
   * Not inlined: the largest of these folders is 712k characters against a `MEMORY_DOC_MAX` of 100k,
   * so a doc-shaped import would silently drop most of it. Copying the facts and injecting the index
   * keeps all of it AND mirrors how the source system works — the index rides in context, a fact is
   * read when it is relevant.
   */
  private importMemory(sel: { key: string; spaceId: string | null; profileId: string | null }, target: (s: string | null, p: string | null) => Space, touched: Set<string>): ImportOutcome {
    const out = (state: ImportOutcome["state"], detail: string, refId: string | null = null): ImportOutcome => ({ key: sel.key, state, refId, detail });
    if (!existsSync(sel.key)) return out("skipped", "no longer on disk");
    let space: Space;
    try { space = target(sel.spaceId, sel.profileId); }
    catch (e) { return out("failed", e instanceof Error ? e.message : String(e)); }

    const dest = this.memoryDestination(space.id, sel.key);
    let copied = 0;
    try {
      mkdirSync(dest, { recursive: true });
      for (const f of readdirSync(sel.key, { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith(".md")) continue;
        cpSync(join(sel.key, f.name), join(dest, f.name));
        copied++;
      }
    } catch (e) { return out("failed", e instanceof Error ? e.message : String(e)); }

    const block = this.memoryIndexBlock(space.id);
    const doc = withImportedMemory(this.d.memory.readDoc(space.id), block);
    this.d.memory.set(space.id, doc);
    touched.add(space.id);
    return out("imported", `${copied} files copied to ${dest}`, space.id);
  }

  /** `<realmHome>/memory/imported/<spaceId>/<source folder name>` — under Realm's own home, beside
   *  the space memory documents, and namespaced by the SOURCE project so two projects importing into
   *  one space cannot overwrite each other's facts. */
  private memoryDestination(spaceId: string, sourceDir: string): string {
    // The source directory is always `<slug>/memory`, so its own basename says nothing; the slug
    // above it is the identity.
    const slug = basename(sourceDir) === "memory" ? basename(join(sourceDir, "..")) : basename(sourceDir);
    return join(this.d.home, "memory", "imported", spaceId, slug.replace(/^-+/, "") || "project");
  }

  /**
   * The fenced block written into a space's memory document: every imported folder's own `MEMORY.md`
   * index, with each link rewritten to the absolute path of the copied file.
   *
   * Rebuilt from what is on disk rather than appended to, so importing a second project into the same
   * space produces one block listing both — and re-importing produces the same block rather than a
   * duplicate (`withImportedMemory` replaces between the markers).
   */
  private memoryIndexBlock(spaceId: string): string {
    const base = join(this.d.home, "memory", "imported", spaceId);
    const parts: string[] = [];
    let projects: string[] = [];
    try { projects = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); }
    catch { return ""; }
    for (const p of projects) {
      const dir = join(base, p);
      const index = readText(join(dir, "MEMORY.md"));
      const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md").sort();
      if (files.length === 0) continue;
      // Relative markdown links in the source index (`[Title](fact.md)`) are rewritten to absolute
      // paths of the copies. Without that the agent reads a link it cannot open — the file it names
      // is in the CLI's folder, which is exactly the place this import does not want anyone reaching.
      const body = index
        ? index.replace(/\]\(\.?\/?([A-Za-z0-9._-]+\.md)\)/g, (m, f: string) => (files.includes(f) ? `](${join(dir, f)})` : m))
        : files.map((f) => `- [${f.replace(/\.md$/, "")}](${join(dir, f)})`).join("\n");
      parts.push(`### ${p}\n\n${body.trim()}`);
    }
    if (parts.length === 0) return "";
    return [
      "## Imported memory",
      "",
      "Facts carried over from the Claude CLI's per-project memory. Each entry below is a file on disk —",
      "read the ones relevant to what you are doing. These files are Realm's copies; editing them here",
      "does not change the originals.",
      "",
      parts.join("\n\n"),
    ].join("\n");
  }

  /**
   * One skill directory → a copy in Realm's library.
   *
   * A copy, not a symlink, and never an overwrite — the same posture `SkillsService.installBundled`
   * takes for the same reason: `~/Realm/skills` is the user's folder, and a skill that changes under
   * them when some other tool updates its own copy is not theirs. No scope entry is written, which
   * leaves the skill a pre-scoping library entry visible in every space — the honest translation of
   * "installed for my user".
   */
  private importSkill(id: string): ImportOutcome {
    const out = (state: ImportOutcome["state"], detail: string, refId: string | null = null): ImportOutcome => ({ key: id, state, refId, detail });
    if (!SkillIdSchema.safeParse(id).success) return out("failed", "not a valid skill directory name");
    const source = findSkills(this.roots).find((s) => s.id === id);
    if (!source) return out("skipped", "no longer on disk");
    const dest = join(skillsRoot(this.d.home), id);
    if (existsSync(dest)) return out("skipped", "already in the library");
    try {
      mkdirSync(skillsRoot(this.d.home), { recursive: true });
      cpSync(join(source.path, ".."), dest, { recursive: true });
    } catch (e) { return out("failed", e instanceof Error ? e.message : String(e)); }
    return out("imported", `copied from ${source.origin}`, id);
  }

  /** The source keys a previous import already brought in — see `IMPORTED_KEYS`. Entries validated
   *  individually so one corrupt element costs that entry, not the whole set its memory. */
  private importedKeys(): Set<string> {
    const v = this.d.settings.get(IMPORTED_KEYS);
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  }

  /** Every transcript on disk, from all three sources — the one listing both `scan` and `apply`
   *  build their view from, so a key offered by one is resolvable by the other. */
  private allFound(): FoundSession[] {
    return [...findClaudeSessions(this.roots), ...findCodexSessions(this.roots), ...findCursorSessions(this.roots)];
  }
}

/**
 * Mark every candidate that another candidate is a fuller copy of — see `duplicate` in the contract
 * for why this exists at all.
 *
 * The winner is the one with the MOST spoken turns, because these are replays of one growing thread
 * and the longest replay is the most complete record of it. Not the newest: a resumed thread can
 * branch, and this corpus has a 13-turn copy written before a 9-turn one. Ties break on `updatedAt`
 * and then on `key`, so a re-scan of an unchanged disk always chooses the same winner — otherwise the
 * preview would silently re-target itself between a scan and an apply.
 *
 * Only candidates sharing a `providerSessionId` are compared. Two genuinely different conversations
 * cannot collide here: the id is the CLI's own, and this is the same key the database dedups on.
 */
function markDuplicates(sessions: ImportSessionCandidate[]): void {
  const byId = new Map<string, ImportSessionCandidate[]>();
  for (const s of sessions) {
    if (!s.providerSessionId) continue;
    const group = byId.get(s.providerSessionId);
    if (group) group.push(s); else byId.set(s.providerSessionId, [s]);
  }
  for (const group of byId.values()) {
    if (group.length === 1) continue;
    const winner = group.reduce((best, s) =>
      s.messages !== best.messages ? (s.messages > best.messages ? s : best)
        : s.updatedAt !== best.updatedAt ? (s.updatedAt > best.updatedAt ? s : best)
          : (s.key < best.key ? s : best));
    for (const s of group) if (s !== winner) s.duplicate = true;
  }
}

/** Titles are clipped to the same `TITLE_MAX` every native session obeys, so an imported row cannot
 *  stretch the sidebar in a way no other row can. Duplicated as a constant rather than imported from
 *  SessionService to keep this module free of that dependency cycle. */
const TITLE_MAX = 40;
function clipTitle(text: string): string {
  const one = text.trim().split("\n").find((l) => l.trim())?.replace(/\s+/g, " ").trim() ?? "";
  if (one === "") return "Imported session";
  return one.length > TITLE_MAX ? `${one.slice(0, TITLE_MAX - 1).trimEnd()}…` : one;
}
