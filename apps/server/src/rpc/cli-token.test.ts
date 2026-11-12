import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import { RpcServer, tokenProtocol, type CallContext } from "./server";

/**
 * SEC-06 (b): `daemon.json` carries a token for the `realm` CLI, and an agent with the sandbox off can
 * read that file. The token must open the CLI's own methods and nothing else — above all not the
 * ones that answer a permission card, turn the sandbox off, change settings or type into a terminal,
 * widen an agent's or a teammate's access, or accept a phone (which could then answer as itself).
 */
const APP = "app-token-only-main-holds";
const CLI = "cli-token-in-daemon-json";

const RESTRICTED = [
  "sessions.respondPermission", "sandbox.set", "sandbox.setDefaults", "settings.set", "terminals.write",
  // A phone it paired could answer permission cards as that phone.
  "remote.pair.answer",
  // Each widens what an agent may do without asking.
  "sessions.setOptions", "teammates.update", "teams.access.set", "runs.approve", "computer.allowedApps.set", "mcp.setAllowedTools",
];

/** Every method the `realm` CLI calls, read from its source so a new command is covered by itself.
 *  `remote.pair.answer` it calls only over `--server`, with the owner's access token. */
const cliSource = readFileSync(join(__dirname, "../ctl/commands.ts"), "utf8");
const CLI_CALLS = [...new Set([...cliSource.matchAll(/\.call(?:<[^>]*>)?\("([a-zA-Z]+\.[a-zA-Z.]+)"/g)].map((m) => m[1]!))]
  .filter((m) => m !== "remote.pair.answer");

let server: RpcServer;
afterEach(async () => { await server?.close(); });

function dial(port: number, token: string): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, [tokenProtocol(token)]);
    ws.once("open", () => res(ws)); ws.once("error", rej);
  });
}

let n = 0;
function call(ws: WebSocket, method: string): Promise<{ ok: boolean; result?: unknown; error?: { code: string } }> {
  const id = String(++n);
  return new Promise((res) => {
    const on = (d: WebSocket.RawData) => {
      const m = JSON.parse(d.toString()) as { id?: string };
      if (m.id === id) { ws.off("message", on); res(m as never); }
    };
    ws.on("message", on);
    ws.send(JSON.stringify({ id, method, params: {} }));
  });
}

async function serve(methods: readonly string[]): Promise<{ port: number; seen: CallContext[] }> {
  server = new RpcServer();
  const seen: CallContext[] = [];
  for (const m of methods) server.register(m, z.object({}).passthrough(), async (_p, ctx) => { seen.push(ctx); return m; });
  const port = await server.listen(0, "127.0.0.1", { token: APP, cliToken: CLI });
  return { port, seen };
}

describe("the CLI token in daemon.json", () => {
  it("is the CLI's only: the source names the calls this test checks", () => {
    // A regex that stopped matching would make every test below pass on nothing.
    expect(CLI_CALLS).toEqual(expect.arrayContaining(["system.info", "terminals.list", "terminals.create", "remote.status"]));
    for (const m of RESTRICTED) expect(readFileSync(join(__dirname, "methods.ts"), "utf8")).toContain(`reg("${m}"`);
  });

  it("is refused for answering permission cards, the sandbox, settings and terminal input", async () => {
    const { port, seen } = await serve(RESTRICTED);
    const ws = await dial(port, CLI);
    for (const m of RESTRICTED) expect({ m, code: (await call(ws, m)).error?.code }).toEqual({ m, code: "FORBIDDEN" });
    expect(seen).toEqual([]);
    ws.close();
  });

  it("opens a pairing window but cannot accept the phone that scans it", async () => {
    const { port, seen } = await serve(["remote.pair.start", "remote.pair.answer"]);
    const ws = await dial(port, CLI);
    expect(await call(ws, "remote.pair.start")).toMatchObject({ ok: true, result: "remote.pair.start" });
    expect((await call(ws, "remote.pair.answer")).error?.code).toBe("FORBIDDEN");
    expect(seen).toHaveLength(1);
    ws.close();
  });

  it("is refused for a method nobody listed, so a new one fails closed", async () => {
    const { port, seen } = await serve(["agents.someMethodAddedLater"]);
    const ws = await dial(port, CLI);
    expect((await call(ws, "agents.someMethodAddedLater")).error?.code).toBe("FORBIDDEN");
    expect(seen).toEqual([]);
    ws.close();
  });

  it("still opens every method the realm CLI calls, as principal cli", async () => {
    const { port, seen } = await serve(CLI_CALLS);
    const ws = await dial(port, CLI);
    for (const m of CLI_CALLS) expect({ m, r: await call(ws, m) }).toEqual({ m, r: expect.objectContaining({ ok: true, result: m }) });
    expect(new Set(seen.map((c) => c.principal))).toEqual(new Set(["cli"]));
    ws.close();
  });

  it("leaves the app's token with everything, as principal local", async () => {
    const { port, seen } = await serve([...RESTRICTED, "agents.someMethodAddedLater"]);
    const ws = await dial(port, APP);
    for (const m of [...RESTRICTED, "agents.someMethodAddedLater"]) expect((await call(ws, m)).ok).toBe(true);
    expect(new Set(seen.map((c) => c.principal))).toEqual(new Set(["local"]));
    expect(ws.protocol).toBe(tokenProtocol(APP));
    ws.close();
  });

  it("is refused in process too, where a handler re-enters the RPC as its caller", async () => {
    await serve(RESTRICTED);
    await expect(server.call("sandbox.set", {}, { client: null, principal: "cli" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
