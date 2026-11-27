import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import WebSocket from "ws";
import { FakeAdapter, type McpServerConfig } from "@realm/adapters";
import { REALM_READ_ONLY_TOOLS } from "@realm/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { GoalsStore } from "../store/goals";

/**
 * `REALM_READ_ONLY_TOOLS` against the REAL gateway and providers: every name on it is a tool Realm
 * actually lists, it is the only thing marked `readOnlyHint` (what Codex reads to skip its approval),
 * and calling each one leaves Realm's database exactly as it was.
 */
let app: App;
afterEach(async () => { await app?.close(); });

async function connect() {
  const home = tempDir("realm-ro-");
  app = await createApp({ home, port: 0, adapters: { fake: new FakeAdapter({ script: [] }) } });
  const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "S", icon: "folder" });
  writeFileSync(join(space.folderPath, "notes.md"), "lecture one\nlecture two\n");
  // The team tools are only listed in a space with teammates, the memory tools where it has a repo.
  const writer = app.team.create({ spaceId: space.id, name: "Writer", brief: "Write.", agentKind: "fake", lead: true });
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}`);
    ws.once("open", () => ws.send(JSON.stringify({ id: "1", method: "memory.repo.create", params: { scope: "space", ownerId: space.id } })));
    ws.on("message", (d) => { if ((JSON.parse(d.toString()) as { id?: string }).id === "1") { ws.close(); resolve(); } });
    ws.once("error", reject);
  });
  const session = app.sessions.create({ spaceId: space.id, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: "default" }).session;
  // The goal tools are only listed while a goal is active.
  new GoalsStore(app.db).start({ sessionId: session.id, objective: "ship it", tokenBudget: null });
  const cfg = app.gateway.register(session.id, space.id) as Extract<McpServerConfig, { url: string }>;
  const client = new Client({ name: "t", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
  // `space_teams` answers only the Lead, in its own chat.
  const leadCfg = app.gateway.register(writer.homeSessionId!, space.id) as Extract<McpServerConfig, { url: string }>;
  const lead = new Client({ name: "t", version: "1.0.0" }, { capabilities: {} });
  await lead.connect(new StreamableHTTPClientTransport(new URL(leadCfg.url), { requestInit: { headers: leadCfg.headers } }));
  return { client, lead, sessionId: session.id };
}

/** Every row of every table, hashed: a tool that writes anything changes this. The gateway's own
 *  call log is left out — it records every call, whatever the tool did. */
function dbFingerprint(): string {
  const tables = app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'mcp_call_log' ORDER BY name").all() as { name: string }[];
  const h = createHash("sha256");
  for (const { name } of tables) h.update(name).update(JSON.stringify(app.db.prepare(`SELECT * FROM "${name}"`).all()));
  return h.digest("hex");
}

describe("Realm's read-only tools, through the real gateway", () => {
  it("marks exactly the listed tools readOnlyHint, and every listed tool exists", async () => {
    const { client, lead } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const t of REALM_READ_ONLY_TOOLS) expect(names, t).toContain(t);
    const marked = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
    expect(marked.sort()).toEqual([...REALM_READ_ONLY_TOOLS].sort());
    await client.close();
    await lead.close();
  });

  it("changes nothing in Realm's database when each one is called", async () => {
    const { client, lead, sessionId } = await connect();
    const leadOnly = new Set(["realm-team__space_teams"]);
    const args: Record<string, Record<string, unknown>> = {
      "realm-docs__docs_search": { query: "lecture" },
      "realm-docs__docs_read": { path: "notes.md" },
      "realm-workspace__session_read": { sessionId },
      "realm-memory__memory_read": { path: "MEMORY" },
      "realm-team__teammate_get": { to: "writer" },
      "realm-team__teammate_sessions": { to: "writer" },
      "realm-memory__memory_search": { query: "memory" },
      "realm-browser__browser_snapshot": { browserId: "b_none" },
      "realm-browser__browser_read": { browserId: "b_none" },
      "realm-browser__browser_screenshot": { browserId: "b_none" },
    };
    const answered = new Map<string, boolean>();
    for (const name of REALM_READ_ONLY_TOOLS) {
      const before = dbFingerprint();
      const r = await (leadOnly.has(name) ? lead : client).callTool({ name, arguments: args[name] ?? {} });
      expect(dbFingerprint(), name).toBe(before);
      answered.set(name, r.isError === true);
    }
    // A call refused before its handler read anything would prove nothing: these must have ANSWERED.
    // The browser three have no pane to point at here, and refuse after looking it up.
    const refused = [...answered].filter(([n, isError]) => isError && !n.startsWith("realm-browser__")).map(([n]) => n);
    expect(refused).toEqual([]);
    await client.close();
    await lead.close();
  });
});
