import { describe, expect, it, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { liveCheck } from "./live-check";
import type { McpServerRow } from "../store/mcp";

/** Never a real key; every assertion about it is that it does NOT appear in a result. */
const KEY = "pat-do-not-leak-me";

// `oauthJson`/`tools` are gateway-era row fields (Plan 9 W3/W5). liveCheck reads neither — it dials the
// upstream server with the row's own command/URL and secrets — but the row type requires them.
const row = (extra: Partial<McpServerRow>): McpServerRow => ({
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "probe", transport: "stdio",
  command: "", args: [], url: "", secrets: {}, oauthJson: "", tools: [], scope: { kind: "space", spaceId: null }, createdAt: 0, updatedAt: 0, ...extra,
});

/** A real MCP-shaped stdio server: reads newline-delimited JSON, answers initialize. Inline node
 *  script, so the test needs nothing installed beyond the node running it. */
const ECHO_SERVER = `
  let buf = "";
  process.stdin.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      const msg = JSON.parse(line);
      if (msg.method === "initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { serverInfo: { name: "fake-mcp", version: "9.9" } } }) + "\\n");
      }
    }
  });
`;

describe("stdio live check", () => {
  it("reaches a server that answers initialize, and names it", async () => {
    const r = await liveCheck(row({ command: process.execPath, args: ["-e", ECHO_SERVER], secrets: { API_KEY: KEY } }));
    expect(r.reached).toBe(true);
    expect(r.detail).toContain("fake-mcp 9.9");
    expect(r.detail).not.toContain(KEY);
  });

  it("skips log noise on stdout and still finds the response", async () => {
    const noisy = `process.stdout.write("starting up...\\n");${ECHO_SERVER}`;
    const r = await liveCheck(row({ command: process.execPath, args: ["-e", noisy] }));
    expect(r.reached).toBe(true);
  });

  it("fails a command that does not exist — and the env value stays out of the detail", async () => {
    const r = await liveCheck(row({ command: "/nonexistent/definitely-not-a-command", secrets: { API_KEY: KEY } }));
    expect(r.reached).toBe(false);
    expect(r.detail).toContain("could not start");
    expect(r.detail).not.toContain(KEY);
  });

  it("fails a command that exits without answering", async () => {
    const r = await liveCheck(row({ command: process.execPath, args: ["-e", "process.exit(3)"] }));
    expect(r.reached).toBe(false);
    expect(r.detail).toContain("exited (code 3)");
  });

  it("times out a command that starts but never speaks", async () => {
    const r = await liveCheck(row({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }), 300);
    expect(r.reached).toBe(false);
    expect(r.detail).toContain("no response");
  });

  it("hands the stored env to the child — the check runs with the session's credentials", async () => {
    // A server that only answers when the key is present proves the secrets actually travel.
    const gated = `if (process.env.API_KEY === ${JSON.stringify(KEY)}) {${ECHO_SERVER}} else { process.exit(1); }`;
    const r = await liveCheck(row({ command: process.execPath, args: ["-e", gated], secrets: { API_KEY: KEY } }));
    expect(r.reached).toBe(true);
  });
});

describe("remote live check", () => {
  let srv: Server | null = null;
  afterEach(() => new Promise<void>((res) => { srv ? srv.close(() => res()) : res(); srv = null; }));

  const listen = (status: number, onReq?: (auth: string | undefined) => void): Promise<string> =>
    new Promise((res) => {
      srv = createServer((req, resp) => { onReq?.(req.headers.authorization); resp.writeHead(status, { "content-type": "application/json" }); resp.end("{}"); });
      srv.listen(0, "127.0.0.1", () => res(`http://127.0.0.1:${(srv!.address() as { port: number }).port}/mcp`));
    });

  it("reaches an http server, sending the stored headers — which never surface in the detail", async () => {
    let seenAuth: string | undefined;
    const url = await listen(200, (a) => { seenAuth = a; });
    const r = await liveCheck(row({ transport: "http", url, secrets: { Authorization: `Bearer ${KEY}` } }));
    expect(r.reached).toBe(true);
    expect(r.detail).toContain("HTTP 200");
    expect(seenAuth).toBe(`Bearer ${KEY}`);
    expect(r.detail).not.toContain(KEY);
  });

  it("counts a 401 as reached, but says the credentials were refused", async () => {
    const url = await listen(401);
    const r = await liveCheck(row({ transport: "http", url }));
    expect(r.reached).toBe(true);
    expect(r.detail).toContain("refused the credentials");
  });

  it("reaches an sse endpoint with a plain GET", async () => {
    const url = await listen(200);
    const r = await liveCheck(row({ transport: "sse", url }));
    expect(r.reached).toBe(true);
  });

  it("fails when nothing is listening", async () => {
    // Bind a port, close it, and probe the now-dead address: guaranteed unoccupied.
    const url = await listen(200);
    await new Promise<void>((res) => srv!.close(() => res()));
    srv = null;
    const r = await liveCheck(row({ transport: "http", url, secrets: { Authorization: KEY } }));
    expect(r.reached).toBe(false);
    expect(r.detail).toContain("could not connect");
    expect(r.detail).not.toContain(KEY);
  });
});
