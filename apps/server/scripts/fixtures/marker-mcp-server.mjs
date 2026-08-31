#!/usr/bin/env node
/**
 * The smallest MCP stdio server that can prove it was started.
 *
 * `live-mcp-check.ts` hands this to a real agent CLI as a client-supplied server and then waits for the
 * marker file. The marker is written on **startup**, before any handshake, because that is the claim
 * under test — that the server Realm configured is the server the agent spawned — and it needs no model
 * turn, no tokens and no cooperation from the agent's planner to establish.
 *
 *   argv[2]  absolute path of the marker file to write
 *
 * The marker records whether `REALM_MCP_PROBE_TOKEN` arrived with the expected value, which is what
 * proves `env` survived each protocol's own shape (ACP's array-of-pairs above all). It records the
 * VERDICT, never the token: a fixture that echoed a secret into a file the check prints would be the
 * very leak the rest of this work is built to avoid.
 *
 * After the marker it speaks just enough MCP 2025-06-18 to be a well-behaved server — `initialize`,
 * `notifications/initialized`, `tools/list`, `tools/call` — so the agent does not report a crash.
 */
import { writeFileSync } from "node:fs";

const marker = process.argv[2];
const expected = process.argv[3] ?? "";
if (!marker) { process.stderr.write("marker-mcp-server: no marker path\n"); process.exit(2); }

writeFileSync(marker, JSON.stringify({
  startedAt: Date.now(),
  args: process.argv.slice(4),
  // A verdict, not the value.
  token: process.env.REALM_MCP_PROBE_TOKEN === undefined ? "absent"
    : process.env.REALM_MCP_PROBE_TOKEN === expected ? "match" : "mismatch",
}) + "\n");

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const TOOL = { name: "realm_marker", description: "Realm live-check marker. Returns ok.", inputSchema: { type: "object", properties: {} } };

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined) continue; // a notification: nothing to answer
    if (m.method === "initialize") {
      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "realm-marker", version: "0.0.1" } } });
    } else if (m.method === "tools/list") {
      send({ jsonrpc: "2.0", id: m.id, result: { tools: [TOOL] } });
    } else if (m.method === "tools/call") {
      send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }], isError: false } });
    } else {
      send({ jsonrpc: "2.0", id: m.id, result: {} });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
