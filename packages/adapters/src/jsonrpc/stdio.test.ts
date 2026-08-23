import { describe, it, expect, vi } from "vitest";
import { StdioJsonRpc, JsonRpcCallError } from "./stdio";

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
    await expect(rpc.request("boom")).rejects.toBeInstanceOf(JsonRpcCallError);
    await rpc.request("boom").catch((e: JsonRpcCallError) => {
      expect(e.code).toBe(-32600);
      expect(e.data).toEqual({ action: "relogin" });
    });
    await rpc.dispose();
  });

  it("dispatches a server request whose id collides with a live client id", async () => {
    const { rpc, serverRequests } = make();
    // The child immediately fires a server request reusing this SAME id while the request is still
    // pending, then delays the real response ~150ms. This is a genuine race, not a coincidence of
    // disjoint id spaces: id-first dispatch would find the pending entry and settle the promise wrong.
    const inFlight = rpc.request("slowPing", { n: 1 });
    await vi.waitFor(() => expect(serverRequests).toHaveLength(1));
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
    await vi.waitFor(() => expect(notifications).toContainEqual({ method: "tick", params: { at: 1 } }));
    await rpc.dispose();
  });

  it("keeps a bounded stderr tail and forwards lines", async () => {
    const { rpc, stderr } = make();
    rpc.notify("loud");
    await vi.waitFor(() => expect(stderr).toEqual(["noise-1", "noise-2"]));
    expect(rpc.stderrTail).toEqual(["noise-1", "noise-2"]);
    await rpc.dispose();
  });

  it("rejects in-flight requests and reports exit when the child dies", async () => {
    const { rpc, onExit } = make({ args: ["-e", "process.exit(3)"] });
    await expect(rpc.request("ping")).rejects.toThrow(/exited/);
    await vi.waitFor(() => expect(onExit).toHaveBeenCalled());
    await rpc.dispose();
  });

  it("reports a spawn failure as an exit rather than throwing", async () => {
    const { rpc, onExit } = make({ command: "/definitely/not/a/binary", args: [] });
    await expect(rpc.request("ping")).rejects.toThrow();
    await vi.waitFor(() => expect(onExit).toHaveBeenCalled());
    await rpc.dispose();
  });
});
