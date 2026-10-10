import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type McpServerConfig } from "@realm/adapters";
import { REALM_TOOL_CLASSES, type TeamPolicies } from "@realm/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, type App } from "../../app";
import { GoalsStore } from "../../store/goals";

/**
 * Realm's tool table against the REAL gateway and providers, every one of them switched on: each name
 * a session can be handed has a class, and each class is for a name that exists. Then the Policies
 * page's one method over the wire, with a real stdio server serving the four risk tools.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const HERE = fileURLToPath(new URL(".", import.meta.url));

let app: App;
afterEach(async () => { await app?.close(); });

async function rpc(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  let n = 0;
  ws.on("message", (d) => { const m = JSON.parse(d.toString()) as Any; if ("id" in m) pending.get(m.id)?.(m); });
  const call = (method: string, params: unknown) => new Promise<Any>((res) => { const id = String(++n); pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  return { call, close: () => ws.close() };
}

/** A team space with every provider on — the opt-in three included, a simulator toolchain said to be
 *  present, and a goal running — so nothing a session could ever be listed is held back. */
async function everything() {
  app = await createApp({ home: tempDir("realm-classes-"), port: 0, adapters: { fake: new FakeAdapter({ script: [] }) }, simulatorToolchain: async () => true });
  const c = await rpc(app.port);
  const profile = (await c.call("profiles.create", { name: "P" })).result;
  const space = (await c.call("spaces.create", { profileId: profile.id, name: "S" })).result;
  for (const name of ["realm-computer", "realm-vm", "realm-app"]) await c.call("mcp.setProviderEnabled", { spaceId: space.id, name, enabled: true });
  await app.team.makeTeam(space.id, [], { roles: [{ name: "Writer", brief: "Write.", realmite: { seed: "w" }, agentKind: "fake" }] });
  return { c, spaceId: space.id as string };
}

describe("REALM_TOOL_CLASSES is exhaustive", () => {
  it("classes every tool every provider lists, and nothing that no provider lists", async () => {
    const { c, spaceId } = await everything();
    const session = app.sessions.create({ spaceId, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: "default" }).session;
    new GoalsStore(app.db).start({ sessionId: session.id, objective: "ship it", tokenBudget: null });
    const cfg = app.gateway.register(session.id, spaceId) as Extract<McpServerConfig, { url: string }>;
    const client = new Client({ name: "t", version: "1.0.0" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
    let names: string[] = [];
    // The simulator's toolchain answer arrives on its own probe; list until it has.
    for (let i = 0; i < 100 && !names.some((n) => n.startsWith("realm-simulator__")); i++) {
      names = (await client.listTools()).tools.map((t) => t.name);
      if (!names.some((n) => n.startsWith("realm-simulator__"))) await new Promise((r) => setTimeout(r, 20));
    }
    // Every provider contributed, so a provider whose tools all went missing cannot pass by silence.
    expect(new Set(names.map((n) => n.split("__")[0]))).toEqual(new Set(app.gateway.providerNames()));
    // THE MUTANT: a tool added to a provider without a line in the table.
    expect(names.filter((n) => !REALM_TOOL_CLASSES[n])).toEqual([]);
    expect(Object.keys(REALM_TOOL_CLASSES).filter((n) => !names.includes(n))).toEqual([]);
    await client.close();
    c.close();
  });
});

describe("team.policies", () => {
  it("classes a server's four tools by their labels and names, and says every call asks today", async () => {
    const { c, spaceId } = await everything();
    const tsx = join(HERE, "..", "..", "..", "node_modules", ".bin", "tsx");
    const added = await c.call("mcp.add", { spaceId, name: "stub", transport: "stdio", command: tsx, args: [join(HERE, "..", "..", "mcp", "fixtures", "stub-stdio.ts")], env: { PATH: process.env.PATH ?? "", STUB_TOOLS: "risk" } });
    expect(added.error).toBeUndefined();
    const r = await c.call("team.policies", { spaceId });
    expect(r.error).toBeUndefined();
    const view = r.result as TeamPolicies;
    const stub = view.connectors.find((x) => x.connector === `mcp:${added.result.id}`)!;
    expect(stub).toMatchObject({ kind: "server", name: "stub", reached: true });
    expect(Object.fromEntries(stub.tools.map((t) => [t.tool, [t.class, t.source, t.floor, t.asksToday]]))).toEqual({
      read_thing: ["read", "server", null, true],
      save_thing: ["reversible-external", "server", null, true],
      send_thing: ["irreversible-external", "unclassified", null, true],
      send_quietly: ["irreversible-external", "server", "send", true],
    });
    // Realm's own: grouped by provider, every one of them classed by Realm, and the promptless reads
    // the only calls that do not ask.
    const docs = view.connectors.find((x) => x.connector === "realm:realm-docs")!;
    expect(docs).toMatchObject({ kind: "realm", name: "Documents" });
    expect(docs.tools.filter((t) => !t.asksToday).map((t) => t.tool)).toEqual(["docs_search", "docs_read", "docs_state"]);
    expect(view.connectors.filter((x) => x.kind === "realm").flatMap((x) => x.tools).every((t) => t.source === "realm")).toBe(true);
    expect((await c.call("team.policies", { spaceId: "01J00000000000000000000000" })).error.code).toBe("NOT_FOUND");
    c.close();
  }, 30_000);
});
