import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type McpServerConfig } from "@realm/adapters";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

/**
 * A saved password filled on its own site while "Let agents finish sign-ins" is off: one card, with
 * Allow once, Turn on sign-ins and Deny, through the real gateway and RPC. Only a person answers it
 * Allow, and once Settings has turned sign-ins on, the next fill raises no card at all.
 */

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let app: App | null = null;
afterEach(async () => { await app?.close(); app = null; vi.unstubAllEnvs(); });

async function socket(port: number, onEvent?: (event: string, payload: Any, call: (m: string, p: unknown) => Promise<Any>) => void) {
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

const PAGE = "https://example.com";
const CREDENTIAL = { id: "cred-1", origin: PAGE, username: "ada", label: "Work", createdAt: 1, generated: false };

async function boot() {
  const home = tempDir("realm-signins-card-");
  vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
  app = await createApp({ home, port: 0, adapters: { fake: new FakeAdapter({ script: [] }) } });
  const state = { signins: false, fills: 0 };
  // Electron main's half of the bridge: a pane on the password's own site, and main's switch.
  const host = await socket(app.port, (event, payload, call) => {
    if (event !== "browserHost.op") return;
    const { callId, op, params } = payload as { callId: string; op: string; params: Any };
    const answer = (result: unknown) => void call("browserHost.result", { callId, ok: true, result });
    if (op === "describe") answer({ open: true, url: `${PAGE}/login`, title: "Sign in", element: null });
    else if (op === "credentials") answer(params.browserId ? { origin: PAGE, credentials: [{ ...CREDENTIAL, match: "exact", agentAllowed: false }] } : { credentials: [CREDENTIAL] });
    else if (op === "signinsEnabled") answer({ enabled: state.signins });
    else if (op === "fillCredential") { state.fills += 1; answer({ ok: true, detail: "filled the saved sign-in" }); }
    else void call("browserHost.result", { callId, ok: false, error: "not in this test" });
  });
  await host.call("browserHost.register", {});
  const profile = (await host.call("profiles.create", { name: "P" })).result;
  const space = (await host.call("spaces.create", { profileId: profile.id, name: "S" })).result;
  const { browserId } = (await host.call("browsers.create", { spaceId: space.id, url: `${PAGE}/login` })).result;
  // Full access, so the only card is the sign-in one.
  const { session } = app.sessions.create({ spaceId: space.id, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: "bypassPermissions" });
  const cfg = app.gateway.register(session.id, space.id) as Extract<McpServerConfig, { url: string }>;
  const mcp = new Client({ name: "t", version: "1.0.0" }, { capabilities: {} });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
  const fill = () => mcp.callTool({ name: "realm-browser__browser_fill_credential", arguments: { browserId, ref: 7, credentialId: "cred-1" } }) as Promise<CallToolResult>;
  const cards = () => app!.sessions.events(session.id, 0, 500).map((e) => e.event).flatMap((e) => (e.type === "permission_request" ? [e.payload] : []));
  return { host, mcp, fill, cards, state, sessionId: session.id };
}

describe("the fill card when agent sign-ins are off", () => {
  it("offers to turn sign-ins on, refuses an Allow sent from in process, and takes the person's", async () => {
    const { host, mcp, fill, cards, state, sessionId } = await boot();
    const filled = fill();
    await waitFor(() => cards().length === 1);
    const [card] = cards();
    expect(card).toMatchObject({ toolName: "browser_fill_credential", input: { offersSignins: true } });

    // In process is where an agent's tool call would answer from. THE MUTANT: the broker taking it.
    await expect(app!.rpc.call("sessions.respondPermission", { id: sessionId, requestId: card!.requestId, decision: "allow" })).rejects.toThrow(/only the person/);
    expect(state.fills).toBe(0);

    // Turn on sign-ins: Settings sets main's switch, then the card is answered Allow, from the window.
    state.signins = true;
    const answered = await host.call("sessions.respondPermission", { id: sessionId, requestId: card!.requestId, decision: "allow" });
    expect(answered.ok).toBe(true);
    expect((await filled).isError).toBeFalsy();
    expect(state.fills).toBe(1);

    // And the next fill goes ahead with no second card, and no invitation either.
    expect((await fill()).isError).toBeFalsy();
    expect(state.fills).toBe(2);
    expect(cards()).toHaveLength(1);
    await mcp.close();
    host.close();
  }, 20_000);
});
