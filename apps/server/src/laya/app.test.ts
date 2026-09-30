import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type McpServerConfig } from "@realm/adapters";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createApp, type App } from "../app";
import { realLayaRuntime } from "./runtime";
import type { ShadowRow } from "./shadow";
import { fakeRuntime, until } from "./test-fakes";

/**
 * Laya through `createApp`, the way the server is really assembled. What must die: an app a test
 * builds that looks for Python (or starts one), and a `realm-computer` act that the shadow never
 * hears — the wiring in app.ts that no unit test of either half can see.
 */

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

let app: App | null = null;
afterEach(async () => { await app?.close(); app = null; vi.unstubAllEnvs(); });

/** A Python that writes down every time it is run, and answers the discovery probe as a 3.13. */
function recordingPython() {
  const dir = tempDir("realm-laya-app-py-");
  const log = join(dir, "calls.log");
  for (const name of ["python3", "python3.13"]) {
    const bin = join(dir, name);
    writeFileSync(bin, `#!/usr/bin/env node
require("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log(JSON.stringify({ version: [3, 13, 12], machine: "arm64" }));
`);
    chmodSync(bin, 0o755);
  }
  return { dir, bin: join(dir, "python3.13"), calls: (): string[][] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : []) };
}

async function rpc(port: number, onEvent?: (event: string, payload: Any, call: (m: string, p: unknown) => Promise<Any>) => void) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res) => {
    const id = String(++n);
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString()) as Any;
    if ("id" in m) pending.get(m.id)?.(m);
    else onEvent?.(m.event, m.payload, call);
  });
  return { call, close: () => ws.close() };
}

describe("createApp's Laya seam", () => {
  it("looks for no Python in an app built without a runtime — the suite's case — and says Laya is unavailable", async () => {
    const py = recordingPython();
    vi.stubEnv("PATH", `${py.dir}:${process.env.PATH}`);
    vi.stubEnv("REALM_LAYA_PYTHON", py.bin);
    const home = tempDir("realm-laya-app-");
    vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
    app = await createApp({ home, port: 0 });
    const c = await rpc(app.port);
    expect((await c.call("laya.status", {})).result.runtime).toEqual({ state: "unavailable", reason: "This build of Realm does not run Laya." });
    expect((await c.call("laya.install", {})).error.code).toBe("LAYA_UNAVAILABLE");
    expect((await c.call("laya.setMode", { mode: "shadow" })).error.code).toBe("LAYA_NOT_INSTALLED");
    // THE MUTANT: `opts.laya ?? realLayaRuntime(...)` in createApp. Every app in the suite would then
    // run every Python on the developer's Mac on its first status read.
    expect(py.calls()).toEqual([]);
    c.close();
  });

  it("asks the interpreter when it is handed the production runtime — so the silence above is not a blind test", async () => {
    const py = recordingPython();
    const home = tempDir("realm-laya-app-");
    vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
    app = await createApp({ home, port: 0, laya: realLayaRuntime({ home, env: { ...process.env, REALM_LAYA_PYTHON: py.bin } }) });
    const c = await rpc(app.port);
    const status = (await c.call("laya.status", {})).result;
    expect(status.runtime).toEqual({ state: "not-installed", python: { path: py.bin, version: "3.13.12" } });
    expect(status.dir).toBe(join(home, "laya"));
    expect(py.calls().map((args) => args.slice(0, 3))).toEqual([["-I", "-S", "-c"]]);
    // Looked, and did not install: nothing under the home but what the log directory needs.
    expect(existsSync(join(home, "laya", "venv"))).toBe(false);
    c.close();
  });
});

describe("a realm-computer act, through the real gateway", () => {
  const SNAPSHOT = {
    snapshotId: "ax_1", pid: 9, bundleId: "com.apple.TextEdit", appName: "TextEdit", frontmost: true, truncated: false,
    elements: [
      { index: 0, role: "AXTextArea", subrole: "", name: "Body", value: "Dear team", x: 0, y: 0, w: 10, h: 10, actions: [], enabled: true, focused: true, depth: 2 },
      { index: 1, role: "AXButton", subrole: "", name: "Save", value: "", x: 0, y: 0, w: 10, h: 10, actions: ["AXPress"], enabled: true, focused: false, depth: 2 },
      { index: 2, role: "AXButton", subrole: "", name: "Don't Save", value: "", x: 0, y: 0, w: 10, h: 10, actions: ["AXPress"], enabled: true, focused: false, depth: 2 },
    ],
    text: '[0] AXTextArea "Body"\n[1] AXButton "Save"\n[2] AXButton "Don\'t Save"',
  };

  it("is heard by the shadow and becomes a row, while the agent gets exactly what the act returned", async () => {
    const home = tempDir("realm-laya-app-");
    vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
    const runtime = fakeRuntime({ dir: join(home, "laya"), installed: true, server: { choose: () => "Save", noul: () => 0.07 } });
    app = await createApp({ home, port: 0, adapters: { fake: new FakeAdapter({ script: [] }) }, laya: runtime });
    const acts: unknown[] = [];
    // Electron main's half of the bridge: the helper's answers, scripted.
    const host = await rpc(app.port, (event, payload, call) => {
      if (event !== "browserHost.op") return;
      const { callId, op, params } = payload as { callId: string; op: string; params: unknown };
      if (op === "computerSnapshot") void call("browserHost.result", { callId, ok: true, result: SNAPSHOT });
      else if (op === "computerAct") { acts.push(params); void call("browserHost.result", { callId, ok: true, result: { ok: true, detail: 'clicked "Save" in TextEdit' } }); }
      else void call("browserHost.result", { callId, ok: false, error: "not in this test" });
    });
    await host.call("browserHost.register", {});
    const profile = (await host.call("profiles.create", { name: "P" })).result;
    const space = (await host.call("spaces.create", { profileId: profile.id, name: "S" })).result;
    await host.call("mcp.setProviderEnabled", { spaceId: space.id, name: "realm-computer", enabled: true });
    await host.call("computer.allowedApps.set", { spaceId: space.id, apps: ["com.apple.TextEdit"] });
    await host.call("laya.setMode", { mode: "shadow" });
    await until(async () => (await host.call("laya.status", {})).result.runtime.state === "ready");

    const { session } = app.sessions.create({ spaceId: space.id, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: "default" });
    const cfg = app.gateway.register(session.id, space.id) as Extract<McpServerConfig, { url: string }>;
    const mcp = new Client({ name: "t", version: "1.0.0" }, { capabilities: {} });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
    await mcp.callTool({ name: "realm-computer__computer_snapshot", arguments: { bundleId: "com.apple.TextEdit" } });
    const result = await mcp.callTool({ name: "realm-computer__computer_act", arguments: { snapshotId: "ax_1", action: { kind: "click", index: 1 }, intent: "save the document" } }) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: 'clicked "Save" in TextEdit' }]);
    expect(acts).toHaveLength(1);
    await mcp.close();
    host.close();

    // Closing the app writes the step that was waiting to learn what came next.
    await app.close();
    app = null;
    const rows = readFileSync(runtime.logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as ShadowRow);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      surface: "computer", tool: "computer_act", spaceId: space.id, sessionId: session.id, intent: "save the document",
      chosen: { id: "1" }, checkpoint: "english@55cf4c4",
      laya: { target: { choice: "1" }, sensitive: { p: 0.07 } },
      truth: { target: { id: "1", source: "agent" }, sensitive: { value: false, source: "rule" }, permission: null, verify: null },
    });
    expect(rows[0]!.candidates.map((e) => e.label)).toEqual(["Body", "Save", "Don't Save"]);
    // And the app took laya-serve down with it.
    await expect(fetch(`http://127.0.0.1:${runtime.starts[0]!.port}/health`)).rejects.toThrow();
  });

  it("labels the step with the user's answer when a card was raised for it", async () => {
    // Not on the space's list, so the gate raises a real card, and the answer comes back over RPC the
    // way the renderer sends it. THE MUTANT: the broker's events not reaching the shadow in app.ts.
    const home = tempDir("realm-laya-app-");
    vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
    const runtime = fakeRuntime({ dir: join(home, "laya"), installed: true });
    app = await createApp({ home, port: 0, adapters: { fake: new FakeAdapter({ script: [] }) }, laya: runtime });
    const host = await rpc(app.port, (event, payload, call) => {
      if (event === "browserHost.op") {
        const { callId, op } = payload as { callId: string; op: string };
        if (op === "computerSnapshot") void call("browserHost.result", { callId, ok: true, result: SNAPSHOT });
        else if (op === "computerAct") void call("browserHost.result", { callId, ok: true, result: { ok: true, detail: "clicked" } });
        else void call("browserHost.result", { callId, ok: false, error: "not in this test" });
      }
      if (event === "session.event" && payload.event.type === "permission_request") {
        void call("sessions.respondPermission", { id: payload.sessionId, requestId: payload.event.payload.requestId, decision: "allow" });
      }
    });
    await host.call("browserHost.register", {});
    const profile = (await host.call("profiles.create", { name: "P" })).result;
    const space = (await host.call("spaces.create", { profileId: profile.id, name: "S" })).result;
    await host.call("mcp.setProviderEnabled", { spaceId: space.id, name: "realm-computer", enabled: true });
    await host.call("laya.setMode", { mode: "shadow" });
    await until(async () => (await host.call("laya.status", {})).result.runtime.state === "ready");
    const { session } = app.sessions.create({ spaceId: space.id, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: "default" });
    const cfg = app.gateway.register(session.id, space.id) as Extract<McpServerConfig, { url: string }>;
    const mcp = new Client({ name: "t", version: "1.0.0" }, { capabilities: {} });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
    await mcp.callTool({ name: "realm-computer__computer_snapshot", arguments: { bundleId: "com.apple.TextEdit" } });
    await mcp.callTool({ name: "realm-computer__computer_act", arguments: { snapshotId: "ax_1", action: { kind: "click", index: 1 }, intent: "save the document" } });
    await mcp.close();
    host.close();
    await app.close();
    app = null;
    const [row] = readFileSync(runtime.logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as ShadowRow);
    expect(row!.truth.permission).toEqual({ decision: "allow", source: "user" });
  });
});

describe("a realm-browser act and walk, through the real gateway", () => {
  /** A page as Electron main's pane sends it: the lines the agent reads, and the same elements as data. */
  const page = (url: string, title: string, els: { ref: number; role: string; name: string }[]) => ({
    url, title, elementCount: els.length, text: els.map((e) => `[ref=${e.ref}] ${e.role} "${e.name}"`).join("\n"),
    elements: els.map((e) => ({ ...e, value: null, rect: { x: 0, y: 40 * e.ref, w: 80, h: 20 }, checked: null, disabled: false, password: false, focused: false, offscreen: false })),
    viewport: { width: 1200, height: 800 }, page: { loading: false, requests: 0, quietMs: 1_000 },
  });
  const HOME = page("http://127.0.0.1:8123/", "Fixture", [{ ref: 1, role: "link", name: "Home" }, { ref: 2, role: "link", name: "Docs" }]);
  const DOCS = page("http://127.0.0.1:8123/docs", "Docs", [{ ref: 1, role: "link", name: "Home" }, { ref: 11, role: "link", name: "Getting started" }]);

  it("is heard by the shadow — an act, and each click of a walk — while the agent gets exactly what the page answered", async () => {
    const home = tempDir("realm-laya-app-");
    vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
    const runtime = fakeRuntime({ dir: join(home, "laya"), installed: true, server: { choose: () => "Docs", noul: () => 0.07 } });
    app = await createApp({ home, port: 0, adapters: { fake: new FakeAdapter({ script: [] }) }, laya: runtime });
    let at = HOME;
    // Electron main's half of the bridge, scripted: a link to the docs, and one back home.
    const host = await rpc(app.port, (event, payload, call) => {
      if (event !== "browserHost.op") return;
      const { callId, op, params } = payload as { callId: string; op: string; params: Any };
      const answer = (result: unknown) => void call("browserHost.result", { callId, ok: true, result });
      if (op === "describe") answer({ open: true, url: at.url, title: at.title, element: null });
      else if (op === "snapshot") answer(at);
      else if (op === "act") { at = params.action.ref === 2 ? DOCS : params.action.ref === 1 ? HOME : at; answer({ ok: true, detail: `clicked ref=${params.action.ref}` }); }
      else void call("browserHost.result", { callId, ok: false, error: "not in this test" });
    });
    await host.call("browserHost.register", {});
    const profile = (await host.call("profiles.create", { name: "P" })).result;
    const space = (await host.call("spaces.create", { profileId: profile.id, name: "S" })).result;
    await host.call("laya.setMode", { mode: "shadow" });
    await until(async () => (await host.call("laya.status", {})).result.runtime.state === "ready");
    const { browserId } = (await host.call("browsers.create", { spaceId: space.id, url: HOME.url })).result;

    const { session } = app.sessions.create({ spaceId: space.id, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: "bypassPermissions" });
    const cfg = app.gateway.register(session.id, space.id) as Extract<McpServerConfig, { url: string }>;
    const mcp = new Client({ name: "t", version: "1.0.0" }, { capabilities: {} });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
    await mcp.callTool({ name: "realm-browser__browser_snapshot", arguments: { browserId } });
    const acted = await mcp.callTool({ name: "realm-browser__browser_act", arguments: { browserId, action: { kind: "click", ref: 2 }, intent: "open the docs" } }) as CallToolResult;
    expect(acted.content).toEqual([{ type: "text", text: "clicked ref=2" }]);
    const walked = await mcp.callTool({ name: "realm-browser__browser_do", arguments: { browserId, intent: "go home and back", path: ["Home", "Docs"] } }) as CallToolResult;
    expect(walked.isError).toBeFalsy();
    // Nothing Laya answered reaches the agent: it chose "Docs" at every question and was asked plenty.
    expect(JSON.stringify(walked.content)).not.toMatch(/laya/i);
    await mcp.close();
    host.close();
    await app.close();
    app = null;

    const rows = readFileSync(runtime.logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as ShadowRow);
    expect(rows.map((r) => [r.surface, r.tool, r.intent, r.chosen])).toEqual([
      ["browser", "browser_act", "open the docs", { id: "2" }],
      ["browser", "browser_do", "go home and back", { id: "1" }],
      ["browser", "browser_do", "go home and back", { id: "2" }],
    ]);
    expect(rows[0]).toMatchObject({
      spaceId: space.id, sessionId: session.id, checkpoint: "english@55cf4c4",
      laya: { target: { choice: "2" }, sensitive: { p: 0.07 } },
      truth: { target: { id: "2", source: "agent" }, sensitive: { value: false, source: "rule" } },
    });
    expect(rows[0]!.candidates.map((e) => e.label)).toEqual(["Home", "Docs"]);
    // The page the act left reached the shadow through the walk's first look at it.
    expect(rows[0]!.baseline.verify).toEqual({ value: true, changed: true, alert: false });
  }, 20_000);
});
