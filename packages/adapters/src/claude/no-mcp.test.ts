import { afterEach, describe, expect, it, vi } from "vitest";
import { noMcpServers, promptCacheDefault } from "./no-mcp";

describe("noMcpServers", () => {
  it("passes no servers, ignores every configured one, and turns the claude.ai connectors off", () => {
    const o = noMcpServers();
    expect(o.mcpServers).toEqual({});
    expect(o.strictMcpConfig).toBe(true);
    expect(o.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
  });

  it("carries the rest of the environment, since `env` replaces the child's, and adds the call's own", () => {
    const o = noMcpServers({ DISABLE_PROMPT_CACHING: "1" });
    expect(o.env?.PATH).toBe(process.env.PATH);
    expect(o.env?.DISABLE_PROMPT_CACHING).toBe("1");
    expect(o.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
  });
});

describe("promptCacheDefault", () => {
  const keys = ["DISABLE_PROMPT_CACHING", "FORCE_PROMPT_CACHING_5M", "CLAUDE_CODE_PROMPT_CACHE_TTL", "ENABLE_PROMPT_CACHING_1H", "CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL"];
  afterEach(() => { vi.unstubAllEnvs(); });

  it("is Realm's default when the person set no cache switch", () => {
    for (const key of keys) vi.stubEnv(key, undefined);
    expect(promptCacheDefault({ DISABLE_PROMPT_CACHING: "1" })).toEqual({ DISABLE_PROMPT_CACHING: "1" });
  });

  it("is nothing at all once the person set any cache switch, so theirs is the only one the CLI reads", () => {
    for (const set of keys) {
      for (const key of keys) vi.stubEnv(key, key === set ? "1h" : undefined);
      expect(promptCacheDefault({ DISABLE_PROMPT_CACHING: "1" }), set).toEqual({});
      expect(promptCacheDefault({ CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" }), set).toEqual({});
    }
  });
});
