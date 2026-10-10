import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import WebSocket from "ws";
import { FakeAdapter, type FakeScript, type McpServerConfig } from "@realm/adapters";
import { recordPreset, recordTemplate } from "@realm/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, type App } from "../../app";
import { ProfilesStore } from "../../store/profiles";
import { SpacesStore } from "../../store/spaces";
import { waitFor } from "../../test-utils";

/**
 * Record types end to end: a team made from the creator starters keeps creators, a person adds Leads,
 * and a role — the scripted agent calling the real `realm-team` tools through the gateway — reads the
 * team's kinds, makes a lead in leads/ under its own name, and is told when it writes a section the
 * type does not name. The tools' words follow the team's types; their list never changes.
 */

let app: App;
afterEach(async () => { await app?.close(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const SCRIPT: FakeScript = [
  { on: "keep a lead", emit: [
    { kind: "call", tool: "realm-team__record_types", input: {} },
    { kind: "call", tool: "realm-team__record_update", input: { op: "create", type: "lead", name: "Acme Corp" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "leads/acme-corp", section: "Touches", entry: "2026-10-09 first email · sent" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "leads/acme-corp", section: "Gossip", entry: "Dana is moving teams" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "create", name: "Nobody" } },
    { kind: "call", tool: "realm-team__record_list", input: { type: "lead" } },
    { kind: "call", tool: "realm-team__record_list", input: { kind: "creators" } },
    { kind: "text", text: "Lead kept." },
  ] },
];

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 8000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const must = async (method: string, params: unknown) => { const r = await call(method, params); if (!r.ok) throw new Error(`${method}: ${r.error?.message}`); return r.result; };
  return { call, must, close: () => ws.close() };
}

async function boot() {
  const home = tempDir("realm-record-types-it-");
  const fake = new FakeAdapter({ script: SCRIPT, delayMs: 2 });
  app = await createApp({ home, port: 0, adapters: { fake, claude: fake }, agentRun: { fallbackKind: "fake" } });
  const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Versed", icon: "folder" });
  const c = await client(app.port);
  const team = await c.must("team.make", { spaceId: space.id, templates: ["creator-manager"] });
  const role = team.roles[0];
  await c.must("team.roleUpdate", { id: role.id, agentKind: "fake" });
  return { c, spaceId: space.id as string, roleId: role.id as string };
}

const runsOf = async (c: Any, roleId: string) => (await c.must("team.roleRuns", { id: roleId, limit: 20 })) as Any[];
const settled = (r: Any) => !["queued", "running", "blocked"].includes(r.state);
const toolResults = (sessionId: string) => app.sessions.events(sessionId, 0, 500).filter((e) => e.event.type === "tool_result").map((e) => e.event.payload as Any);
const text = (r: Any) => typeof r.content === "string" ? r.content : JSON.stringify(r.content);

async function toolsIn(spaceId: string) {
  const session = app.sessions.create({ spaceId, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: "default" }).session;
  const cfg = app.gateway.register(session.id, spaceId) as Extract<McpServerConfig, { url: string }>;
  const mcp = new Client({ name: "t", version: "1.0.0" }, { capabilities: {} });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
  const { tools } = await mcp.listTools();
  await mcp.close();
  return tools.filter((t) => t.name.startsWith("realm-team__"));
}

describe("record types over the wire", () => {
  it("a team made from the creator starters keeps creators, and its meta says so", async () => {
    const { c, spaceId } = await boot();
    const team = await c.must("team.space", { spaceId });
    expect(team.recordTypes.map((t: Any) => [t.key, t.folder, t.preset])).toEqual([["creator", "creators", "creator"]]);
    expect(app.db.prepare("SELECT template, template_version FROM team_meta WHERE space_id = ?").get(spaceId)).toEqual({ template: "creator-campaigns", template_version: 1 });
    // A second click adds nothing: no second type, no second line.
    await c.must("team.make", { spaceId, templates: ["creator-manager", "content-producer"] });
    expect((await c.must("team.recordTypes.list", { spaceId })).map((t: Any) => t.key)).toEqual(["creator"]);
    c.close();
  });

  it("a role reads the team's kinds and makes a lead in leads/, under its own name, from the lead's template", async () => {
    const { c, spaceId, roleId } = await boot();
    await c.must("team.recordTypes.create", { spaceId, preset: "lead" });
    await c.must("team.roleRun", { id: roleId, message: "keep a lead" });
    await waitFor(async () => (await runsOf(c, roleId)).every(settled), { timeout: 8000 });
    const rec = await c.must("team.record", { spaceId, path: "leads/acme-corp" });
    expect(rec).toMatchObject({ path: "leads/acme-corp.md", kind: "lead", name: "Acme Corp", status: "prospect", lastAuthor: "Creator Manager" });
    expect(rec.markdown.startsWith(recordTemplate(recordPreset("lead")!, "Acme Corp").trimEnd().split("\n## Touches")[0]!)).toBe(true);
    expect(rec.markdown).toMatch(/## Touches\n- 2026-10-09 first email · sent \[source: realm:session\//);
    // A section the type does not name is the person's Markdown too: kept, and said.
    expect(rec.markdown).toMatch(/## Gossip\n- Dana is moving teams/);
    const sid = (await runsOf(c, roleId))[0].sessionId;
    const results = toolResults(sid).map(text);
    expect(results[0]).toContain("- Creator (type `creator`): creators/<name>.md");
    expect(results[0]).toContain("- Lead (type `lead`): leads/<name>.md");
    expect(results[0]).toContain("## Accounts — one per line, with vault: device: consent: parts after \" · \"");
    expect(results[3]).toContain("Leads do not name a section \"Gossip\" (Notes, Touches); it is kept, and shows under Other.");
    // Two kinds and no `type`: refused, naming them.
    expect(results[4]).toContain("say which kind of record to make with `type` — it keeps creator (creators/), lead (leads/)");
    expect(results[5]).toBe("- leads/acme-corp.md — Acme Corp (prospect)");
    // v50's `kind: "creators"` still reads, as the creators folder.
    expect(results[6]).toContain("No records yet");
    expect(existsSync(join((await c.must("team.space", { spaceId })).repoPath, "creators", "nobody.md"))).toBe(false);
    c.close();
  });

  it("the record tools' words follow the team's types, and the list of tools does not change", async () => {
    const { c, spaceId } = await boot();
    const one = await toolsIn(spaceId);
    const update1 = one.find((t) => t.name === "realm-team__record_update")!;
    expect(update1.description).toContain("makes creators/<name>.md from its type's template");
    expect((update1.inputSchema.properties as Any).section.description).toBe("op add: Deal, Accounts, Deadlines or Content; omit for the head");
    await c.must("team.recordTypes.create", { spaceId, preset: "lead" });
    const two = await toolsIn(spaceId);
    expect(two.map((t) => t.name)).toEqual(one.map((t) => t.name));
    expect(two.map((t) => JSON.stringify(Object.keys(t.inputSchema.properties ?? {})))).toEqual(one.map((t) => JSON.stringify(Object.keys(t.inputSchema.properties ?? {}))));
    const update2 = two.find((t) => t.name === "realm-team__record_update")!;
    expect((update2.inputSchema.properties as Any).section.description).toBe("op add: Deal, Accounts, Deadlines, Content, Notes or Touches; omit for the head");
    expect(two.find((t) => t.name === "realm-team__record_types")?.annotations?.readOnlyHint).toBe(true);
    c.close();
  });

  it("no tool a role can call writes a type: the role's whole run leaves the types as the person set them", async () => {
    const { c, spaceId, roleId } = await boot();
    await c.must("team.recordTypes.create", { spaceId, preset: "lead" });
    const before = app.db.prepare("SELECT * FROM team_record_types ORDER BY id").all();
    const names = (await toolsIn(spaceId)).map((t) => t.name);
    expect(names.filter((n) => /record_type/.test(n))).toEqual(["realm-team__record_types"]);
    await c.must("team.roleRun", { id: roleId, message: "keep a lead" });
    await waitFor(async () => (await runsOf(c, roleId)).every(settled), { timeout: 8000 });
    expect(app.db.prepare("SELECT * FROM team_record_types ORDER BY id").all()).toEqual(before);
    c.close();
  });

  it("refuses to move a folder that holds records, over RPC, and makes the person a record of any kind", async () => {
    const { c, spaceId } = await boot();
    const lead = await c.must("team.recordTypes.create", { spaceId, preset: "lead" });
    const made = await c.must("team.recordCreate", { spaceId, name: "Acme Corp", type: "lead" });
    expect(made).toMatchObject({ path: "leads/acme-corp.md", kind: "lead" });
    expect(readFileSync(made.absPath, "utf8")).toBe(recordTemplate(recordPreset("lead")!, "Acme Corp"));
    const moved = await c.call("team.recordTypes.update", { id: lead.id, folder: "prospects" });
    expect(moved.ok).toBe(false);
    expect(moved.error.message).toContain("leads/ holds 1 record, so its folder stays");
    // Archived, it leaves the column; its file stays where it was.
    await c.must("team.recordTypes.archive", { id: lead.id });
    expect((await c.must("team.space", { spaceId })).recordTypes.map((t: Any) => t.key)).toEqual(["creator"]);
    expect(existsSync(made.absPath)).toBe(true);
    const activity = (await c.must("team.activity", { spaceId, limit: 50 })).map((a: Any) => a.verb);
    expect(activity).toEqual(expect.arrayContaining(["made_record_type", "archived_record_type", "adopted_record_type"]));
    c.close();
  });
});
