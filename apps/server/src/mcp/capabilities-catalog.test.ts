import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type McpServerConfig } from "@realm/adapters";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, type App } from "../app";
import { GoalsStore } from "../store/goals";
import { CAPABILITY_PROVIDERS, capabilitiesContext } from "./capabilities";

/**
 * What Realm tells an agent it can do, against the REAL gateway with every provider on: the preamble
 * names every tool a session can be listed, and `realm_capabilities` reports every one of them, live.
 * The first is the guard against drift — a provider that gains a tool fails here until its block in
 * `capabilities.ts` names it — and the second needs no guard, because it reads the gateway.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

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

/** A space with every provider listing — the opt-in three on, a simulator toolchain said to be
 *  present, a team (which brings the vault and a memory repo) and a goal running. `team: false` is
 *  the ordinary space beside it. */
async function boot(o: { team: boolean } = { team: true }) {
  app = await createApp({ home: tempDir("realm-catalog-"), port: 0, adapters: { fake: new FakeAdapter({ script: [] }) }, simulatorToolchain: async () => true });
  const c = await rpc(app.port);
  const profile = (await c.call("profiles.create", { name: "P" })).result;
  const space = (await c.call("spaces.create", { profileId: profile.id, name: "S" })).result;
  for (const name of ["realm-computer", "realm-vm", "realm-app"]) await c.call("mcp.setProviderEnabled", { spaceId: space.id, name, enabled: true });
  if (o.team) await app.team.makeTeam(space.id, [], { roles: [{ name: "Writer", brief: "Write.", realmite: { seed: "w" }, agentKind: "fake" }] });
  const session = app.sessions.create({ spaceId: space.id, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: "default" }).session;
  new GoalsStore(app.db).start({ sessionId: session.id, objective: "ship it", tokenBudget: null });
  const cfg = app.gateway.register(session.id, space.id) as Extract<McpServerConfig, { url: string }>;
  const client = new Client({ name: "t", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
  return { c, client, spaceId: space.id as string, sessionId: session.id };
}

/** Every tool the session is listed, once the simulator's probe has answered. */
async function allTools(client: Client): Promise<{ name: string; description?: string }[]> {
  let tools: { name: string; description?: string }[] = [];
  for (let i = 0; i < 100 && !tools.some((t) => t.name.startsWith("realm-simulator__")); i++) {
    tools = (await client.listTools()).tools;
    if (!tools.some((t) => t.name.startsWith("realm-simulator__"))) await new Promise((r) => setTimeout(r, 20));
  }
  return tools;
}

const text = (r: Any): string => r.content.map((x: Any) => x.text).join("\n");

describe("the capability map cannot drift from the tools", () => {
  it("describes every provider the app registers, and names every tool each one lists", async () => {
    const { c, client } = await boot();
    const tools = await allTools(client);
    // Every provider contributed, so one whose tools all went missing cannot pass by silence.
    expect(new Set(tools.map((t) => t.name.split("__")[0]))).toEqual(new Set(app.gateway.providerNames()));
    // THE MUTANT: register a new provider without a block. Its sessions are told nothing about it.
    expect([...app.gateway.providerNames()].sort()).toEqual([...CAPABILITY_PROVIDERS].sort());
    // THE MUTANT: add a tool to a provider without naming it in that provider's block. An agent that
    // never opens its (deferred) tool list then never learns the tool is there.
    const unnamed = tools.filter((t) => {
      const [provider, tool] = t.name.split("__") as [string, string];
      return !capabilitiesContext([provider]).includes(`\`${tool}\``);
    }).map((t) => t.name);
    expect(unnamed).toEqual([]);
    await client.close();
    c.close();
  });

  it("realm_capabilities lists every tool the session has, in that tool's own words", async () => {
    const { c, client } = await boot();
    const tools = await allTools(client);
    const catalog = text(await client.callTool({ name: "realm-workspace__realm_capabilities", arguments: {} }));
    // Derived from the gateway, so a tool added by any provider is here without anyone writing it in.
    // THE MUTANT: build the list from a fixed table — a tool added since is missing below.
    const missing = tools.filter((t) => !catalog.includes(`- ${t.name.split("__")[1]} — `)).map((t) => t.name);
    expect(missing).toEqual([]);
    expect(catalog).toContain("## In Realm, with no tool");
    await client.close();
    c.close();
  });
});

describe("realm_capabilities", () => {
  it("says which groups are off and where the user turns them on, and how each connection stands", async () => {
    const { c, client, spaceId } = await boot({ team: false });
    await c.call("mcp.setProviderEnabled", { spaceId, name: "realm-browser", enabled: false });
    await c.call("mcp.add", { name: "linear", transport: "stdio", command: "/nonexistent/linear-mcp", args: [], spaceId });
    const catalog = text(await client.callTool({ name: "realm-workspace__realm_capabilities", arguments: {} }));
    // THE MUTANT: list only the groups that have tools. The agent then cannot tell "Realm has no
    // browser" from "this space switched it off", and tells the user the first.
    expect(catalog).toContain("- realm-browser — off in this space — the user switches it on under \"Realm's own tools\" on the space's Connections page");
    expect(catalog).not.toContain("- browser_open — ");
    // Not a team, so no team tools — and the reason is said, not left to guess.
    expect(catalog).toMatch(/- realm-team — nothing to list in this space \(team tools only in a team's space/);
    expect(catalog).toContain("- linear — on, connects on first use");
    await client.close();
    c.close();
  });

  it("gives one group's tools in full", async () => {
    const { c, client } = await boot({ team: false });
    const one = text(await client.callTool({ name: "realm-workspace__realm_capabilities", arguments: { group: "realm-browser" } }));
    expect(one).toContain("## browser_fill_credential");
    // The whole description, past the first sentence the summary stops at.
    expect(one).toContain("Two-factor prompts (Duo, Okta, an emailed code) are not automated");
    const bad = await client.callTool({ name: "realm-workspace__realm_capabilities", arguments: { group: "realm-nope" } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("realm-browser");
    await client.close();
    c.close();
  });

  it("is a read — it runs without a prompt in every mode", async () => {
    const { c, client } = await boot({ team: false });
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "realm-workspace__realm_capabilities")?.annotations?.readOnlyHint).toBe(true);
    await client.close();
    c.close();
  });
});

describe("what a space IS decides what its sessions are told", () => {
  it("tells a session in an ordinary space nothing about a team, a vault or a memory repo it does not have", async () => {
    const { c, client, spaceId, sessionId } = await boot({ team: false });
    // THE MUTANT: `realmProvidersFor` ignoring `listsIn`. Every session in every space is then told
    // "the space has standing roles" and handed tools that refuse with "this space has no team".
    const providers = app.gateway.realmProvidersFor(sessionId, spaceId);
    expect(providers).not.toContain("realm-team");
    expect(providers).not.toContain("realm-vault");
    expect(providers).not.toContain("realm-memory");
    expect(capabilitiesContext(providers)).not.toContain("team_roles");
    await client.close();
    c.close();
  });

  it("and tells a team's session about its team", async () => {
    const { c, client, spaceId, sessionId } = await boot();
    const providers = app.gateway.realmProvidersFor(sessionId, spaceId);
    expect(providers).toEqual(expect.arrayContaining(["realm-team", "realm-vault", "realm-memory"]));
    await client.close();
    c.close();
  });
});
