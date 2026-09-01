import { z } from "zod";
import { AGENT_META } from "./presets";
import { AgentKindSchema, type AgentKind } from "./entities";

/**
 * W3's ground rule: Realm READS the files each agent loads and never writes them. The one permitted
 * write is the opt-in `AGENTS.md` in a space folder Realm itself created (`AgentsFileState`), and even
 * that is refused anywhere else. Everything else reaches a session through a per-session parameter —
 * `systemPrompt.append` for Claude, `thread/start` `developerInstructions` for Codex — or not at all.
 */

/** Hard cap on ONE Realm memory document (space or profile). It travels inside every session's system
 *  context, so an unbounded doc is a prompt that quietly swallows the context window. */
export const MEMORY_DOC_MAX = 100_000;

/**
 * W2: cap on the COMBINED memory content injected into one session (profile doc + space doc), enforced
 * where the CLIs actually meet the docs — `MemoryService.systemContextFor`. Each doc is write-capped at
 * `MEMORY_DOC_MAX`, so two full docs could otherwise double the old injection budget. When the pair
 * exceeds this, the PROFILE doc is truncated to fit and the space doc rides whole: the space doc is the
 * more specific standing instruction for the workspace the session is actually in.
 */
export const MEMORY_COMBINED_MAX = 150_000;

/**
 * The profile-level memory doc as one space sees it (W2). `enabledHere` is the per-space inheritance
 * toggle — the profile doc is an inherited item like any other: ON by default, per-space disableable,
 * never editable from a space (`memory.setProfile` edits it at its defining scope).
 */
export const ProfileMemoryStateSchema = z.object({
  profileId: z.string(),
  /** Where the profile document lives: `<realmHome>/memory/profile-<profileId>.md`. */
  path: z.string(),
  doc: z.string(),
  /** Whether THIS space injects the profile doc. Per-space, default true. */
  enabledHere: z.boolean(),
});
export type ProfileMemoryState = z.infer<typeof ProfileMemoryStateSchema>;

/**
 * One file of durable context, as `memory.sources` reports it for a session.
 *
 * `via` is the honest part: `cli` means the agent loads the file itself, `realm` means Realm carries
 * its content into the session (a Claude session whose skills library sets `settingSources: []` loads
 * NO settings files on its own — Realm re-injects them), and `none` means the file is a known location
 * that is currently empty or absent.
 */
export const MemorySourceSchema = z.object({
  /** Absolute path. */
  path: z.string(),
  /** `user` = the agent's home-dir file, `project` = a checkout-level file, `import` = pulled in by an
   *  `@path` reference, `reported` = named by the agent itself (Codex `instructionSources`). */
  origin: z.enum(["user", "project", "import", "reported"]),
  exists: z.boolean(),
  /** How the content reaches the session: loaded by the CLI itself, re-injected by Realm, or not at all. */
  via: z.enum(["cli", "realm", "none"]),
});
export type MemorySource = z.infer<typeof MemorySourceSchema>;

/**
 * The opt-in `AGENTS.md` at the root of a Realm-created space folder — the plan's one permitted write.
 *
 * `writable: false` (with `reason`) covers the two refusals: the space's primary checkout is a
 * directory Realm did not create, or an `AGENTS.md` Realm did not write already sits there.
 */
export const AgentsFileStateSchema = z.object({
  enabled: z.boolean(),
  /** Where the file goes (or is): `<space folder>/AGENTS.md`. */
  path: z.string(),
  exists: z.boolean(),
  /** True when the file on disk carries Realm's marker header — the only kind Realm will rewrite or remove. */
  managedByRealm: z.boolean(),
  writable: z.boolean(),
  reason: z.string().nullable(),
});
export type AgentsFileState = z.infer<typeof AgentsFileStateSchema>;

/** A space's Realm-owned memory document, stored under Realm's home — never in any agent's config. */
export const MemoryStateSchema = z.object({
  /** Where the document lives: `<realmHome>/memory/<spaceId>.md`. */
  path: z.string(),
  doc: z.string(),
  agentsFile: AgentsFileStateSchema,
  /** The profile doc this space inherits (W2), or null when the space's profile is unknown. Injection
   *  order is profile doc then space doc, combined cap `MEMORY_COMBINED_MAX`. */
  profile: ProfileMemoryStateSchema.nullable(),
});
export type MemoryState = z.infer<typeof MemoryStateSchema>;

/**
 * The per-session channel Realm can hand durable context through, per agent — proven live, not assumed
 * (see `docs/superpowers/specs/2026-08-29-agent-config-surfaces.md` §1.3).
 *
 * - `systemPrompt` — Claude: `systemPrompt: { type: "preset", preset: "claude_code", append }`.
 * - `developerInstructions` — Codex: a `thread/start` parameter.
 * - `none` — ACP `session/new` is `{cwd, mcpServers}`: there is no parameter to put context in, so
 *   nothing Realm manages reaches these agents. Stated, not faked: no adapter fallback pretends otherwise.
 */
export type MemoryChannel = "systemPrompt" | "developerInstructions" | "none";
export const AGENT_MEMORY_CHANNEL = {
  claude: "systemPrompt",
  codex: "developerInstructions",
  "acp:cursor": "none",
  "acp:gemini": "none",
  fake: "none",
} as const satisfies Record<AgentKind, MemoryChannel>;

/**
 * What `memory.sources` answers for one session: which durable-context files reach its agent, and on
 * what authority.
 *
 * `basis` names the authority so the UI can say it: `modeled` — Realm read the same paths the CLI
 * reads (Claude); `reported` — the agent itself named the files it loaded (Codex `instructionSources`);
 * `none` — either the agent takes no durable context at all (Cursor) or it has not started yet and so
 * has reported nothing (a Codex session before its first message).
 */
export const MemorySourcesSchema = z.object({
  agent: AgentKindSchema,
  channel: z.enum(["systemPrompt", "developerInstructions", "none"]),
  basis: z.enum(["modeled", "reported", "none"]),
  /** One sentence naming the agent and its reality, so a note rendered for the wrong session is visibly wrong. */
  note: z.string(),
  /** Whether this space's Realm memory document is non-empty and travels to this agent's sessions. */
  realmMemoryInjected: z.boolean(),
  sources: z.array(MemorySourceSchema),
});
export type MemorySources = z.infer<typeof MemorySourcesSchema>;

/** The per-agent honesty line for the memory pane. Always names the agent. */
export function memorySupportNote(kind: AgentKind): string {
  const label = AGENT_META[kind].label;
  switch (AGENT_MEMORY_CHANNEL[kind]) {
    case "systemPrompt":
      return `${label} sessions receive this space's Realm memory per session; the files below are the ones the CLI reads, modeled by Realm from the same paths.`;
    case "developerInstructions":
      return `${label} sessions receive this space's Realm memory per session, and ${label} itself reports the exact instruction files it loaded once the session starts.`;
    default:
      return `${label} takes no per-session context parameter, so neither Realm's memory nor any managed file reaches it.`;
  }
}
