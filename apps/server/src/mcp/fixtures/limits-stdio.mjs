#!/usr/bin/env node
/**
 * An MCP server over stdio for checking that Realm puts no limits of its own on a server: a tool that
 * takes as long as it is asked to, as many tools as it is asked for, and tool names as long as it is
 * asked for. Plain node, so a test can kill the very process the hub started.
 *
 *   LIMITS_TOOLS=300        serve 300 `tool_NNN` tools besides `slow` (default 0)
 *   LIMITS_NAME_LENGTH=120  serve one more tool whose name is this long
 *   LIMITS_START_MS=8000    wait this long before speaking at all, like a first `npx -y` run
 *   LIMITS_RESULT_META=1    put the `_meta` Realm's gateway puts on every tool on `big`
 *
 * `slow` answers after `seconds` (default `STUB_DELAY_MS`, else 90 s), saying how long it took; `big`
 * answers `chars` characters of numbered words, for what an engine does with a large result.
 *
 * Run with plain node from the repository: `node apps/server/src/mcp/fixtures/limits-stdio.mjs`.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const count = Number(process.env.LIMITS_TOOLS) || 0;
const nameLength = Number(process.env.LIMITS_NAME_LENGTH) || 0;
const startMs = Number(process.env.LIMITS_START_MS) || 0;
const defaultMs = Number(process.env.STUB_DELAY_MS) || 90_000;

const object = { type: "object", properties: {} };
const tools = [
  { name: "slow", description: "Works for `seconds` before it answers.", inputSchema: { type: "object", properties: { seconds: { type: "number" } } } },
  { name: "big", description: "Answers `chars` characters of text.", inputSchema: { type: "object", properties: { chars: { type: "number" } } },
    ...(process.env.LIMITS_RESULT_META ? { _meta: { "anthropic/maxResultSizeChars": 500_000 } } : {}) },
  ...Array.from({ length: count }, (_, i) => ({ name: `tool_${String(i + 1).padStart(3, "0")}`, description: `Numbered tool ${i + 1} of ${count}.`, inputSchema: object })),
  ...(nameLength > 0 ? [{ name: "long_".padEnd(nameLength, "x"), description: "A tool with a long name.", inputSchema: object }] : []),
];

const server = new Server({ name: "limits-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  if (name === "slow") {
    const ms = typeof args.seconds === "number" ? args.seconds * 1000 : defaultMs;
    const started = Date.now();
    await new Promise((r) => setTimeout(r, ms));
    return { content: [{ type: "text", text: `slow answered after ${Math.round((Date.now() - started) / 1000)}s` }] };
  }
  if (name === "big") {
    const chars = typeof args.chars === "number" ? args.chars : 100_000;
    let text = "";
    for (let i = 0; text.length < chars; i++) text += `word${i} `;
    return { content: [{ type: "text", text: text.slice(0, chars) }] };
  }
  if (!tools.some((t) => t.name === name)) return { content: [{ type: "text", text: `no tool ${name}` }], isError: true };
  return { content: [{ type: "text", text: `${name} ran` }] };
});

if (startMs > 0) await new Promise((r) => setTimeout(r, startMs));
await server.connect(new StdioServerTransport());
