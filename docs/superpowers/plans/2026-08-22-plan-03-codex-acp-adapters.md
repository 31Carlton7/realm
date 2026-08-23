# Realm Plan 3 — Codex + ACP (Cursor/Gemini) adapters

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex, Cursor, and Gemini first-class agents in Realm — same transcript, same permission cards, same interrupt and resume — by adding two adapters behind the existing `AgentAdapter` interface, with no changes to `SessionService`, the RPC contract, or the transcript UI.

**Architecture:** Both new protocols are newline-delimited JSON-RPC 2.0 over a child process's stdio with *bidirectional* requests, so Task 1 builds one shared `StdioJsonRpc` transport that both adapters sit on. `CodexAdapter` runs **one** `codex app-server` process shared by every Codex session, fanning notifications out by `threadId` (the protocol multiplexes threads; verified). `AcpAdapter` is generic and instantiated twice — once per registered kind (`acp:cursor`, `acp:gemini`) — with **one child process per session**, because ACP sessions are per-connection. Each adapter pairs with a *pure* mapper module (protocol frame → `SessionEvent[]`) that is unit-tested without any process.

**Tech Stack:** No new runtime dependencies. Raw ndjson JSON-RPC rather than `@zed-industries/agent-client-protocol`, because (a) Codex has no SDK at all so the transport must exist regardless, (b) both protocols' shipped types were verified to *lag the live wire* (Codex's `availableDecisions`, Cursor's `sessionCapabilities`), so permissive hand-written types are the correct posture, and (c) the ACP SDK is ESM-only with a Web-Streams argument order that silently hangs when reversed.

**Protocol references — read these before starting.** They are captured from live processes and are the source of truth for every shape in this plan:
- `docs/dev/codex-app-server-protocol.md`
- `docs/dev/acp-protocol.md`
- Runnable drivers: `docs/dev/examples/codex-smoke.mjs`, `docs/dev/examples/acp-smoke.mjs`

**Conventions:** repo root `/Users/carltonaikins/Desktop/Home/Work/Projects/realm`; branch `feat/plan-03-codex-acp` off `main`; pnpm only; TDD per task; one commit per task with the given message. Run tests with `pnpm test` (vitest 3, root `vitest.config.ts` with `test.projects`); typecheck with `pnpm typecheck`.

**Environment note (2026-08-22).** `codex` and `cursor-agent` are logged in and verified working end-to-end on this machine. `gemini` 0.56.0 speaks ACP but its `oauth-personal` tier has been **discontinued by Google** — `session/new` returns `-32000` pointing at Antigravity. Gemini therefore ships as a registered-but-unauthenticated agent; **do not** treat a Gemini auth failure as a bug in this plan. Develop and verify against **Cursor**.

---

## File structure (new / changed)

```
packages/adapters/src/
  jsonrpc/stdio.ts              (new) StdioJsonRpc — ndjson JSON-RPC over a child process
  jsonrpc/stdio.test.ts         (new)
  codex/map-codex.ts            (new) pure: codex notification → SessionEvent[]
  codex/map-codex.test.ts       (new)
  codex/probe.ts                (new)
  codex/connection.ts           (new) shared app-server process, fan-out by threadId
  codex/codex-adapter.ts        (new)
  codex/codex-adapter.test.ts   (new)
  acp/map-acp.ts                (new) pure: session/update → SessionEvent[]
  acp/map-acp.test.ts           (new)
  acp/probe.ts                  (new)
  acp/acp-adapter.ts            (new)
  acp/acp-adapter.test.ts       (new)
  index.ts                      (modify) new exports
apps/server/src/
  app.ts                        (modify) register codex + acp:cursor + acp:gemini
apps/desktop/src/renderer/src/panes/session/
  NewSessionSheet.tsx           (modify) per-agent login hint instead of the Claude-only one
packages/contracts/src/
  presets.ts                    (modify) AGENT_LOGIN_HINTS
docs/dev/
  codex-app-server-protocol.md  (already written — reference only)
  acp-protocol.md               (already written — reference only)
```

**Deliberately out of scope** (record as Plan 4 candidates, do not build here):
- Dynamic model lists for Codex/ACP. `AGENT_MODELS.codex` and `AGENT_MODELS["acp:*"]` stay `[]`; `Composer.tsx:44` and `NewSessionSheet.tsx:65` already hide the model picker when the list is empty, so these sessions run on the agent's own default model. Discovering models needs `model/list` (Codex) or a live `session/new` (ACP) and a contract change to `ProbeResult`.
- ACP `terminal/*` client methods. We declare `terminal: false`; agents fall back to their own shell execution, which still surfaces as a `tool_call`.
- ACP `plan`, `available_commands_update`, `current_mode_update` updates — parsed and dropped.
- Codex `item/permissions/requestApproval` and `item/tool/requestUserInput` — answered with a JSON-RPC error so the turn never stalls, but no UI.

---

## Part A — Shared transport

### Task 1: `StdioJsonRpc` — ndjson JSON-RPC over a child process

Both protocols send *and receive* requests over one pipe, with **independent id spaces**. Codex numbers its server→client requests from `0` while our client ids are already at `6`; ACP does the same. A pending-map lookup keyed on the bare id would resolve the wrong promise. The dispatcher must therefore branch on **frame shape**, never on id membership.

**Files:**
- Create: `packages/adapters/src/jsonrpc/stdio.ts`
- Create: `packages/adapters/src/jsonrpc/stdio.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/adapters/src/jsonrpc/stdio.test.ts`:

```ts
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

  it("caps the stderr tail at 50 lines, dropping the oldest", async () => {
    const { rpc, stderr } = make();
    rpc.notify("spam");
    await vi.waitFor(() => expect(stderr).toHaveLength(60));
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
    await vi.waitFor(() => expect(onExit).toHaveBeenCalled());
    expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ disposed: false }));
    await rpc.dispose();
  });

  it("reports a spawn failure as an exit rather than throwing", async () => {
    const { rpc, onExit } = make({ command: "/definitely/not/a/binary", args: [] });
    await expect(rpc.request("ping")).rejects.toThrow();
    await vi.waitFor(() => expect(onExit).toHaveBeenCalled());
    expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ disposed: false }));
    await rpc.dispose();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/adapters/src/jsonrpc/stdio.test.ts`
Expected: FAIL — `Failed to resolve import "./stdio"`.

- [ ] **Step 3: Write the implementation**

Create `packages/adapters/src/jsonrpc/stdio.ts`:

```ts
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

export type JsonRpcId = number | string;
export type JsonRpcNotification = { method: string; params: unknown };
export type JsonRpcServerRequest = { id: JsonRpcId; method: string; params: unknown };

/** A JSON-RPC `error` response. `data` is preserved verbatim — Codex hides `{action:"relogin"}` there. */
export class JsonRpcCallError extends Error {
  constructor(readonly code: number, message: string, readonly data: unknown) {
    super(message);
    this.name = "JsonRpcCallError";
  }
}

const STDERR_TAIL_LINES = 50;
const DISPOSE_KILL_TIMEOUT_MS = 2000;

export type StdioJsonRpcOptions = {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  onNotification: (n: JsonRpcNotification) => void;
  /** MUST be answered with respond()/respondError() — an unanswered server request stalls the agent's turn forever. */
  onServerRequest: (r: JsonRpcServerRequest) => void;
  onStderr?: (line: string) => void;
  /** `disposed` is the reliable signal for "we caused this shutdown" vs "the child actually died" —
   *  branch on it, not on parsing `reason`, which is a free-form string for logs only. */
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null; reason: string; disposed: boolean }) => void;
};

/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdio, shared by the Codex and ACP adapters.
 *
 * Inbound frames are dispatched by SHAPE, never by id lookup: the peer numbers its own requests from 0 in an
 * INDEPENDENT id space that overlaps ours (verified on both protocols). `{id, method}` is a server request;
 * `{id, result|error}` is a response to us; `{method}` without an id is a notification.
 *
 * Codex responses additionally omit the `jsonrpc` field, so nothing here validates it.
 */
export class StdioJsonRpc {
  private child: ChildProcess;
  private pending = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private outBuf = "";
  private errBuf = "";
  private dead: Error | null = null;
  private childExited = false;
  private _stderrTail: string[] = [];

  constructor(private o: StdioJsonRpcOptions, deps: { spawn?: typeof nodeSpawn } = {}) {
    const spawnFn = deps.spawn ?? nodeSpawn;
    this.child = spawnFn(o.command, o.args, { cwd: o.cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...o.env } });
    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    this.child.stdout?.on("data", (c: string) => this.onStdout(c));
    this.child.stderr?.on("data", (c: string) => this.onStderrChunk(c));
    // Stream 'error' (EPIPE, ERR_STREAM_WRITE_AFTER_END, ...) is otherwise unhandled and crashes the whole
    // process with an uncaughtException. It isn't fatal to the RPC session by itself — 'exit' is what ends
    // that — so just surface it as a diagnostic.
    this.child.stdin?.on("error", (e: Error) => this.o.onStderr?.(`stdin error: ${e.message}`));
    this.child.stdout?.on("error", (e: Error) => this.o.onStderr?.(`stdout error: ${e.message}`));
    this.child.stderr?.on("error", (e: Error) => this.o.onStderr?.(`stderr error: ${e.message}`));
    this.child.on("error", (e: Error) => {
      this.childExited = true; // never actually started; nothing left to reap
      this.die(`failed to start ${o.command}: ${e.message}`, null, null, false);
    });
    this.child.on("exit", (code, signal) => {
      this.childExited = true;
      this.die(`${o.command} exited (code ${code ?? "null"}, signal ${signal ?? "null"})`, code, signal, false);
    });
  }

  get alive(): boolean { return this.dead === null; }
  get stderrTail(): readonly string[] { return [...this._stderrTail]; }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.dead) return;
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: JsonRpcId, result: unknown): void {
    if (this.dead) return;
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    if (this.dead) return;
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /**
   * Sends EOF — most CLI agents exit cleanly on stdin close — then waits briefly for the real process to
   * go away, escalating to SIGKILL if it hasn't. The child is not spawned detached, so a hard crash of
   * this process still orphans it; this only covers the graceful path.
   */
  async dispose(): Promise<void> {
    if (!this.dead) this.die("disposed", null, null, true);
    this.child.stdin?.end();
    await this.reap();
  }

  private reap(): Promise<void> {
    if (this.childExited) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(killTimer); resolve(); };
      this.child.once("exit", finish);
      this.child.once("error", finish); // spawn never actually started; nothing more to wait for
      const killTimer = setTimeout(() => this.child.kill("SIGKILL"), DISPOSE_KILL_TIMEOUT_MS);
    });
  }

  private write(msg: unknown): void {
    // Guards synchronous throws only (e.g. writing after the stream is already destroyed); async write
    // failures surface via the stdin 'error' listener registered in the constructor instead.
    try { this.child.stdin?.write(JSON.stringify(msg) + "\n"); }
    catch { /* swallow: the 'error'/'exit' handlers already reject everything in flight */ }
  }

  private onStdout(chunk: string): void {
    this.outBuf += chunk;
    let i: number;
    while ((i = this.outBuf.indexOf("\n")) >= 0) {
      const line = this.outBuf.slice(0, i);
      this.outBuf = this.outBuf.slice(i + 1);
      if (line.trim()) this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line) as Record<string, unknown>; }
    catch { this.o.onStderr?.(`unparseable frame: ${line.slice(0, 200)}`); return; }

    const hasId = msg.id !== undefined && msg.id !== null;
    const id = msg.id as JsonRpcId;

    if (hasId && typeof msg.method === "string") { this.o.onServerRequest({ id, method: msg.method, params: msg.params }); return; }
    if (hasId && ("result" in msg || "error" in msg)) {
      const p = this.pending.get(id);
      if (!p) { this.o.onStderr?.(`response for unknown request id ${String(id)}: ${line.slice(0, 200)}`); return; }
      this.pending.delete(id);
      if ("error" in msg) {
        const e = (msg.error ?? {}) as { code?: number; message?: string; data?: unknown };
        p.reject(new JsonRpcCallError(e.code ?? -32603, e.message ?? "request failed", e.data));
      } else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === "string") { this.o.onNotification({ method: msg.method, params: msg.params }); return; }
    this.o.onStderr?.(`unroutable frame: ${line.slice(0, 200)}`);
  }

  private onStderrChunk(chunk: string): void {
    this.errBuf += chunk;
    let i: number;
    while ((i = this.errBuf.indexOf("\n")) >= 0) {
      const line = this.errBuf.slice(0, i);
      this.errBuf = this.errBuf.slice(i + 1);
      if (!line.trim()) continue;
      this.o.onStderr?.(line);
      this._stderrTail.push(line);
      if (this._stderrTail.length > STDERR_TAIL_LINES) this._stderrTail.shift();
    }
  }

  private die(reason: string, code: number | null, signal: NodeJS.Signals | null, disposed: boolean): void {
    if (this.dead) return;
    this.dead = new Error(reason);
    for (const [, p] of this.pending) p.reject(this.dead);
    this.pending.clear();
    this.o.onExit({ code, signal, reason, disposed });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/adapters/src/jsonrpc/stdio.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/jsonrpc
git commit -m "feat(adapters): ndjson JSON-RPC stdio transport shared by Codex and ACP"
```

---

## Part B — Codex adapter

### Task 2: `createCodexMapper` — Codex notifications → `SessionEvent[]`

A pure, stateful mapper, mirroring `claude/map-sdk-message.ts`. Three things it must get right, all verified against live traffic:

1. **Drop Codex's `userMessage` item.** `SessionService.send()` (`apps/server/src/sessions/service.ts:64`) already emits `user_message` before handing the text to the adapter. Mapping the echo would duplicate every message in the transcript.
2. **Force-close open items on `turn/completed`.** An interrupt emits `turn/completed{status:"interrupted"}` with **no** `item/completed` for whatever was streaming, so the mapper must synthesize the missing `tool_result`s or the UI keeps a spinner forever.
3. **Use `tokenUsage.total`, not `last`.** `thread/tokenUsage/updated` fires once per model round-trip, not once per turn; `total` is thread-cumulative.

Advisory notifications (`warning`, `configWarning`, `deprecationNotice`, `mcpServer/startupStatus/updated`, `account/rateLimits/updated`, `rawResponse/*`) are **dropped by the mapper** — the adapter routes them to `opts.onLog` instead. This matters: the user's `~/.codex` config has three MCP servers that fail on every start, and turning those into transcript error cards would put three red cards in every Codex session.

**Files:**
- Create: `packages/adapters/src/codex/map-codex.ts`
- Create: `packages/adapters/src/codex/map-codex.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/adapters/src/codex/map-codex.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createCodexMapper } from "./map-codex";
import type { SessionEvent } from "@realm/contracts";

const types = (evs: SessionEvent[]) => evs.map((e) => e.type);

describe("createCodexMapper", () => {
  it("drops the userMessage echo so the transcript isn't duplicated", () => {
    const m = createCodexMapper();
    const out = m.map("item/started", { item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "hi" }] } });
    expect(out).toEqual([]);
  });

  it("maps agent message deltas and the final text", () => {
    const m = createCodexMapper();
    expect(m.map("item/started", { item: { type: "agentMessage", id: "msg_1", text: "" } })).toEqual([]);
    const d = m.map("item/agentMessage/delta", { itemId: "msg_1", delta: "Run" });
    expect(d[0]).toMatchObject({ type: "assistant_delta", payload: { messageId: "msg_1", delta: "Run" } });
    const f = m.map("item/completed", { item: { type: "agentMessage", id: "msg_1", text: "Running it." } });
    expect(f[0]).toMatchObject({ type: "assistant_text", payload: { messageId: "msg_1", text: "Running it." } });
  });

  it("emits thinking once, from the completed reasoning item", () => {
    const m = createCodexMapper();
    m.map("item/started", { item: { type: "reasoning", id: "rs_1", summary: [], content: [] } });
    expect(m.map("item/reasoning/summaryTextDelta", { itemId: "rs_1", delta: "Check", summaryIndex: 0 })).toEqual([]);
    const done = m.map("item/completed", { item: { type: "reasoning", id: "rs_1", summary: ["Checking the request."], content: [] } });
    expect(done[0]).toMatchObject({ type: "thinking", payload: { messageId: "rs_1", text: "Checking the request." } });
  });

  it("maps commandExecution to tool_call then tool_result", () => {
    const m = createCodexMapper();
    const start = m.map("item/started", { item: { type: "commandExecution", id: "call_1", command: "/bin/zsh -lc 'echo hi'", cwd: "/tmp", status: "inProgress" } });
    expect(start[0]).toMatchObject({ type: "tool_call", payload: { toolUseId: "call_1", name: "exec_command", input: { command: "/bin/zsh -lc 'echo hi'", cwd: "/tmp" }, parentToolUseId: null } });
    const done = m.map("item/completed", { item: { type: "commandExecution", id: "call_1", status: "completed", aggregatedOutput: "hi\n", exitCode: 0 } });
    expect(done[0]).toMatchObject({ type: "tool_result", payload: { toolUseId: "call_1", content: "hi\n", isError: false } });
  });

  it("marks a failed command as an error result", () => {
    const m = createCodexMapper();
    m.map("item/started", { item: { type: "commandExecution", id: "c2", command: "false", cwd: "/tmp" } });
    const done = m.map("item/completed", { item: { type: "commandExecution", id: "c2", status: "failed", aggregatedOutput: "", exitCode: 1 } });
    expect(done[0]).toMatchObject({ type: "tool_result", payload: { isError: true } });
  });

  it("maps fileChange to a tool_call with a readable diff summary", () => {
    const m = createCodexMapper();
    const start = m.map("item/started", { item: { type: "fileChange", id: "p1", status: "inProgress", changes: [{ path: "/tmp/a.txt", kind: { type: "add" }, diff: "hello\n" }] } });
    expect(start[0]).toMatchObject({ type: "tool_call", payload: { toolUseId: "p1", name: "apply_patch" } });
    const done = m.map("item/completed", { item: { type: "fileChange", id: "p1", status: "completed", changes: [{ path: "/tmp/a.txt", kind: { type: "add" }, diff: "hello\n" }] } });
    expect(done[0]!.type).toBe("tool_result");
    expect((done[0] as { payload: { content: string } }).payload.content).toContain("add /tmp/a.txt");
  });

  it("force-closes open items when an interrupted turn completes", () => {
    const m = createCodexMapper();
    m.map("turn/started", { turn: { id: "t1" } });
    m.map("item/started", { item: { type: "commandExecution", id: "c9", command: "sleep 60", cwd: "/tmp" } });
    const out = m.map("turn/completed", { turn: { id: "t1", status: "interrupted", items: [] } });
    expect(types(out)).toEqual(["tool_result", "status"]);
    expect(out[0]).toMatchObject({ type: "tool_result", payload: { toolUseId: "c9", isError: true, content: "interrupted" } });
    expect(out[1]).toMatchObject({ type: "status", payload: { status: "idle" } });
  });

  it("labels a force-closed item with the turn status when the turn wasn't interrupted", () => {
    // Pins the non-interrupted branch of the force-close wording: it should never read as if the
    // turn itself succeeded/failed with that word as its result — it should say what actually happened
    // (the item never got its own item/completed).
    const m = createCodexMapper();
    m.map("turn/started", { turn: { id: "t1" } });
    m.map("item/started", { item: { type: "commandExecution", id: "c10", command: "sleep 60", cwd: "/tmp" } });
    const out = m.map("turn/completed", { turn: { id: "t1", status: "completed", items: [] } });
    expect(out[0]).toMatchObject({ type: "tool_result", payload: { toolUseId: "c10", isError: true, content: "turn ended without a result (completed)" } });
  });

  it("emits only status on a normal completion — no leftover tool_result once item/completed already closed the item", () => {
    // Regression guard for the openTools bookkeeping: if item/completed stopped deleting the id from
    // openTools, turn/completed would force-close it a second time and every tool call in every turn
    // would get a spurious extra error tool_result.
    const m = createCodexMapper();
    m.map("turn/started", { turn: { id: "t1" } });
    m.map("item/started", { item: { type: "commandExecution", id: "c11", command: "echo hi", cwd: "/tmp" } });
    m.map("item/completed", { item: { type: "commandExecution", id: "c11", status: "completed", aggregatedOutput: "hi\n", exitCode: 0 } });
    const out = m.map("turn/completed", { turn: { id: "t1", status: "completed", items: [] } });
    expect(types(out)).toEqual(["status"]);
  });

  it("reports a failed turn as an error before going idle", () => {
    const m = createCodexMapper();
    m.map("turn/started", { turn: { id: "t1" } });
    const out = m.map("turn/completed", { turn: { id: "t1", status: "failed", error: { message: "model exploded" }, items: [] } });
    expect(types(out)).toEqual(["error", "status"]);
    expect(out[0]).toMatchObject({ payload: { message: "model exploded" } });
  });

  it("uses tokenUsage.total, not last, and counts turns", () => {
    const m = createCodexMapper();
    m.map("turn/started", { turn: { id: "t1" } });
    const out = m.map("thread/tokenUsage/updated", {
      tokenUsage: { total: { totalTokens: 154, inputTokens: 120, outputTokens: 34 }, last: { inputTokens: 1, outputTokens: 1 }, modelContextWindow: 258400 },
    });
    expect(out[0]).toMatchObject({ type: "usage", payload: { costUsd: 0, inputTokens: 120, outputTokens: 34, numTurns: 1 } });
  });

  it("maps thread status changes", () => {
    const m = createCodexMapper();
    expect(m.map("thread/status/changed", { status: { type: "active", activeFlags: [] } })[0]).toMatchObject({ type: "status", payload: { status: "running" } });
    expect(m.map("thread/status/changed", { status: { type: "idle" } })[0]).toMatchObject({ type: "status", payload: { status: "idle" } });
  });

  it("maps the error notification", () => {
    const m = createCodexMapper();
    const out = m.map("error", { error: { message: "rate limited" }, willRetry: true });
    expect(out[0]).toMatchObject({ type: "error", payload: { message: "rate limited (retrying)" } });
  });

  it("maps mcpToolCall to tool_call then tool_result, using server.tool as the name", () => {
    const m = createCodexMapper();
    const start = m.map("item/started", { item: { type: "mcpToolCall", id: "mcp1", server: "figma", tool: "get_file", arguments: { fileId: "abc" } } });
    expect(start[0]).toMatchObject({ type: "tool_call", payload: { toolUseId: "mcp1", name: "figma.get_file", input: { fileId: "abc" }, parentToolUseId: null } });
    const done = m.map("item/completed", { item: { type: "mcpToolCall", id: "mcp1", status: "completed", result: "ok" } });
    expect(done[0]).toMatchObject({ type: "tool_result", payload: { toolUseId: "mcp1", content: "ok", isError: false } });
  });

  it("surfaces the mcpToolCall error field as the result content when the call fails", () => {
    const m = createCodexMapper();
    m.map("item/started", { item: { type: "mcpToolCall", id: "mcp2", server: "notion", tool: "search", arguments: {} } });
    const done = m.map("item/completed", { item: { type: "mcpToolCall", id: "mcp2", status: "failed", error: "401 unauthorized" } });
    expect(done[0]).toMatchObject({ type: "tool_result", payload: { toolUseId: "mcp2", content: "401 unauthorized", isError: true } });
  });

  it("appends the exit code to a nonzero-exit command's output", () => {
    const m = createCodexMapper();
    m.map("item/started", { item: { type: "commandExecution", id: "c3", command: "false", cwd: "/tmp" } });
    const done = m.map("item/completed", { item: { type: "commandExecution", id: "c3", status: "failed", aggregatedOutput: "boom", exitCode: 1 } });
    expect((done[0] as { payload: { content: string } }).payload.content).toBe("boom\n[exit 1]");
  });

  it("closeOpenTools force-closes items awaiting item/completed and clears them", () => {
    const m = createCodexMapper();
    m.map("item/started", { item: { type: "commandExecution", id: "c4", command: "sleep 5", cwd: "/tmp" } });
    m.map("item/started", { item: { type: "fileChange", id: "p2", status: "inProgress", changes: [] } });
    const closed = m.closeOpenTools("process exited");
    expect(closed).toHaveLength(2);
    expect(closed).toContainEqual({ type: "tool_result", ts: expect.any(Number), payload: { toolUseId: "c4", content: "process exited", isError: true } });
    expect(closed).toContainEqual({ type: "tool_result", ts: expect.any(Number), payload: { toolUseId: "p2", content: "process exited", isError: true } });
    // calling it again finds nothing left open
    expect(m.closeOpenTools("again")).toEqual([]);
  });

  it("returns no event for item/commandExecution/outputDelta (streamed stdout, coalesced by item/completed)", () => {
    const m = createCodexMapper();
    m.map("item/started", { item: { type: "commandExecution", id: "c12", command: "echo hi", cwd: "/tmp" } });
    expect(m.map("item/commandExecution/outputDelta", { itemId: "c12", delta: "hi\n" })).toEqual([]);
  });

  it("maps a systemError thread status to the error status", () => {
    const m = createCodexMapper();
    expect(m.map("thread/status/changed", { status: { type: "systemError" } })[0]).toMatchObject({ type: "status", payload: { status: "error" } });
  });

  it("drops advisory and firehose notifications", () => {
    const m = createCodexMapper();
    for (const method of ["warning", "configWarning", "deprecationNotice", "mcpServer/startupStatus/updated", "account/rateLimits/updated", "rawResponse/completed", "serverRequest/resolved", "thread/started"]) {
      expect(m.map(method, {})).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/adapters/src/codex/map-codex.test.ts`
Expected: FAIL — `Failed to resolve import "./map-codex"`.

- [ ] **Step 3: Write the implementation**

Create `packages/adapters/src/codex/map-codex.ts`:

```ts
import { sessionEvent, type SessionEvent } from "@realm/contracts";

type Bag = Record<string, unknown>;
const obj = (v: unknown): Bag => (v && typeof v === "object" ? (v as Bag) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

/** Item types Realm renders as a tool card, and the tool name it shows. */
function toolNameFor(item: Bag): string | null {
  switch (str(item.type)) {
    case "commandExecution": return "exec_command";
    case "fileChange": return "apply_patch";
    case "mcpToolCall": return `${str(item.server) || "mcp"}.${str(item.tool) || "tool"}`;
    case "dynamicToolCall": case "collabAgentToolCall": case "webSearch": return str(item.type);
    default: return null;
  }
}

function toolInputFor(item: Bag): Record<string, unknown> {
  switch (str(item.type)) {
    case "commandExecution": return { command: str(item.command), cwd: str(item.cwd) };
    case "fileChange": return { changes: item.changes ?? [] };
    case "mcpToolCall": return obj(item.arguments);
    default: { const { id: _id, type: _type, ...rest } = item; return rest; }
  }
}

function toolOutputFor(item: Bag): string {
  switch (str(item.type)) {
    case "commandExecution": {
      const out = str(item.aggregatedOutput);
      const code = item.exitCode;
      return typeof code === "number" && code !== 0 ? `${out}\n[exit ${code}]`.trim() : out;
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? (item.changes as Bag[]) : [];
      return changes.map((c) => `${str(obj(c.kind).type) || "change"} ${str(c.path)}\n${str(c.diff)}`.trimEnd()).join("\n\n");
    }
    case "mcpToolCall": {
      const err = str(item.error);
      if (err) return err;
      return typeof item.result === "string" ? item.result : JSON.stringify(item.result ?? null);
    }
    default: return JSON.stringify(item);
  }
}

/**
 * Pure, stateful mapper from `codex app-server` notifications to Realm SessionEvents.
 *
 * - Codex's `userMessage` item is dropped: SessionService already emits `user_message` on send.
 * - Reasoning is emitted once, on `item/completed`, because Realm's `thinking` event has no delta variant.
 * - Open tool items are force-closed on `turn/completed`; an interrupt never sends their `item/completed`.
 * - Advisory notifications return `[]` — the adapter logs them instead of putting them in the transcript.
 */
export function createCodexMapper() {
  /** itemIds of tool items still awaiting item/completed. */
  const openTools = new Set<string>();
  let numTurns = 0;

  return {
    map(method: string, rawParams: unknown): SessionEvent[] {
      const p = obj(rawParams);
      const out: SessionEvent[] = [];

      switch (method) {
        case "item/started": {
          const item = obj(p.item);
          const id = str(item.id);
          const name = toolNameFor(item);
          if (name) { openTools.add(id); out.push(sessionEvent("tool_call", { toolUseId: id, name, input: toolInputFor(item), parentToolUseId: null })); }
          return out; // userMessage / agentMessage / reasoning starts carry no Realm event
        }

        case "item/completed": {
          const item = obj(p.item);
          const id = str(item.id);
          const type = str(item.type);
          if (type === "agentMessage") { out.push(sessionEvent("assistant_text", { messageId: id, text: str(item.text) })); return out; }
          if (type === "reasoning") {
            const summary = Array.isArray(item.summary) ? (item.summary as unknown[]).map(str) : [];
            const content = Array.isArray(item.content) ? (item.content as unknown[]).map(str) : [];
            const text = [...summary, ...content].filter(Boolean).join("\n\n");
            if (text) out.push(sessionEvent("thinking", { messageId: id, text }));
            return out;
          }
          if (openTools.has(id)) {
            openTools.delete(id);
            out.push(sessionEvent("tool_result", { toolUseId: id, content: toolOutputFor(item), isError: str(item.status) !== "completed" }));
          }
          return out;
        }

        case "item/agentMessage/delta":
          return [sessionEvent("assistant_delta", { messageId: str(p.itemId), delta: str(p.delta) })];

        case "item/commandExecution/outputDelta":
          // Streamed stdout. Realm has no partial-tool-result event in v1; the full output arrives on item/completed.
          return [];

        case "turn/started":
          numTurns += 1;
          return [];

        case "turn/completed": {
          const turn = obj(p.turn);
          const status = str(turn.status);
          // An item still open here never got its own item/completed (an interrupt skips it entirely).
          for (const id of openTools) out.push(sessionEvent("tool_result", { toolUseId: id, content: status === "interrupted" ? "interrupted" : `turn ended without a result (${status})`, isError: true }));
          openTools.clear();
          if (status === "failed") out.push(sessionEvent("error", { message: str(obj(turn.error).message) || "turn failed" }));
          out.push(sessionEvent("status", { status: "idle" }));
          return out;
        }

        case "thread/status/changed": {
          const t = str(obj(p.status).type);
          if (t === "active") return [sessionEvent("status", { status: "running" })];
          if (t === "idle") return [sessionEvent("status", { status: "idle" })];
          if (t === "systemError") return [sessionEvent("status", { status: "error" })];
          return [];
        }

        case "thread/tokenUsage/updated": {
          const total = obj(obj(p.tokenUsage).total);
          return [sessionEvent("usage", { costUsd: 0, inputTokens: num(total.inputTokens), outputTokens: num(total.outputTokens), numTurns })];
        }

        case "error": {
          const message = str(obj(p.error).message) || "agent error";
          return [sessionEvent("error", { message: p.willRetry === true ? `${message} (retrying)` : message })];
        }

        default:
          return []; // advisory + firehose notifications; the adapter logs them
      }
    },

    /** Close anything still open — used when the process dies mid-turn. */
    closeOpenTools(reason: string): SessionEvent[] {
      const out = [...openTools].map((id) => sessionEvent("tool_result", { toolUseId: id, content: reason, isError: true }));
      openTools.clear();
      return out;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/adapters/src/codex/map-codex.test.ts`
Expected: PASS — 20 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/codex/map-codex.ts packages/adapters/src/codex/map-codex.test.ts
git commit -m "feat(adapters): pure mapper from codex app-server notifications to SessionEvents"
```

---

### Task 3: `probeCodex`

Mirrors `claude/probe.ts`. Two CLI calls, no `app-server` spawn — the probe runs every time the New Session sheet opens, so it must stay cheap.

**Known limitation to encode in the doc comment:** both `codex --version` and `codex login status` reported a healthy login on a machine whose refresh token had been revoked server-side; the failure only surfaced at `thread/start`. `loggedIn: true` therefore means "credentials exist", not "credentials work".

**Files:**
- Create: `packages/adapters/src/codex/probe.ts`
- Create: `packages/adapters/src/codex/probe.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/adapters/src/codex/probe.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { probeCodex } from "./probe";

describe("probeCodex", () => {
  it("reports unavailable with a reason when the binary is missing", async () => {
    const r = await probeCodex("/definitely/not/a/binary");
    expect(r.available).toBe(false);
    expect(r.version).toBeNull();
    expect(r.reason).toBeTruthy();
  });

  it("reports the version and a login verdict when the binary runs", async () => {
    // A stub that answers both `--version` and `login status`.
    const stub = process.execPath;
    const r = await probeCodex(stub, ["-e", "console.log('codex-cli 9.9.9')"]);
    expect(r.available).toBe(true);
    expect(r.version).toBe("codex-cli 9.9.9");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/adapters/src/codex/probe.test.ts`
Expected: FAIL — `Failed to resolve import "./probe"`.

- [ ] **Step 3: Write the implementation**

Create `packages/adapters/src/codex/probe.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Checks the local `codex` CLI is runnable and whether a login exists.
 *
 * `loggedIn: true` means "credentials are on disk", NOT "credentials work": both `codex login status` and the
 * protocol's `getAuthStatus` were verified to report a healthy ChatGPT login on a machine whose refresh token had
 * been revoked server-side. That failure only surfaces at `thread/start`, as `error.data.action === "relogin"`,
 * which CodexAdapter turns into an `error` event telling the user to re-run `codex login`.
 *
 * `versionArgs` exists so tests can point at a stub binary.
 */
export async function probeCodex(
  bin = process.env.REALM_CODEX_BIN ?? "codex",
  versionArgs: string[] = ["--version"],
): Promise<{ available: boolean; version: string | null; loggedIn: boolean | null; reason: string | null }> {
  let version: string;
  try {
    const { stdout } = await run(bin, versionArgs, { timeout: 5000 });
    version = stdout.trim();
  } catch (e) {
    return { available: false, version: null, loggedIn: null, reason: (e as Error).message };
  }
  try {
    await run(bin, ["login", "status"], { timeout: 5000 });
    return { available: true, version: version || null, loggedIn: true, reason: null };
  } catch {
    return { available: true, version: version || null, loggedIn: false, reason: "not logged in — run `codex login`" };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/adapters/src/codex/probe.test.ts`
Expected: PASS — 2 tests. (The second asserts only `available`/`version`; the stub has no `login status` subcommand, so `loggedIn` is `false`, which is correct behaviour for a binary that can't answer it.)

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/codex/probe.ts packages/adapters/src/codex/probe.test.ts
git commit -m "feat(adapters): codex CLI probe"
```

---

### Task 4: `CodexConnection` — one shared `app-server`, fanned out by `threadId`

A single `codex app-server` process multiplexes any number of threads, and every notification and approval request is tagged with `threadId` (verified live with two concurrent threads). Realm therefore runs **one** process for all Codex sessions rather than one per session.

Two subtleties this task must handle:

- **The attach race.** Notifications for a thread can arrive before `thread/start` returns and we know its id. The connection buffers frames for unknown thread ids (bounded) and flushes them on `attach`.
- **Unknown server requests must still be answered.** Codex can send approval kinds we don't implement (`item/permissions/requestApproval`, `item/tool/requestUserInput`). Dropping one stalls the turn permanently, so anything unrouted gets a `-32601` reply.

**Files:**
- Create: `packages/adapters/src/codex/connection.ts`
- Create: `packages/adapters/src/codex/fixtures/fake-codex-server.mjs`
- Create: `packages/adapters/src/codex/connection.test.ts`

- [ ] **Step 1: Write the fake server fixture**

Create `packages/adapters/src/codex/fixtures/fake-codex-server.mjs`. This speaks enough of the real protocol to drive the adapter tests, using the exact frame shapes captured in `docs/dev/codex-app-server-protocol.md`:

```js
// Minimal `codex app-server` stand-in for adapter tests. Newline-delimited JSON-RPC.
// Responses deliberately omit `jsonrpc`, and server->client requests start at id 0, exactly like the real server.
let buf = "";
let threadSeq = 0;
let turnSeq = 0;
let serverReqId = 0;
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const notify = (method, params) => send({ method, params, emittedAtMs: 1 });

process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") return send({ id, result: { userAgent: "fake/0.0.1", codexHome: "/tmp/codex-home" } });
  if (method === "initialized") return;
  if (method === "thread/start" || method === "thread/resume") {
    const threadId = method === "thread/resume" ? params.threadId : `th_${++threadSeq}`;
    if (params.model === "explode") return send({ id, error: { code: -32600, message: "failed to load configuration", data: { action: "relogin", statusCode: 401 } } });
    return send({ id, result: { thread: { id: threadId, status: { type: "idle" }, cwd: params.cwd, turns: [] }, model: params.model ?? "gpt-fake", cwd: params.cwd } });
  }
  if (method === "turn/start") {
    const threadId = params.threadId;
    const turnId = `tu_${++turnSeq}`;
    send({ id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    const text = params.input.map((b) => b.text ?? "").join("");
    queueMicrotask(() => runTurn(threadId, turnId, text));
    return;
  }
  if (method === "turn/interrupt") {
    send({ id, result: {} });
    notify("thread/status/changed", { threadId: params.threadId, status: { type: "idle" } });
    notify("turn/completed", { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted", items: [] } });
    return;
  }
  if (id !== undefined && id !== null) send({ id, error: { code: -32600, message: `unknown method ${method}` } });
}

function runTurn(threadId, turnId, text) {
  const base = { threadId, turnId };
  notify("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
  notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
  notify("item/started", { ...base, item: { type: "userMessage", id: "u1", content: [{ type: "text", text }] } });

  if (text.includes("APPROVE")) {
    const itemId = "call_1";
    notify("item/started", { ...base, item: { type: "commandExecution", id: itemId, command: "/bin/zsh -lc 'echo hi'", cwd: "/tmp", status: "inProgress" } });
    const reqId = serverReqId++;
    send({ method: "item/commandExecution/requestApproval", id: reqId, params: { ...base, itemId, command: "/bin/zsh -lc 'echo hi'", cwd: "/tmp", availableDecisions: ["accept", "cancel"] } });
    return; // the rest of the turn waits for our answer (see onApproval)
  }
  if (text.includes("HANG")) return; // never completes, for interrupt tests

  notify("item/started", { ...base, item: { type: "agentMessage", id: "msg_1", text: "" } });
  notify("item/agentMessage/delta", { ...base, itemId: "msg_1", delta: "hel" });
  notify("item/agentMessage/delta", { ...base, itemId: "msg_1", delta: "lo" });
  notify("item/completed", { ...base, item: { type: "agentMessage", id: "msg_1", text: "hello" } });
  notify("thread/tokenUsage/updated", { ...base, tokenUsage: { total: { totalTokens: 12, inputTokens: 10, outputTokens: 2 }, last: {}, modelContextWindow: 1000 } });
  notify("thread/status/changed", { threadId, status: { type: "idle" } });
  notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [] } });
}

// Answering an approval finishes the command and the turn.
const origHandle = handle;
process.on("exit", () => {});
let pendingApproval = null;
const _send = send;
// Intercept client responses to our server requests.
const originalDispatch = handle;
function onClientResponse(msg) {
  if (msg.result && msg.result.decision !== undefined) {
    notify("serverRequest/resolved", { threadId: pendingApproval?.threadId, requestId: msg.id });
    if (!pendingApproval) return;
    const { threadId, turnId } = pendingApproval;
    const base = { threadId, turnId };
    const accepted = msg.result.decision === "accept";
    notify("item/completed", { ...base, item: { type: "commandExecution", id: "call_1", status: accepted ? "completed" : "failed", aggregatedOutput: accepted ? "hi\n" : "", exitCode: accepted ? 0 : 1 } });
    notify("thread/status/changed", { threadId, status: { type: "idle" } });
    notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [] } });
    pendingApproval = null;
  }
}
```

Note: the trailing block above is illustrative of intent but duplicates state. **Write the fixture as a single coherent script** — declare `pendingApproval` at the top with the other `let` declarations, set it inside `runTurn` when it sends the approval request, and route client responses from `handle()` like this, replacing the final block:

```js
function handle(msg) {
  const { id, method, params, result } = msg;
  if (result !== undefined && method === undefined) return onClientResponse(msg);
  // …the method branches above…
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/adapters/src/codex/connection.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { CodexConnection } from "./connection";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex-server.mjs", import.meta.url));
const open = () => CodexConnection.open({ bin: process.execPath, args: [FAKE], cwd: process.cwd() });

describe("CodexConnection", () => {
  it("initializes and starts a thread", async () => {
    const c = await open();
    const r = await c.request<{ thread: { id: string } }>("thread/start", { cwd: "/tmp" });
    expect(r.thread.id).toMatch(/^th_/);
    await c.dispose();
  });

  it("routes notifications to the attached thread listener only", async () => {
    const c = await open();
    const a = await c.request<{ thread: { id: string } }>("thread/start", { cwd: "/tmp" });
    const b = await c.request<{ thread: { id: string } }>("thread/start", { cwd: "/tmp" });
    const seenA: string[] = []; const seenB: string[] = [];
    c.attach(a.thread.id, { onNotification: (m) => seenA.push(m), onServerRequest: () => {}, onGone: () => {} });
    c.attach(b.thread.id, { onNotification: (m) => seenB.push(m), onServerRequest: () => {}, onGone: () => {} });
    await c.request("turn/start", { threadId: a.thread.id, input: [{ type: "text", text: "hi", text_elements: [] }] });
    await vi.waitFor(() => expect(seenA).toContain("turn/completed"));
    expect(seenB).toEqual([]);
    await c.dispose();
  });

  it("buffers frames that arrive before attach and flushes them", async () => {
    const c = await open();
    const t = await c.request<{ thread: { id: string } }>("thread/start", { cwd: "/tmp" });
    await c.request("turn/start", { threadId: t.thread.id, input: [{ type: "text", text: "hi", text_elements: [] }] });
    await new Promise((r) => setTimeout(r, 50)); // let the whole turn stream out unattached
    const seen: string[] = [];
    c.attach(t.thread.id, { onNotification: (m) => seen.push(m), onServerRequest: () => {}, onGone: () => {} });
    await vi.waitFor(() => expect(seen).toContain("turn/completed"));
    await c.dispose();
  });

  it("answers unroutable server requests with -32601 so turns never stall", async () => {
    const c = await open();
    const replies: unknown[] = [];
    c.onUnroutedReply = (id, code) => replies.push({ id, code });
    // A decoy thread is attached, so the buffering path (which only applies before ANY thread attaches) is off
    // and an approval for a second, unattached thread must be rejected rather than queued.
    const decoy = await c.request<{ thread: { id: string } }>("thread/start", { cwd: "/tmp" });
    c.attach(decoy.thread.id, { onNotification: () => {}, onServerRequest: () => {}, onGone: () => {} });
    const orphan = await c.request<{ thread: { id: string } }>("thread/start", { cwd: "/tmp" });
    await c.request("turn/start", { threadId: orphan.thread.id, input: [{ type: "text", text: "APPROVE", text_elements: [] }] });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({ code: -32601 });
    await c.dispose();
  });

  it("tells every attached thread when the process dies", async () => {
    const c = await open();
    const t = await c.request<{ thread: { id: string } }>("thread/start", { cwd: "/tmp" });
    const gone: string[] = [];
    c.attach(t.thread.id, { onNotification: () => {}, onServerRequest: () => {}, onGone: (r) => gone.push(r) });
    await c.dispose();
    await vi.waitFor(() => expect(gone).toHaveLength(1));
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run packages/adapters/src/codex/connection.test.ts`
Expected: FAIL — `Failed to resolve import "./connection"`.

- [ ] **Step 4: Write the implementation**

Create `packages/adapters/src/codex/connection.ts`:

```ts
import { StdioJsonRpc, type JsonRpcId } from "../jsonrpc/stdio";

export type ThreadListener = {
  onNotification: (method: string, params: unknown) => void;
  /** MUST answer via connection.respond()/respondError(). */
  onServerRequest: (id: JsonRpcId, method: string, params: unknown) => void;
  onGone: (reason: string) => void;
};

type Buffered = { kind: "note"; method: string; params: unknown } | { kind: "req"; id: JsonRpcId; method: string; params: unknown };

const MAX_BUFFERED_PER_THREAD = 200;

const threadIdOf = (params: unknown): string | null => {
  const t = (params as { threadId?: unknown } | null)?.threadId;
  return typeof t === "string" ? t : null;
};

/**
 * One `codex app-server` process, shared by every Codex session and fanned out by `threadId`.
 *
 * Frames whose thread has no listener yet are buffered (bounded) and flushed on `attach`, because notifications can
 * beat the `thread/start` response that tells us the id. Server requests for unknown threads are answered -32601
 * rather than dropped: an unanswered request stalls that turn forever.
 */
export class CodexConnection {
  private threads = new Map<string, ThreadListener>();
  private buffer = new Map<string, Buffered[]>();
  private constructor(private rpc: StdioJsonRpc, private onLog?: (line: string) => void) {}

  /** Visible for tests: called when a server request cannot be routed to any thread. */
  onUnroutedReply?: (id: JsonRpcId, code: number) => void;

  static async open(opts: { bin: string; args?: string[]; cwd: string; env?: Record<string, string>; onLog?: (line: string) => void }): Promise<CodexConnection> {
    let self: CodexConnection;
    const rpc = new StdioJsonRpc({
      command: opts.bin,
      args: opts.args ?? ["app-server"],
      cwd: opts.cwd,
      env: opts.env,
      onNotification: (n) => self.routeNotification(n.method, n.params),
      onServerRequest: (r) => self.routeServerRequest(r.id, r.method, r.params),
      onStderr: (l) => opts.onLog?.(l),
      onExit: ({ reason }) => self.fanOutGone(reason),
    });
    self = new CodexConnection(rpc, opts.onLog);
    await rpc.request("initialize", {
      clientInfo: { name: "realm", title: "Realm", version: "0.0.1" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    rpc.notify("initialized");
    return self;
  }

  get threadCount(): number { return this.threads.size; }
  get alive(): boolean { return this.rpc.alive; }
  get stderrTail(): string[] { return this.rpc.stderrTail; }

  request<T = unknown>(method: string, params?: unknown): Promise<T> { return this.rpc.request<T>(method, params); }
  respond(id: JsonRpcId, result: unknown): void { this.rpc.respond(id, result); }
  respondError(id: JsonRpcId, code: number, message: string): void { this.rpc.respondError(id, code, message); }

  attach(threadId: string, listener: ThreadListener): void {
    this.threads.set(threadId, listener);
    const queued = this.buffer.get(threadId);
    this.buffer.delete(threadId);
    for (const f of queued ?? []) {
      if (f.kind === "note") listener.onNotification(f.method, f.params);
      else listener.onServerRequest(f.id, f.method, f.params);
    }
  }

  detach(threadId: string): void { this.threads.delete(threadId); this.buffer.delete(threadId); }

  async dispose(): Promise<void> { await this.rpc.dispose(); }

  private routeNotification(method: string, params: unknown): void {
    const threadId = threadIdOf(params);
    if (!threadId) { this.onLog?.(`[codex] ${method}`); return; } // global advisory: rate limits, config warnings
    const l = this.threads.get(threadId);
    if (l) { l.onNotification(method, params); return; }
    this.push(threadId, { kind: "note", method, params });
  }

  private routeServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    const threadId = threadIdOf(params);
    const l = threadId ? this.threads.get(threadId) : undefined;
    if (l) { l.onServerRequest(id, method, params); return; }
    if (threadId && this.buffer.has(threadId)) { this.push(threadId, { kind: "req", id, method, params }); return; }
    if (threadId && this.threads.size === 0) { this.push(threadId, { kind: "req", id, method, params }); return; }
    this.onLog?.(`[codex] unroutable server request ${method} (thread ${threadId ?? "none"})`);
    this.rpc.respondError(id, -32601, "no client for this thread");
    this.onUnroutedReply?.(id, -32601);
  }

  private push(threadId: string, f: Buffered): void {
    const q = this.buffer.get(threadId) ?? [];
    if (q.length >= MAX_BUFFERED_PER_THREAD) {
      if (f.kind === "req") { this.rpc.respondError(f.id, -32601, "buffer overflow"); this.onUnroutedReply?.(f.id, -32601); }
      return;
    }
    q.push(f);
    this.buffer.set(threadId, q);
  }

  private fanOutGone(reason: string): void {
    const listeners = [...this.threads.values()];
    this.threads.clear();
    this.buffer.clear();
    for (const l of listeners) l.onGone(reason);
  }
}
```

**Why the routing rule has two branches.** Before *any* thread attaches, an inbound frame is almost certainly the startup race (the `thread/start` response has not returned yet), so it is buffered. Once at least one thread is attached, a frame for an unknown thread is a genuine orphan and is rejected with `-32601` immediately. Never weaken this to "always buffer" — an approval that is never answered stalls that turn forever, which is the failure mode this task exists to prevent.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/adapters/src/codex/connection.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/codex/connection.ts packages/adapters/src/codex/connection.test.ts packages/adapters/src/codex/fixtures
git commit -m "feat(adapters): shared codex app-server connection with per-thread fan-out"
```

---

### Task 5: `CodexAdapter`

Implements `AgentAdapter`/`AgentHandle` on top of Tasks 1–4.

**Decision mapping is the subtle part.** The live approval capture offered `availableDecisions: ["accept", {acceptWithExecpolicyAmendment:…}, "cancel"]` — note there is **no `"decline"`**. Hard-coding the enum from the generated bindings would send a decision Codex rejects, so `pickCodexDecision` picks the first *offered* decision from a preference list and falls back sanely.

**Known limitation to document in code:** `setOptions` (model / permission mode) cannot be applied to a running Codex thread — `model` and `approvalPolicy` are `thread/start` parameters. The adapter records them and logs; they take effect the next time the thread starts. `SessionService` still persists the change to the session row.

**Files:**
- Create: `packages/adapters/src/codex/codex-adapter.ts`
- Create: `packages/adapters/src/codex/codex-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/adapters/src/codex/codex-adapter.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { CodexAdapter, pickCodexDecision } from "./codex-adapter";
import type { SessionEvent } from "@realm/contracts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex-server.mjs", import.meta.url));
const adapter = () => new CodexAdapter({ bin: process.execPath, args: [FAKE] });

async function collect(events: AsyncIterable<SessionEvent>, until: (e: SessionEvent) => boolean, sink: SessionEvent[] = []): Promise<SessionEvent[]> {
  for await (const e of events) { sink.push(e); if (until(e)) break; }
  return sink;
}

describe("pickCodexDecision", () => {
  it("maps deny to cancel when decline is not offered (the live shape)", () => {
    expect(pickCodexDecision("deny", ["accept", { acceptWithExecpolicyAmendment: {} }, "cancel"])).toBe("cancel");
  });
  it("prefers decline when the server offers it", () => {
    expect(pickCodexDecision("deny", ["accept", "decline", "cancel"])).toBe("decline");
  });
  it("maps allow_always to acceptForSession when offered, else accept", () => {
    expect(pickCodexDecision("allow_always", ["accept", "acceptForSession"])).toBe("acceptForSession");
    expect(pickCodexDecision("allow_always", ["accept"])).toBe("accept");
  });
  it("falls back sanely on an empty list", () => {
    expect(pickCodexDecision("allow", [])).toBe("accept");
    expect(pickCodexDecision("deny", [])).toBe("cancel");
  });
});

describe("CodexAdapter", () => {
  it("emits init then streams a turn to completion", async () => {
    const a = adapter();
    const h = a.start({ cwd: "/tmp", mcpServers: [], permissionMode: "default" });
    const seen: SessionEvent[] = [];
    const done = collect(h.events, (e) => e.type === "status" && e.payload.status === "idle" && seen.some((x) => x.type === "assistant_text"), seen);
    await h.send({ text: "hi", attachments: [] });
    await done;
    const init = seen.find((e) => e.type === "init");
    expect(init).toMatchObject({ payload: { providerSessionId: expect.stringMatching(/^th_/), cwd: "/tmp" } });
    expect(seen.filter((e) => e.type === "assistant_delta").map((e) => (e.payload as { delta: string }).delta)).toEqual(["hel", "lo"]);
    expect(seen.find((e) => e.type === "assistant_text")).toMatchObject({ payload: { text: "hello" } });
    expect(seen.find((e) => e.type === "usage")).toMatchObject({ payload: { inputTokens: 10, outputTokens: 2 } });
    expect(seen.some((e) => e.type === "user_message")).toBe(false); // SessionService owns that event
    await h.dispose();
  });

  it("raises a permission request and resumes the turn when allowed", async () => {
    const a = adapter();
    const h = a.start({ cwd: "/tmp", mcpServers: [], permissionMode: "default" });
    const seen: SessionEvent[] = [];
    const pump = collect(h.events, (e) => e.type === "tool_result", seen);
    await h.send({ text: "APPROVE please", attachments: [] });
    await vi.waitFor(() => expect(seen.some((e) => e.type === "permission_request")).toBe(true));
    expect(seen.find((e) => e.type === "status" && e.payload.status === "waiting_permission")).toBeTruthy();
    const req = seen.find((e) => e.type === "permission_request") as Extract<SessionEvent, { type: "permission_request" }>;
    expect(req.payload.toolName).toBe("exec_command");
    h.respondPermission(req.payload.requestId, "allow");
    await pump;
    expect(seen.find((e) => e.type === "permission_response")).toMatchObject({ payload: { decision: "allow" } });
    expect(seen.find((e) => e.type === "tool_result")).toMatchObject({ payload: { content: "hi\n", isError: false } });
    await h.dispose();
  });

  it("interrupts a hung turn and force-closes the open tool card", async () => {
    const a = adapter();
    const h = a.start({ cwd: "/tmp", mcpServers: [], permissionMode: "default" });
    const seen: SessionEvent[] = [];
    const pump = collect(h.events, (e) => e.type === "status" && e.payload.status === "idle" && seen.some((x) => x.type === "tool_call"), seen);
    await h.send({ text: "HANG", attachments: [] });
    await vi.waitFor(() => expect(seen.some((e) => e.type === "status" && e.payload.status === "running")).toBe(true));
    await h.interrupt();
    await pump;
    await h.dispose();
  });

  it("reports a revoked login as an actionable error", async () => {
    const a = adapter();
    const h = a.start({ cwd: "/tmp", mcpServers: [], permissionMode: "default", model: "explode" });
    const seen = await collect(h.events, (e) => e.type === "status" && e.payload.status === "ended");
    const err = seen.find((e) => e.type === "error") as Extract<SessionEvent, { type: "error" }>;
    expect(err.payload.message).toMatch(/codex login/);
    await h.dispose();
  });

  it("shares one process across sessions and shuts it down with the last one", async () => {
    const a = adapter();
    const h1 = a.start({ cwd: "/tmp", mcpServers: [], permissionMode: "default" });
    const h2 = a.start({ cwd: "/tmp", mcpServers: [], permissionMode: "default" });
    await h1.send({ text: "hi", attachments: [] });
    await h2.send({ text: "hi", attachments: [] });
    await vi.waitFor(() => expect(a.processCount).toBe(1));
    await h1.dispose();
    expect(a.processCount).toBe(1);
    await h2.dispose();
    await vi.waitFor(() => expect(a.processCount).toBe(0));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/adapters/src/codex/codex-adapter.test.ts`
Expected: FAIL — `Failed to resolve import "./codex-adapter"`.

- [ ] **Step 3: Write the implementation**

Create `packages/adapters/src/codex/codex-adapter.ts`:

```ts
import { sessionEvent, type SessionEvent } from "@realm/contracts";
import { AsyncQueue } from "../event-queue";
import { JsonRpcCallError, type JsonRpcId } from "../jsonrpc/stdio";
import { CodexConnection, type ThreadListener } from "./connection";
import { createCodexMapper } from "./map-codex";
import { probeCodex } from "./probe";
import type { AgentAdapter, AgentHandle, PermissionDecision, ProbeResult, StartOptions, UserMessage } from "../types";

type Bag = Record<string, unknown>;
const obj = (v: unknown): Bag => (v && typeof v === "object" ? (v as Bag) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Codex offers a per-request list of acceptable decisions and it does NOT always include `decline` — the live
 * capture offered `["accept", {acceptWithExecpolicyAmendment}, "cancel"]`. Pick the first offered decision from a
 * preference list rather than hard-coding the enum from the generated bindings.
 */
export function pickCodexDecision(decision: PermissionDecision, available: unknown[]): string {
  const names = available.filter((d): d is string => typeof d === "string");
  const prefs = decision === "deny" ? ["decline", "cancel"]
    : decision === "allow_always" ? ["acceptForSession", "accept"]
    : ["accept"];
  for (const p of prefs) if (names.includes(p)) return p;
  return prefs[prefs.length - 1]!;
}

/** Realm permission modes → Codex approval policy + sandbox mode. `thread/start` takes `sandbox` as a STRING. */
function policyFor(mode: string | undefined): { approvalPolicy: string; sandbox: string } {
  switch (mode) {
    case "plan": return { approvalPolicy: "untrusted", sandbox: "read-only" };
    case "bypassPermissions": return { approvalPolicy: "never", sandbox: "danger-full-access" };
    default: return { approvalPolicy: "on-request", sandbox: "workspace-write" };
  }
}

function describeStartError(e: unknown): string {
  if (e instanceof JsonRpcCallError) {
    const action = str(obj(e.data).action);
    if (action === "relogin") return "Codex is signed out (its refresh token was rejected). Run `codex login` and try again.";
    return `${e.message}${e.code ? ` (code ${e.code})` : ""}`;
  }
  return (e as Error)?.message ?? String(e);
}

export class CodexAdapter implements AgentAdapter {
  readonly kind = "codex" as const;
  private conn: CodexConnection | null = null;
  private opening: Promise<CodexConnection> | null = null;
  private refs = 0;

  constructor(private o: { bin?: string; args?: string[] } = {}) {}

  /** Visible for tests: 1 while the shared app-server is up, 0 once the last session releases it. */
  get processCount(): number { return this.conn ? 1 : 0; }

  async probe(): Promise<ProbeResult> {
    const p = await probeCodex(this.o.bin);
    return { kind: this.kind, ...p };
  }

  private async acquire(cwd: string, onLog?: (l: string) => void): Promise<CodexConnection> {
    this.refs += 1;
    try {
      if (this.conn?.alive) return this.conn;
      if (!this.opening) {
        this.opening = CodexConnection.open({ bin: this.o.bin ?? process.env.REALM_CODEX_BIN ?? "codex", args: this.o.args, cwd, onLog })
          .then((c) => { this.conn = c; this.opening = null; return c; }, (e) => { this.opening = null; throw e; });
      }
      return await this.opening;
    } catch (e) { this.refs -= 1; throw e; }
  }

  private async release(): Promise<void> {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs === 0 && this.conn) { const c = this.conn; this.conn = null; await c.dispose(); }
  }

  start(opts: StartOptions): AgentHandle {
    const events = new AsyncQueue<SessionEvent>();
    const mapper = createCodexMapper();
    const pending = new Map<string, { id: JsonRpcId; available: unknown[] }>();
    let conn: CodexConnection | null = null;
    let threadId: string | null = null;
    let turnId: string | null = null;
    let disposed = false;
    let failed = false;

    const fail = (message: string) => {
      if (failed || events.isClosed) return;
      failed = true;
      for (const e of mapper.closeOpenTools("session ended")) events.push(e);
      events.push(sessionEvent("error", { message }));
      events.push(sessionEvent("status", { status: "error" }));
      events.push(sessionEvent("status", { status: "ended" }));
      events.close();
    };

    const respondPermission = (requestId: string, decision: PermissionDecision) => {
      const p = pending.get(requestId);
      if (!p) return;
      pending.delete(requestId);
      conn?.respond(p.id, { decision: pickCodexDecision(decision, p.available) });
      events.push(sessionEvent("permission_response", { requestId, decision }));
      if (pending.size === 0) events.push(sessionEvent("status", { status: turnId ? "running" : "idle" }));
    };
    const denyAllPending = () => { for (const id of [...pending.keys()]) respondPermission(id, "deny"); };

    const listener: ThreadListener = {
      onNotification: (method, params) => {
        if (method === "turn/started") turnId = str(obj(obj(params).turn).id) || turnId;
        if (method === "turn/completed") turnId = null;
        for (const e of mapper.map(method, params)) events.push(e);
      },
      onServerRequest: (id, method, params) => {
        if (method !== "item/commandExecution/requestApproval" && method !== "item/fileChange/requestApproval") {
          opts.onLog?.(`[codex] unsupported server request ${method}`);
          conn?.respondError(id, -32601, `unsupported request ${method}`);
          return;
        }
        const p = obj(params);
        const requestId = String(id);
        const available = Array.isArray(p.availableDecisions) ? (p.availableDecisions as unknown[]) : [];
        const isPatch = method.includes("fileChange");
        if (pending.size === 0) events.push(sessionEvent("status", { status: "waiting_permission" }));
        pending.set(requestId, { id, available });
        events.push(sessionEvent("permission_request", {
          requestId,
          toolName: isPatch ? "apply_patch" : "exec_command",
          input: isPatch ? { itemId: str(p.itemId), grantRoot: p.grantRoot ?? null } : { command: str(p.command), cwd: str(p.cwd) },
          title: str(p.reason) || (isPatch ? "Apply file changes?" : `Run ${str(p.command) || "a command"}?`),
          suggestions: available,
        }));
      },
      onGone: (reason) => fail(reason),
    };

    const boot = (async () => {
      try {
        conn = await this.acquire(opts.cwd, opts.onLog);
        const { approvalPolicy, sandbox } = policyFor(opts.permissionMode);
        const common: Bag = {
          cwd: opts.cwd, approvalPolicy, sandbox,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.mcpServers.length
            ? { config: { mcp_servers: Object.fromEntries(opts.mcpServers.map((s) => [s.name, { command: s.command, args: s.args ?? [], env: s.env ?? {} }])) } }
            : {}),
        };
        const res = obj(opts.resume
          ? await conn.request("thread/resume", { threadId: opts.resume, ...common })
          : await conn.request("thread/start", { ...common, sessionStartSource: "startup" }));
        threadId = str(obj(res.thread).id);
        if (!threadId) throw new Error("codex did not return a thread id");
        conn.attach(threadId, listener);
        events.push(sessionEvent("init", { providerSessionId: threadId, model: str(res.model) || (opts.model ?? ""), tools: [], cwd: str(res.cwd) || opts.cwd }));
        events.push(sessionEvent("status", { status: "idle" }));
      } catch (e) {
        fail(describeStartError(e));
      }
    })();

    const buildInput = (m: UserMessage): Bag[] => {
      const images = m.attachments.filter((a) => a.mime.startsWith("image/")).map((a) => ({ type: "localImage", path: a.path }));
      const others = m.attachments.filter((a) => !a.mime.startsWith("image/")).map((a) => a.path);
      const text = others.length ? `${m.text}\n\nAttached files:\n${others.join("\n")}` : m.text;
      return [{ type: "text", text, text_elements: [] }, ...images];
    };

    return {
      events,
      send: async (m: UserMessage) => {
        if (disposed || events.isClosed) { events.push(sessionEvent("error", { message: "session ended" })); return; }
        await boot;
        if (failed || !conn || !threadId) return; // boot already reported it
        const input = buildInput(m);
        events.push(sessionEvent("status", { status: "running" }));
        const startTurn = async () => {
          const r = obj(await conn!.request("turn/start", { threadId, input }));
          turnId = str(obj(r.turn).id) || null;
        };
        try {
          if (turnId) await conn.request("turn/steer", { threadId, expectedTurnId: turnId, input });
          else await startTurn();
        } catch (e) {
          // `turn/steer` fails with "no active turn to steer" when the turn ended between our check and the call.
          if (turnId) {
            turnId = null;
            try { await startTurn(); return; } catch (e2) { e = e2; }
          }
          events.push(sessionEvent("error", { message: (e as Error).message ?? String(e) }));
          events.push(sessionEvent("status", { status: "idle" }));
        }
      },
      respondPermission,
      interrupt: async () => {
        denyAllPending();
        if (!conn || !threadId || !turnId) return;
        try { await conn.request("turn/interrupt", { threadId, turnId }); }
        catch (e) { opts.onLog?.(`[codex] interrupt failed: ${(e as Error).message}`); }
      },
      setOptions: async (o) => {
        // `model` and `approvalPolicy` are thread/start parameters; Codex has no mid-thread equivalent. The session
        // row is still updated by SessionService, so the change applies the next time this thread starts.
        opts.onLog?.(`[codex] setOptions ${JSON.stringify(o)} applies to the next thread start`);
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        denyAllPending();
        await boot.catch(() => {});
        if (conn && threadId) conn.detach(threadId);
        if (!events.isClosed) {
          for (const e of mapper.closeOpenTools("session closed")) events.push(e);
          events.push(sessionEvent("status", { status: "ended" }));
          events.close();
        }
        await this.release();
      },
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/adapters/src/codex/codex-adapter.test.ts`
Expected: PASS — 9 tests (4 for `pickCodexDecision`, 5 for the adapter).

- [ ] **Step 5: Export the new modules**

Modify `packages/adapters/src/index.ts`, adding after the existing Claude exports:

```ts
export { StdioJsonRpc, JsonRpcCallError, type JsonRpcId } from "./jsonrpc/stdio";
export { CodexAdapter, pickCodexDecision } from "./codex/codex-adapter";
export { createCodexMapper } from "./codex/map-codex";
export { probeCodex } from "./codex/probe";
```

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add packages/adapters/src/codex packages/adapters/src/index.ts
git commit -m "feat(adapters): Codex adapter on the app-server protocol"
```

---

### Task 6: Register Codex in the server adapter registry

**Files:**
- Modify: `apps/server/src/app.ts:19-23`
- Create: `apps/server/src/app.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/app.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { defaultAdapters } from "./app";

describe("defaultAdapters", () => {
  it("registers claude and codex by default", () => {
    const reg = defaultAdapters();
    expect(Object.keys(reg).sort()).toContain("codex");
    expect(reg.codex?.kind).toBe("codex");
  });
  it("only registers the fake agent behind the env flag", () => {
    delete process.env.REALM_ENABLE_FAKE_AGENT;
    expect(defaultAdapters().fake).toBeUndefined();
    process.env.REALM_ENABLE_FAKE_AGENT = "1";
    expect(defaultAdapters().fake).toBeDefined();
    delete process.env.REALM_ENABLE_FAKE_AGENT;
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/server/src/app.test.ts`
Expected: FAIL — `expect(received).toContain("codex")`.

- [ ] **Step 3: Write the implementation**

Modify `apps/server/src/app.ts`. Change the import line:

```ts
import { ClaudeAdapter, CodexAdapter, FakeAdapter, type AdapterRegistry } from "@realm/adapters";
```

and replace `defaultAdapters`:

```ts
/** Claude and Codex always; the scripted fake only when REALM_ENABLE_FAKE_AGENT=1 (offline dev). */
export function defaultAdapters(): AdapterRegistry {
  const reg: AdapterRegistry = { claude: new ClaudeAdapter(), codex: new CodexAdapter() };
  if (process.env.REALM_ENABLE_FAKE_AGENT === "1") reg.fake = new FakeAdapter({ script: [], delayMs: 15 });
  return reg;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/server/src/app.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/app.ts apps/server/src/app.test.ts
git commit -m "feat(server): register the Codex adapter"
```

---

## Part C — ACP adapter (Cursor + Gemini)

### Task 7: `createAcpMapper` — `session/update` → `SessionEvent[]`

ACP streams text as `agent_message_chunk` with no message id and no explicit end. Realm's contract has an ephemeral `assistant_delta` plus a persisted `assistant_text`, so the mapper groups a **contiguous run** of chunks under one generated `messageId`: each chunk emits a delta, and the run is flushed to a single `assistant_text` when any non-message update arrives or the turn ends. `agent_thought_chunk` works the same way and flushes to `thinking`. Agents interleave thought and message chunks freely, so both runs are tracked independently.

`tool_call_update` is a **sparse patch** — only `toolCallId` is guaranteed, and other fields are optional *and* nullable. Merging must never treat a missing field as a clear, or tool cards blank out mid-turn.

**Files:**
- Create: `packages/adapters/src/acp/map-acp.ts`
- Create: `packages/adapters/src/acp/map-acp.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/adapters/src/acp/map-acp.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createAcpMapper } from "./map-acp";
import type { SessionEvent } from "@realm/contracts";

const types = (evs: SessionEvent[]) => evs.map((e) => e.type);

describe("createAcpMapper", () => {
  it("groups a contiguous message run under one id and flushes it as assistant_text", () => {
    const m = createAcpMapper();
    const a = m.map({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
    const b = m.map({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
    expect(types(a)).toEqual(["assistant_delta"]);
    const idA = (a[0] as { payload: { messageId: string } }).payload.messageId;
    expect((b[0] as { payload: { messageId: string } }).payload.messageId).toBe(idA);
    const flushed = m.flush();
    expect(flushed[0]).toMatchObject({ type: "assistant_text", payload: { messageId: idA, text: "Hello" } });
    expect(m.flush()).toEqual([]); // idempotent
  });

  it("flushes the message run before an interleaved tool call", () => {
    const m = createAcpMapper();
    m.map({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading " } });
    const out = m.map({ sessionUpdate: "tool_call", toolCallId: "call_1", title: "Read NOTES.txt", kind: "read", status: "pending", rawInput: { path: "/tmp/NOTES.txt" } });
    expect(types(out)).toEqual(["assistant_text", "tool_call"]);
    expect(out[1]).toMatchObject({ payload: { toolUseId: "call_1", name: "Read NOTES.txt", input: { path: "/tmp/NOTES.txt" }, parentToolUseId: null } });
  });

  it("emits thinking from a thought run", () => {
    const m = createAcpMapper();
    m.map({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "I should " } });
    m.map({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "read it." } });
    expect(m.flush()[0]).toMatchObject({ type: "thinking", payload: { text: "I should read it." } });
  });

  it("treats tool_call_update as a sparse patch and only completes once", () => {
    const m = createAcpMapper();
    m.map({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Read", kind: "read", status: "pending" });
    expect(m.map({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" })).toEqual([]);
    const done = m.map({
      sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed",
      content: [{ type: "content", content: { type: "text", text: "hello from realm\n" } }],
    });
    expect(done[0]).toMatchObject({ type: "tool_result", payload: { toolUseId: "c1", content: "hello from realm\n", isError: false } });
    // A trailing patch must not emit a second result.
    expect(m.map({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" })).toEqual([]);
  });

  it("marks a failed tool call as an error result", () => {
    const m = createAcpMapper();
    m.map({ sessionUpdate: "tool_call", toolCallId: "c2", title: "Run", kind: "execute" });
    expect(m.map({ sessionUpdate: "tool_call_update", toolCallId: "c2", status: "failed" })[0])
      .toMatchObject({ type: "tool_result", payload: { isError: true } });
  });

  it("renders diff and terminal tool content", () => {
    const m = createAcpMapper();
    m.map({ sessionUpdate: "tool_call", toolCallId: "c3", title: "Edit", kind: "edit" });
    const out = m.map({
      sessionUpdate: "tool_call_update", toolCallId: "c3", status: "completed",
      content: [{ type: "diff", path: "/tmp/a.txt", oldText: "a\n", newText: "b\n" }, { type: "terminal", terminalId: "t1" }],
    });
    const content = (out[0] as { payload: { content: string } }).payload.content;
    expect(content).toContain("/tmp/a.txt");
    expect(content).toContain("[terminal t1]");
  });

  it("does not clear a title when a patch omits it", () => {
    const m = createAcpMapper();
    m.map({ sessionUpdate: "tool_call", toolCallId: "c4", title: "Original", kind: "read" });
    m.map({ sessionUpdate: "tool_call_update", toolCallId: "c4", status: "in_progress" });
    expect(m.titleOf("c4")).toBe("Original");
  });

  it("drops plan, command-list, mode and user-echo updates", () => {
    const m = createAcpMapper();
    for (const u of [
      { sessionUpdate: "plan", entries: [] },
      { sessionUpdate: "available_commands_update", availableCommands: [] },
      { sessionUpdate: "current_mode_update", currentModeId: "agent" },
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "echo" } },
    ]) expect(m.map(u)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/adapters/src/acp/map-acp.test.ts`
Expected: FAIL — `Failed to resolve import "./map-acp"`.

- [ ] **Step 3: Write the implementation**

Create `packages/adapters/src/acp/map-acp.ts`:

```ts
import { newId, sessionEvent, type SessionEvent } from "@realm/contracts";

type Bag = Record<string, unknown>;
const obj = (v: unknown): Bag => (v && typeof v === "object" ? (v as Bag) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Text out of an ACP ContentBlock; non-text blocks render as a short marker. */
function blockText(block: unknown): string {
  const b = obj(block);
  switch (str(b.type)) {
    case "text": return str(b.text);
    case "image": return "[image]";
    case "audio": return "[audio]";
    case "resource_link": return `[${str(b.name) || str(b.uri)}]`;
    case "resource": return `[resource ${str(obj(b.resource).uri)}]`;
    default: return "";
  }
}

/** ToolCallContent[] → a single string for Realm's `tool_result.content`. */
function renderToolContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((raw) => {
    const c = obj(raw);
    switch (str(c.type)) {
      case "content": return blockText(c.content);
      case "diff": {
        const old = c.oldText === null || c.oldText === undefined ? "" : str(c.oldText);
        return `--- ${str(c.path)}\n${old ? `- ${old.trimEnd()}\n` : ""}+ ${str(c.newText).trimEnd()}`;
      }
      case "terminal": return `[terminal ${str(c.terminalId)}]`;
      default: return "";
    }
  }).filter(Boolean).join("\n");
}

type Call = { title: string; kind: string; input: Record<string, unknown>; done: boolean };

/**
 * Pure, stateful mapper from ACP `session/update` payloads to Realm SessionEvents.
 *
 * ACP has no message ids and no end-of-message marker, so a contiguous run of `agent_message_chunk`s is grouped
 * under one generated id: every chunk emits an ephemeral `assistant_delta`, and the run is flushed to a single
 * persisted `assistant_text` when any other update arrives or the turn ends. Thought runs work identically.
 *
 * `tool_call_update` is a SPARSE PATCH — only `toolCallId` is guaranteed and other fields are optional AND
 * nullable, so a missing field must never clear stored state.
 */
export function createAcpMapper() {
  const calls = new Map<string, Call>();
  let msg: { id: string; text: string } | null = null;
  let thought: { id: string; text: string } | null = null;

  const flushRuns = (): SessionEvent[] => {
    const out: SessionEvent[] = [];
    if (msg) { if (msg.text) out.push(sessionEvent("assistant_text", { messageId: msg.id, text: msg.text })); msg = null; }
    if (thought) { if (thought.text) out.push(sessionEvent("thinking", { messageId: thought.id, text: thought.text })); thought = null; }
    return out;
  };

  return {
    map(rawUpdate: unknown): SessionEvent[] {
      const u = obj(rawUpdate);
      const kind = str(u.sessionUpdate);

      if (kind === "agent_message_chunk") {
        const text = blockText(u.content);
        const out: SessionEvent[] = [];
        if (thought) out.push(...flushRuns());
        if (!msg) msg = { id: newId(), text: "" };
        msg.text += text;
        out.push(sessionEvent("assistant_delta", { messageId: msg.id, delta: text }));
        return out;
      }

      if (kind === "agent_thought_chunk") {
        const text = blockText(u.content);
        const out: SessionEvent[] = [];
        if (msg) out.push(...flushRuns());
        if (!thought) thought = { id: newId(), text: "" };
        thought.text += text;
        return out;
      }

      const out = flushRuns();

      if (kind === "tool_call") {
        const id = str(u.toolCallId);
        const call: Call = { title: str(u.title) || id, kind: str(u.kind) || "other", input: obj(u.rawInput), done: false };
        calls.set(id, call);
        out.push(sessionEvent("tool_call", { toolUseId: id, name: call.title, input: call.input, parentToolUseId: null }));
        return out;
      }

      if (kind === "tool_call_update") {
        const id = str(u.toolCallId);
        const call = calls.get(id) ?? { title: id, kind: "other", input: {}, done: false };
        // Sparse patch: only overwrite fields that are actually present.
        if (typeof u.title === "string") call.title = u.title;
        if (typeof u.kind === "string") call.kind = u.kind;
        if (u.rawInput !== undefined && u.rawInput !== null) call.input = obj(u.rawInput);
        calls.set(id, call);
        const status = str(u.status);
        if ((status === "completed" || status === "failed") && !call.done) {
          call.done = true;
          const body = renderToolContent(u.content);
          const raw = u.rawOutput === undefined || u.rawOutput === null ? "" : JSON.stringify(u.rawOutput);
          out.push(sessionEvent("tool_result", { toolUseId: id, content: body || raw, isError: status === "failed" }));
        }
        return out;
      }

      // plan / available_commands_update / current_mode_update / user_message_chunk are parsed and dropped in v1.
      return out;
    },

    /** Flush any open text runs — call on prompt resolution, cancellation, and dispose. */
    flush(): SessionEvent[] { return flushRuns(); },

    /** Close any tool call still open, e.g. when the child dies mid-turn. */
    closeOpenCalls(reason: string): SessionEvent[] {
      const out: SessionEvent[] = [];
      for (const [id, call] of calls) {
        if (call.done) continue;
        call.done = true;
        out.push(sessionEvent("tool_result", { toolUseId: id, content: reason, isError: true }));
      }
      return out;
    },

    /** Visible for tests: the merged title currently held for a call. */
    titleOf(id: string): string | undefined { return calls.get(id)?.title; },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/adapters/src/acp/map-acp.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/acp/map-acp.ts packages/adapters/src/acp/map-acp.test.ts
git commit -m "feat(adapters): pure mapper from ACP session/update to SessionEvents"
```

---

### Task 8: `probeAcp`

Both ACP CLIs answer `--version` cheaply. Neither exposes a login check that can be trusted without opening a session, so `loggedIn` is reported as `null` ("unknown") rather than guessed — the same honest posture `probeClaude` takes for keychain credentials.

**Files:**
- Create: `packages/adapters/src/acp/probe.ts`
- Create: `packages/adapters/src/acp/probe.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/adapters/src/acp/probe.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { probeAcp } from "./probe";

describe("probeAcp", () => {
  it("reports unavailable with a reason when the binary is missing", async () => {
    const r = await probeAcp("/definitely/not/a/binary");
    expect(r).toMatchObject({ available: false, version: null, loggedIn: null });
    expect(r.reason).toBeTruthy();
  });

  it("reports available with a version and an unknown login state", async () => {
    const r = await probeAcp(process.execPath, ["-e", "console.log('2026.07.25-e42b078')"]);
    expect(r).toMatchObject({ available: true, version: "2026.07.25-e42b078", loggedIn: null });
    expect(r.reason).toBe("unknown until a session starts");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/adapters/src/acp/probe.test.ts`
Expected: FAIL — `Failed to resolve import "./probe"`.

- [ ] **Step 3: Write the implementation**

Create `packages/adapters/src/acp/probe.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Checks an ACP agent CLI is runnable.
 *
 * `loggedIn` is deliberately `null`: neither Cursor nor Gemini exposes a trustworthy offline login check.
 * `cursor-agent status` was observed printing "Login successful" and "unable to fetch user details" in the same
 * breath, and Gemini's credentials file can exist for a tier that no longer accepts sessions. Auth failures
 * surface at `session/new` and AcpAdapter turns them into an actionable error event.
 */
export async function probeAcp(
  bin: string,
  versionArgs: string[] = ["--version"],
): Promise<{ available: boolean; version: string | null; loggedIn: boolean | null; reason: string | null }> {
  try {
    const { stdout } = await run(bin, versionArgs, { timeout: 5000 });
    const version = stdout.trim().split("\n")[0]?.trim() || null;
    return { available: true, version, loggedIn: null, reason: "unknown until a session starts" };
  } catch (e) {
    return { available: false, version: null, loggedIn: null, reason: (e as Error).message };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/adapters/src/acp/probe.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/acp/probe.ts packages/adapters/src/acp/probe.test.ts
git commit -m "feat(adapters): ACP agent CLI probe"
```

---

### Task 9: `AcpAdapter` — one generic adapter, one child process per session

Unlike Codex, ACP sessions are per-connection, so this adapter spawns one child per session. The same class is instantiated once per registered kind with a different launch command.

Four rules this task must honour, each of which is a real failure mode:

1. **`send()` must not await the turn.** `session/prompt` is a single request that stays pending for the *entire* turn. `SessionService.send()` awaits `handle.send()`, and the RPC method awaits that — so awaiting the prompt would hang the WebSocket call for minutes. Fire the request and settle it in the background, exactly like Claude's streaming input.
2. **Never turn a deny into an allow.** `optionId`s are agent-defined strings; if no option matches the user's decision, answer `{outcome:{outcome:"cancelled"}}` rather than falling back to `options[0]`.
3. **Suppress the `session/load` replay.** The agent replays the whole prior conversation as `session/update` notifications *before* `session/load` returns. Realm has already persisted those events, so they must be dropped, not appended.
4. **Never call `authenticate` automatically.** Gemini's `oauth-personal` blocks the JSON-RPC call while it opens a browser and never returns. Surface the login hint and let the user run the CLI's own login.

**Files:**
- Create: `packages/adapters/src/acp/acp-adapter.ts`
- Create: `packages/adapters/src/acp/fixtures/fake-acp-agent.mjs`
- Create: `packages/adapters/src/acp/acp-adapter.test.ts`

- [ ] **Step 1: Write the fake agent fixture**

Create `packages/adapters/src/acp/fixtures/fake-acp-agent.mjs`:

```js
// Minimal ACP agent stand-in for adapter tests. Newline-delimited JSON-RPC 2.0.
// Server->client request ids start at 0 to mirror the real agents' independent id space.
let buf = "";
let sessionSeq = 0;
let serverReqId = 0;
let pendingPrompt = null;   // { id, sessionId }
let pendingPermission = null;

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const update = (sessionId, u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });

process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});

function handle(msg) {
  const { id, method, params, result } = msg;
  if (result !== undefined && method === undefined) return onClientResult(msg);

  if (method === "initialize") {
    return send({ jsonrpc: "2.0", id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: false } },
      authMethods: [{ id: "fake_login", name: "Fake Login", description: "run `fake login`" }],
    }});
  }
  if (method === "session/new") {
    if (process.env.FAKE_ACP_AUTHFAIL === "1") return send({ jsonrpc: "2.0", id, error: { code: -32000, message: "not authenticated" } });
    return send({ jsonrpc: "2.0", id, result: { sessionId: `sess_${++sessionSeq}` } });
  }
  if (method === "session/load") {
    // Replay burst BEFORE responding — Realm must drop these.
    update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old question" } });
    update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old answer" } });
    return send({ jsonrpc: "2.0", id, result: {} });
  }
  if (method === "session/prompt") {
    const sessionId = params.sessionId;
    const text = params.prompt.map((b) => b.text ?? "").join("");
    pendingPrompt = { id, sessionId };
    if (text.includes("PERMIT")) {
      update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_1", title: "Read NOTES.txt", kind: "read", status: "pending", rawInput: { path: "/tmp/NOTES.txt" } });
      pendingPermission = { sessionId };
      return send({ jsonrpc: "2.0", method: "session/request_permission", id: serverReqId++, params: {
        sessionId,
        toolCall: { toolCallId: "call_1", title: "Read NOTES.txt", kind: "read" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      }});
    }
    if (text.includes("HANG")) return; // resolves only on session/cancel
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
    return finishPrompt("end_turn");
  }
  if (method === "session/cancel") return finishPrompt("cancelled");
  if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown ${method}` } });
}

function onClientResult(msg) {
  if (!pendingPermission) return;
  const outcome = msg.result?.outcome ?? {};
  const { sessionId } = pendingPermission;
  pendingPermission = null;
  const allowed = outcome.outcome === "selected" && String(outcome.optionId).startsWith("allow");
  update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: allowed ? "completed" : "failed",
    content: allowed ? [{ type: "content", content: { type: "text", text: "file body\n" } }] : [] });
  finishPrompt(allowed ? "end_turn" : "end_turn");
}

function finishPrompt(stopReason) {
  if (!pendingPrompt) return;
  const { id } = pendingPrompt;
  pendingPrompt = null;
  send({ jsonrpc: "2.0", id, result: { stopReason } });
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/adapters/src/acp/acp-adapter.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { AcpAdapter, pickAcpOption } from "./acp-adapter";
import type { SessionEvent } from "@realm/contracts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const adapter = (env?: Record<string, string>) =>
  new AcpAdapter({ kind: "acp:cursor", bin: process.execPath, args: [FAKE], label: "Cursor", loginHint: "Run `cursor-agent login`.", env });

async function collect(events: AsyncIterable<SessionEvent>, until: (e: SessionEvent) => boolean, sink: SessionEvent[] = []) {
  for await (const e of events) { sink.push(e); if (until(e)) break; }
  return sink;
}

describe("pickAcpOption", () => {
  const options = [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow-always", name: "Always", kind: "allow_always" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ];
  it("maps each decision to the matching option id", () => {
    expect(pickAcpOption("allow", options)).toBe("allow-once");
    expect(pickAcpOption("allow_always", options)).toBe("allow-always");
    expect(pickAcpOption("deny", options)).toBe("reject-once");
  });
  it("returns null rather than guessing when nothing matches a deny", () => {
    expect(pickAcpOption("deny", [{ optionId: "yes", name: "Yes", kind: "allow_once" }])).toBeNull();
  });
});

describe("AcpAdapter", () => {
  it("initializes, opens a session and streams a turn", async () => {
    const h = adapter().start({ cwd: "/tmp", mcpServers: [], permissionMode: "default" });
    const seen: SessionEvent[] = [];
    const done = collect(h.events, (e) => e.type === "status" && e.payload.status === "idle" && seen.some((x) => x.type === "assistant_text"), seen);
    await h.send({ text: "hi", attachments: [] });
    await done;
    expect(seen.find((e) => e.type === "init")).toMatchObject({ payload: { providerSessionId: "sess_1", cwd: "/tmp" } });
    expect(seen.filter((e) => e.type === "assistant_delta").map((e) => (e.payload as { delta: string }).delta)).toEqual(["Hel", "lo"]);
    expect(seen.find((e) => e.type === "assistant_text")).toMatchObject({ payload: { text: "Hello" } });
    expect(seen.find((e) => e.type === "thinking")).toMatchObject({ payload: { text: "thinking" } });
    await h.dispose();
  });

  it("returns from send() without waiting for the whole turn", async () => {
    const h = adapter().start({ cwd: "/tmp", mcpServers: [], permissionMode: "default" });
    const t0 = Date.now();
    await h.send({ text: "HANG", attachments: [] });   // this turn never completes on its own
    expect(Date.now() - t0).toBeLessThan(2000);
    await h.interrupt();
    await h.dispose();
  });

  it("raises a permission request and completes the tool when allowed", async () => {
    const h = adapter().start({ cwd: "/tmp", mcpServers: [], permissionMode: "default" });
    const seen: SessionEvent[] = [];
    const pump = collect(h.events, (e) => e.type === "tool_result", seen);
    await h.send({ text: "PERMIT", attachments: [] });
    await vi.waitFor(() => expect(seen.some((e) => e.type === "permission_request")).toBe(true));
    const req = seen.find((e) => e.type === "permission_request") as Extract<SessionEvent, { type: "permission_request" }>;
    expect(req.payload.toolName).toBe("Read NOTES.txt");
    h.respondPermission(req.payload.requestId, "allow");
    await pump;
    expect(seen.find((e) => e.type === "tool_result")).toMatchObject({ payload: { content: "file body\n", isError: false } });
    await h.dispose();
  });

  it("drops the session/load replay instead of duplicating the transcript", async () => {
    const h = adapter().start({ cwd: "/tmp", mcpServers: [], permissionMode: "default", resume: "sess_old" });
    const seen: SessionEvent[] = [];
    const done = collect(h.events, (e) => e.type === "status" && e.payload.status === "idle", seen);
    await done;
    expect(seen.find((e) => e.type === "init")).toMatchObject({ payload: { providerSessionId: "sess_old" } });
    expect(seen.some((e) => e.type === "assistant_text" || e.type === "assistant_delta")).toBe(false);
    await h.dispose();
  });

  it("reports an auth failure with the agent's login hint", async () => {
    const h = adapter({ FAKE_ACP_AUTHFAIL: "1" }).start({ cwd: "/tmp", mcpServers: [], permissionMode: "default" });
    const seen = await collect(h.events, (e) => e.type === "status" && e.payload.status === "ended");
    const err = seen.find((e) => e.type === "error") as Extract<SessionEvent, { type: "error" }>;
    expect(err.payload.message).toContain("cursor-agent login");
    await h.dispose();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run packages/adapters/src/acp/acp-adapter.test.ts`
Expected: FAIL — `Failed to resolve import "./acp-adapter"`.

- [ ] **Step 4: Write the implementation**

Create `packages/adapters/src/acp/acp-adapter.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { sessionEvent, type AgentKind, type SessionEvent } from "@realm/contracts";
import { AsyncQueue } from "../event-queue";
import { JsonRpcCallError, StdioJsonRpc, type JsonRpcId } from "../jsonrpc/stdio";
import { createAcpMapper } from "./map-acp";
import { probeAcp } from "./probe";
import type { AgentAdapter, AgentHandle, McpStdioConfig, PermissionDecision, ProbeResult, StartOptions, UserMessage } from "../types";

type Bag = Record<string, unknown>;
const obj = (v: unknown): Bag => (v && typeof v === "object" ? (v as Bag) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export type AcpAgentSpec = {
  kind: AgentKind;
  bin: string;
  args: string[];
  label: string;
  /** Shown when the agent rejects a session — tells the user which CLI login to run. */
  loginHint: string;
  env?: Record<string, string>;
};

/**
 * ACP `optionId`s are agent-defined strings, so decisions are matched on `kind`.
 * Returns null when nothing matches: the caller must then answer `cancelled` rather than pick an arbitrary
 * option, because falling back to `options[0]` could silently turn a user's Deny into an Allow.
 */
export function pickAcpOption(decision: PermissionDecision, options: unknown[]): string | null {
  const want = decision === "deny" ? ["reject_once", "reject_always"]
    : decision === "allow_always" ? ["allow_always", "allow_once"]
    : ["allow_once", "allow_always"];
  for (const k of want) {
    const found = options.find((o) => str(obj(o).kind) === k);
    if (found) return str(obj(found).optionId);
  }
  return null;
}

/** ACP's Stdio MCP server takes `env` as an array of {name,value} pairs, not a record. */
const toAcpMcp = (s: McpStdioConfig) => ({
  name: s.name, command: s.command, args: s.args ?? [],
  env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })),
});

/** One ACP agent, one child process per session. Instantiated once per registered kind. */
export class AcpAdapter implements AgentAdapter {
  readonly kind: AgentKind;
  constructor(private spec: AcpAgentSpec) { this.kind = spec.kind; }

  async probe(): Promise<ProbeResult> {
    const p = await probeAcp(this.spec.bin);
    return { kind: this.kind, ...p };
  }

  start(opts: StartOptions): AgentHandle {
    const spec = this.spec;
    const events = new AsyncQueue<SessionEvent>();
    const mapper = createAcpMapper();
    const pending = new Map<string, { id: JsonRpcId; options: unknown[] }>();
    let rpc: StdioJsonRpc | null = null;
    let sessionId: string | null = null;
    let caps: Bag = {};
    let replaying = false;
    let turnActive = false;
    let disposed = false;
    let failed = false;

    const fail = (message: string) => {
      if (failed || events.isClosed) return;
      failed = true;
      for (const e of mapper.closeOpenCalls("session ended")) events.push(e);
      events.push(sessionEvent("error", { message }));
      events.push(sessionEvent("status", { status: "error" }));
      events.push(sessionEvent("status", { status: "ended" }));
      events.close();
    };

    const answerPermission = (requestId: string, outcome: Bag, decision: PermissionDecision | null) => {
      const p = pending.get(requestId);
      if (!p) return;
      pending.delete(requestId);
      rpc?.respond(p.id, { outcome });
      if (decision) events.push(sessionEvent("permission_response", { requestId, decision }));
      if (pending.size === 0 && !disposed) events.push(sessionEvent("status", { status: turnActive ? "running" : "idle" }));
    };
    const respondPermission = (requestId: string, decision: PermissionDecision) => {
      const p = pending.get(requestId);
      if (!p) return;
      const optionId = pickAcpOption(decision, p.options);
      if (optionId === null) {
        opts.onLog?.(`[acp] no option matched decision ${decision}; cancelling the request`);
        answerPermission(requestId, { outcome: "cancelled" }, decision);
        return;
      }
      answerPermission(requestId, { outcome: "selected", optionId }, decision);
    };
    const cancelAllPending = () => { for (const id of [...pending.keys()]) answerPermission(id, { outcome: "cancelled" }, "deny"); };

    const onServerRequest = (id: JsonRpcId, method: string, rawParams: unknown) => {
      const p = obj(rawParams);
      if (method === "session/request_permission") {
        const tc = obj(p.toolCall);
        const options = Array.isArray(p.options) ? (p.options as unknown[]) : [];
        const toolCallId = str(tc.toolCallId);
        const requestId = String(id);
        // `toolCall` is a sparse ToolCallUpdate: only toolCallId is guaranteed, so fall back to what we recorded.
        const title = str(tc.title) || mapper.titleOf(toolCallId) || toolCallId || "tool";
        if (pending.size === 0) events.push(sessionEvent("status", { status: "waiting_permission" }));
        pending.set(requestId, { id, options });
        events.push(sessionEvent("permission_request", { requestId, toolName: title, input: obj(tc.rawInput), title: `${title}?`, suggestions: options }));
        return;
      }
      if (method === "fs/read_text_file") {
        void (async () => {
          try {
            const all = await readFile(str(p.path), "utf8");
            const lines = all.split("\n");
            const from = typeof p.line === "number" ? Math.max(0, p.line - 1) : 0;
            const to = typeof p.limit === "number" ? from + p.limit : undefined;
            rpc?.respond(id, { content: from === 0 && to === undefined ? all : lines.slice(from, to).join("\n") });
          } catch (e) { rpc?.respondError(id, -32603, (e as Error).message); }
        })();
        return;
      }
      if (method === "fs/write_text_file") {
        void (async () => {
          try { await writeFile(str(p.path), str(p.content), "utf8"); rpc?.respond(id, {}); }
          catch (e) { rpc?.respondError(id, -32603, (e as Error).message); }
        })();
        return;
      }
      // Catch-all: agents probe for capabilities we did not declare (terminal/*). An unanswered request stalls the turn.
      opts.onLog?.(`[acp] unsupported client method ${method}`);
      rpc?.respondError(id, -32601, `method not supported: ${method}`);
    };

    const describeError = (e: unknown, authMethods: unknown[]): string => {
      if (e instanceof JsonRpcCallError) {
        const names = authMethods.map((a) => str(obj(a).name)).filter(Boolean).join(", ");
        if (e.code === -32000) return `${spec.label} needs authentication${names ? ` (${names})` : ""}. ${spec.loginHint}`;
        const detail = str(obj(e.data).message) || str(obj(e.data).details);
        return `${spec.label} could not start a session: ${e.message}${detail ? ` — ${detail}` : ""}. ${spec.loginHint}`;
      }
      return (e as Error)?.message ?? String(e);
    };

    let authMethods: unknown[] = [];
    const boot = (async () => {
      try {
        rpc = new StdioJsonRpc({
          command: spec.bin, args: spec.args, cwd: opts.cwd, env: { ...spec.env, ...opts.env },
          onNotification: (n) => {
            if (n.method !== "session/update") { opts.onLog?.(`[acp] ${n.method}`); return; }
            if (replaying) return; // session/load replays history Realm has already persisted
            for (const e of mapper.map(obj(obj(n.params).update))) events.push(e);
          },
          onServerRequest: (r) => onServerRequest(r.id, r.method, r.params),
          onStderr: (l) => opts.onLog?.(l),
          onExit: ({ reason }) => fail(reason),
        });

        const init = obj(await rpc.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        }));
        caps = obj(init.agentCapabilities);
        authMethods = Array.isArray(init.authMethods) ? (init.authMethods as unknown[]) : [];

        const mcpServers = opts.mcpServers.map(toAcpMcp);
        if (opts.resume && caps.loadSession === true) {
          replaying = true;
          try { await rpc.request("session/load", { sessionId: opts.resume, cwd: opts.cwd, mcpServers }); sessionId = opts.resume; }
          catch (e) { opts.onLog?.(`[acp] session/load failed, starting fresh: ${(e as Error).message}`); }
          finally { replaying = false; }
        }
        if (!sessionId) {
          const res = obj(await rpc.request("session/new", { cwd: opts.cwd, mcpServers }));
          sessionId = str(res.sessionId);
          if (!sessionId) throw new Error("agent did not return a sessionId");
        }
        events.push(sessionEvent("init", { providerSessionId: sessionId, model: opts.model ?? "", tools: [], cwd: opts.cwd }));
        events.push(sessionEvent("status", { status: "idle" }));
      } catch (e) {
        fail(describeError(e, authMethods));
      }
    })();

    const buildPrompt = async (m: UserMessage): Promise<Bag[]> => {
      const prompt: Bag[] = [{ type: "text", text: m.text }];
      const canImage = obj(caps.promptCapabilities).image === true;
      for (const a of m.attachments) {
        if (a.mime.startsWith("image/") && canImage) {
          prompt.push({ type: "image", data: (await readFile(a.path)).toString("base64"), mimeType: a.mime });
        } else {
          prompt.push({ type: "resource_link", uri: `file://${a.path}`, name: basename(a.path), mimeType: a.mime });
        }
      }
      return prompt;
    };

    return {
      events,
      send: async (m: UserMessage) => {
        if (disposed || events.isClosed) { events.push(sessionEvent("error", { message: "session ended" })); return; }
        await boot;
        if (failed || !rpc || !sessionId) return;
        let prompt: Bag[];
        try { prompt = await buildPrompt(m); }
        catch (e) { events.push(sessionEvent("error", { message: `attachment error: ${(e as Error).message}` })); return; }
        events.push(sessionEvent("status", { status: "running" }));
        turnActive = true;
        // `session/prompt` stays pending for the whole turn — never await it here, or the RPC call that triggered
        // this send would hang for the entire turn.
        void rpc.request("session/prompt", { sessionId, prompt }).then(
          (res) => {
            turnActive = false;
            for (const e of mapper.flush()) events.push(e);
            const stop = str(obj(res).stopReason);
            if (stop === "refusal") events.push(sessionEvent("error", { message: "the agent refused this request" }));
            if (stop === "max_tokens") events.push(sessionEvent("error", { message: "the agent hit its token limit" }));
            events.push(sessionEvent("status", { status: "idle" }));
          },
          (e: unknown) => {
            turnActive = false;
            for (const ev of mapper.flush()) events.push(ev);
            if (!disposed) {
              events.push(sessionEvent("error", { message: describeError(e, authMethods) }));
              events.push(sessionEvent("status", { status: "idle" }));
            }
          },
        );
      },
      respondPermission,
      interrupt: async () => {
        cancelAllPending();
        if (rpc && sessionId) rpc.notify("session/cancel", { sessionId });
        // Do NOT tear the connection down: the agent still flushes updates and must resolve the prompt with
        // stopReason "cancelled", which the handler above turns into an idle status.
      },
      setOptions: async (o) => {
        if (!rpc || !sessionId) return;
        if (o.permissionMode) {
          try { await rpc.request("session/set_mode", { sessionId, modeId: o.permissionMode }); }
          catch (e) { opts.onLog?.(`[acp] set_mode(${o.permissionMode}) rejected: ${(e as Error).message}`); }
        }
        if (o.model) {
          try { await rpc.request("session/set_model", { sessionId, modelId: o.model }); }
          catch (e) { opts.onLog?.(`[acp] set_model(${o.model}) rejected: ${(e as Error).message}`); }
        }
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        cancelAllPending();
        await boot.catch(() => {});
        if (!events.isClosed) {
          for (const e of mapper.flush()) events.push(e);
          for (const e of mapper.closeOpenCalls("session closed")) events.push(e);
          events.push(sessionEvent("status", { status: "ended" }));
          events.close();
        }
        await rpc?.dispose();
      },
    };
  }
}
```

**Note on `init.models`:** `session/new` and `session/load` may return a `models` block (Cursor returns ~35 entries). It is deliberately ignored in v1 — dynamic model lists are out of scope, so the `init` event carries `model: opts.model ?? ""` and the UI hides the model picker for these kinds.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/adapters/src/acp/acp-adapter.test.ts`
Expected: PASS — 7 tests (2 for `pickAcpOption`, 5 for the adapter).

- [ ] **Step 6: Export and commit**

Add to `packages/adapters/src/index.ts`:

```ts
export { AcpAdapter, pickAcpOption, type AcpAgentSpec } from "./acp/acp-adapter";
export { createAcpMapper } from "./acp/map-acp";
export { probeAcp } from "./acp/probe";
```

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add packages/adapters/src/acp packages/adapters/src/index.ts
git commit -m "feat(adapters): generic ACP adapter for Cursor and Gemini"
```

---

### Task 10: Register Cursor and Gemini in the server adapter registry

**Files:**
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/app.test.ts`:

```ts
it("registers both ACP agents with their own launch commands", () => {
  const reg = defaultAdapters();
  expect(reg["acp:cursor"]?.kind).toBe("acp:cursor");
  expect(reg["acp:gemini"]?.kind).toBe("acp:gemini");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/server/src/app.test.ts`
Expected: FAIL — `expected undefined to be "acp:cursor"`.

- [ ] **Step 3: Write the implementation**

Modify `apps/server/src/app.ts`. Update the import:

```ts
import { AcpAdapter, ClaudeAdapter, CodexAdapter, FakeAdapter, type AdapterRegistry } from "@realm/adapters";
```

and replace `defaultAdapters`:

```ts
/**
 * Claude, Codex and both ACP agents are always registered; availability is reported by `agents.probe` so the
 * New Session sheet can disable the ones that are not installed or not signed in. The scripted fake is only
 * registered when REALM_ENABLE_FAKE_AGENT=1 (offline dev).
 */
export function defaultAdapters(): AdapterRegistry {
  const reg: AdapterRegistry = {
    claude: new ClaudeAdapter(),
    codex: new CodexAdapter(),
    "acp:cursor": new AcpAdapter({
      kind: "acp:cursor",
      bin: process.env.REALM_CURSOR_BIN ?? "cursor-agent",
      args: ["acp"],
      label: "Cursor",
      loginHint: "Run `cursor-agent login`.",
    }),
    "acp:gemini": new AcpAdapter({
      kind: "acp:gemini",
      bin: process.env.REALM_GEMINI_BIN ?? "gemini",
      args: ["--acp"],
      label: "Gemini",
      loginHint: "Gemini's free personal tier was discontinued — configure a Gemini API key or Vertex AI credentials.",
    }),
  };
  if (process.env.REALM_ENABLE_FAKE_AGENT === "1") reg.fake = new FakeAdapter({ script: [], delayMs: 15 });
  return reg;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/server/src/app.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/app.ts apps/server/src/app.test.ts
git commit -m "feat(server): register Cursor and Gemini ACP adapters"
```

---

## Part D — UI affordance and verification

### Task 11: Per-agent login hints in the New Session sheet

`NewSessionSheet.tsx:47` currently hard-codes a Claude-only hint. With four agents — one of which (Gemini) is permanently unusable on its old auth method — that line needs to be per-agent and driven by data.

**Files:**
- Modify: `packages/contracts/src/presets.ts`
- Modify: `packages/contracts/src/presets.test.ts` (it already exists — append the new describe block)
- Modify: `apps/desktop/src/renderer/src/panes/session/NewSessionSheet.tsx`

- [ ] **Step 1: Write the failing test**

Add to `packages/contracts/src/presets.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { AGENT_LOGIN_HINTS, AGENT_META } from "./presets";

describe("AGENT_LOGIN_HINTS", () => {
  it("has a hint for every agent kind that has display metadata", () => {
    for (const kind of Object.keys(AGENT_META)) {
      expect(typeof AGENT_LOGIN_HINTS[kind as keyof typeof AGENT_LOGIN_HINTS]).toBe("string");
    }
  });
  it("names the exact command for each CLI", () => {
    expect(AGENT_LOGIN_HINTS.claude).toContain("claude auth login");
    expect(AGENT_LOGIN_HINTS.codex).toContain("codex login");
    expect(AGENT_LOGIN_HINTS["acp:cursor"]).toContain("cursor-agent login");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/contracts/src/presets.test.ts`
Expected: FAIL — `AGENT_LOGIN_HINTS` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `packages/contracts/src/presets.ts`:

```ts
/** Shown under the agent picker so a signed-out agent tells the user exactly which command to run. */
export const AGENT_LOGIN_HINTS = {
  claude: "Uses your `claude` login — run `claude auth login` if sessions fail to authenticate.",
  codex: "Uses your `codex` login — run `codex login` if sessions fail to authenticate.",
  "acp:cursor": "Uses your Cursor login — run `cursor-agent login` if sessions fail to authenticate.",
  "acp:gemini": "Google discontinued the free personal tier for the Gemini CLI; sessions need a Gemini API key or Vertex AI credentials.",
  fake: "Scripted offline agent used for development.",
} as const satisfies Record<import("./entities").AgentKind, string>;
```

Modify `apps/desktop/src/renderer/src/panes/session/NewSessionSheet.tsx`. Change the import on line 1:

```tsx
import { AGENT_LOGIN_HINTS, AGENT_META, AGENT_MODELS, PERMISSION_MODES, type AgentKind } from "@realm/contracts";
```

and replace the Claude-only hint (line 47) with a hint for the *selected* agent, rendered below the list. Delete this line:

```tsx
{probe.some((p) => p.kind === "claude") && <div className="agent-hint-text muted">Claude uses your <code>claude</code> login — run <code>claude auth login</code> if sessions fail to authenticate.</div>}
```

and insert this immediately after the closing `</div>` of `.agent-list`, still inside the `.field`:

```tsx
{agent && <div className="agent-hint-text muted">{AGENT_LOGIN_HINTS[agent]}</div>}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/contracts/src/presets.test.ts`
Expected: PASS — 2 tests.

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/presets.ts packages/contracts/src/presets.test.ts apps/desktop/src/renderer/src/panes/session/NewSessionSheet.tsx
git commit -m "feat(desktop): per-agent login hint in the New Session sheet"
```

---

### Task 12: Full suite, then live verification in the running app

Unit tests use fake servers. This task proves the adapters work against the **real** CLIs.

**Files:** none (verification only).

- [ ] **Step 1: Run the whole suite and typecheck**

```bash
pnpm test && pnpm typecheck
```
Expected: all projects pass, no type errors.

- [ ] **Step 2: Confirm the real CLIs still work outside Realm**

```bash
node docs/dev/examples/codex-smoke.mjs --cwd /tmp --prompt "Reply with exactly: CODEX OK" --sandbox read-only
```
Expected: `CODEX OK`, a `usage:` line, then `turn completed`.

```bash
ACP_CWD=/tmp node docs/dev/examples/acp-smoke.mjs cursor-agent acp -- "Reply with exactly: ACP OK"
```
Expected: ends with `[smoke] PASS`.

If either fails with an auth error, stop and report it — that is an environment problem, not a code problem. `gemini --acp` is **expected** to fail at `session/new` with the `-32000` Antigravity notice; do not treat that as a task failure.

- [ ] **Step 3: Verify each agent end-to-end in the app**

```bash
pnpm dev
```

For **Codex** and then **Cursor**, in the running app:
1. Open the New Session sheet. Confirm all four agents are listed, that Codex and Cursor show a version, that Gemini shows its API-key hint, and that the selected agent's login hint appears.
2. Create a session and send `Run \`echo hello-from-realm\` and then reply DONE`.
3. Confirm in the transcript: streaming assistant text, a tool card for the command, a **permission card** with working Allow / Deny, the command output on the card after approving, and the status settling to idle.
4. Send a second message and press **Stop** mid-turn. Confirm the tool card closes (no stuck spinner) and the status returns to idle.
5. Quit the app, run `pnpm dev` again, reopen the session, and send another message. Confirm the transcript rehydrates **without duplicated history** and the agent still has context from step 2 — this is the resume path (`thread/resume` / `session/load`).

- [ ] **Step 4: Confirm the shared Codex process behaves**

Open **two** Codex sessions and send a message in each. Then:

```bash
ps ax | grep -c "[c]odex app-server"
```
Expected: `1` — one process serving both threads. Close both sessions and re-run; expected: `0`.

- [ ] **Step 5: Commit any fixes and finish the branch**

Commit anything the verification turned up, then use `superpowers:finishing-a-development-branch` to merge.

---

## Self-review notes

**Coverage against the goal.** Every agent kind already declared in `AgentKind` now has a registered adapter (Task 6, Task 10). Permissions (Tasks 5, 9), interrupt (Tasks 5, 9), and resume (Task 5 `thread/resume`, Task 9 `session/load`) are implemented and tested for both new protocols. No change to `SessionService`, `rpc.ts`, `session-events.ts`, or the transcript components was required — the whole point of the `AgentAdapter` seam.

**Contract fit — checked against the real types.** `AgentHandle.send` returns `Promise<void>` and both adapters resolve it on *acceptance*, not on turn completion (`SessionService.send` awaits it inside an RPC call). `respondPermission` is synchronous in the interface and is synchronous in both adapters. `ProbeResult` is returned as `{ kind, ...probe }`, matching `ClaudeAdapter.probe`. `permission_request.suggestions` is typed `z.array(z.unknown())`, so passing Codex's `availableDecisions` and ACP's `options` through is type-legal. `usage.costUsd` is required and non-nullable, so Codex passes `0` and ACP emits no `usage` at all (ACP 0.4.5 has no token-usage message).

**Known limitations, deliberately shipped:**
- Codex `setOptions` cannot change model or approval policy on a live thread; it logs and applies on the next thread start (Task 5).
- `item/commandExecution/outputDelta` is dropped; command output appears when the item completes. Realm has no partial-tool-result event in v1.
- ACP `plan`, `available_commands_update`, and `current_mode_update` are parsed and dropped.
- ACP sessions emit no `usage`, so the Codex/Claude token display will be blank for them.
- Gemini is registered but cannot open a session on this machine until an API key or Vertex credentials are configured.
