import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncQueue, type AgentAdapter, type AgentHandle, type StartOptions } from "@realm/adapters";
import { sessionEvent, type SessionEvent } from "@realm/contracts";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";
import { makeStubAuthServer, type StubAuthServer } from "./fixtures/stub-auth-server";

let app: App;
const authServers: StubAuthServer[] = [];
afterEach(async () => {
  await app?.close();
  for (const as of authServers.splice(0)) await as.close();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Never a real key. Every assertion here is about where it does NOT appear. */
const KEY = "pat-do-not-leak-me";

/** Stands in for a real adapter under a real agent kind, and records the StartOptions it was handed. */
class RecordingAdapter implements AgentAdapter {
  readonly starts: StartOptions[] = [];
  readonly logs: string[] = [];
  constructor(readonly kind: "claude" | "codex") {}
  async probe() { return { kind: this.kind, available: true, version: "0", loggedIn: true, reason: null }; }
  start(opts: StartOptions): AgentHandle {
    this.starts.push(opts);
    const events = new AsyncQueue<SessionEvent>();
    events.push(sessionEvent("init", { providerSessionId: "prov_1", model: "m", tools: [], cwd: opts.cwd }));
    events.push(sessionEvent("status", { status: "idle" }));
    return {
      events,
      send: async () => { events.push(sessionEvent("assistant_text", { messageId: "m1", text: "ok" })); events.push(sessionEvent("status", { status: "idle" })); },
      respondPermission: () => {},
      interrupt: async () => {},
      setOptions: async () => {},
      dispose: async () => { events.close(); },
    };
  }
}

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>(); const events: Any[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 5000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, events, close: () => ws.close() };
}

async function boot() {
  const home = mkdtempSync(join(tmpdir(), "realm-mcp-int-"));
  const claude = new RecordingAdapter("claude");
  app = await createApp({ home, port: 0, adapters: { claude } });
  const c = await client(app.port);
  const profile = (await c.call("profiles.create", { name: "P" })).result;
  const work = (await c.call("spaces.create", { profileId: profile.id, name: "Work" })).result;
  const school = (await c.call("spaces.create", { profileId: profile.id, name: "School" })).result;
  return { c, claude, work, school };
}

/** Start a session in `spaceId` and return the StartOptions the adapter was handed. */
async function startSession(c: Any, adapter: RecordingAdapter, spaceId: string): Promise<StartOptions> {
  const before = adapter.starts.length;
  const { session } = (await c.call("sessions.create", { spaceId, agentKind: "claude" })).result;
  await c.call("sessions.send", { id: session.id, text: "go" });
  await waitFor(() => adapter.starts.length > before);
  return adapter.starts[before]!;
}

const addStdio = (c: Any, spaceId: string | null, name: string) =>
  c.call("mcp.add", { spaceId, name, transport: "stdio", command: "/usr/bin/node", args: ["/abs/s.mjs"], env: { AIRTABLE_API_KEY: KEY } });

// W3: the passthrough this describe block used to exercise (`configFor` → an adapter receiving the
// space's raw server configs) is gone. Every session now receives exactly one `realm` gateway entry
// regardless of what is enabled — that shape is covered by `sessions/service.test.ts` (the fake-adapter
// wiring test), and which upstream tools a space's policy actually exposes THROUGH that gateway entry is
// `mcp/gateway.test.ts`'s job, over real HTTP against a stub upstream. Nothing here can still assert on
// `mcpServers` contents without re-introducing the direct passthrough this workstream removed.

describe("mcp over rpc", () => {
  it("never puts a secret value on the wire, in a result or in an event", async () => {
    // The named mutant: secrets echoed into an event payload. `mcp.changed` carries no payload at all,
    // and every result is the key-names projection.
    const { c, claude, work } = await boot();
    const added = await addStdio(c, work.id, "airtable");
    const listed = await c.call("mcp.list", { spaceId: work.id });
    const updated = await c.call("mcp.update", { spaceId: work.id, id: added.result.id, name: "airtable2" });
    await startSession(c, claude, work.id);
    await waitFor(() => c.events.some((e: Any) => e.event === "mcp.changed"));
    const everything = JSON.stringify([added, listed, updated, c.events]);
    expect(everything).not.toContain(KEY);
    expect(listed.result.servers[0].envKeys).toEqual(["AIRTABLE_API_KEY"]);
    c.close();
  });

  it("returns the storage note on every list, so a key-taking UI cannot forget it", async () => {
    const { c, work } = await boot();
    const listed = await c.call("mcp.list", { spaceId: work.id });
    expect(listed.result.secretNote).toMatch(/plain text/);
    c.close();
  });

  it("broadcasts mcp.changed on add, edit, toggle and remove", async () => {
    const { c, work } = await boot();
    const count = () => c.events.filter((e: Any) => e.event === "mcp.changed").length;
    const added = await addStdio(c, work.id, "airtable");
    await waitFor(() => count() === 1);
    await c.call("mcp.update", { spaceId: work.id, id: added.result.id, name: "renamed" });
    await waitFor(() => count() === 2);
    await c.call("mcp.setEnabled", { spaceId: work.id, id: added.result.id, enabled: false });
    await waitFor(() => count() === 3);
    await c.call("mcp.remove", { id: added.result.id });
    await waitFor(() => count() === 4);
    expect((await c.call("mcp.list", { spaceId: work.id })).result.servers).toEqual([]);
    c.close();
  });

  it("refuses a space that does not exist rather than writing preferences for it", async () => {
    const { c } = await boot();
    const ghost = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    for (const [method, params] of [
      ["mcp.list", { spaceId: ghost }],
      ["mcp.add", { spaceId: ghost, name: "x", transport: "stdio", command: "/bin/x" }],
      ["mcp.setEnabled", { spaceId: ghost, id: "01ARZ3NDEKTSV4RRFFQ69G5FAY", enabled: true }],
    ] as const) {
      expect((await c.call(method, params)).error?.code).toBe("NOT_FOUND");
    }
    c.close();
  });

  it("reports a bad definition as an error code rather than storing it", async () => {
    const { c, work } = await boot();
    expect((await c.call("mcp.add", { spaceId: work.id, name: "empty", transport: "stdio" })).error?.code).toBe("MCP_INCOMPLETE");
    await addStdio(c, work.id, "airtable");
    expect((await addStdio(c, work.id, "airtable")).error?.code).toBe("MCP_NAME_TAKEN");
    expect((await c.call("mcp.list", { spaceId: work.id })).result.servers).toHaveLength(1);
    c.close();
  });

  it("scopes a space-added server to its space; promote shares it disarmed; remove clears every space (W2)", async () => {
    // The named mutants, over the real RPC wire: a space-scoped server leaking into a sibling's list;
    // promotion arming a space that had not opted in; `mcp.remove` leaving another space's state behind.
    // `McpService`'s own unit tests prove the store-level behavior; this is the wiring check.
    const { c, work, school } = await boot();
    const server = (await addStdio(c, work.id, "airtable")).result;
    expect(server.scope).toEqual({ kind: "space", spaceId: work.id });
    // Defined in Work: School does not even list it — that is what "defined in this space" means now.
    expect((await c.call("mcp.list", { spaceId: school.id })).result.servers).toEqual([]);
    await c.call("mcp.promote", { spaceId: work.id, id: server.id });
    // Inherited everywhere in the profile — ON where it was on (Work), OFF where nobody opted in (School).
    expect((await c.call("mcp.list", { spaceId: work.id })).result.servers[0]).toMatchObject({ enabled: true, scope: { kind: "profile" } });
    expect((await c.call("mcp.list", { spaceId: school.id })).result.servers[0]).toMatchObject({ enabled: false, scope: { kind: "profile" } });
    // The panels' existing toggle flips the override for an inherited row.
    await c.call("mcp.setEnabled", { spaceId: school.id, id: server.id, enabled: true });
    expect((await c.call("mcp.list", { spaceId: school.id })).result.servers[0]).toMatchObject({ enabled: true });
    await c.call("mcp.remove", { id: server.id });
    expect((await c.call("mcp.list", { spaceId: school.id })).result.servers).toEqual([]);
    expect((await c.call("mcp.list", { spaceId: work.id })).result.servers).toEqual([]);
    c.close();
  });

  it("mcp.providers.list names the gateway's registered providers with THIS space's switch state (W4)", async () => {
    const { c, work, school } = await boot();
    // The real app registers both built-in providers; every space lists them, default ON.
    const before = (await c.call("mcp.providers.list", { spaceId: work.id })).result.providers;
    expect(before).toEqual([{ name: "realm-browser", enabled: true }, { name: "realm-agent", enabled: true }]);
    await c.call("mcp.setProviderEnabled", { spaceId: work.id, name: "realm-browser", enabled: false });
    // The disable is per-space: Work reads OFF, School still reads ON.
    expect((await c.call("mcp.providers.list", { spaceId: work.id })).result.providers).toEqual(
      [{ name: "realm-browser", enabled: false }, { name: "realm-agent", enabled: true }]);
    expect((await c.call("mcp.providers.list", { spaceId: school.id })).result.providers[0]).toEqual({ name: "realm-browser", enabled: true });
    // Same ghost-space refusal as every other per-space mcp method.
    expect((await c.call("mcp.providers.list", { spaceId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ" })).error?.code).toBe("NOT_FOUND");
    c.close();
  });
});

describe("oauth over rpc — the whole flow through a real app", () => {
  it("connects a remote server end to end: RPC start → browser redirect → gateway callback → status", async () => {
    // The only test that exercises `app.ts`'s actual wiring: the RPC handler, `McpOauth`, the real
    // gateway listener's callback route, and the status broadcast, against a stub authorization server
    // on loopback. Nothing here touches a real provider.
    const { c, work } = await boot();
    const as = await makeStubAuthServer();
    authServers.push(as);
    const server = (await c.call("mcp.add", { spaceId: work.id, name: "remote", transport: "http", url: `${as.url}/mcp` })).result;
    expect(server).toMatchObject({ authKind: "none", oauthStatus: "unconfigured" });

    const { authUrl } = (await c.call("mcp.oauth.start", { id: server.id })).result;
    // The redirect URI the flow minted points at THIS app's gateway port, so following the stub's
    // redirect is exactly what the user's browser would do.
    const redirect = as.authorize(authUrl);
    expect(redirect).toContain("/oauth/callback");
    const page = await fetch(redirect);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Connected — return to Realm.");

    await waitFor(() => c.events.some((e: Any) => e.event === "mcp.serverStatus" && e.payload.id === server.id && e.payload.oauthStatus === "connected"));
    const listed = await c.call("mcp.list", { spaceId: work.id });
    expect(listed.result.servers[0]).toMatchObject({ authKind: "oauth", oauthStatus: "connected" });
    // The token exists on the row by now, and no result or event has ever carried it.
    expect(JSON.stringify([listed, c.events])).not.toContain(as.lastIssuedAccessToken()!);

    await c.call("mcp.oauth.disconnect", { id: server.id });
    await waitFor(() => c.events.some((e: Any) => e.event === "mcp.serverStatus" && e.payload.id === server.id && e.payload.oauthStatus === "unconfigured"));
    expect((await c.call("mcp.list", { spaceId: work.id })).result.servers[0]).toMatchObject({ authKind: "none", oauthStatus: "unconfigured" });
    c.close();
  });

  /** Add a remote server and take it all the way through a real OAuth connection. */
  async function connected(c: Any, spaceId: string, name = "remote"): Promise<{ as: StubAuthServer; id: string }> {
    const as = await makeStubAuthServer();
    authServers.push(as);
    const server = (await c.call("mcp.add", { spaceId, name, transport: "http", url: `${as.url}/mcp` })).result;
    const { authUrl } = (await c.call("mcp.oauth.start", { id: server.id })).result;
    await fetch(as.authorize(authUrl));
    await waitFor(async () => (await c.call("mcp.list", { spaceId })).result.servers.find((s: Any) => s.id === server.id)?.oauthStatus === "connected");
    return { as, id: server.id };
  }

  it("repointing a server's URL drops the OAuth connection minted for the old host", async () => {
    // A settings typo must not send a credential granted for server A to server B. Over-clearing costs
    // one Connect click; under-clearing hands a live token to a host the user never authorized.
    const { c, work } = await boot();
    const { as, id } = await connected(c, work.id);
    const other = await makeStubAuthServer();
    authServers.push(other);

    const updated = (await c.call("mcp.update", { spaceId: work.id, id, url: `${other.url}/mcp` })).result;
    // The RESULT itself must already be honest — not just the next `mcp.list`.
    expect(updated).toMatchObject({ authKind: "none", oauthStatus: "unconfigured" });
    const listed = (await c.call("mcp.list", { spaceId: work.id })).result.servers[0];
    expect(listed).toMatchObject({ authKind: "none", oauthStatus: "unconfigured" });
    expect(JSON.stringify([updated, listed, c.events])).not.toContain(as.lastIssuedAccessToken()!);
    await waitFor(() => c.events.some((e: Any) => e.event === "mcp.serverStatus" && e.payload.id === id && e.payload.oauthStatus === "unconfigured"));
    c.close();
  });

  it("switching a server to stdio drops it too, rather than leaving a Connect button that can only error", async () => {
    const { c, work } = await boot();
    const { id } = await connected(c, work.id);
    const updated = (await c.call("mcp.update", { spaceId: work.id, id, transport: "stdio", command: "/usr/bin/node" })).result;
    expect(updated).toMatchObject({ transport: "stdio", authKind: "none", oauthStatus: "unconfigured" });
    // And a Connect attempt now refuses honestly instead of half-working.
    expect((await c.call("mcp.oauth.start", { id })).error?.code).toBe("MCP_OAUTH_UNSUPPORTED");
    c.close();
  });

  it("an edit that leaves the endpoint alone keeps the connection", async () => {
    // The guard has to be narrow: renaming a server, or editing one that never used OAuth, must not
    // silently cost the user a re-authorization.
    const { c, work } = await boot();
    const { id } = await connected(c, work.id);
    const renamed = (await c.call("mcp.update", { spaceId: work.id, id, name: "renamed" })).result;
    expect(renamed).toMatchObject({ name: "renamed", authKind: "oauth", oauthStatus: "connected" });
    c.close();
  });

  it("a URL edit on a server that never used OAuth is left entirely alone", async () => {
    const { c, work } = await boot();
    const server = (await c.call("mcp.add", { spaceId: work.id, name: "keyed", transport: "http", url: "https://a.example.com/mcp", headers: { Authorization: `Bearer ${KEY}` } })).result;
    expect(server.authKind).toBe("secrets");
    const updated = (await c.call("mcp.update", { spaceId: work.id, id: server.id, url: "https://b.example.com/mcp" })).result;
    // Its API-key headers are the user's own, not something Realm negotiated — they survive the move.
    expect(updated).toMatchObject({ authKind: "secrets", oauthStatus: "unconfigured", headerKeys: ["Authorization"] });
    c.close();
  });

  it("refuses to start a flow for a stdio server rather than opening a browser that goes nowhere", async () => {
    const { c, work } = await boot();
    const server = (await addStdio(c, work.id, "airtable")).result;
    expect((await c.call("mcp.oauth.start", { id: server.id })).error?.code).toBe("MCP_OAUTH_UNSUPPORTED");
    c.close();
  });

  it("the gateway's callback route rejects a state nobody is waiting on, and echoes nothing back", async () => {
    const { c, work } = await boot();
    const as = await makeStubAuthServer();
    authServers.push(as);
    const server = (await c.call("mcp.add", { spaceId: work.id, name: "remote", transport: "http", url: `${as.url}/mcp` })).result;
    const { authUrl } = (await c.call("mcp.oauth.start", { id: server.id })).result;
    const callbackBase = new URL(new URL(authUrl).searchParams.get("redirect_uri")!);

    const res = await fetch(`${callbackBase}?code=some-forged-code&state=forged-state`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Connection failed — try again from Realm settings.");
    expect(body).not.toContain("some-forged-code");
    expect((await c.call("mcp.list", { spaceId: work.id })).result.servers[0]).toMatchObject({ oauthStatus: "unconfigured" });
    c.close();
  });
});
