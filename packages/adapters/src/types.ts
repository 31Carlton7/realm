import type { AgentKind, SessionEvent } from "@realm/contracts";

/**
 * One MCP server on its way to an agent.
 *
 * Since Plan 9 W3 an agent is only ever handed ONE of these per session: the Realm gateway's own `http`
 * entry, minted by `McpGateway.register` and handed straight to an adapter. Third-party server configs
 * (and their secret values) never leave realm-server — the gateway proxies to them instead. This type
 * still carries `stdio`/`sse` variants for the adapter-level plumbing that decodes it, but nothing in
 * `apps/server` constructs one of those anymore, and (Plan 9 W4) no adapter filters by `transport`
 * either — the per-agent transport asymmetry this used to guard against (Codex has no SSE) is now
 * entirely the gateway's problem: it is the only thing that ever dials stdio/http/sse upstream.
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
  /** Since Plan 9 W3, `apps/server` always sends exactly ONE entry: the gateway's own `http` endpoint —
   *  enablement or not, `fake` included (its adapter simply never reads it). Only tests pass `[]`. */
  mcpServers: McpServerConfig[];
  /** Omitted for agents Realm cannot inject skills into (see AGENT_SKILL_SUPPORT), and for a space
   *  whose enabled skill set is empty. */
  skills?: SkillsInjection;
  resume?: string | null;
  env?: Record<string, string>;
  /** Diagnostic sink for provider stderr / log lines. */
  onLog?: (line: string) => void;
};

export type UserMessage = { text: string; attachments: { path: string; mime: string }[] };
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
