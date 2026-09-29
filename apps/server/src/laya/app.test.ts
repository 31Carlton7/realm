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
  });
});
