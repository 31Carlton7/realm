import { z } from "zod";
import { AGENT_META } from "./presets";
import { ItemScopeSchema } from "./scoping";
import type { AgentKind } from "./entities";

/**
 * A skill's identity is its **directory name**, not its frontmatter `name`.
 *
 * The directory is the only thing that is unique by construction and the only thing that survives a
 * `SKILL.md` Realm cannot parse — and an unparseable skill still has to be listable, or the user has no
 * way to find out why it is missing. Frontmatter `name` is carried alongside for display, and a skill is
 * only handed to an agent when it has one.
 *
 * Once Realm looks outside its own library the directory name stops being unique on its own — this Mac
 * has `find-skills` in three agent directories and `nextjs` in two installed plugins — so a skill from
 * any origin but `library` is identified by `<rootKey>.<dirName>` (`agents.apple-design`,
 * `figma.figma-use`). Library ids are left BARE, unprefixed and unchanged, which is what keeps every
 * stored disabled-set, scope entry and `@mention` written before discovery still resolving after it.
 * The `.` separator is already inside this charset and inside `mentions.ts`'s, so a qualified id stays
 * typeable as `@agents.apple-design` and stays legal as a staged directory name.
 */
export const SkillIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "skill id must be a plain directory name");

/**
 * One entry of Realm's skills library, as `skills.list` reports it for a given space.
 *
 * `valid: false` entries are listed on purpose: they are what the user sees instead of silence when a
 * `SKILL.md` is malformed. They are never staged for an agent, whatever `enabled` says.
 */
/**
 * Where a skill was found. Realm's own library is one origin among several as of W-discovery: the
 * library is still the only place Realm ever WRITES, but it is no longer the only place it LOOKS.
 *
 * - `library` — `~/Realm/skills`, Realm-owned, the only writable origin.
 * - `user`    — a per-user agent directory (`~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills`,
 *               `~/.cursor/skills`). Read-only to Realm, always.
 * - `plugin`  — a Claude plugin's `skills/` dir, resolved from `~/.claude/plugins/installed_plugins.json`
 *               so a stale cached version is never shown as installed.
 * - `project` — the session folder's own `.claude|.agents|.codex|.cursor/skills`.
 * - `extra`   — a directory the user added by hand (`skills.scanRoots`).
 *
 * Every origin outside `library` is scanned, symlinked and never touched: Realm reads these trees and
 * writes nothing into them, which is the same promise `SkillsInjection` already makes about `~/.claude`.
 */
export const SKILL_ORIGIN_KINDS = ["library", "user", "plugin", "project", "extra"] as const;
export const SkillOriginKindSchema = z.enum(SKILL_ORIGIN_KINDS);
export type SkillOriginKind = z.infer<typeof SkillOriginKindSchema>;

export const SkillOriginSchema = z.object({
  kind: SkillOriginKindSchema,
  /** Stable key of the ROOT this skill came from, and the `<key>.` prefix of every non-library id.
   *  Unique across a scan by construction (see `assignRootKeys`), so `key + "." + dirName` is unique. */
  key: z.string(),
  /** One short human label for a group header: "Realm library", "~/.agents/skills", "figma plugin". */
  label: z.string(),
  /** Absolute path of the directory that was scanned. */
  root: z.string(),
});
export type SkillOrigin = z.infer<typeof SkillOriginSchema>;

/**
 * One directory the scan reads, as `skills.sources` reports it — the answer to "why is this skill here"
 * and "what else is Realm looking at".
 *
 * `count` is from the same scan that answered `skills.list`, so a source and the rows it produced can
 * never disagree. A source with `count: 0` is still listed: "I added that directory and nothing showed
 * up" is precisely the question this panel exists to answer, and omitting it answers nothing.
 */
export const SkillSourceSchema = z.object({
  kind: SkillOriginKindSchema,
  key: z.string(),
  label: z.string(),
  path: z.string(),
  count: z.number().int(),
  /** Only a user-added (`extra`) directory can be removed. The library and the agent directories are
   *  facts about the machine — a remove button on them would claim Realm could stop them existing. */
  removable: z.boolean(),
});
export type SkillSource = z.infer<typeof SkillSourceSchema>;

/** The library origin, which every pre-discovery skill has and which alone allows writes. */
export const LIBRARY_ORIGIN = (root: string): SkillOrigin => ({ kind: "library", key: "library", label: "Realm library", root });

export const SkillSchema = z.object({
  id: SkillIdSchema,
  /** Frontmatter `name`; falls back to the directory name when the file could not be parsed. */
  name: z.string(),
  /** Frontmatter `description` — the whole basis on which every agent decides to invoke a skill. */
  description: z.string(),
  /** Absolute path of the skill's `SKILL.md`. */
  path: z.string(),
  /** Whether this space passes it to its agents. Defaults to true; per-space, persisted. */
  enabled: z.boolean(),
  /** Where this skill is defined (W2). Space-scoped with `spaceId: null` = a pre-scoping library entry,
   *  visible in every space; profile-scoped = inherited by every space of that profile. Only skills that
   *  APPLY to the listed space are returned, so an inherited entry here always belongs to this space's
   *  own profile. */
  scope: ItemScopeSchema,
  /** False when `SKILL.md` is missing, unreadable, or has no `name`/`description` frontmatter. */
  valid: z.boolean(),
  /** Why it is invalid, in one sentence. Null when valid. */
  reason: z.string().nullable(),
  /** Where it was found. `kind: "library"` is Realm's own folder; everything else is read-only. */
  origin: SkillOriginSchema,
});
export type Skill = z.infer<typeof SkillSchema>;

/**
 * What actually happens to Realm's skills library on each agent, proven live (see
 * `docs/superpowers/specs/2026-08-29-agent-config-surfaces.md` §1.1 and
 * `apps/server/scripts/live-skills-check.ts`).
 *
 * - `injected` — the library reaches the agent per-invocation with no writes to user-owned files.
 * - `unsupported` — there is no route. Cursor's cross-directory skill discovery is gated by a
 *   server-side predicate Realm can neither read nor set, and it differed between runs of the same
 *   binary; a skills path built on it would work for some users and silently not for others.
 */
export type SkillSupport = "injected" | "unsupported";

export const AGENT_SKILL_SUPPORT = {
  // claude-adapter.ts: `plugins: [{ type: "local", path }]` + `settingSources: []`.
  claude: "injected",
  // codex-adapter.ts: `skills/extraRoots/set` on the app-server connection, after the thread exists.
  codex: "injected",
  // acp-adapter.ts: ACP `session/new` is `{cwd, mcpServers}` and `cursor-agent acp` takes no flags.
  "acp:cursor": "unsupported",
  // Same ACP session shape; Gemini has no skills concept to inject into either.
  "acp:gemini": "unsupported",
  // Plan 18's ACP agents, all "unsupported" for the same structural reason: `session/new` is
  // `{cwd, mcpServers}` and carries nowhere to put a skills root. Several of these DO have a skills
  // concept of their own (Qwen's registry entry passes --experimental-skills; opencode and Copilot
  // both load skill directories) — but Realm cannot reach it over ACP, and "we cannot inject" is the
  // claim this table makes. A `true` nobody measured is worse than a `false`.
  "acp:opencode": "unsupported",
  "acp:copilot": "unsupported",
  "acp:goose": "unsupported",
  "acp:qwen": "unsupported",
  "acp:grok": "unsupported",
  "acp:fx": "unsupported",
  // fake-adapter.ts never looks at `skills`.
  fake: "unsupported",
} as const satisfies Record<AgentKind, SkillSupport>;

/** One sentence naming the agent and what it will do with the library. Always names the agent, so a
 *  note rendered for the wrong session is visibly wrong. */
export function skillSupportNote(kind: AgentKind): string {
  const label = AGENT_META[kind].label;
  return AGENT_SKILL_SUPPORT[kind] === "injected"
    ? `${label} gets this space's enabled skills, and only those — including any you switch on from your own installed directories.`
    : `${label} cannot be given a skills directory, so it will not see these skills.`;
}
