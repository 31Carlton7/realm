import { describe, expect, it } from "vitest";
import { selectMcpServers } from "./mcp-transport";
import type { McpServerConfig } from "./types";

const stdio = (name: string): McpServerConfig => ({ name, transport: "stdio", command: "/usr/bin/node", args: [], env: { K: "sk-live-do-not-log" } });
const http = (name: string): McpServerConfig => ({ name, transport: "http", url: "https://mcp.vercel.com", headers: { Authorization: "Bearer sk-live-do-not-log" } });
const sse = (name: string): McpServerConfig => ({ name, transport: "sse", url: "https://sse.example/mcp?token=sk-live-do-not-log", headers: {} });

describe("selectMcpServers", () => {
  it("keeps everything for an agent that takes everything", () => {
    const all = [stdio("a"), http("b"), sse("c")];
    const lines: string[] = [];
    expect(selectMcpServers("claude", all, (l) => lines.push(l)).map((s) => s.name)).toEqual(["a", "b", "c"]);
    expect(lines).toEqual([]);
  });

  it("drops sse for codex and keeps stdio and http", () => {
    // The named mutant: give codex "sse" in AGENT_MCP_TRANSPORTS and this passes an SSE URL to a client
    // that will dial it as HTTP. Configured, listed, connects to nothing.
    expect(selectMcpServers("codex", [stdio("a"), http("b"), sse("c")]).map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("says which server it dropped and why, because a silent skip is the failure being prevented", () => {
    const lines: string[] = [];
    selectMcpServers("codex", [sse("vercel")], (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"vercel"');
    expect(lines[0]).toContain("sse");
    expect(lines[0]).toContain("codex");
  });

  it("never puts a secret or a URL in that log line", () => {
    const lines: string[] = [];
    selectMcpServers("codex", [sse("vercel")], (l) => lines.push(l));
    selectMcpServers("fake", [stdio("a"), http("b")], (l) => lines.push(l));
    const all = lines.join("\n");
    expect(all).not.toContain("sk-live-do-not-log");
    expect(all).not.toContain("https://");
  });

  it("drops everything for the fake agent, which reads mcpServers not at all", () => {
    const lines: string[] = [];
    expect(selectMcpServers("fake", [stdio("a"), http("b"), sse("c")], (l) => lines.push(l))).toEqual([]);
    expect(lines).toHaveLength(3);
  });

  it("tolerates having no logger at all", () => {
    expect(() => selectMcpServers("codex", [sse("c")])).not.toThrow();
  });
});
