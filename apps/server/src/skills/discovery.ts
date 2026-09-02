import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { SkillIdSchema, type SkillOrigin, type SkillOriginKind } from "@realm/contracts";

/**
 * Finding the skills the user already installed, in every agent that installs them, WITHOUT writing a
 * byte into any of those trees.
 *
 * The whole module is read-only and total: a root that does not exist, a `SKILL.md` that cannot be read
 * and a plugin manifest that is not JSON all produce fewer entries, never an exception. Discovery runs
 * on the way to answering "what can this space turn on", and a scan that throws would take the user's
 * own library down with someone else's broken file.
 */

/** One directory to scan, with the key that prefixes every id found under it. */
export type ScanRoot = {
  kind: SkillOriginKind;
  /** Unique across the scan — see `assignRootKeys`, which is what guarantees it. */
  key: string;
  label: string;
  path: string;
};

/** One skill directory found by a scan. `id` is already qualified; `dir` is the directory itself. */
export type Discovered = {
  id: string;
  dirName: string;
  dir: string;
  origin: SkillOrigin;
};

/** `~/.claude/skills` → `~/.claude/skills`, for labels that stay readable when the home is long. */
export function tildify(p: string, home: string): string {
  const h = home.endsWith("/") ? home.slice(0, -1) : home;
  return p === h ? "~" : p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

/**
 * The per-user agent directories, in PRECEDENCE order.
 *
 * Order is load-bearing exactly once: `~/.claude/skills` here is 29 symlinks into `~/.agents/skills`,
 * and `dedupe` keeps whichever root is seen first. Listing `.claude` before `.agents` would key those
 * skills `claude.*`; listing `.agents` first keys them `agents.*` — at the directory the file actually
 * lives in, which is the one the user would recognise and the one that survives unlinking Claude.
 */
const USER_DIRS: Array<{ key: string; rel: string }> = [
  { key: "agents", rel: ".agents/skills" },
  { key: "claude", rel: ".claude/skills" },
  { key: "codex", rel: ".codex/skills" },
  { key: "cursor", rel: ".cursor/skills" },
];

/** The same four, relative to a project folder. Keyed `project-*` so a repo's `.claude/skills` can
 *  never collide with the user's — they are different trees with the same basename. */
const PROJECT_DIRS: Array<{ key: string; rel: string }> = [
  { key: "project-claude", rel: ".claude/skills" },
  { key: "project-agents", rel: ".agents/skills" },
  { key: "project-codex", rel: ".codex/skills" },
  { key: "project-cursor", rel: ".cursor/skills" },
];

/**
 * The installed Claude plugins that ship skills, from `installed_plugins.json` — NOT from globbing
 * `plugins/cache`.
 *
 * The cache is a history, not an inventory: this Mac holds figma 2.2.90 beside 2.2.96 and a vercel
 * 0.40.1 that no longer corresponds to anything installed. Globbing it produced 36 name collisions,
 * every single one of them two versions of one plugin or a plugin that is not installed. The manifest
 * names one `installPath` per plugin, so reading it is both the correct answer and the cheap one.
 *
 * `settings.json`'s `enabledPlugins` then removes the ones the user has switched OFF: a disabled
 * plugin's skills are not skills the user has, and offering them would put Realm ahead of the setting.
 */
export function pluginRoots(home: string): ScanRoot[] {
  const manifest = readJson(join(home, ".claude", "plugins", "installed_plugins.json"));
  const plugins = manifest && typeof manifest === "object" ? (manifest as { plugins?: unknown }).plugins : null;
  if (!plugins || typeof plugins !== "object") return [];

  const settings = readJson(join(home, ".claude", "settings.json"));
  const enabledMap = settings && typeof settings === "object" ? (settings as { enabledPlugins?: unknown }).enabledPlugins : null;
  // Absent `enabledPlugins` means "nothing has been switched off", not "everything is off".
  const isEnabled = (fullName: string): boolean => {
    if (!enabledMap || typeof enabledMap !== "object") return true;
    const v = (enabledMap as Record<string, unknown>)[fullName];
    return v === undefined ? true : v === true;
  };

  const out: ScanRoot[] = [];
  for (const [fullName, entries] of Object.entries(plugins as Record<string, unknown>)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    if (!isEnabled(fullName)) continue;
    const installPath = (entries[0] as { installPath?: unknown } | undefined)?.installPath;
    if (typeof installPath !== "string" || !installPath) continue;
    const skills = join(installPath, "skills");
    if (!isDir(skills)) continue;
    // "figma@claude-plugins-official" → "figma": the marketplace disambiguates two plugins of one
    // name, so it stays in the label; the key uses the plugin name and `assignRootKeys` handles the
    // rare pair that genuinely collides (here: `vercel` and `vercel-plugin`, already distinct).
    const short = fullName.split("@")[0] || fullName;
    out.push({ kind: "plugin", key: sanitizeKey(short), label: `${short} plugin`, path: skills });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Every root to scan for one space, library first.
 *
 * Library first is what makes a library id stay bare: `assignRootKeys` hands out keys in this order,
 * and `dedupe` keeps the first sighting of a realpath — so a skill that is BOTH in `~/Realm/skills`
 * and symlinked into `~/.agents/skills` is the library's, with the library's id and the library's
 * writability, rather than appearing twice.
 */
export function scanRoots(d: { home: string; libraryRoot: string; projectDir?: string | null; extraRoots?: string[] }): ScanRoot[] {
  const roots: ScanRoot[] = [{ kind: "library", key: "library", label: "Realm library", path: d.libraryRoot }];

  for (const { key, rel } of USER_DIRS) {
    const path = join(d.home, rel);
    if (isDir(path)) roots.push({ kind: "user", key, label: tildify(path, d.home), path });
  }

  roots.push(...pluginRoots(d.home));

  if (d.projectDir) {
    for (const { key, rel } of PROJECT_DIRS) {
      const path = join(d.projectDir, rel);
      if (isDir(path)) roots.push({ kind: "project", key, label: `${basename(d.projectDir)}/${rel}`, path });
    }
  }

  for (const raw of d.extraRoots ?? []) {
    // Only absolute paths: a relative extra root would resolve against the server's cwd, which is not
    // a directory the user ever chose or can see.
    if (!isAbsolute(raw) || !isDir(raw)) continue;
    roots.push({ kind: "extra", key: sanitizeKey(basename(raw)) || "extra", label: tildify(raw, d.home), path: raw });
  }

  return assignRootKeys(roots);
}

/**
 * Make every root key unique, in the order given, by suffixing repeats `-2`, `-3`, ….
 *
 * In practice nothing collides — the four user dirs, the plugin names and `project-*` are already
 * disjoint. This exists so that when something DOES (two extra roots both named `skills`, a plugin
 * literally called `codex`), the result is still deterministic and still addressable, instead of two
 * skills quietly sharing an id and one of them inheriting the other's enabled state.
 */
export function assignRootKeys(roots: ScanRoot[]): ScanRoot[] {
  const taken = new Set<string>();
  return roots.map((r) => {
    let key = r.key;
    for (let n = 2; taken.has(key); n++) key = `${r.key}-${n}`;
    taken.add(key);
    return key === r.key ? r : { ...r, key };
  });
}

/** A root key has to survive being half of an id, so it lives in `SkillIdSchema`'s charset. */
function sanitizeKey(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
}

/**
 * Scan the roots and return one entry per DISTINCT skill directory, first sighting wins.
 *
 * Deduplication is by `realpath`, and it is the reason this is not just a concatenation: `~/.claude/skills`
 * is very often a field of symlinks into `~/.agents/skills` (29 of 29 here), and listing the same skill
 * once per agent that can see it would turn a 134-skill machine into a 160-row list where the duplicates
 * carry independent toggles for one directory.
 */
export function scan(roots: ScanRoot[]): Discovered[] {
  const seen = new Set<string>();
  const ids = new Set<string>();
  const out: Discovered[] = [];
  for (const root of roots) {
    for (const dirName of dirNames(root.path)) {
      const dir = join(root.path, dirName);
      const real = realpathOr(dir);
      if (seen.has(real)) continue;
      // A directory with no SKILL.md is not a skill anywhere but the library, where it is listed as
      // broken on purpose (the user put it there; silence would be the bug). Elsewhere it is someone
      // else's stray folder and saying nothing is correct.
      if (root.kind !== "library" && !existsSync(join(dir, "SKILL.md"))) continue;
      seen.add(real);
      const base = root.kind === "library" ? dirName : `${root.key}.${dirName}`;
      let id = base;
      for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
      ids.add(id);
      out.push({ id, dirName, dir, origin: { kind: root.kind, key: root.key, label: root.label, root: root.path } });
    }
  }
  return out;
}

/** Directory entries that could be a skill. A name that is not a legal id is skipped: it could not be
 *  addressed over RPC, mentioned, or staged under its own name. */
function dirNames(dir: string): string[] {
  let entries: string[];
  try { entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name); }
  catch { return []; }
  return entries.filter((n) => !n.startsWith(".") && SkillIdSchema.safeParse(n).success).sort();
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** Unresolvable (a broken symlink) falls back to the literal path — which cannot collide with a real
 *  one, so a dangling link stays its own entry and gets listed as invalid rather than swallowing another. */
function realpathOr(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
