import { afterEach, describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type FakeScript } from "@realm/adapters";
import type { SessionEvent } from "@realm/contracts";
import { createApp, type App } from "../app";
import { McpServersStore } from "../store/mcp";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { SettingsStore } from "../store/settings";
import { waitFor } from "../test-utils";

/** The stdio MCP server that ships views — the same one the live check connects as "Charts". */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../mcp/fixtures/apps-stdio.mjs");
const SCRIPT: FakeScript = [
  { on: "chart", emit: [{ kind: "call", tool: "Charts__show_chart", input: { title: "Bundle size", labels: ["1.4", "1.5", "1.6"], values: [3, 1, 2] } }] },
  { on: "sum", emit: [{ kind: "call", tool: "Charts__plain_sum", input: { values: [1, 2] } }] },
  { on: "refresh", emit: [{ kind: "call", tool: "Charts__refresh_chart", input: {} }] },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const apps: App[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); });

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 10_000);
    pending.set(id, (v) => { clearTimeout(timer); v.ok ? res(v.result) : rej(new Error(v.error.message)); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, close: () => ws.close() };
}

function get(url: string): Promise<{ status: number; csp: string | undefined; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: Number(u.port), path: u.pathname, headers: { host: u.host } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, csp: res.headers["content-security-policy"] as string | undefined, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function boot(home = tempDir("realm-apps-int-")) {
  const app = await createApp({ home, port: 0, adapters: { fake: new FakeAdapter({ script: SCRIPT, delayMs: 2 }) } });
  apps.push(app);
  return { app, home };
}

/** A space with "Charts" connected and on, and a fake-agent session in it. */
function seed(app: App, home: string) {
  const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "S", icon: "folder" });
  const row = new McpServersStore(app.db).create({ name: "Charts", transport: "stdio", command: process.execPath, args: [FIXTURE], url: "", secrets: {} });
  new SettingsStore(app.db).set(`mcp.enabled:${space.id}`, [row.id]);
  const { session } = app.sessions.create({ spaceId: space.id, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: null });
  return { serverId: row.id, sessionId: session.id };
}

const results = (app: App, id: string) => app.sessions.events(id, 0, 500).map((e) => e.event).filter((e): e is Extract<SessionEvent, { type: "tool_result" }> => e.type === "tool_result");

describe("a tool call that draws a view, end to end", () => {
  it("carries a reference to its view on the result, and the view is served on an origin of its own under the spec's CSP", async () => {
    const { app, home } = await boot();
    const { serverId, sessionId } = seed(app, home);
    await app.sessions.send(sessionId, { text: "chart", attachments: [] });
    await waitFor(() => results(app, sessionId).length === 1, { timeout: 15_000 });
    const [result] = results(app, sessionId);
    // What the agent read is the server's text — and the result names the view the call drew.
    expect(result!.payload.content).toContain("Charted 3 values");
    expect(result!.payload.view).toMatchObject({ serverId, serverName: "Charts", tool: "show_chart" });

    const rpc = await client(app.port);
    const opened = await rpc.call("apps.view", { viewId: result!.payload.view!.viewId });
    expect(opened.state).toBe("ready");
    expect(opened.view).toMatchObject({ sessionId, serverName: "Charts", input: { values: [3, 1, 2] }, prefersBorder: true });
    // The whole result, structured half included — the part no agent's transcript keeps.
    expect(opened.view.result.structuredContent).toEqual({ title: "Bundle size", unit: "", labels: ["1.4", "1.5", "1.6"], values: [3, 1, 2] });
    expect(opened.view.origin).toMatch(/^http:\/\/[0-9a-f]{16}\.mcp-view\.localhost:\d+$/);
    const page = await get(opened.view.url);
    expect(page.status).toBe(200);
    expect(page.body).toContain("ui/initialize");
    // The chart declares no CSP, so it gets exactly the spec's restrictive default.
    expect(page.csp).toContain("connect-src 'none'");
    expect(page.csp).toContain("default-src 'none'");

    // A second open is a second origin; releasing an address stops it serving.
    const again = await rpc.call("apps.view", { viewId: result!.payload.view!.viewId });
    expect(again.view.origin).not.toBe(opened.view.origin);
    await rpc.call("apps.release", { url: opened.view.url });
    expect((await get(opened.view.url)).status).toBe(404);
    rpc.close();
  }, 30_000);

  it("draws nothing for a tool with no view, and refuses the agent a tool only its view may call", async () => {
    const { app, home } = await boot();
    const { sessionId } = seed(app, home);
    await app.sessions.send(sessionId, { text: "sum", attachments: [] });
    await waitFor(() => results(app, sessionId).length === 1, { timeout: 15_000 });
    expect(results(app, sessionId)[0]!.payload).toEqual(expect.not.objectContaining({ view: expect.anything() }));
    await app.sessions.send(sessionId, { text: "refresh", attachments: [] });
    await waitFor(() => results(app, sessionId).length === 2, { timeout: 15_000 });
    const refused = results(app, sessionId)[1]!.payload;
    expect(refused.isError).toBe(true);
    expect(refused.content).toMatch(/for that server's view to call, not the agent/);
  }, 30_000);

  it("draws no view while the server's views are off, and an earlier view then opens as hidden", async () => {
    const { app, home } = await boot();
    const { serverId, sessionId } = seed(app, home);
    await app.sessions.send(sessionId, { text: "chart", attachments: [] });
    await waitFor(() => results(app, sessionId).length === 1, { timeout: 15_000 });
    new SettingsStore(app.db).set("mcp.viewsHidden", [serverId]);
    await app.sessions.send(sessionId, { text: "chart", attachments: [] });
    await waitFor(() => results(app, sessionId).length === 2, { timeout: 15_000 });
    expect(results(app, sessionId)[1]!.payload.view).toBeUndefined();
    const rpc = await client(app.port);
    expect(await rpc.call("apps.view", { viewId: results(app, sessionId)[0]!.payload.view!.viewId })).toEqual({ state: "hidden" });
    rpc.close();
  }, 30_000);

  it("is kept across a relaunch: the reopened transcript names the view, and it opens again", async () => {
    const { app, home } = await boot();
    const { sessionId } = seed(app, home);
    await app.sessions.send(sessionId, { text: "chart", attachments: [] });
    await waitFor(() => results(app, sessionId).length === 1, { timeout: 15_000 });
    const viewId = results(app, sessionId)[0]!.payload.view!.viewId;
    await apps.pop()!.close();
    const { app: reopened } = await boot(home);
    expect(results(reopened, sessionId)[0]!.payload.view?.viewId).toBe(viewId);
    const rpc = await client(reopened.port);
    const opened = await rpc.call("apps.view", { viewId });
    expect(opened.state).toBe("ready");
    expect((await get(opened.view.url)).status).toBe(200);
    rpc.close();
  }, 40_000);
});
