#!/usr/bin/env node
/**
 * A scripted ACP agent for `laya-live.mjs`: no model, nothing billed, and no network beyond Realm's own
 * MCP gateway on 127.0.0.1.
 *
 * It stands exactly where a real agent stands. Realm spawns it for a session (the live check points an
 * ACP kind's binary override at this file), hands it the session's gateway URL and token in
 * `session/new`, and on each prompt it drives `realm-computer` the way an agent would — snapshot the
 * app, find the element by its label in the tree the snapshot returned, and act on its index with an
 * intent. Everything between that call and the app is the real server.
 *
 * The steps are read from `$LAYA_LIVE_DIR/steps.json`; each outcome is appended to
 * `$LAYA_LIVE_DIR/agent.log`.
 */
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  console.log("laya-live-agent 1.0.0");
  process.exit(0);
}

const sdk = new URL("../../../server/node_modules/@modelcontextprotocol/sdk/dist/esm/", import.meta.url);
const { Client } = await import(new URL("client/index.js", sdk).href);
const { StreamableHTTPClientTransport } = await import(new URL("client/streamableHttp.js", sdk).href);

const dir = process.env.LAYA_LIVE_DIR;
const log = (entry) => appendFileSync(path.join(dir, "agent.log"), JSON.stringify(entry) + "\n");
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
let servers = [];

createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  void handle(m).catch((e) => log({ error: String(e?.stack ?? e) }));
});

async function handle(m) {
  if (m.method === "initialize") {
    return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, mcpCapabilities: { http: true, sse: false }, promptCapabilities: {} }, authMethods: [] } });
  }
  if (m.method === "session/new") {
    servers = m.params.mcpServers ?? [];
    return send({ id: m.id, result: { sessionId: "laya-live" } });
  }
  if (m.method === "session/prompt") {
    await turn(m.params.sessionId);
    return send({ id: m.id, result: { stopReason: "end_turn" } });
  }
  // Anything else a client asks (a mode, a model) is acknowledged and ignored: this agent has neither.
  if (m.id !== undefined && m.method) send({ id: m.id, result: {} });
}

async function turn(sessionId) {
  const realm = servers.find((s) => s.name === "realm");
  const headers = Object.fromEntries((realm?.headers ?? []).map((h) => [h.name, h.value]));
  const client = new Client({ name: "laya-live-agent", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(realm.url), { requestInit: { headers } }));
  const say = (text) => send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
  for (const step of JSON.parse(readFileSync(path.join(dir, "steps.json"), "utf8"))) {
    const snap = await client.callTool({ name: "realm-computer__computer_snapshot", arguments: { bundleId: step.bundleId } });
    const text = snap.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    const snapshotId = /Snapshot (\S+) of/.exec(text)?.[1];
    const index = findIndex(text, step.label);
    const act = await client.callTool({ name: "realm-computer__computer_act", arguments: { snapshotId, action: { kind: "click", index }, intent: step.intent } });
    const result = act.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    log({ intent: step.intent, label: step.label, snapshotId, index, isError: act.isError === true, result });
    say(`${step.intent}: ${result}\n`);
  }
  await client.close();
  log({ done: true });
}

/** `[N] AXButton "Label" …` — the first element whose name is exactly the label. */
function findIndex(text, label) {
  for (const line of text.split("\n")) {
    const m = /^\s*\[(\d+)\]\s+\S+\s+"((?:[^"\\]|\\.)*)"/.exec(line);
    if (m && m[2] === label) return Number(m[1]);
  }
  throw new Error(`no element labelled ${JSON.stringify(label)} in the snapshot`);
}
