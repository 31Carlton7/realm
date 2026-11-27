import type { Options } from "@anthropic-ai/claude-agent-sdk";

/**
 * The options that keep every MCP server out of a call Realm makes on its own: a recap, a title,
 * memory, a hand-off, dictation, an icon, a live answer. None of them uses a tool, and with
 * `tools: []` the CLI also drops its ToolSearch tool, so any server that loads is inlined whole
 * rather than deferred. That was ~240 claude.ai connector schemas on every recap from Nov 16.
 *
 * Two switches, because they stop different things (CLI 2.1.322, read off its debug log):
 *  - `strictMcpConfig` leaves out the servers in the person's config (user `.claude.json`, project
 *    `.mcp.json`, plugins). `mcpServers: {}` on its own passes no flag at all.
 *  - `ENABLE_CLAUDEAI_MCP_SERVERS=false` stops the claude.ai connector fetch. Under strict config
 *    alone the CLI still starts that fetch.
 *
 * `env` replaces the child's environment, so the rest of it is passed on; `extraEnv` is for the
 * call's own variables.
 */
export function noMcpServers(extraEnv: Record<string, string> = {}): Pick<Options, "mcpServers" | "strictMcpConfig" | "env"> {
  return {
    mcpServers: {},
    strictMcpConfig: true,
    env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false", ...extraEnv },
  };
}
