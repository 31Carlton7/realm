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

/**
 * One configured MCP server, as `mcp.list` reports it.
 *
 * **No secret values appear here, ever.** `envKeys` and `headerKeys` name what is set; the values stay
 * in the database and travel only to the agent that was configured to receive them. A settings UI can
 * therefore show "AIRTABLE_API_KEY is set" and offer to replace it, and nothing that is logged,
 * broadcast, or screenshotted can leak the key — including this object.
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
