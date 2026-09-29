import { createServer, type Server } from "node:http";
import { createServer as tcpServer, type Server as TcpServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loopbackSocket, parseResponse, RunnerClient, runnerRequest, RunnerUnreachable } from "./runner-client";

/**
 * Realm's half of the runner's HTTP, against a runner played by a loopback server that answers the
 * way the real one does: one request per connection, `Connection: close`, JSON errors as `{ error }`.
 */

const servers: (Server | TcpServer)[] = [];
const open: Socket[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) s.destroy();
  for (const s of servers) if ("closeAllConnections" in s) s.closeAllConnections();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

type Seen = { method: string; url: string; body: string; headers: Record<string, string | string[] | undefined> };

async function runner(answer: (req: Seen) => { status?: number; type?: string; body: string | Buffer }): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const s = { method: req.method ?? "", url: req.url ?? "", body, headers: req.headers };
      seen.push(s);
      const a = answer(s);
      // As the runner writes it: a length, never chunks, and the connection closed after.
      const bytes = Buffer.isBuffer(a.body) ? a.body : Buffer.from(a.body);
      res.writeHead(a.status ?? 200, { "Content-Type": a.type ?? "application/json", "Content-Length": bytes.length, Connection: "close" });
      res.end(bytes);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as { port: number }).port, seen };
}

describe("parseResponse", () => {
  it("reads the status and cuts the body at Content-Length", () => {
    const r = parseResponse(Buffer.from("HTTP/1.1 400 Error\r\nContent-Type: application/json\r\nContent-Length: 4\r\n\r\n{\"a\"trailing"));
    expect(r?.status).toBe(400);
    expect(r?.body.toString()).toBe("{\"a\"");
  });

  it("takes the rest as the body when there is no length, and is nothing for a head that never ends or is not HTTP", () => {
    expect(parseResponse(Buffer.from("HTTP/1.0 200 OK\r\n\r\nhello"))?.body.toString()).toBe("hello");
    expect(parseResponse(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n"))).toBeNull();
    expect(parseResponse(Buffer.from("SSH-2.0-OpenSSH\r\n\r\n"))).toBeNull();
  });
});

describe("runnerRequest", () => {
  it("sends the method, path and JSON body the runner parses, and closes after one answer", async () => {
    const r = await runner(() => ({ body: "{\"ok\":true}" }));
    const res = await runnerRequest(loopbackSocket(r.port), "POST", "/tap", { x: 1, y: 2 });
    expect(res.status).toBe(200);
    expect(r.seen[0]).toMatchObject({ method: "POST", url: "/tap", body: "{\"x\":1,\"y\":2}" });
    expect(r.seen[0]!.headers["content-length"]).toBe("13");
    expect(r.seen[0]!.headers.connection).toBe("close");
  });

  it("says the runner is unreachable when nothing listens, and when it never answers", async () => {
    await expect(runnerRequest(loopbackSocket(1), "GET", "/status")).rejects.toBeInstanceOf(RunnerUnreachable);
    const silent = tcpServer((sock) => { open.push(sock); /* accepts, says nothing */ });
    servers.push(silent);
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    const port = (silent.address() as { port: number }).port;
    await expect(runnerRequest(loopbackSocket(port), "GET", "/hierarchy", undefined, 150)).rejects.toThrow(/did not answer \/hierarchy/);
  });
});

describe("RunnerClient", () => {
  it("counts only Realm's runner as alive — not any server that happens to be on the port", async () => {
    const ours = await runner(() => ({ body: JSON.stringify({ ok: true, runner: "realm-device-runner", version: 1 }) }));
    const other = await runner(() => ({ body: JSON.stringify({ ok: true }) }));
    expect(await new RunnerClient(loopbackSocket(ours.port)).alive()).toBe(true);
    expect(await new RunnerClient(loopbackSocket(other.port)).alive()).toBe(false);
    expect(await new RunnerClient(loopbackSocket(1)).alive()).toBe(false);
  });

  it("reads the screen in points with its scale, and the app in front by bundle id alone", async () => {
    const r = await runner((q) => ({ body: q.url === "/device" ? JSON.stringify({ width: 402, height: 874, scale: 3 }) : JSON.stringify({ bundleId: "com.apple.springboard" }) }));
    const c = new RunnerClient(loopbackSocket(r.port));
    expect(await c.screen()).toEqual({ width: 402, height: 874, scale: 3 });
    expect(await c.foreground()).toBe("com.apple.springboard");
  });

  it("maps the tree it is sent, and has none when the runner answers with an error", async () => {
    let fail = false;
    const r = await runner(() => (fail ? { status: 500, body: "{\"error\":\"no app\"}" } : { body: JSON.stringify({ bundleId: "x", tree: { type: 2, label: "X", frame: { x: 0, y: 0, width: 10, height: 20 }, children: [{ type: 9, label: "Go", frame: { x: 1, y: 1, width: 2, height: 2 } }] } }) }));
    const c = new RunnerClient(loopbackSocket(r.port));
    expect((await c.tree())?.elements.map((e) => e.label)).toEqual(["Go"]);
    fail = true;
    expect(await c.tree()).toBeNull();
  });

  it("asks for the picture it wants, and refuses an empty one", async () => {
    let body: Buffer = Buffer.from([0xff, 0xd8, 0xff]);
    const r = await runner(() => ({ type: "image/jpeg", body }));
    const c = new RunnerClient(loopbackSocket(r.port));
    expect([...(await c.screenshot({ format: "jpeg", scale: 0.5, quality: 0.6 }))]).toEqual([0xff, 0xd8, 0xff]);
    expect(r.seen[0]!.url).toBe("/screenshot?format=jpeg&scale=0.5&quality=0.6");
    await c.screenshot({ format: "png" });
    expect(r.seen[1]!.url).toBe("/screenshot?format=png");
    body = Buffer.alloc(0);
    await expect(c.screenshot({ format: "png" })).rejects.toThrow(/did not send a picture/);
  });

  it("sends each act in the runner's own words, and hands back the runner's sentence when it says no", async () => {
    const r = await runner((q) => (q.url === "/key" ? { status: 400, body: "{\"error\":\"no key f13\"}" } : { body: "{\"ok\":true}" }));
    const c = new RunnerClient(loopbackSocket(r.port));
    expect(await c.tap(10, 20, 2, 600)).toEqual({ ok: true, detail: "" });
    expect(await c.swipe({ x: 1, y: 2 }, { x: 3, y: 4 }, 300, 0, 120)).toEqual({ ok: true, detail: "" });
    await c.swipe({ x: 1, y: 2 }, { x: 3, y: 4 }, 300, 50);
    await c.text("About");
    await c.button("home");
    await c.openUrl("https://example.com");
    expect(await c.key("return")).toEqual({ ok: false, detail: "no key f13" });
    expect(r.seen.map((q) => [q.url, JSON.parse(q.body)])).toEqual([
      ["/tap", { x: 10, y: 20, count: 2, holdMs: 600 }],
      ["/swipe", { fromX: 1, fromY: 2, toX: 3, toY: 4, durationMs: 300, holdMs: 0, stopMs: 120 }],
      ["/swipe", { fromX: 1, fromY: 2, toX: 3, toY: 4, durationMs: 300, holdMs: 50 }],
      ["/text", { text: "About" }],
      ["/button", { button: "home" }],
      ["/open", { url: "https://example.com" }],
      ["/key", { key: "return" }],
    ]);
  });

  it("answers an act the runner never heard with why, rather than throwing out of the step", async () => {
    const c = new RunnerClient(loopbackSocket(1));
    const r = await c.tap(1, 1, 1);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/ECONNREFUSED/);
  });
});
