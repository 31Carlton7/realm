import { describe, expect, it } from "vitest";
import { noMcpServers } from "./no-mcp";

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
