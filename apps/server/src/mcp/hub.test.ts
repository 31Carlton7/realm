import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { openDatabase } from "../db/database";
import { McpServersStore, type McpServerRow } from "../store/mcp";
import { waitFor } from "../test-utils";
import { McpHub } from "./hub";
import { makeStubServer, type StubServer } from "./fixtures/stub-server";

const HERE = dirname(fileURLToPath(import.meta.url));

let servers: McpServersStore;
beforeEach(() => {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "realm-mcp-hub-")), "realm.db"));
  servers = new McpServersStore(db);
});

const noAuth = async () => ({});
const newRow = (secrets: Record<string, string> = {}): McpServerRow =>
  servers.create({ name: `s-${Math.random().toString(36).slice(2)}`, transport: "stdio", command: "unused-in-memory", args: [], url: "", secrets });

/** Builds a hub wired to `stub` through the in-memory transport seam, counting how many times the
 *  transport was actually built — the assertion every "lazy"/"shared" test below hangs on. */
function hubFor(stub: StubServer, opts: { onStatus?: (id: string, status: string) => void } = {}) {
  const connects = { n: 0 };
  const hub = new McpHub({
    servers,
    onStatus: opts.onStatus ?? (() => {}),
    authHeaders: noAuth,
    makeTransport: async (): Promise<Transport> => { connects.n += 1; return stub.connectInMemory(); },
  });
  return { hub, connects };
}

describe("lazy connect", () => {
  it("connects nothing at construction; the first tools() call is what connects", async () => {
    const row = newRow();
    const { hub, connects } = hubFor(makeStubServer());
    expect(connects.n).toBe(0);
    await hub.tools(row.id);
    expect(connects.n).toBe(1);
  });

  it("reuses the same client on a second call — no reconnect for an already-connected row", async () => {
    const row = newRow();
    const { hub, connects } = hubFor(makeStubServer());
    await hub.tools(row.id);
    await hub.call(row.id, "echo", {});
    expect(connects.n).toBe(1);
  });
});

describe("sharing an in-flight connect", () => {
  it("produces exactly one connect for two concurrent callers on the same server", async () => {
    // The named mutant: drop the `entry.connecting` promise and call `connect()` unconditionally from
    // `ensureClient()`, and this fails with connects.n === 2.
    const row = newRow();
    const { hub, connects } = hubFor(makeStubServer());
    const [tools, call] = await Promise.all([hub.tools(row.id), hub.call(row.id, "echo", { a: 1 })]);
    expect(connects.n).toBe(1);
    expect(tools.map((t) => t.name).sort()).toEqual(["boom", "echo"]);
    expect(call).toMatchObject({ content: [{ type: "text", text: JSON.stringify({ a: 1 }) }] });
  });

  it("does not share a connect across two DIFFERENT server rows", async () => {
    const rowA = newRow();
    const rowB = newRow();
    const stubA = makeStubServer();
    const stubB = makeStubServer();
    const connects = { n: 0 };
    const hub = new McpHub({
      servers, onStatus: () => {}, authHeaders: noAuth,
      makeTransport: async (row): Promise<Transport> => {
        connects.n += 1;
        return row.id === rowA.id ? stubA.connectInMemory() : stubB.connectInMemory();
      },
    });
    await Promise.all([hub.tools(rowA.id), hub.tools(rowB.id)]);
    expect(connects.n).toBe(2);
  });
});

describe("tool cache", () => {
  it("persists a successful tools/list to the row via setTools", async () => {
    const row = newRow();
    const stub = makeStubServer({ tools: [{ name: "search", description: "Search records", inputSchema: { type: "object" } }] });
    const { hub } = hubFor(stub);
    const tools = await hub.tools(row.id);
    expect(tools).toEqual([{ name: "search", description: "Search records" }]);
    expect(servers.get(row.id)!.tools).toEqual([{ name: "search", description: "Search records" }]);
  });

  it("defaults a tool with no description to \"\", never undefined", async () => {
    const row = newRow();
    const stub = makeStubServer({ tools: [{ name: "bare", inputSchema: { type: "object" } }] });
    const { hub } = hubFor(stub);
    expect(await hub.tools(row.id)).toEqual([{ name: "bare", description: "" }]);
  });
});

describe("tools/list_changed", () => {
  it("relists and recaches on the notification, and re-emits onStatus(connected)", async () => {
    const row = newRow();
    const stub = makeStubServer();
    const statuses: string[] = [];
    const { hub } = hubFor(stub, { onStatus: (_id, s) => statuses.push(s) });
    await hub.tools(row.id); // connects; caches [boom, echo]
    statuses.length = 0; // only care about what the notification itself produces from here

    stub.setTools([{ name: "solo", description: "only tool now", inputSchema: { type: "object" } }]);
    await waitFor(() => servers.get(row.id)!.tools.some((t) => t.name === "solo"));

    expect(servers.get(row.id)!.tools).toEqual([{ name: "solo", description: "only tool now" }]);
    // Unconditional, even though status was already "connected" — see hub.ts's onToolsChanged doc
    // comment: this event doubles as the gateway's only "your cached list is stale" signal.
    expect(statuses).toEqual(["connected"]);
  });
});

describe("circuit breaker", () => {
  it("opens after 3 consecutive failures, a success resets the count, retry() closes it", async () => {
    const row = newRow();
    const stub = makeStubServer();
    const statuses: string[] = [];
    const { hub } = hubFor(stub, { onStatus: (_id, s) => statuses.push(s) });

    await hub.tools(row.id); // connected

    stub.failNext(2);
    expect((await hub.call(row.id, "echo", {})).isError).toBe(true);
    expect((await hub.call(row.id, "echo", {})).isError).toBe(true);
    // The named mutant: don't reset `failures` on success, and the next 3-in-a-row below (which is only
    // 3 failures total, not 5) would already have tripped the breaker from these first two.
    expect((await hub.call(row.id, "echo", { ok: true })).isError).toBeUndefined();

    stub.failNext(3);
    expect((await hub.call(row.id, "echo", {})).isError).toBe(true);
    expect((await hub.call(row.id, "echo", {})).isError).toBe(true);
    expect((await hub.call(row.id, "echo", {})).isError).toBe(true); // 3rd consecutive → circuit opens

    await expect(hub.call(row.id, "echo", {})).rejects.toThrow(/mcp\.retry/);
    // Fail-fast means no request reached the stub at all — the 4th failure didn't consume a failNext slot.
    expect((await hub.tools(row.id).catch(() => "blocked"))).toBe("blocked");

    await hub.retry(row.id);
    const result = await hub.call(row.id, "echo", { reconnected: true });
    expect(result).toMatchObject({ content: [{ type: "text", text: JSON.stringify({ reconnected: true }) }] });

    expect(statuses).toEqual(["connected", "error", "error", "connected", "error", "error", "circuit_open", "idle", "connected"]);
  });

  it("counts a connect failure the same as a call failure", async () => {
    const row = newRow();
    let attempts = 0;
    const hub = new McpHub({
      servers, onStatus: () => {}, authHeaders: noAuth,
      makeTransport: () => { attempts += 1; throw new Error("refused"); },
    });
    await expect(hub.tools(row.id)).rejects.toThrow();
    await expect(hub.tools(row.id)).rejects.toThrow();
    await expect(hub.tools(row.id)).rejects.toThrow();
    expect(attempts).toBe(3); // three real attempts, the third one trips the breaker
    await expect(hub.tools(row.id)).rejects.toThrow(/mcp\.retry/);
    expect(attempts).toBe(3); // the 4th call fails fast — no 4th attempt
  });
});

describe("invalidate", () => {
  it("disconnects and forgets the client, so the next use makes a fresh one", async () => {
    const row = newRow();
    const stub = makeStubServer();
    const statuses: string[] = [];
    const { hub, connects } = hubFor(stub, { onStatus: (_id, s) => statuses.push(s) });
    await hub.tools(row.id);
    expect(connects.n).toBe(1);

    hub.invalidate(row.id);
    expect(statuses.at(-1)).toBe("idle");

    await hub.tools(row.id);
    expect(connects.n).toBe(2);
  });

  it("never throws, even for a server that was never connected", () => {
    expect(() => new McpHub({ servers, onStatus: () => {}, authHeaders: noAuth }).invalidate("01ARZ3NDEKTSV4RRFFQ69G5FAZ")).not.toThrow();
  });
});

describe("sanitized errors", () => {
  it("keeps a connect failure's message free of the row's secret value", async () => {
    // The named mutant: build the thrown error from `row` (e.g. interpolate headers/env into a
    // wrapping message) instead of forwarding only `err.message`, and this fails.
    const SENTINEL = "sk-do-not-leak-me";
    const row = newRow({ TOKEN: SENTINEL });
    const hub = new McpHub({
      servers, onStatus: () => {}, authHeaders: noAuth,
      makeTransport: () => { throw new Error("connection refused"); },
    });
    let err: unknown;
    try { await hub.tools(row.id); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(SENTINEL);
  });
});

describe("close", () => {
  it("closes every live client and never throws", async () => {
    const rowA = newRow();
    const rowB = newRow();
    const stubA = makeStubServer();
    const stubB = makeStubServer();
    const connectsA = { n: 0 };
    const connectsB = { n: 0 };
    const hub = new McpHub({
      servers, onStatus: () => {}, authHeaders: noAuth,
      makeTransport: async (row): Promise<Transport> => {
        if (row.id === rowA.id) { connectsA.n += 1; return stubA.connectInMemory(); }
        connectsB.n += 1; return stubB.connectInMemory();
      },
    });
    await hub.tools(rowA.id);
    await hub.tools(rowB.id);
    await expect(hub.close()).resolves.toBeUndefined();
    // A closed hub reconnects on next use rather than staying dead — same contract as invalidate().
    await hub.tools(rowA.id);
    expect(connectsA.n).toBe(2);
  });
});

describe("stdio integration (real process)", () => {
  it("lists and calls echo over a real stdio child process, via tsx", async () => {
    // The one test in this suite that does not use the in-memory seam — it proves `StdioClientTransport`
    // wiring (command/args/env) actually works end to end, not just that the hub's own bookkeeping does.
    const tsxBin = join(HERE, "..", "..", "node_modules", ".bin", "tsx");
    const stubStdioScript = join(HERE, "fixtures", "stub-stdio.ts");
    // A real child process needs PATH to resolve `node` for tsx's shebang; nothing else. This is what a
    // real user configuring a stdio server whose command needs PATH would also have to supply as `env`.
    const row = newRow({ PATH: process.env.PATH ?? "" });
    servers.update(row.id, { command: tsxBin, args: [stubStdioScript] });
    const hub = new McpHub({ servers, onStatus: () => {}, authHeaders: noAuth });
    try {
      const tools = await hub.tools(row.id);
      expect(tools.map((t) => t.name).sort()).toEqual(["boom", "echo"]);
      const result = await hub.call(row.id, "echo", { hello: "world" });
      expect(result).toMatchObject({ content: [{ type: "text", text: JSON.stringify({ hello: "world" }) }] });
    } finally {
      await hub.close();
    }
  }, 20_000);
});
