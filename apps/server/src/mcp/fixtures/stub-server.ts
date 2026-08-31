import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * A minimal in-process MCP server, standing in for every third-party upstream `hub.ts` will ever talk
 * to. Every hub/gateway test in W2–W6 connects to one of these instead of a real process, so its shape
 * is deliberately generic: two tools (`echo`, `boom`) plus the levers a test actually needs — force the
 * next N calls to return a tool-level error result (`failNext`) or to reject the round-trip entirely
 * (`throwNext`, a distinct lever because the hub's circuit breaker treats the two very differently — see
 * `hub.ts`'s `CIRCUIT_THRESHOLD` doc comment), and push a `tools/list_changed` notification (cache-refresh
 * tests). Nothing here is Realm-specific; it only speaks MCP.
 */
export type StubServerOptions = {
  /** Defaults to `echo` + `boom`. */
  tools?: Tool[];
  /** Observes every `tools/call`, forced failures included — lets a test assert on args without
   *  threading a return value through the protocol. */
  onCall?: (tool: string, args: unknown) => void;
};

export type StubServer = {
  server: Server;
  /**
   * One fresh in-memory transport per call, matching what a real hub does per connecting client: the
   * server side of the pair attaches to `server` immediately, and the returned client-side transport is
   * what the test hands to an SDK `Client`.
   */
  connectInMemory(): Promise<Transport>;
  /** Swap the served tool list and emit `notifications/tools/list_changed` for it. */
  setTools(tools: Tool[]): void;
  /**
   * The next `n` `tools/call` requests (any tool name, `echo` included) return an `isError: true` result
   * instead of succeeding — a normal, successfully round-tripped response the *tool* reports as failed.
   * A test that needs "fail, fail, succeed, fail, fail, fail" can't get that from `boom` alone, since
   * `boom` never succeeds.
   */
  failNext(n: number): void;
  /**
   * The next `n` `tools/call` requests reject instead of resolving at all — the server handler throws,
   * so the client's `callTool()` promise rejects with a protocol-level error. This is what the hub's
   * circuit breaker actually counts; `failNext` deliberately does not trip it.
   */
  throwNext(n: number): void;
  close(): Promise<void>;
};

// `echo`'s schema is deliberately NOT a bare `{type:"object"}` — a required `message` property is what
// every hub/gateway test that cares about schema fidelity (as opposed to just tool names) asserts
// survives the round trip verbatim, distinguishing it from a placeholder a naive re-export could produce.
const DEFAULT_TOOLS: Tool[] = [
  { name: "echo", description: "Returns its arguments as text content.", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  { name: "boom", description: "Always returns an error result.", inputSchema: { type: "object" } },
];

const errorResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

export function makeStubServer(opts: StubServerOptions = {}): StubServer {
  let tools = opts.tools ?? DEFAULT_TOOLS;
  let forcedFailures = 0;
  let forcedThrows = 0;

  // `tools: { listChanged: true }` is not decoration — the client only wires up its list-changed
  // notification handling for capabilities the server actually advertises during `initialize`.
  const server = new Server({ name: "stub-mcp-server", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    opts.onCall?.(name, args);
    // Checked before `failNext` so a test can set both and know exactly which one fires — not that any
    // test needs to today, but a silent priority order is the kind of thing that bites later.
    if (forcedThrows > 0) {
      forcedThrows -= 1;
      throw new Error(`${name} failed (forced throw by throwNext)`);
    }
    if (forcedFailures > 0) {
      forcedFailures -= 1;
      return errorResult(`${name} failed (forced by failNext)`);
    }
    if (name === "boom") return errorResult("boom always fails");
    return { content: [{ type: "text", text: JSON.stringify(args ?? {}) }] };
  });

  return {
    server,
    async connectInMemory() {
      // The SDK's `Server` refuses a second `connect()` while it still thinks it owns a transport (see
      // `Protocol.connect`'s guard). A real hub reconnect never hits this — each attempt is a fresh OS
      // process or socket — but this fixture reuses one `Server` across a whole test's reconnects
      // (invalidate, retry, close), so it closes defensively first. A no-op when nothing is connected.
      await server.close().catch(() => {});
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      return clientSide;
    },
    setTools(next) {
      tools = next;
      // Fire-and-forget: the notification itself is one-way, and a test awaits the hub's *effect* of
      // receiving it (a re-listed, re-cached tool set), not this call.
      void server.sendToolListChanged();
    },
    failNext(n) {
      forcedFailures = n;
    },
    throwNext(n) {
      forcedThrows = n;
    },
    async close() {
      await server.close();
    },
  };
}
