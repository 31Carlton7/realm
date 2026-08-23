import { describe, it, expect, vi } from "vitest";
import { StdioJsonRpc, JsonRpcCallError } from "./stdio";

/**
 * Every assertion in this file is gated on a real child process: node cold start, module load and at least one
 * round trip. vitest's 1000 ms default is routinely too tight for that on a loaded two-core CI runner, and a
 * longer bound costs nothing when the assertion passes.
 */
const waitFor = <T>(fn: () => T | Promise<T>) => vi.waitFor(fn, { timeout: 10_000, interval: 25 });

/** A child that echoes back one canned reply per inbound line. Written as a node -e script so the test exercises real ndjson framing. */
const echoScript = `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "ping") process.stdout.write(JSON.stringify({ id: msg.id, result: { pong: msg.params?.n ?? 0 } }) + "\\n");
    if (msg.method === "boom") process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32600, message: "nope", data: { action: "relogin" } } }) + "\\n");
    if (msg.method === "slowPing") {
      // Fire a server -> client request that REUSES this same request's id while it is still pending,
      // then deliver the real response ~150ms later. A dispatcher that resolves by id-lookup instead of
      // frame shape would settle the client's promise from the collision, not the real response.
      process.stdout.write(JSON.stringify({ method: "askYou", id: msg.id, params: { q: "ok?" } }) + "\\n");
      setTimeout(() => process.stdout.write(JSON.stringify({ id: msg.id, result: { pong: msg.params?.n ?? 0 } }) + "\\n"), 150);
    }
    if (msg.method === "notifyMe") process.stdout.write(JSON.stringify({ method: "tick", params: { at: 1 }, emittedAtMs: 7 }) + "\\n");
    if (msg.method === "loud") process.stderr.write("noise-1\\nnoise-2\\n");
    if (msg.method === "spam") {
      // 60 lines, one write each, to exercise the 50-line stderrTail cap's shift() branch.
      for (let n = 1; n <= 60; n++) process.stderr.write("line-" + n + "\\n");
    }
    if (msg.method === "big") {
      // A single large write is split across multiple stdout 'data' chunks by the OS pipe buffer
      // (well under 500KB on any platform), exercising the outBuf reassembly loop for real.
      const s = "x".repeat(500000);
      process.stdout.write(JSON.stringify({ id: msg.id, result: { s: s } }) + "\\n");
    }
  }
});
`;

const make = (over: Partial<ConstructorParameters<typeof StdioJsonRpc>[0]> = {}) => {
  const notifications: { method: string; params: unknown }[] = [];
  const serverRequests: { id: number | string; method: string; params: unknown }[] = [];
  const stderr: string[] = [];
  const onExit = vi.fn();
  const rpc = new StdioJsonRpc({
    command: process.execPath, args: ["-e", echoScript], cwd: process.cwd(),
    onNotification: (n) => notifications.push(n),
    onServerRequest: (r) => serverRequests.push(r),
    onStderr: (l) => stderr.push(l),
    onExit,
    ...over,
  });
  return { rpc, notifications, serverRequests, stderr, onExit };
};

describe("StdioJsonRpc", () => {
  it("round-trips a request and resolves with the result", async () => {
    const { rpc } = make();
    await expect(rpc.request("ping", { n: 5 })).resolves.toEqual({ pong: 5 });
    await rpc.dispose();
  });

  it("rejects with a JsonRpcCallError carrying code and data", async () => {
    const { rpc } = make();
    await expect(rpc.request("boom")).rejects.toMatchObject({ code: -32600, data: { action: "relogin" } });
    await rpc.dispose();
  });

  it("dispatches a server request whose id collides with a live client id", async () => {
    const { rpc, serverRequests } = make();
    // The child immediately fires a server request reusing this SAME id while the request is still
    // pending, then delays the real response ~150ms. This is a genuine race, not a coincidence of
    // disjoint id spaces: id-first dispatch would find the pending entry and settle the promise wrong.
    const inFlight = rpc.request("slowPing", { n: 1 });
    await waitFor(() => expect(serverRequests).toHaveLength(1));
    expect(serverRequests[0]).toMatchObject({ method: "askYou" });
    const liveId = serverRequests[0]!.id;
    // The colliding server request must not have touched the pending client request: it should still
    // resolve, ~150ms later, from the real deferred response and not from the collision.
    await expect(inFlight).resolves.toEqual({ pong: 1 });
    rpc.respond(liveId, { ok: true });
    await rpc.dispose();
  });

  it("delivers notifications (which have no id)", async () => {
    const { rpc, notifications } = make();
    rpc.notify("notifyMe");
    await waitFor(() => expect(notifications).toContainEqual({ method: "tick", params: { at: 1 } }));
    await rpc.dispose();
  });

  it("keeps a bounded stderr tail and forwards lines", async () => {
    const { rpc, stderr } = make();
    rpc.notify("loud");
    await waitFor(() => expect(stderr).toEqual(["noise-1", "noise-2"]));
    expect(rpc.stderrTail).toEqual(["noise-1", "noise-2"]);
    await rpc.dispose();
  });

  it("caps the stderr tail at 50 lines, dropping the oldest", async () => {
    const { rpc, stderr } = make();
    rpc.notify("spam");
    await waitFor(() => expect(stderr).toHaveLength(60));
    expect(rpc.stderrTail).toHaveLength(50);
    expect(rpc.stderrTail[0]).toBe("line-11");
    expect(rpc.stderrTail[49]).toBe("line-60");
    await rpc.dispose();
  });

  it("reassembles a JSON-RPC frame split across multiple stdout chunks", async () => {
    const { rpc } = make();
    const result = await rpc.request<{ s: string }>("big");
    expect(result.s).toHaveLength(500_000);
    expect(result.s).toBe("x".repeat(500_000));
    await rpc.dispose();
  });

  it("dispose() reports onExit exactly once with disposed: true", async () => {
    const { rpc, onExit } = make();
    await rpc.dispose();
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ disposed: true, reason: "disposed" }));
  });

  it("rejects in-flight requests and reports exit when the child dies", async () => {
    const { rpc, onExit } = make({ args: ["-e", "process.exit(3)"] });
    await expect(rpc.request("ping")).rejects.toThrow(/exited/);
    await waitFor(() => expect(onExit).toHaveBeenCalled());
    expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ disposed: false }));
    await rpc.dispose();
  });

  it("reports a spawn failure as an exit rather than throwing", async () => {
    const { rpc, onExit } = make({ command: "/definitely/not/a/binary", args: [] });
    await expect(rpc.request("ping")).rejects.toThrow();
    await waitFor(() => expect(onExit).toHaveBeenCalled());
    expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ disposed: false }));
    await rpc.dispose();
  });
});
