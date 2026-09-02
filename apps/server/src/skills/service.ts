import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_SKILL_SUPPORT, ItemScopeSchema, LEGACY_SPACE_SCOPE, SkillIdSchema, type AgentKind, type ItemScope, type Skill } from "@realm/contracts";
import { scan, scanRoots as buildScanRoots, tildify, type Discovered, type ScanRoot } from "./discovery";
import type { SkillsInjection } from "@realm/adapters";
import { RpcError } from "../store/rows";
import type { SettingsStore } from "../store/settings";
import { parseFrontmatter } from "./frontmatter";

/** Realm's library lives here and nowhere else. Nothing is ever written into `~/.claude`, `~/.codex`,
 *  `~/.cursor` or `~/.agents` — see `SkillsInjection` for the two per-invocation routes that replace it. */
export const skillsRoot = (home: string): string => join(home, "skills");
/** Staged plugin/roots per space. Dot-prefixed and under Realm's own home: derived, disposable, and
 *  deliberately not somewhere the user is invited to edit. */
const stageRoot = (home: string): string => join(home, ".cache", "skills");

/** Per-space disabled ids. Storing the *disabled* set rather than the enabled one is what makes a skill
 *  the user drops into the folder work immediately instead of being invisible until they find a toggle. */
const disabledKey = (spaceId: string): string => `skills.disabled:${spaceId}`;

/**
 * Per-space ENABLED ids, for skills discovered outside `~/Realm/skills`.
 *
 * The opposite polarity to `disabledKey`, and deliberately so. A skill the user drops into Realm's own
 * folder is a skill they chose, so default-on is right there. The directories Realm now also reads hold
 * 134 skills on this machine that the user installed for other tools and at other times; default-on
 * there would not be a library, it would be every agent in every space started with 134 descriptions it
 * never asked for. Opt-in is the only polarity that scales with someone else's folder.
 */
const externalEnabledKey = (spaceId: string): string => `skills.external:${spaceId}`;

/** User-added directories to scan, absolute paths, global (not per-space): the question "where do I
 *  keep skills" is about the machine, not about one space. */
const SCAN_ROOTS_KEY = "skills.scanRoots";
/** Bundled ids already installed once. Install-once, not sync: a bundled skill the user deletes stays
 *  deleted, and a bundled skill the user edits is never overwritten from under them. */
const INSTALLED_KEY = "skills.bundledInstalled";

/**
 * W2: one map of skill id → defining scope (`ItemScope`). An id with no entry is a pre-scoping skill
 * (`LEGACY_SPACE_SCOPE`: space-level, visible everywhere) — which is the whole migration: nothing is
 * written on upgrade, so no space's effective set can move. Entries appear only when the user promotes
 * or demotes, and they outlive the directory the same way the disabled set does (a skill deleted from
 * disk and put back keeps its scope).
 */
const SCOPES_KEY = "skills.scope";

/**
 * Where the repo-shipped skills (`<repo>/skills/<id>/SKILL.md`) are on this machine.
 *
 * `REALM_BUNDLED_SKILLS` wins, and is how tests point this at a fixture instead of the real repo. Then the
 * workspace root, found by walking up from this module — which works identically for `src/` under vitest
 * and for the single bundled `apps/server/dist/main.js`. Then the Electron resources directory, for a
 * packaged build. Null when there are none, which is not an error.
 */
export function bundledSkillsDir(): string | null {
  const override = process.env.REALM_BUNDLED_SKILLS;
  if (override) return existsSync(override) ? override : null;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, "skills"))) return join(dir, "skills");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const packaged = resources ? join(resources, "skills") : null;
  return packaged && existsSync(packaged) ? packaged : null;
}

const readIds = (settings: SettingsStore, key: string): string[] => {
  const v = settings.get(key);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
};

/**
 * Realm's skills library: what is on disk, which of it each space wants, and the staged directory that
 * carries it to an agent.
 *
 * Everything here reads the filesystem on demand. The library is a folder the user is expected to open in
 * Finder and edit, so a cache would only ever be a way to be wrong about it.
 */
export class SkillsService {
  readonly root: string;
  constructor(private d: {
    home: string; settings: SettingsStore; bundledDir?: string | null;
    /** W2: space → profile, for scope resolution. Optional like `McpService.scopes`: unwired, every
     *  space reads as profile-less, profile-scoped skills apply nowhere, pre-scoping skills everywhere. */
    scopes?: { profileIdOf(spaceId: string): string | null };
    /** The space's own folder, for project-level skill roots (`<folder>/.claude/skills` and friends).
     *  Optional on the same terms as `scopes`: unwired, no space contributes project roots and the
     *  scan is the user- and plugin-level one. Never a reason to fail a list. */
    spaces?: { folderPathOf(spaceId: string): string | null };
  }) {
    this.root = skillsRoot(d.home);
  }

  /**
   * Parsed `SKILL.md` metadata, keyed by path and validated by the file's own mtime and size.
   *
   * The expensive half of a list is READING a hundred `SKILL.md` files, not enumerating the ten
   * directories they sit in — and `SearchService.skills` calls `list` once per space in a loop. So the
   * enumeration is redone every single call (which is what keeps a folder dropped into Finder visible
   * immediately, the property the library has always had) and only the parse is memoized, against a
   * stamp that changes whenever the file does.
   *
   * This is the narrow version of the cache the original comment on this class refused: it cannot be
   * wrong about which skills exist, only about the contents of a file that has not been touched.
   */
  private parsed = new Map<string, { mtimeMs: number; size: number; meta: ParsedMeta }>();

  /** Drop the memo. Called whenever Realm changes what a scan would find. */
  invalidate(): void { this.parsed.clear(); }

  /** Every skill directory visible to this space, deduped by realpath. Enumerated fresh each call. */
  private discover(spaceId: string | null): { entries: Discovered[]; roots: ScanRoot[] } {
    const projectDir = spaceId ? this.d.spaces?.folderPathOf(spaceId) ?? null : null;
    const roots = buildScanRoots({ home: this.d.home, libraryRoot: this.root, projectDir, extraRoots: this.scanRoots() });
    return { entries: scan(roots), roots };
  }

  /** The user's extra scan directories, absolute paths only, in the order they were added. */
  scanRoots(): string[] {
    return readIds(this.d.settings, SCAN_ROOTS_KEY);
  }

  /** Add a directory to scan. Idempotent, and it refuses a relative path — that would resolve against
   *  the server's cwd, which is not a directory the user picked or can see. */
  addScanRoot(path: string): void {
    if (!isAbsolute(path)) throw new RpcError("BAD_REQUEST", "a scan directory must be an absolute path");
    if (!existsSync(path)) throw new RpcError("NOT_FOUND", `no directory at ${path}`);
    const current = this.scanRoots();
    if (!current.includes(path)) this.d.settings.set(SCAN_ROOTS_KEY, [...current, path]);
    this.invalidate();
  }

  /** Remove a scan directory. The skills under it vanish from every list; their enabled entries are
   *  left alone, so re-adding the directory restores exactly what was on. */
  removeScanRoot(path: string): void {
    this.d.settings.set(SCAN_ROOTS_KEY, this.scanRoots().filter((p) => p !== path));
    this.invalidate();
  }

  /** The stored scope map, entries validated individually — one corrupt entry costs that entry its
   *  scope (back to pre-scoping), not the whole library its model. */
  private scopeMap(): Record<string, ItemScope> {
    const v = this.d.settings.get(SCOPES_KEY);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, ItemScope> = {};
    for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
      const parsed = ItemScopeSchema.safeParse(raw);
      if (parsed.success) out[id] = parsed.data;
    }
    return out;
  }

  scopeOf(id: string): ItemScope { return this.scopeMap()[id] ?? LEGACY_SPACE_SCOPE; }

  /** Same reach question `McpService.appliesTo` answers, same liveness degrade — see that doc comment.
   *  (For a skill the degrade means "back to default ON everywhere", which is W1's stated polarity
   *  cost: the price of being wrong about a skill is a paragraph of text, and the alternative is a
   *  library directory no panel can ever show again.) */
  private appliesTo(scope: ItemScope, spaceId: string): boolean {
    if (scope.kind === "profile") { const pid = this.d.scopes?.profileIdOf(spaceId) ?? null; return pid !== null && pid === scope.profileId; }
    return scope.spaceId === null || scope.spaceId === spaceId || (this.d.scopes?.profileIdOf(scope.spaceId) ?? null) === null;
  }

  /**
   * Promote: move a skill's defining scope to `spaceId`'s profile. Effective-set neutral for every
   * space of that profile at the moment it runs, with NOTHING to rewrite: skills keep ONE per-space
   * disabled-set for both scopes (unlike MCP's two keys), because the polarity of an inherited item
   * (default ON minus disables) IS the polarity space-scoped skills already had — so a skill disabled
   * in a space stays disabled there across promote AND demote, by construction. Spaces of other
   * profiles stop seeing a pre-scoping skill; that reach change is what promotion means.
   */
  promote(spaceId: string, id: string): void {
    const scope = this.scopeOf(id);
    if (scope.kind === "profile") throw new RpcError("SCOPE_MISMATCH", `skill "${id}" is already profile-scoped`);
    if (!this.appliesTo(scope, spaceId)) throw new RpcError("SCOPE_MISMATCH", `skill "${id}" is not defined in this space`);
    if (!this.discover(spaceId).entries.some((e) => e.id === id)) throw new RpcError("NOT_FOUND", `skill "${id}" is not in this space's skills`);
    const profileId = this.d.scopes?.profileIdOf(spaceId) ?? null;
    if (!profileId) throw new RpcError("SCOPE_MISMATCH", `space ${spaceId} has no profile to promote into`);
    this.setScope(id, { kind: "profile", profileId });
  }

  /** Demote: pin a profile-scoped skill to `spaceId` alone (must be a space of its profile). The shared
   *  disabled-set preserves this space's enable state untouched; siblings stop seeing it. */
  demote(spaceId: string, id: string): void {
    const scope = this.scopeOf(id);
    if (scope.kind !== "profile") throw new RpcError("SCOPE_MISMATCH", `skill "${id}" is not profile-scoped`);
    if ((this.d.scopes?.profileIdOf(spaceId) ?? null) !== scope.profileId) throw new RpcError("SCOPE_MISMATCH", `space ${spaceId} is not in skill "${id}"'s profile`);
    this.setScope(id, { kind: "space", spaceId });
  }

  private setScope(id: string, scope: ItemScope): void {
    this.d.settings.set(SCOPES_KEY, { ...this.scopeMap(), [id]: scope });
  }

  /**
   * Copy repo-shipped skills into the library, once each, on boot.
   *
   * Copies rather than symlinks on purpose: `~/Realm/skills` is the user's folder, and a skill they can
   * open but not edit — or that changes under them on the next `git pull` — is not theirs. Returns the ids
   * it installed, which is only ever non-empty on the first boot after a skill ships.
   */
  installBundled(): string[] {
    const src = this.d.bundledDir === undefined ? bundledSkillsDir() : this.d.bundledDir;
    if (!src) return [];
    const already = new Set(readIds(this.d.settings, INSTALLED_KEY));
    const installed: string[] = [];
    try { mkdirSync(this.root, { recursive: true }); } catch { return []; }
    for (const id of this.dirNames(src)) {
      if (already.has(id)) continue;
      const from = join(src, id);
      if (!existsSync(join(from, "SKILL.md"))) continue;
      already.add(id); // recorded even if the copy fails, so a broken bundle is not retried every boot
      const to = join(this.root, id);
      if (existsSync(to)) continue;
      try { cpSync(from, to, { recursive: true }); installed.push(id); }
      catch (e) { console.error(`[skills] could not install bundled skill ${id}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    this.d.settings.set(INSTALLED_KEY, [...already].sort());
    this.invalidate(); // a freshly copied skill must not wait out the memo before it can be listed
    return installed;
  }

  /**
   * Every directory in the library whose scope reaches this space, valid or not, with this space's
   * enabled flag. Sorted by id.
   *
   * **The effective set** (W2) lives here and nowhere else: scope reach (profile-scoped skills of this
   * space's profile + space-scoped skills of this space + pre-scoping skills) minus this space's
   * disabled-set — ONE disabled-set for both scopes, see `promote`'s doc comment. `injectionFor`,
   * `wouldInject` and the `skills.list` RPC all consume this method, so the panel and the staged
   * library cannot disagree (`scoping.test.ts` greps the keys to keep it that way).
   */
  list(spaceId: string): { root: string; skills: Skill[] } {
    const disabled = new Set(readIds(this.d.settings, disabledKey(spaceId)));
    const external = new Set(readIds(this.d.settings, externalEnabledKey(spaceId)));
    const scopes = this.scopeMap();
    const skills = this.discover(spaceId).entries
      .filter((e) => this.appliesTo(scopes[e.id] ?? LEGACY_SPACE_SCOPE, spaceId))
      // The two polarities meet here and nowhere else: library skills are on unless disabled, everything
      // discovered elsewhere is off unless enabled. See `externalEnabledKey` for why they differ.
      .map((e) => this.read(e, e.origin.kind === "library" ? !disabled.has(e.id) : external.has(e.id), scopes[e.id] ?? LEGACY_SPACE_SCOPE));
    return { root: this.root, skills };
  }

  /**
   * Every root this space scans, for the panel that lets the user see and edit them. `count` is what
   * the last scan actually found under each — a root that contributes nothing is far more useful shown
   * with a zero than omitted, because "I added that directory and nothing appeared" is the question.
   */
  sources(spaceId: string): Array<{ kind: ScanRoot["kind"]; key: string; label: string; path: string; count: number; removable: boolean }> {
    const { entries, roots } = this.discover(spaceId);
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.origin.key, (counts.get(e.origin.key) ?? 0) + 1);
    return roots.map((r) => ({
      kind: r.kind, key: r.key, label: r.label, path: r.path,
      count: counts.get(r.key) ?? 0,
      // Only what the user added by hand can be taken away by hand. The library and the agent
      // directories are facts about the machine; a "remove" on them would be a lie about what Realm reads.
      removable: r.kind === "extra",
    }));
  }

  /**
   * Flip one skill for one space. Which of the two keys it writes follows the skill's ORIGIN, not the
   * caller — the caller only ever says on or off, and "on" means the opposite stored fact for a library
   * skill (absent from the disabled-set) than for an installed one (present in the enabled-set).
   *
   * An id the current scan cannot place is still accepted, as it always has been: a skill can be
   * removed from disk and put back, and the preference has to survive that. It is routed by its
   * prefix instead — `agents.foo` against a live `agents` root is external, anything else is the
   * library — so a missing skill's toggle lands in the same key it will be read from when it returns.
   */
  setEnabled(spaceId: string, id: string, enabled: boolean): void {
    const found = this.discover(spaceId).entries.find((e) => e.id === id);
    const isLibrary = found
      ? found.origin.kind === "library"
      : !this.discover(spaceId).roots.some((r) => r.kind !== "library" && id.startsWith(`${r.key}.`));
    if (isLibrary) {
      const key = disabledKey(spaceId);
      const disabled = new Set(readIds(this.d.settings, key));
      if (enabled) disabled.delete(id); else disabled.add(id);
      this.d.settings.set(key, [...disabled].sort());
    } else {
      const key = externalEnabledKey(spaceId);
      const on = new Set(readIds(this.d.settings, key));
      if (enabled) on.add(id); else on.delete(id);
      this.d.settings.set(key, [...on].sort());
    }
  }

  /**
   * Whether `injectionFor` would hand this session a library — without staging anything. This is what
   * read paths (memory.sources) ask, because staging rebuilds a directory tree and a LIST call that
   * rewrites disk state is a list call that races the session starts it is describing.
   */
  wouldInject(spaceId: string, kind: AgentKind): boolean {
    if (AGENT_SKILL_SUPPORT[kind] !== "injected") return false;
    try { return this.list(spaceId).skills.some((s) => s.valid && s.enabled); }
    catch { return false; }
  }

  /**
   * Stage this space's enabled skills and return the two paths the adapters want, or null when there is
   * nothing to hand over.
   *
   * Null is load-bearing on the Claude side: being given a library is also what makes that session
   * isolate itself from the user's own `~/.claude` settings, so "no skills" has to mean "no option",
   * not "an empty option".
   *
   * Never throws. A session that cannot be given skills is a session with fewer skills; it is not a
   * session that fails to start, and no `SKILL.md` anyone can write may change that.
   */
  injectionFor(spaceId: string, kind: AgentKind, narrow?: {
    /** Plan 13 W1: stage only this SUBSET of the space's enabled skills. Ids not in the effective
     *  set are silently dropped here — the caller (`agent_run`) has already refused unknown ids
     *  loudly; this stays a filter, never an expander. */
    only: string[];
    /** Stage directory key. A narrowed set must NOT rebuild the space's shared stage (other live
     *  sessions symlink through it), so a narrowing caller stages under its own key — the child
     *  session id, which shares the ULID namespace with space ids and cannot collide. */
    stageId: string;
  }): SkillsInjection | null {
    if (AGENT_SKILL_SUPPORT[kind] !== "injected") return null;
    try {
      const all = this.list(spaceId).skills.filter((s) => s.valid && s.enabled);
      const enabled = narrow ? all.filter((s) => narrow.only.includes(s.id)) : all;
      if (enabled.length === 0) return null;
      const pluginPath = join(stageRoot(this.d.home), narrow?.stageId ?? spaceId);
      const root = join(pluginPath, "skills");
      // Rebuilt from scratch every start rather than reconciled: the staged tree is derived state, and a
      // stale symlink to a skill the user renamed is exactly the bug reconciliation would leave behind.
      rmSync(pluginPath, { recursive: true, force: true });
      mkdirSync(join(pluginPath, ".claude-plugin"), { recursive: true });
      writeFileSync(join(pluginPath, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "realm", version: "0.0.1", description: "Skills managed by Realm." }, null, 2));
      mkdirSync(root, { recursive: true });
      // Symlinks, not copies: both agents resolve them (proven in scripts/live-skills-check.ts), and an
      // edit the user makes mid-session is then live rather than a snapshot taken at start.
      for (const s of enabled) symlinkSync(dirname(s.path), join(root, s.id), "dir");
      return { pluginPath, root };
    } catch (e) {
      console.error(`[skills] could not stage skills for space ${spaceId}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** Drop a per-session staged tree (`injectionFor`'s `narrow.stageId`) once its session is deleted —
   *  the stage is derived state, and a dead session's copy is just litter. Best effort: it will be
   *  rebuilt (or never read again) either way. */
  discardStage(stageId: string): void {
    try { rmSync(join(stageRoot(this.d.home), stageId), { recursive: true, force: true }); } catch { /* derived state */ }
  }

  /** Directory entries that could be a skill, cheapest-first: unreadable or absent root is an empty
   *  library, and a name that is not a plain directory name is not addressable over RPC so it is skipped. */
  private dirNames(dir: string): string[] {
    let entries: string[];
    try { entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name); }
    catch { return []; }
    return entries.filter((n) => !n.startsWith(".") && SkillIdSchema.safeParse(n).success).sort();
  }

  /** One directory. Every failure below produces a listed-but-invalid skill, never an exception. */
  private read(e: Discovered, enabled: boolean, scope: ItemScope): Skill {
    const path = join(e.dir, "SKILL.md");
    const meta = this.meta(path, e.dirName);
    return { id: e.id, ...meta, path, enabled, scope, origin: e.origin };
  }

  /** `SKILL.md`'s frontmatter, from the memo when the file has not changed since it was last parsed. */
  private meta(path: string, dirName: string): ParsedMeta {
    let stamp: { mtimeMs: number; size: number };
    try { const st = statSync(path); stamp = { mtimeMs: st.mtimeMs, size: st.size }; }
    catch { this.parsed.delete(path); return invalidMeta(dirName, "no SKILL.md in this directory"); }
    const hit = this.parsed.get(path);
    if (hit && hit.mtimeMs === stamp.mtimeMs && hit.size === stamp.size) return hit.meta;
    const meta = parseMeta(path, dirName);
    this.parsed.set(path, { ...stamp, meta });
    return meta;
  }
}

/** The part of a `Skill` that comes out of the file itself — everything else is per-space or per-scan. */
type ParsedMeta = Pick<Skill, "name" | "description" | "valid" | "reason">;

const invalidMeta = (dirName: string, reason: string): ParsedMeta =>
  ({ name: dirName, description: "", valid: false, reason });

function parseMeta(path: string, dirName: string): ParsedMeta {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch { return invalidMeta(dirName, "no SKILL.md in this directory"); }
  const fm = parseFrontmatter(text);
  if (!fm) return invalidMeta(dirName, "SKILL.md has no `---` frontmatter block");
  const name = fm.name?.trim() ?? "";
  const description = fm.description?.trim() ?? "";
  if (!name) return invalidMeta(dirName, "frontmatter has no `name`");
  // Every agent decides whether to invoke a skill from its description alone, so one without a
  // description is not a skill that works badly — it is a skill that never runs.
  if (!description) return invalidMeta(dirName, "frontmatter has no `description`");
  return { name, description, valid: true, reason: null };
}
