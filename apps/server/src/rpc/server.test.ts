import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import { RpcServer } from "./server";

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
    server.register("boom", z.object({}), async () => { throw Object.assign(new Error("nope"), { code: "NOT_FOUND" }); });
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
});
