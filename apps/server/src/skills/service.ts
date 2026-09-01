import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_SKILL_SUPPORT, ItemScopeSchema, LEGACY_SPACE_SCOPE, SkillIdSchema, type AgentKind, type ItemScope, type Skill } from "@realm/contracts";
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
  }) {
    this.root = skillsRoot(d.home);
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
    if (!this.dirNames(this.root).includes(id)) throw new RpcError("NOT_FOUND", `skill "${id}" is not in the library`);
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
    const scopes = this.scopeMap();
    const skills = this.dirNames(this.root)
      .filter((id) => this.appliesTo(scopes[id] ?? LEGACY_SPACE_SCOPE, spaceId))
      .map((id) => this.read(id, !disabled.has(id), scopes[id] ?? LEGACY_SPACE_SCOPE));
    return { root: this.root, skills };
  }

  setEnabled(spaceId: string, id: string, enabled: boolean): void {
    const key = disabledKey(spaceId);
    const disabled = new Set(readIds(this.d.settings, key));
    if (enabled) disabled.delete(id); else disabled.add(id);
    this.d.settings.set(key, [...disabled].sort());
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
  injectionFor(spaceId: string, kind: AgentKind): SkillsInjection | null {
    if (AGENT_SKILL_SUPPORT[kind] !== "injected") return null;
    try {
      const enabled = this.list(spaceId).skills.filter((s) => s.valid && s.enabled);
      if (enabled.length === 0) return null;
      const pluginPath = join(stageRoot(this.d.home), spaceId);
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

  /** Directory entries that could be a skill, cheapest-first: unreadable or absent root is an empty
   *  library, and a name that is not a plain directory name is not addressable over RPC so it is skipped. */
  private dirNames(dir: string): string[] {
    let entries: string[];
    try { entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name); }
    catch { return []; }
    return entries.filter((n) => !n.startsWith(".") && SkillIdSchema.safeParse(n).success).sort();
  }

  /** One directory. Every failure below produces a listed-but-invalid skill, never an exception. */
  private read(id: string, enabled: boolean, scope: ItemScope): Skill {
    const path = join(this.root, id, "SKILL.md");
    const invalid = (reason: string): Skill => ({ id, name: id, description: "", path, enabled, valid: false, reason, scope });
    let text: string;
    try { text = readFileSync(path, "utf8"); }
    catch { return invalid("no SKILL.md in this directory"); }
    const fm = parseFrontmatter(text);
    if (!fm) return invalid("SKILL.md has no `---` frontmatter block");
    const name = fm.name?.trim() ?? "";
    const description = fm.description?.trim() ?? "";
    if (!name) return invalid("frontmatter has no `name`");
    // Every agent decides whether to invoke a skill from its description alone, so one without a
    // description is not a skill that works badly — it is a skill that never runs.
    if (!description) return invalid("frontmatter has no `description`");
    return { id, name, description, path, enabled, valid: true, reason: null, scope };
  }
}
