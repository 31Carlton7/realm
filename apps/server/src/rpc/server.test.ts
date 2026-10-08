import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import { RpcServer, acceptsHandshake, tokenProtocol, type CallContext } from "./server";
import { NotFoundError, RpcError } from "../store/rows";

let server: RpcServer;
afterEach(async () => { await server?.close(); });

function connect(port: number): Promise<WebSocket> {
  return new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); ws.once("open", () => res(ws)); ws.once("error", rej); });
}
function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((res) => ws.once("message", (d) => res(JSON.parse(d.toString()))));
}

describe("RpcServer", () => {
  it("dispatches a registered method and validates params", async () => {
    server = new RpcServer();
    server.register("echo", z.object({ text: z.string() }), async (p) => ({ echoed: p.text }));
    const port = await server.listen(0);
    const ws = await connect(port);
    ws.send(JSON.stringify({ id: "1", method: "echo", params: { text: "hi" } }));
    expect(await nextMessage(ws)).toEqual({ id: "1", ok: true, result: { echoed: "hi" } });
    ws.send(JSON.stringify({ id: "2", method: "echo", params: { text: 5 } }));
    const bad = (await nextMessage(ws)) as { ok: boolean; error: { code: string } };
    expect(bad.ok).toBe(false); expect(bad.error.code).toBe("INVALID_PARAMS");
    ws.send(JSON.stringify({ id: "3", method: "nope", params: {} }));
    expect(((await nextMessage(ws)) as { error: { code: string } }).error.code).toBe("METHOD_NOT_FOUND");
    ws.close();
  });

  it("maps thrown errors with a code and broadcasts events to all clients", async () => {
    server = new RpcServer();
    server.register("boom", z.object({}), async () => { throw new NotFoundError("thing", "x"); });
    const port = await server.listen(0);
    const a = await connect(port); const b = await connect(port);
    a.send(JSON.stringify({ id: "1", method: "boom", params: {} }));
    expect(((await nextMessage(a)) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    const pa = nextMessage(a); const pb = nextMessage(b);
    server.broadcast("spaces.changed", { profileId: "x" });
    expect(await pa).toEqual({ event: "spaces.changed", payload: { profileId: "x" } });
    expect(await pb).toEqual({ event: "spaces.changed", payload: { profileId: "x" } });
    a.close(); b.close();
  });

  it("does not leak codes from plain errors: non-RpcError throws map to INTERNAL", async () => {
    server = new RpcServer();
    server.register("plain", z.object({}), async () => { throw Object.assign(new Error("db exploded"), { code: "SQLITE_BUSY" }); });
    server.register("weird", z.object({}), async () => { throw "not an error object"; });
    const port = await server.listen(0);
    const ws = await connect(port);
    ws.send(JSON.stringify({ id: "1", method: "plain", params: {} }));
    const r1 = (await nextMessage(ws)) as { ok: boolean; error: { code: string; message: string } };
    expect(r1.ok).toBe(false); expect(r1.error.code).toBe("INTERNAL"); expect(r1.error.message).toBe("db exploded");
    ws.send(JSON.stringify({ id: "2", method: "weird", params: {} }));
    const r2 = (await nextMessage(ws)) as { error: { code: string } };
    expect(r2.error.code).toBe("INTERNAL");
    ws.close();
  });
});

describe("RpcServer in process (Plan 28)", () => {
  const methods = (s: RpcServer, seen: CallContext[] = []) => {
    s.register("echo", z.object({ text: z.string(), times: z.number().default(1) }), async (p, ctx) => { seen.push(ctx); return { echoed: p.text.repeat(p.times) }; });
    s.register("boom", z.object({}), async () => { throw new NotFoundError("thing", "x"); });
    s.register("plain", z.object({}), async () => { throw Object.assign(new Error("db exploded"), { code: "SQLITE_BUSY" }); });
    return seen;
  };

  it("call() runs the socket's path: the schema parses (defaults and all), the handler answers, codes survive", async () => {
    server = new RpcServer();
    const seen = methods(server);
    // The parsed params reach the handler, not the raw ones: `times` was defaulted by the schema.
    expect(await server.call("echo", { text: "hi" })).toEqual({ echoed: "hi" });
    expect(seen).toEqual([{ client: null, principal: "local" }]);
    await expect(server.call("echo", { text: 5 })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(server.call("nope", {})).rejects.toMatchObject({ code: "METHOD_NOT_FOUND", message: "nope" });
    await expect(server.call("boom", {})).rejects.toMatchObject({ code: "NOT_FOUND", message: "thing x not found" });
    // A plain error's own `code` does not leak in process either: the socket would have said INTERNAL.
    await expect(server.call("plain", {})).rejects.toMatchObject({ code: "INTERNAL", message: "db exploded" });
    await expect(server.call("plain", {})).rejects.toBeInstanceOf(RpcError);
    // The schema ran: a handler never sees a param it would have refused over the socket.
    expect(seen).toHaveLength(1);
  });

  it("answers in process exactly what it answers on the socket", async () => {
    server = new RpcServer();
    methods(server);
    const ws = await connect(await server.listen(0));
    const viaSocket = async (method: string, params: unknown) => {
      ws.send(JSON.stringify({ id: "1", method, params }));
      const r = (await nextMessage(ws)) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
      return r.ok ? { ok: true, result: r.result } : { ok: false, code: r.error!.code, message: r.error!.message };
    };
    const inProcess = (method: string, params: unknown) => server.call(method, params)
      .then((result) => ({ ok: true, result }), (e: RpcError) => ({ ok: false, code: e.code, message: e.message }));
    for (const [method, params] of [["echo", { text: "ab", times: 2 }], ["echo", {}], ["nope", {}], ["boom", {}], ["plain", {}]] as const) {
      expect(await inProcess(method, params), method).toEqual(await viaSocket(method, params));
    }
    ws.close();
  });

  it("tells a handler who is calling: the socket, or an in-process principal with no socket", async () => {
    server = new RpcServer();
    const seen = methods(server);
    const ws = await connect(await server.listen(0));
    ws.send(JSON.stringify({ id: "1", method: "echo", params: { text: "x" } }));
    await nextMessage(ws);
    await server.call("echo", { text: "x" }, { client: null, principal: "phone:abc" });
    expect(seen[0]!.client).not.toBeNull();
    expect(seen[0]!.principal).toBe("local");
    expect(seen[1]).toEqual({ client: null, principal: "phone:abc" });
    ws.close();
  });

  it("onBroadcast hears every broadcast beside the sockets, a listener that throws stops nothing, and it can stop listening", async () => {
    server = new RpcServer();
    const ws = await connect(await server.listen(0));
    const heard: string[] = [];
    server.onBroadcast(() => { throw new Error("a broken listener"); });
    const off = server.onBroadcast((event, payload) => { heard.push(`${event}:${JSON.stringify(payload)}`); });
    const onSocket = nextMessage(ws);
    expect(() => server.broadcast("spaces.changed", { profileId: "p1" })).not.toThrow();
    expect(heard).toEqual(['spaces.changed:{"profileId":"p1"}']);
    expect(await onSocket).toEqual({ event: "spaces.changed", payload: { profileId: "p1" } });
    off();
    server.broadcast("spaces.changed", { profileId: "p2" });
    expect(heard).toHaveLength(1);
    ws.close();
  });
});

describe("handshake auth", () => {
  const token = "s3cret";
  const opts = { token, allowedOrigins: ["file://"] };

  it("decides on the two headers it reads", () => {
    const good = [tokenProtocol(token)];
    expect(acceptsHandshake({ protocols: good }, opts)).toBe(true);
    expect(acceptsHandshake({ origin: "file://", protocols: good }, opts)).toBe(true);
    // The whole point: a page holding the token is still not Realm's own window.
    expect(acceptsHandshake({ origin: "https://evil.com", protocols: good }, opts)).toBe(false);
    expect(acceptsHandshake({ protocols: [] }, opts)).toBe(false);
    expect(acceptsHandshake({ protocols: ["realm.wrong"] }, opts)).toBe(false);
    expect(acceptsHandshake({ protocols: [token] }, opts)).toBe(false);
    // Tokenless stays legal — it is what every server test below dials.
    expect(acceptsHandshake({ protocols: [] }, {})).toBe(true);
    // …but an Origin is judged even then, since an allowlist of none allows none.
    expect(acceptsHandshake({ origin: "https://evil.com", protocols: [] }, {})).toBe(false);
  });

  it("accepts a dial carrying the token and refuses one without it", async () => {
    server = new RpcServer();
    server.register("ping", z.object({}), async () => "pong");
    const port = await server.listen(0, "127.0.0.1", opts);
    const ws = await new Promise<WebSocket>((res, rej) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}`, [tokenProtocol(token)]);
      s.once("open", () => res(s)); s.once("error", rej);
    });
    expect(ws.protocol).toBe(tokenProtocol(token));
    ws.send(JSON.stringify({ id: "1", method: "ping", params: {} }));
    expect(await nextMessage(ws)).toEqual({ id: "1", ok: true, result: "pong" });
    ws.close();
    await expect(connect(port)).rejects.toThrow(/401|403|Unexpected server response/);
  });
});
