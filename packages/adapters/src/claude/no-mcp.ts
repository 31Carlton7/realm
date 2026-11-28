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

/**
 * The prompt-cache switches the CLI reads from the env of an SDK call. `DISABLE_PROMPT_CACHING` is
 * checked before any TTL; then `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, the
 * `promptCacheTtl` setting and `ENABLE_PROMPT_CACHING_1H`, in that order; and
 * `CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL=5m` shortens whatever was picked (CLI 2.1.322).
 */
const PROMPT_CACHE_ENV = ["DISABLE_PROMPT_CACHING", "FORCE_PROMPT_CACHING_5M", "CLAUDE_CODE_PROMPT_CACHE_TTL", "ENABLE_PROMPT_CACHING_1H", "CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL"];

/**
 * A helper call's cache default, unless the person set a cache switch in their own environment.
 * Then Realm sends none of its own, not just the same key: its `DISABLE_PROMPT_CACHING` would beat
 * their `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`, and its 5m TTL would beat their `ENABLE_PROMPT_CACHING_1H`.
 * These calls pass `settingSources: []`, so their environment is the only choice of theirs that reaches them.
 */
export function promptCacheDefault(env: Record<string, string>): Record<string, string> {
  return PROMPT_CACHE_ENV.some((key) => process.env[key] !== undefined) ? {} : env;
}
