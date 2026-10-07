#!/usr/bin/env node
/**
 * A tiny MCP server over stdio that ASKS — the fixture a live check connects as a Connection to see
 * an MCP server's elicitation reach Realm's card. Three tools, one per thing a server may ask:
 *
 *   create_issue       a form (a titled choice, an enum, an integer, a yes/no) mid-call
 *   connect_workspace  a page to open (URL mode)
 *   set_api_key        a form asking for a key — which a client must not draw
 *
 * Each returns, as its text, what the client answered, so the transcript shows the round trip.
 * The elicitation waits as long as the broker does: the SDK's own one-minute request default would
 * withdraw the question while the card is still up.
 *
 * Run with plain node from the repository: `node apps/server/src/mcp/fixtures/elicit-stdio.mjs`.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const WAIT = { timeout: 15 * 60_000 };
const server = new Server({ name: "linear-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });

const TOOLS = [
  { name: "create_issue", description: "Create an issue. Asks the user which team, and how urgent.", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
  { name: "connect_workspace", description: "Connect a workspace. Sends the user to a page to authorize it.", inputSchema: { type: "object", properties: {} } },
  { name: "set_api_key", description: "Asks for an API key in a form, which no client should draw.", inputSchema: { type: "object", properties: {} } },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const said = (text) => ({ content: [{ type: "text", text }] });
  if (name === "create_issue") {
    const r = await server.elicitInput({ mode: "form", message: `Where should “${args.title ?? "the issue"}” go?`, requestedSchema: {
      type: "object", required: ["team", "priority"],
      properties: {
        team: { type: "string", title: "Team", oneOf: [{ const: "eng", title: "Engineering" }, { const: "design", title: "Design" }, { const: "growth", title: "Growth" }] },
        priority: { type: "string", title: "Priority", enum: ["Urgent", "High", "Medium", "Low"], default: "Medium" },
        estimate: { type: "integer", title: "Estimate, in points", minimum: 1, maximum: 8 },
        notify: { type: "boolean", title: "Tell the team in Slack?", default: true },
      },
    } }, WAIT);
    return said(r.action === "accept" ? `Created ENG-421 “${args.title}” — ${JSON.stringify(r.content)}` : `Not created: the user chose ${r.action}.`);
  }
  if (name === "connect_workspace") {
    const r = await server.elicitInput({ mode: "url", elicitationId: "connect-1", url: "https://linear.app/oauth/authorize?client_id=realm-fixture&scope=read", message: "Connect your Linear workspace" }, WAIT);
    return said(r.action === "accept" ? "The user is authorizing in their browser." : `Not connected: the user chose ${r.action}.`);
  }
  if (name === "set_api_key") {
    const r = await server.elicitInput({ mode: "form", message: "Paste your Linear API key", requestedSchema: { type: "object", required: ["api_key"], properties: { api_key: { type: "string", title: "API key" } } } }, WAIT);
    return said(`The client answered ${r.action}.`);
  }
  return { content: [{ type: "text", text: `no tool ${name}` }], isError: true };
});

await server.connect(new StdioServerTransport());
