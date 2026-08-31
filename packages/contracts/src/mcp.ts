import { z } from "zod";
import { AGENT_META } from "./presets";
import { IdSchema } from "./ids";
import type { AgentKind } from "./entities";

/**
 * A server's **name** is what every agent keys it by on the wire — a record key for Claude, a
 * `[mcp_servers.NAME]` TOML table for Codex, a `name` field for ACP. So it has to survive being a TOML
 * bare key, which is the narrowest of the three: letters, digits, `_` and `-`, nothing else.
 *
 * It is separate from the row's `id` because the user can rename a server, and a rename must not look
 * like a delete-plus-add to the per-space enable sets that point at it.
 */
export const McpServerNameSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_][A-Za-z0-9_-]*$/,
  "server name must be letters, digits, underscore or hyphen");

/**
 * How Realm reaches the server. All three are real; none of them reaches every agent (see
 * `AGENT_MCP_TRANSPORTS`), which is why the transport is stored rather than inferred from the URL.
 */
export const McpTransportSchema = z.enum(["stdio", "http", "sse"]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

/**
 * Where Realm keeps the API keys an MCP server needs, stated plainly because the alternative is a
 * false sense of security.
 *
 * This string is UI copy, not decoration: any surface that takes a secret has to show it. Realm has no
 * Keychain integration and no encryption — the value is in `realm.db` in the clear. That is the same
 * posture as the CLIs Realm drives (`~/.codex/config.toml` and `~/.claude.json` both hold MCP env
 * blocks in plaintext), so it is not *worse* than the status quo; it is simply not a secret store.
 */
export const MCP_SECRET_STORAGE_NOTE =
  "Keys and headers are stored in plain text in Realm's database (~/Realm/realm.db) — not encrypted, not in the Keychain. Anyone who can read that file, or any process running as you, can read them. Realm's CLIs keep their own MCP credentials the same way.";

/** One tool from an upstream server's cached `tools/list` — name and description only. No input
 *  schema: the gateway forwards calls verbatim rather than validating against a cached copy that can
 *  go stale the moment the upstream server changes it. */
export const McpToolSchema = z.object({ name: z.string(), description: z.string() });
export type McpTool = z.infer<typeof McpToolSchema>;

/** Where a remote server's OAuth connection stands. `reconnect_needed` is the one state a UI must badge:
 *  it means calls will fail until the user re-authorizes (see the gateway design's refresh-failure path). */
export const McpOauthStatusSchema = z.enum(["unconfigured", "connected", "reconnect_needed"]);
export type McpOauthStatus = z.infer<typeof McpOauthStatusSchema>;

/** The hub's live connection state for a server row. `circuit_open` is distinct from `error`: it means
 *  three consecutive failures tripped the breaker, and calls fail fast until `mcp.retry` or a row edit. */
export const McpServerStatusSchema = z.enum(["idle", "connected", "error", "circuit_open"]);
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;

/**
 * One proxied tool call, as `mcp.calls.list` and the `mcp.call` event report it — Realm's own view of
 * the call (Activity), independent of whatever the agent's own transcript recorded for the same call.
 *
 * `resultSummary` is a truncated excerpt, never the full payload — the gateway decides what is safe to
 * keep, not this schema. `argsJson` is the call's arguments as sent upstream, which is why this schema
 * lives beside `McpServer` rather than `session-events.ts`: an MCP tool argument can itself be a secret
 * (an API key passed as a tool parameter, not a header), so a surface rendering this owes the same
 * MCP_SECRET_STORAGE_NOTE honesty as the server editor.
 */
export const McpCallSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  /** Null once the server row that produced this call has been deleted — the log outlives the config. */
  serverId: IdSchema.nullable(),
  serverName: z.string(),
  tool: z.string(),
  argsJson: z.string(),
  resultSummary: z.string(),
  ok: z.boolean(),
  durationMs: z.number().int(),
  ts: z.number().int(),
});
export type McpCall = z.infer<typeof McpCallSchema>;

/**
 * One configured MCP server, as `mcp.list` reports it.
 *
 * **No secret values appear here, ever.** `envKeys` and `headerKeys` name what is set; the values stay
 * in the database and travel only to the agent that was configured to receive them. A settings UI can
 * therefore show "AIRTABLE_API_KEY is set" and offer to replace it, and nothing that is logged,
 * broadcast, or screenshotted can leak the key — including this object. The same holds for OAuth:
 * `oauthStatus` says whether a connection exists, never the token.
 */
export const McpServerSchema = z.object({
  id: IdSchema,
  name: McpServerNameSchema,
  transport: McpTransportSchema,
  /** stdio only; `""` for a remote server. */
  command: z.string(),
  /** stdio only; `[]` for a remote server. */
  args: z.array(z.string()),
  /** http/sse only; `""` for stdio. */
  url: z.string(),
  /** Names of the stdio `env` entries. Values are deliberately absent — see the type doc. */
  envKeys: z.array(z.string()),
  /** Names of the http/sse headers. Values are deliberately absent — see the type doc. */
  headerKeys: z.array(z.string()),
  /** How this server authenticates, derived — never a stored field. Oauth beats secrets beats none: a
   *  server can carry both a leftover header key and a completed OAuth connection, and OAuth is the one
   *  actually used upstream once it exists. */
  authKind: z.enum(["none", "secrets", "oauth"]),
  /** Derived from whether OAuth has ever completed for this row. See `McpOauthStatusSchema`. */
  oauthStatus: McpOauthStatusSchema,
  /** The hub's live connection state. Always `"idle"` before the hub exists (W1–W2). */
  status: McpServerStatusSchema,
  /** The last successful `tools/list`, cached — `[]` before the hub has ever connected. */
  tools: z.array(McpToolSchema),
  /** This space's per-tool allowlist for this server. `null` = every cached tool is allowed, which is
   *  also the state of a server nobody has ever narrowed. Per the space `mcp.list` was asked for. */
  allowedTools: z.array(z.string()).nullable(),
  /** Whether the space this was listed for passes it to its agents. Per-space, persisted, default OFF. */
  enabled: z.boolean(),
  createdAt: z.number().int(),
});
export type McpServer = z.infer<typeof McpServerSchema>;

/** stdio `env` / remote `headers` on the way IN. The only shape any secret value is ever carried by. */
export const McpSecretsSchema = z.record(z.string().min(1), z.string());

/**
 * What each agent will actually connect to, proven against the installed CLIs
 * (`docs/superpowers/specs/2026-08-29-agent-config-surfaces.md` §1.2).
 *
 * **Codex has no SSE at all.** That is the one asymmetry that bites: an SSE server configured in Realm
 * reaches Claude and Cursor and is silently missing on Codex unless somebody says so out loud, which is
 * what `mcpSupportNote` and the adapters' drop-logging are for.
 *
 * `fake` takes none: the scripted adapter never spawns anything, and claiming otherwise would make an
 * offline dev session look like it had tools it does not have.
 */
export const AGENT_MCP_TRANSPORTS = {
  // claude-adapter.ts → SDK `mcpServers`; sdk.d.ts has McpStdioServerConfig / McpSSEServerConfig / McpHttpServerConfig.
  claude: ["stdio", "http", "sse"],
  // codex-adapter.ts → `thread/start` `config.mcp_servers`. RawMcpServerConfig carries `url` + `http_headers`; no SSE variant exists.
  codex: ["stdio", "http"],
  // acp-adapter.ts → `session/new` `mcpServers`. Cursor advertises `mcpCapabilities:{http:true,sse:true}` (verified live).
  "acp:cursor": ["stdio", "http", "sse"],
  // Same shape; Gemini advertises the same capabilities (research §7).
  "acp:gemini": ["stdio", "http", "sse"],
  // fake-adapter.ts never reads `mcpServers`.
  fake: [],
} as const satisfies Record<AgentKind, readonly McpTransport[]>;

export const agentSupportsTransport = (kind: AgentKind, transport: McpTransport): boolean =>
  (AGENT_MCP_TRANSPORTS[kind] as readonly McpTransport[]).includes(transport);

/**
 * One sentence naming the agent and the transports it will take. Always names the agent, so a note
 * rendered against the wrong session is visibly wrong rather than quietly misleading.
 */
export function mcpSupportNote(kind: AgentKind): string {
  const label = AGENT_META[kind].label;
  const supported = AGENT_MCP_TRANSPORTS[kind] as readonly McpTransport[];
  if (supported.length === 0) return `${label} does not connect to MCP servers, so this space's servers are ignored there.`;
  const missing = (McpTransportSchema.options as readonly McpTransport[]).filter((t) => !supported.includes(t));
  const takes = `${label} connects to this space's enabled ${supported.join(" and ")} servers`;
  return missing.length === 0 ? `${takes}.` : `${takes}; it has no ${missing.join(" or ")} support, so those are skipped.`;
}
