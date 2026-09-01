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
const newHttpRow = (secrets: Record<string, string> = {}): McpServerRow =>
  servers.create({ name: `s-${Math.random().toString(36).slice(2)}`, transport: "http", command: "", args: [], url: "https://example.invalid/mcp", secrets });

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
  it("persists a successful tools/list to the row via setTools — name+description only in the CACHE, but the live return carries inputSchema too", async () => {
    const schema = { type: "object" as const, properties: { q: { type: "string" as const } }, required: ["q"] };
    const row = newRow();
    const stub = makeStubServer({ tools: [{ name: "search", description: "Search records", inputSchema: schema }] });
    const { hub } = hubFor(stub);
    const tools = await hub.tools(row.id);
    // The live return: real inputSchema, straight from the upstream server.
    expect(tools).toEqual([{ name: "search", description: "Search records", inputSchema: schema }]);
    // The persisted cache: name + description ONLY — see `McpToolRow`'s doc comment on why a schema
    // does not belong in something that can go stale between hub connections.
    expect(servers.get(row.id)!.tools).toEqual([{ name: "search", description: "Search records" }]);
  });

  it("defaults a tool with no description to \"\", never undefined", async () => {
    const row = newRow();
    const stub = makeStubServer({ tools: [{ name: "bare", inputSchema: { type: "object" } }] });
    const { hub } = hubFor(stub);
    expect(await hub.tools(row.id)).toEqual([{ name: "bare", description: "", inputSchema: { type: "object" } }]);
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
  it("opens after 3 consecutive THROWN failures, a success resets the count, retry() closes it", async () => {
    // Uses `throwNext` (a rejected round-trip), not `failNext` (an `isError` result) — see the
    // "does not count an isError result" test below for why that distinction is the whole point.
    const row = newRow();
    const stub = makeStubServer();
    const statuses: string[] = [];
    const { hub } = hubFor(stub, { onStatus: (_id, s) => statuses.push(s) });

    await hub.tools(row.id); // connected

    stub.throwNext(2);
    await expect(hub.call(row.id, "echo", {})).rejects.toThrow();
    await expect(hub.call(row.id, "echo", {})).rejects.toThrow();
    // The named mutant: don't reset `failures` on success, and the next 3-in-a-row below (which is only
    // 3 failures total, not 5) would already have tripped the breaker from these first two.
    expect((await hub.call(row.id, "echo", { ok: true })).isError).toBeUndefined();

    stub.throwNext(3);
    await expect(hub.call(row.id, "echo", {})).rejects.toThrow();
    await expect(hub.call(row.id, "echo", {})).rejects.toThrow();
    await expect(hub.call(row.id, "echo", {})).rejects.toThrow(); // 3rd consecutive → circuit opens

    await expect(hub.call(row.id, "echo", {})).rejects.toThrow(/mcp\.retry/);
    // Fail-fast means no request reached the stub at all — the 4th failure didn't consume a throwNext slot.
    await expect(hub.tools(row.id)).rejects.toThrow(/mcp\.retry/);

    await hub.retry(row.id);
    const result = await hub.call(row.id, "echo", { reconnected: true });
    expect(result).toMatchObject({ content: [{ type: "text", text: JSON.stringify({ reconnected: true }) }] });

    expect(statuses).toEqual(["connected", "error", "error", "connected", "error", "error", "circuit_open", "idle", "connected"]);
  });

  it("never counts an isError result toward the breaker, however many happen in a row", async () => {
    // BLOCKING fix: an `isError: true` result is a successful, round-tripped MCP response — the tool
    // ran and reported a problem. Three of those from one confused agent must not circuit-open a server
    // that is working fine, so `failNext` (unlike `throwNext` above) must never move the needle.
    const row = newRow();
    const stub = makeStubServer();
    const statuses: string[] = [];
    const { hub } = hubFor(stub, { onStatus: (_id, s) => statuses.push(s) });
    await hub.tools(row.id); // connected

    stub.failNext(5); // more than CIRCUIT_THRESHOLD
    for (let i = 0; i < 5; i++) {
      expect((await hub.call(row.id, "echo", {})).isError).toBe(true);
    }
    expect(statuses).toEqual(["connected"]); // never dipped into "error" or "circuit_open"

    const healthy = await hub.call(row.id, "echo", { fine: true });
    expect(healthy.isError).toBeUndefined();
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

  it("counts a missing-row failure toward the breaker instead of caching the rejection forever", async () => {
    // The named bug: `connect()`'s `!row` branch used to write `entry.connecting = null` before the
    // OUTER `entry.connecting = this.connect(...)` assignment (in `ensureClient`) had landed — `connect`
    // throws before its first `await`, so the null write happens first and then gets clobbered by the
    // rejected promise a moment later. Every later `tools()` call then saw `entry.connecting` already
    // set and replayed that same cached rejection forever, without ever calling `recordFailure` again —
    // three calls produced `["error"]`, not `["error","error","circuit_open"]`, and the entry wedged.
    const row = newRow();
    servers.delete(row.id); // defined, then removed — same shape as "the gateway raced a row delete"
    const statuses: string[] = [];
    const hub = new McpHub({ servers, onStatus: (_id, s) => statuses.push(s), authHeaders: noAuth });
    await expect(hub.tools(row.id)).rejects.toThrow();
    await expect(hub.tools(row.id)).rejects.toThrow();
    await expect(hub.tools(row.id)).rejects.toThrow();
    expect(statuses).toEqual(["error", "error", "circuit_open"]);
    await expect(hub.tools(row.id)).rejects.toThrow(/mcp\.retry/); // fail-fast, same as any other class
    expect(statuses).toEqual(["error", "error", "circuit_open"]); // the 4th call added nothing new
  });

  it("does not double-wrap the missing-row message", async () => {
    const row = newRow();
    servers.delete(row.id);
    const hub = new McpHub({ servers, onStatus: () => {}, authHeaders: noAuth });
    let err: unknown;
    try { await hub.tools(row.id); } catch (e) { err = e; }
    expect((err as Error).message).toBe(`mcp server ${row.id}: server row not found`);
  });
});

describe("authHeaders seam (http/sse)", () => {
  it("merges row.secrets with authHeaders, authHeaders winning on a key collision, and both reach the transport builder", async () => {
    // Every other test row in this file is stdio, so `buildTransport`'s http/sse branch — and the merge
    // order OAuth (W5) depends on — had zero coverage until this test.
    const row = newHttpRow({ Authorization: "Bearer stale-secret-key", "X-Extra": "extra-value" });
    const stub = makeStubServer();
    let captured: Record<string, string> | null = null;
    const hub = new McpHub({
      servers, onStatus: () => {},
      authHeaders: async () => ({ Authorization: "Bearer fresh-oauth-token" }),
      makeTransport: async (_row, headers): Promise<Transport> => { captured = headers; return stub.connectInMemory(); },
    });
    await hub.tools(row.id);
    expect(captured).toEqual({ Authorization: "Bearer fresh-oauth-token", "X-Extra": "extra-value" });
  });

  it("redacts an authHeaders value from an error message the same as a row secret", async () => {
    // HARDENING: `sanitize()` used to scrub only `row.secrets`. A W5 OAuth bearer token arrives via
    // `authHeaders`, never `row.secrets`, so a 401 body quoting it back would have sailed through
    // unredacted. This row has NO secrets at all — the sentinel arrives purely via `authHeaders`.
    const SENTINEL = "oauth-bearer-do-not-leak-me";
    const row = newHttpRow();
    const hub = new McpHub({
      servers, onStatus: () => {},
      authHeaders: async () => ({ Authorization: `Bearer ${SENTINEL}` }),
      makeTransport: () => { throw new Error(`401: invalid token "Bearer ${SENTINEL}"`); },
    });
    let err: unknown;
    try { await hub.tools(row.id); } catch (e) { err = e; }
    expect((err as Error).message).not.toContain(SENTINEL);
    expect((err as Error).message).toContain("[redacted]");
  });

  it("redacts the BARE token when an upstream error quotes it without its scheme prefix", async () => {
    // THE LEAK THIS FIXES: `entry.redact` used to be `Object.values(headers)`, i.e. the literal
    // `"Bearer at_xyz"`. A 401 body quoting the bare token — which is what an OAuth error response
    // actually does (`{"error":"invalid_token","token":"at_xyz"}`) — matched nothing, and the token rode
    // the sanitized message all the way into `mcp_call_log.result_summary`, the `mcp.call` broadcast,
    // and the agent's own tool-result context. `credentialValues` now contributes both forms.
    const SENTINEL = "at_bare_token_do_not_leak_me";
    const row = newHttpRow();
    const hub = new McpHub({
      servers, onStatus: () => {},
      authHeaders: async () => ({ Authorization: `Bearer ${SENTINEL}` }),
      makeTransport: () => { throw new Error(`401 {"error":"invalid_token","token":"${SENTINEL}"}`); },
    });
    let err: unknown;
    try { await hub.tools(row.id); } catch (e) { err = e; }
    expect((err as Error).message).not.toContain(SENTINEL);
    expect((err as Error).message).toContain("[redacted]");
    // The diagnostic itself survives — redaction must not cost the reader what went wrong.
    expect((err as Error).message).toContain("invalid_token");
  });

  it("still redacts a row secret when authHeaders itself REJECTS, not just when it resolves", async () => {
    // W2 review drive-by fix: `entry.redact` used to be set only from `{ ...row.secrets, ...(await
    // authHeaders(row)) }` — AFTER the `await`. A rejecting `authHeaders` (a token-refresh network
    // error, say) never reached that line, so if its rejection message happened to echo a row secret
    // (a provider error quoting back the header it rejected), sanitize() had nothing to redact with.
    const SECRET = "row-secret-do-not-leak-me";
    const row = newHttpRow({ "X-Api-Key": SECRET });
    const hub = new McpHub({
      servers, onStatus: () => {},
      authHeaders: async () => { throw new Error(`refresh failed, last known key was "${SECRET}"`); },
    });
    let err: unknown;
    try { await hub.tools(row.id); } catch (e) { err = e; }
    expect((err as Error).message).not.toContain(SECRET);
    expect((err as Error).message).toContain("[redacted]");
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

  it("redacts a secret value the upstream error message echoes back", async () => {
    // HARDENING fix: forwarding only `err.message` isn't enough on its own — a real transport error can
    // legitimately echo part of a failed request back (an HTTP error body quoting a bad API key). This
    // proves `sanitize()` actively scrubs `row.secrets` values out of whatever the SDK hands back, not
    // just that the hub's own code never constructs a leaking message.
    const SENTINEL = "sk-do-not-leak-me-anywhere";
    const row = newRow({ TOKEN: SENTINEL });
    const hub = new McpHub({
      servers, onStatus: () => {}, authHeaders: noAuth,
      makeTransport: () => { throw new Error(`POST failed: upstream said "invalid token ${SENTINEL}"`); },
    });
    let err: unknown;
    try { await hub.tools(row.id); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(SENTINEL);
    expect((err as Error).message).toContain("[redacted]");
  });

  it("leaves a short secret value (<4 chars) alone rather than shredding ordinary text", async () => {
    // A 2-3 char "secret" (a stray env var, a placeholder) would otherwise turn common substrings of an
    // unrelated error message into `[redacted]` noise. The threshold trades a theoretical, tiny leak for
    // a message that stays legible in the overwhelmingly common case.
    const row = newRow({ PIN: "42" });
    const hub = new McpHub({
      servers, onStatus: () => {}, authHeaders: noAuth,
      makeTransport: () => { throw new Error("connect ETIMEDOUT after 42 retries"); },
    });
    let err: unknown;
    try { await hub.tools(row.id); } catch (e) { err = e; }
    expect((err as Error).message).toContain("42 retries");
  });
});

describe("superseded connects", () => {
  /**
   * Wraps the transport `connectInMemory()` returns so a test can see whether the hub actually closed
   * it — the assertion the leak fix hangs on. Monkey-patches the instance's own `close`, shadowing the
   * prototype method; `Client`/`Protocol` only ever calls `transport.close()`, so this is transparent.
   *
   * `called` guards against counting more than once: `InMemoryTransport.close()` closes its paired
   * transport and that pairing closes back, which re-enters this same shadowed `close` a second time —
   * an artifact of the in-memory pair's plumbing, not a second close attempt by the hub. The signal this
   * test wants is "did the hub close this transport at all", not the SDK's internal recursion count.
   */
  function spyOnClose(t: Transport, onClose: () => void): Transport {
    const originalClose = t.close.bind(t);
    let called = false;
    t.close = async () => {
      if (!called) { called = true; onClose(); }
      return originalClose();
    };
    return t;
  }

  it("closes and discards a client whose connect resolves after invalidate() raced it", async () => {
    // BLOCKING fix: the reviewer reproduced this as a leaked child process. `invalidate()` runs fully
    // synchronously and completes before `connect()`'s first `await` yields back to it (see hub.ts's
    // `entries` map identity check), so this race is deterministic, not a timing gamble.
    const row = newRow();
    const stub = makeStubServer();
    let transportCloses = 0;
    const hub = new McpHub({
      servers, onStatus: () => {}, authHeaders: noAuth,
      makeTransport: async (): Promise<Transport> => spyOnClose(await stub.connectInMemory(), () => { transportCloses += 1; }),
    });

    const pending = hub.tools(row.id);
    hub.invalidate(row.id); // races the in-flight connect
    await expect(pending).rejects.toThrow(/superseded/i);
    expect(transportCloses).toBe(1); // the orphaned client was actually closed, not left dangling

    // The hub is not wedged: the next use makes a genuinely fresh connection.
    const tools = await hub.tools(row.id);
    expect(tools.map((t) => t.name).sort()).toEqual(["boom", "echo"]);
  });

  it("closes and discards a client whose connect resolves after close() raced it", async () => {
    const row = newRow();
    const stub = makeStubServer();
    let transportCloses = 0;
    const hub = new McpHub({
      servers, onStatus: () => {}, authHeaders: noAuth,
      makeTransport: async (): Promise<Transport> => spyOnClose(await stub.connectInMemory(), () => { transportCloses += 1; }),
    });

    const pending = hub.tools(row.id);
    // `close()` must await this in-flight connect (not fire-and-forget past it) for the reap to have
    // happened by the time `close()` itself returns — that's the property under test.
    await hub.close();
    await expect(pending).rejects.toThrow(/superseded/i);
    expect(transportCloses).toBe(1);

    // A closed hub refuses new work outright rather than silently reconnecting.
    await expect(hub.tools(row.id)).rejects.toThrow(/superseded/i);
  });

  it("never trips the breaker for a superseded connect", async () => {
    const row = newRow();
    const stub = makeStubServer();
    const statuses: string[] = [];
    const hub = new McpHub({
      servers, onStatus: (_id, s) => statuses.push(s), authHeaders: noAuth,
      makeTransport: async (): Promise<Transport> => stub.connectInMemory(),
    });
    const pending = hub.tools(row.id);
    hub.invalidate(row.id);
    await expect(pending).rejects.toThrow();
    // `invalidate()` itself emits "idle"; nothing else — in particular no "error"/"circuit_open" from
    // the superseded connect's own catch block treating the race as a server failure.
    expect(statuses).toEqual(["idle"]);
  });

  it("real stdio process: closes and discards a connect superseded by invalidate()", async () => {
    // The one non-in-memory race test — proves the reap actually tears down a real child process, not
    // just an `InMemoryTransport`. Same deterministic race as the seam-based tests above (see their doc
    // comments): `invalidate()` completes synchronously before the handshake's first `await` returns.
    const tsxBin = join(HERE, "..", "..", "node_modules", ".bin", "tsx");
    const stubStdioScript = join(HERE, "fixtures", "stub-stdio.ts");
    const row = newRow({ PATH: process.env.PATH ?? "" });
    servers.update(row.id, { command: tsxBin, args: [stubStdioScript] });
    const hub = new McpHub({ servers, onStatus: () => {}, authHeaders: noAuth });
    try {
      const pending = hub.tools(row.id);
      hub.invalidate(row.id);
      await expect(pending).rejects.toThrow(/superseded/i);
      // Reconnects cleanly afterward — the superseded attempt didn't leave the row wedged.
      const tools = await hub.tools(row.id);
      expect(tools.map((t) => t.name).sort()).toEqual(["boom", "echo"]);
    } finally {
      await hub.close();
    }
  }, 20_000);
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
    // A closed hub refuses new work rather than silently reconnecting — see "superseded connects".
    await expect(hub.tools(rowA.id)).rejects.toThrow(/superseded/i);
    expect(connectsA.n).toBe(1);
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
