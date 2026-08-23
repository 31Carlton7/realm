#!/usr/bin/env node
/**
 * Fake `codex app-server` — speaks the subset of the real protocol that CodexConnection and the Codex
 * adapter exercise. Frame shapes are copied from docs/dev/codex-app-server-protocol.md:
 *
 *   - newline-delimited JSON, one object per line, no Content-Length headers
 *   - responses OMIT `jsonrpc` (the real server does), so nothing may validate on it
 *   - server -> client request ids start at 0 and therefore collide with client request ids on purpose
 *   - every thread-scoped notification carries `threadId`; turn-scoped ones add `turnId`
 *
 * Turn behaviour is selected by the text of `turn/start`'s input: "APPROVE" runs a command that needs an
 * approval decision, "HANG" streams nothing at all, anything else streams a short agent message.
 *
 * `$test/exit` is a test-only notification that kills the process, letting tests tell an unexpected death
 * apart from an intentional dispose.
 */

let nextThreadN = 0;
let nextTurnN = 0;
let nextItemN = 0;
let nextServerRequestId = 0; // the real server numbers its own requests from 0
const threads = new Map(); // threadId -> { cwd }
const pendingApprovals = new Map(); // server request id -> (decision) => void
let stdinBuf = "";

const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const ok = (id, result) => send({ id, result });
const fail = (id, code, message, data) => send({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
const notify = (method, params) => send({ method, params, emittedAtMs: Date.now() });
const ask = (method, params) => {
  const id = nextServerRequestId++;
  send({ method, id, params });
  return id;
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
const inputText = (input) => (Array.isArray(input) ? input : []).map((p) => (p && typeof p.text === "string" ? p.text : "")).join(" ");

async function streamApprovalTurn(threadId, turnId) {
  const itemId = `call_${nextItemN++}`;
  const cwd = threads.get(threadId)?.cwd ?? process.cwd();
  const command = "/bin/zsh -lc 'echo hi'";
  await tick();
  notify("item/started", {
    threadId, turnId, startedAtMs: Date.now(),
    item: { type: "commandExecution", id: itemId, command, cwd, status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null },
  });
  const requestId = ask("item/commandExecution/requestApproval", {
    threadId, turnId, itemId, startedAtMs: Date.now(), environmentId: "local",
    reason: "fake approval", command, cwd, commandActions: [],
    availableDecisions: ["accept", "cancel"],
  });
  const decision = await new Promise((resolve) => pendingApprovals.set(requestId, resolve));
  const accepted = decision === "accept";
  notify("serverRequest/resolved", { threadId, requestId });
  notify("item/completed", {
    threadId, turnId, completedAtMs: Date.now(),
    item: {
      type: "commandExecution", id: itemId, command, cwd, commandActions: [],
      status: accepted ? "completed" : "failed",
      aggregatedOutput: accepted ? "hi\n" : "",
      exitCode: accepted ? 0 : 1,
    },
  });
  notify("thread/status/changed", { threadId, status: { type: "idle" } });
  notify("turn/completed", { threadId, turn: { id: turnId, itemsView: "summary", items: [], status: "completed", error: null } });
}

async function streamMessageTurn(threadId, turnId) {
  const itemId = `msg_${nextItemN++}`;
  const userItemId = `usr_${nextItemN++}`;
  await tick();
  notify("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
  notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress", items: [] } });
  notify("item/started", {
    threadId, turnId, startedAtMs: Date.now(),
    item: { type: "userMessage", id: userItemId, clientId: null, content: [{ type: "text", text: "hi", text_elements: [] }] },
  });
  notify("item/started", { threadId, turnId, startedAtMs: Date.now(), item: { type: "agentMessage", id: itemId, text: "", phase: null, memoryCitation: null } });
  notify("item/agentMessage/delta", { threadId, turnId, itemId, delta: "hel" });
  notify("item/agentMessage/delta", { threadId, turnId, itemId, delta: "lo" });
  notify("item/completed", { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: itemId, text: "hello", phase: null, memoryCitation: null } });
  notify("thread/tokenUsage/updated", {
    threadId, turnId,
    tokenUsage: {
      total: { totalTokens: 12, inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
      last: { totalTokens: 12, inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
      modelContextWindow: 258400,
    },
  });
  notify("thread/status/changed", { threadId, status: { type: "idle" } });
  notify("turn/completed", { threadId, turn: { id: turnId, itemsView: "summary", items: [{ type: "agentMessage", id: itemId, text: "hello" }], status: "completed", error: null } });
}

async function streamInterrupt(threadId, turnId) {
  await tick();
  notify("thread/status/changed", { threadId, status: { type: "idle" } });
  notify("turn/completed", { threadId, turn: { id: turnId, itemsView: "summary", items: [], status: "interrupted", error: null } });
}

function startThread(id, params, threadId) {
  threads.set(threadId, { cwd: params.cwd });
  ok(id, {
    thread: { id: threadId, status: { type: "idle" }, cwd: params.cwd, turns: [] },
    model: params.model ?? "gpt-5.2",
    cwd: params.cwd,
  });
}

function handleRequest(id, method, params) {
  switch (method) {
    case "initialize":
      ok(id, { userAgent: "fake-codex/0.146.0", codexHome: "/tmp/fake-codex-home" });
      return;
    case "thread/start":
      if (params.model === "explode") {
        fail(id, -32600, "failed to load configuration", { action: "relogin", statusCode: 401 });
        return;
      }
      startThread(id, params, `th_${nextThreadN++}`);
      return;
    case "thread/resume":
      startThread(id, params, params.threadId);
      return;
    case "turn/start": {
      const turnId = `tu_${nextTurnN++}`;
      ok(id, { turn: { id: turnId, status: "inProgress", items: [] } });
      const text = inputText(params.input);
      if (text.includes("HANG")) return; // never completes: drives interrupt tests
      void (text.includes("APPROVE") ? streamApprovalTurn(params.threadId, turnId) : streamMessageTurn(params.threadId, turnId));
      return;
    }
    case "turn/interrupt":
      ok(id, {});
      void streamInterrupt(params.threadId, params.turnId);
      return;
    default:
      fail(id, -32600, `unknown method: ${method}`);
  }
}

function handleFrame(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // A client RESPONSE to one of our server requests: no method, an id, and result/error. Must be checked
  // before the request dispatcher, since the two id spaces overlap.
  if (msg.method === undefined && msg.id !== undefined && ("result" in msg || "error" in msg)) {
    const resolve = pendingApprovals.get(msg.id);
    if (!resolve) return;
    pendingApprovals.delete(msg.id);
    resolve(msg.result?.decision ?? null); // an error response counts as "not accepted"
    return;
  }

  if (typeof msg.method !== "string") return;
  if (msg.method === "$test/exit") process.exit(9);
  if (msg.id === undefined || msg.id === null) return; // notification (e.g. `initialized`): ignore
  handleRequest(msg.id, msg.method, msg.params ?? {});
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk;
  let i;
  while ((i = stdinBuf.indexOf("\n")) >= 0) {
    const line = stdinBuf.slice(0, i);
    stdinBuf = stdinBuf.slice(i + 1);
    if (line.trim()) handleFrame(line);
  }
});
process.stdin.on("end", () => process.exit(0)); // the real server exits when its stdin closes
