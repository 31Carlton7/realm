import { describe, expect, it } from "vitest";
import { generateSvgIcon } from "./generate-svg-icon";

describe("generateSvgIcon", () => {
  it("loads no MCP servers and no claude.ai connectors", async () => {
    let options: unknown;
    const query = ((args: { options: unknown }) => {
      options = args.options;
      return (async function* () { yield { type: "result", subtype: "success", result: '<svg viewBox="0 0 48 48"></svg>' }; })();
    }) as never;
    expect(await generateSvgIcon("a kettle", { query })).toBe('<svg viewBox="0 0 48 48"></svg>');
    expect(options).toMatchObject({ mcpServers: {}, strictMcpConfig: true, env: expect.objectContaining({ ENABLE_CLAUDEAI_MCP_SERVERS: "false", PATH: process.env.PATH }) });
  });
});
