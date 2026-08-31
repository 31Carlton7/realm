import type { AgentKind, SessionEvent } from "@realm/contracts";

/**
 * One MCP server on its way to an agent, secrets and all.
 *
 * This is the ONLY shape a secret value travels in. It is built per session by `McpService.configFor`
 * and handed straight to an adapter; nothing persists it, logs it, or puts it on an event.
 *
 * Every adapter must filter by `transport` against `AGENT_MCP_TRANSPORTS` before translating — Codex
 * has no SSE, and an SSE server passed to it as though it were HTTP would connect to nothing while
 * looking configured.
 */
export type McpServerConfig =
  | { name: string; transport: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { name: string; transport: "http" | "sse"; url: string; headers: Record<string, string> };

/**
 * Realm's skills library, handed to an agent **per invocation**. Nothing is ever written into
 * `~/.claude`, `~/.codex`, `~/.cursor` or `~/.agents` — the two routes below are the whole mechanism.
 *
 * The server stages one directory per space that is simultaneously both shapes, because the two agents
 * want the same tree from different heights:
 *
 *   <staged>/                      ← `pluginPath`: a Claude local plugin
 *     .claude-plugin/plugin.json
 *     skills/                      ← `root`: a Codex extra skills root
 *       <id>/SKILL.md              (a symlink to <realmHome>/skills/<id>; both agents follow it)
 *
 * Absent (`undefined`) means "Realm is not managing skills for this session" — every adapter must then
 * behave exactly as it did before this option existed. That is not the same as an empty library: see
 * ClaudeAdapter, where being handed a library also isolates the session from the user's own settings.
 */
export type SkillsInjection = {
  /** Claude Code: `plugins: [{ type: "local", path: pluginPath }]`. */
  pluginPath: string;
  /** Codex: `skills/extraRoots/set { extraRoots: [root] }`. Contains `<id>/SKILL.md` directly. */
  root: string;
};

export type StartOptions = {
  cwd: string;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string;
  systemContext?: string;
  /** This space's enabled servers. Each adapter drops the transports its agent cannot reach and says so
   *  through `onLog`; a server that is silently absent is the failure this option exists to prevent. */
  mcpServers: McpServerConfig[];
  /** Omitted for agents Realm cannot inject skills into (see AGENT_SKILL_SUPPORT), and for a space
   *  whose enabled skill set is empty. */
  skills?: SkillsInjection;
  resume?: string | null;
  env?: Record<string, string>;
  /** Diagnostic sink for provider stderr / log lines. */
  onLog?: (line: string) => void;
};

/**
 * A skill the server resolved from an `@`-mention for THIS message (Plan 8 W4). By the time it is
 * here it has been re-validated: enabled and valid in the session's space, on an agent whose session
 * was actually started with the library. Each adapter maps it to its own wire — Claude prepends
 * `/realm:<name>` (position 0 is the only place the SDK dispatches a slash command), Codex adds a
 * native `{ type: "skill" }` input item. `text` never contains a literal `@name` for it — the server
 * already stripped the `@` (see contracts/mentions.ts).
 *
 * `name` is the frontmatter name — the identity BOTH agents invoke by (proven live: a plugin skill
 * whose frontmatter name differs from its directory surfaces as `realm:<frontmatter-name>`, and
 * Codex's skills/list reports frontmatter names). `id` is the library directory, for display and
 * validation only. `path` is the skill's `SKILL.md` in Realm's library — the staged trees symlink
 * back to it, so it is the one path that is true for every session.
 */
export type SkillMention = { id: string; name: string; path: string };

export type UserMessage = { text: string; attachments: { path: string; mime: string }[]; skill?: SkillMention };
export type PermissionDecision = "allow" | "allow_always" | "deny";

export interface AgentHandle {
  readonly events: AsyncIterable<SessionEvent>;
  /** Resolves once the message has been accepted (attachments read and enqueued); errors are reported as `error` events. */
  send(message: UserMessage): Promise<void>;
  respondPermission(requestId: string, decision: PermissionDecision): void;
  interrupt(): Promise<void>;
  setOptions(opts: { model?: string; permissionMode?: string }): Promise<void>;
  dispose(): Promise<void>;
}

export type ProbeResult = { kind: AgentKind; available: boolean; version: string | null; loggedIn: boolean | null; reason: string | null };

export interface AgentAdapter {
  readonly kind: AgentKind;
  probe(): Promise<ProbeResult>;
  start(opts: StartOptions): AgentHandle;
}

export type AdapterRegistry = Partial<Record<AgentKind, AgentAdapter>>;
