import { AGENT_MCP_TRANSPORTS, agentSupportsTransport, type AgentKind } from "@realm/contracts";
import type { McpServerConfig } from "./types";

/**
 * The servers this agent can actually reach, with every skipped one announced.
 *
 * Every adapter runs its `mcpServers` through this before translating. Two things make it worth a
 * shared function rather than a filter inline in each adapter:
 *
 *   - **Codex has no SSE.** Passing an SSE server to Codex as though it were HTTP produces a server
 *     that is configured, listed, and connects to nothing. Dropping it is the correct behaviour; doing
 *     it quietly is not.
 *   - The log line is the only thing standing between "my server is not working" and an afternoon.
 *
 * Only the name and the transport are logged. A URL can carry a token in its query string and `env`
 * and `headers` are secrets by definition — none of them belong in a log Realm prints to the console.
 */
export function selectMcpServers(kind: AgentKind, servers: readonly McpServerConfig[], onLog?: (line: string) => void): McpServerConfig[] {
  const kept: McpServerConfig[] = [];
  for (const s of servers) {
    if (agentSupportsTransport(kind, s.transport)) { kept.push(s); continue; }
    const takes = AGENT_MCP_TRANSPORTS[kind];
    onLog?.(`[mcp] skipping "${s.name}": ${kind} has no ${s.transport} transport (it takes ${takes.length ? takes.join(", ") : "none"})`);
  }
  return kept;
}
