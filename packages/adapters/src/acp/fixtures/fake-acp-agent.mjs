#!/usr/bin/env node
/**
 * Fake ACP agent — speaks the subset of ACP 0.4.5 that AcpAdapter exercises. Frame shapes are copied from
 * docs/dev/acp-protocol.md:
 *
 *   - newline-delimited JSON-RPC 2.0, one object per line, no Content-Length headers
 *   - agent -> client request ids start at 0 and therefore collide with client request ids on purpose (§1)
 *   - `session/load` replays the prior conversation as `session/update` notifications BEFORE it responds (§2.3)
 *   - `session/prompt` is one request that stays pending for the whole turn (§3)
 *   - `session/cancel` is a NOTIFICATION; the pending prompt still resolves, with `stopReason:"cancelled"` (§6)
 *
 * What a turn does is selected by the text of the prompt's text blocks:
 *
 *   HANG              never resolves on its own                     (send()-must-not-await, interrupt)
 *   LATEPERMIT        asks for permission 30ms in, then exits    (permission racing the teardown)
 *   OPENTEXT          streams one message chunk and never ends the turn (open text run at dispose)
 *   OPENTOOL          opens a tool call and then never ends the turn (tool cards still open at dispose)
 *   PERMIT            one tool call gated on session/request_permission
 *   PERMIT2           two tool calls whose permissions are open at once (waiting_permission bookkeeping)
 *   READFILE p [l][n] calls fs/read_text_file back on us and echoes the content
 *   WRITEFILE p text  calls fs/write_text_file back on us and echoes the outcome
 *   ODDBALL           asks terminal/create, a method we never declared  (-32601 catch-all)
 *   ECHO              echoes the raw `prompt` array back as the agent message (prompt-shape assertions)
 *   REVEAL            echoes the journal of everything the client has asked of us
 *   STOP:<reason>     resolves with that stopReason (refusal, max_tokens, …)
 *   FAIL              rejects session/prompt outright
 *   DIE               opens a tool call and then dies without warning
 *   anything else      a thought chunk, then "Hel" + "lo", then stopReason:"end_turn"
 *
 * Env hooks: FAKE_ACP_AUTHFAIL=1 makes session/new fail -32000 (Gemini's shape), FAKE_ACP_STARTFAIL=1 makes it
 * fail -32603 with data (Cursor's shape), FAKE_ACP_LOADFAIL=1 makes session/load fail, FAKE_ACP_NOLOAD=1 drops
 * the loadSession capability, FAKE_ACP_NOIMAGE=1 drops the image prompt capability, FAKE_ACP_ALLOWONLY=1 offers no reject option, and FAKE_ACP_LOAD_ASKS=1
 * makes session/load call fs/read_text_file and session/request_permission back on us mid-replay.
 * FAKE_ACP_MUTE_INITIALIZE=1, FAKE_ACP_MUTE_SESSION_NEW=1 and FAKE_ACP_MUTE_SESSION_LOAD=1 leave that request unanswered forever.
 * FAKE_ACP_IGNORE_EOF=1 keeps the child alive after its stdin closes, FAKE_ACP_NOSESSIONID=1 answers session/new without a sessionId, FAKE_ACP_BADAUTH=1 sends a non-array
 * `authMethods`, and FAKE_ACP_EXIT_MARKER=<path> writes that file when our stdin closes.
 */

import { writeFileSync } from "node:fs";

let nextSessionN = 0;
let nextCallN = 0;
let nextServerRequestId = 0; // the real agents number their own requests from 0
const pendingRequests = new Map(); // agent request id -> (clientReply) => void
const pendingPrompts = new Map(); // sessionId -> prompt request id
/** Everything the client asked of us, echoed back by a REVEAL turn. */
const journal = { cwd: process.cwd(), newParams: null, loadParams: null, calls: [], replayAsks: null };
let stdinBuf = "";

const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message, data) => send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const update = (sessionId, u) => notify("session/update", { sessionId, update: u });
const textBlock = (text) => ({ type: "text", text });
/** Sends an agent -> client request and hands back a promise for the client's reply. */
const ask = (method, params) => {
  const id = nextServerRequestId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pendingRequests.set(id, resolve));
};
const promptText = (prompt) => (Array.isArray(prompt) ? prompt : []).map((b) => (b && typeof b.text === "string" ? b.text : "")).join(" ");

// FAKE_ACP_ALLOWONLY drops the reject options, the case where no optionId can carry a deny.
const PERMISSION_OPTIONS = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  ...(process.env.FAKE_ACP_ALLOWONLY ? [] : [{ optionId: "reject-once", name: "Reject", kind: "reject_once" }]),
];

function message(sessionId, text) {
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: textBlock(text) });
}

/** One tool call, blocked on a permission request, completed according to what the client picked. */
async function permitTurn(sessionId, n) {
  const toolCallId = `call_${nextCallN++}`;
  update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: `Run step ${n}`, kind: "execute", status: "pending", rawInput: { command: `echo ${n}` } });
  // Only `toolCallId` is guaranteed on this ToolCallUpdate (§4) — the client must merge it against the
  // tool_call above to render a useful card.
  const reply = await ask("session/request_permission", { sessionId, toolCall: { toolCallId }, options: PERMISSION_OPTIONS });
  const outcome = reply.result?.outcome ?? {};
  const picked = outcome.outcome === "selected" ? outcome.optionId : outcome.outcome;
  const allowed = outcome.outcome === "selected" && String(outcome.optionId).startsWith("allow");
  update(sessionId, {
    sessionUpdate: "tool_call_update", toolCallId,
    status: allowed ? "completed" : "failed",
    content: [{ type: "content", content: textBlock(`outcome:${picked}`) }],
  });
}

async function readFileTurn(sessionId, text) {
  const [, path, line, limit] = text.split(/\s+/);
  const params = { sessionId, path };
  if (line !== undefined) params.line = Number(line);
  if (limit !== undefined) params.limit = Number(limit);
  const reply = await ask("fs/read_text_file", params);
  message(sessionId, reply.error ? `read failed: ${reply.error.message}` : `read:${reply.result.content}`);
}

async function writeFileTurn(sessionId, text) {
  const [, path, ...rest] = text.split(/\s+/);
  const reply = await ask("fs/write_text_file", { sessionId, path, content: rest.join(" ") });
  message(sessionId, reply.error ? `write failed: ${reply.error.message}` : "write:ok");
}

async function oddballTurn(sessionId) {
  // A method the client never declared. The turn only ends once it is answered, so an unanswered probe
  // would stall this forever.
  const reply = await ask("terminal/create", { sessionId, command: "true", args: [] });
  message(sessionId, `terminal refused: ${reply.error?.code ?? "none"}`);
}

async function runTurn(id, sessionId, prompt) {
  const text = promptText(prompt);
  if (text.includes("FAIL")) { pendingPrompts.delete(sessionId); fail(id, -32603, "prompt exploded"); return; }
  if (text.includes("DIE")) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: `call_${nextCallN++}`, title: "Doomed", kind: "execute", status: "in_progress" });
    setTimeout(() => process.exit(9), 25);
    return;
  }
  if (text.includes("LATEPERMIT")) { // asks only once the client has started tearing the session down
    setTimeout(() => {
      void permitTurn(sessionId, 9);
      setTimeout(() => process.exit(0), 30);
    }, 30);
    return;
  }
  if (text.includes("OPENTEXT")) { message(sessionId, "partial"); return; } // a message run left open
  if (text.includes("OPENTOOL")) { // a tool card left open, and a turn that never ends
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: `call_${nextCallN++}`, title: "Never finishes", kind: "execute", status: "in_progress" });
    return;
  }
  if (text.includes("HANG")) return; // resolved only by session/cancel
  if (text.includes("ECHO")) message(sessionId, JSON.stringify(prompt));
  else if (text.includes("REVEAL")) message(sessionId, JSON.stringify(journal));
  else if (text.includes("PERMIT2")) await Promise.all([permitTurn(sessionId, 0), permitTurn(sessionId, 1)]);
  else if (text.includes("PERMIT")) await permitTurn(sessionId, 0);
  else if (text.includes("READFILE")) await readFileTurn(sessionId, text);
  else if (text.includes("WRITEFILE")) await writeFileTurn(sessionId, text);
  else if (text.includes("ODDBALL")) await oddballTurn(sessionId);
  else {
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: textBlock("pondering") });
    message(sessionId, "Hel");
    message(sessionId, "lo");
  }
  const stop = /STOP:(\w+)/.exec(text);
  if (!pendingPrompts.has(sessionId)) return; // cancelled while we were streaming
  pendingPrompts.delete(sessionId);
  ok(id, { stopReason: stop ? stop[1] : "end_turn" });
}

/** Replays the prior conversation as notifications, then responds — the order §2.3 mandates. */
async function loadSession(id, params) {
  journal.loadParams = params;
  const sessionId = params.sessionId;
  update(sessionId, { sessionUpdate: "user_message_chunk", content: textBlock("what did we do yesterday?") });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: textBlock("we replayed history") });
  update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_old", title: "Old tool", kind: "read", status: "completed" });
  if (process.env.FAKE_ACP_LOAD_ASKS) {
    const [read, permission] = await Promise.all([
      ask("fs/read_text_file", { sessionId, path: process.env.FAKE_ACP_LOAD_ASKS_PATH ?? "/nonexistent" }),
      ask("session/request_permission", { sessionId, toolCall: { toolCallId: "call_old" }, options: PERMISSION_OPTIONS }),
    ]);
    journal.replayAsks = { read, permission };
  }
  ok(id, {});
}

function handleRequest(id, method, params) {
  switch (method) {
    case "initialize":
      // Spawned and mute: an unbounded initialize leaves boot pending forever.
      if (process.env.FAKE_ACP_MUTE_INITIALIZE) return;
      journal.calls.push({ method, params });
      ok(id, {
        protocolVersion: 1,
        agentCapabilities: {
          ...(process.env.FAKE_ACP_NOLOAD ? {} : { loadSession: true }),
          mcpCapabilities: { http: true, sse: true },
          promptCapabilities: { image: !process.env.FAKE_ACP_NOIMAGE, audio: false, embeddedContext: false },
        },
        // FAKE_ACP_BADAUTH: a real agent may send anything here; a non-array must not crash the error path.
        authMethods: process.env.FAKE_ACP_BADAUTH ? "not-an-array" : [{ id: "fake_login", name: "Fake Login", description: "Run `fake login` first." }],
      });
      return;
    case "session/new":
      if (process.env.FAKE_ACP_MUTE_SESSION_NEW) return; // handshakes, then never opens a session
      if (process.env.FAKE_ACP_AUTHFAIL) { fail(id, -32000, "This client is no longer supported for individuals."); return; }
      if (process.env.FAKE_ACP_STARTFAIL) { fail(id, -32603, "Internal error", { message: "Failed to initialize session services", details: "[unauthenticated] Error" }); return; }
      journal.newParams = params;
      if (process.env.FAKE_ACP_NOSESSIONID) { ok(id, {}); return; }
      ok(id, { sessionId: `sess_${nextSessionN++}`, models: { currentModelId: "fake-model-1", availableModels: [{ modelId: "fake-model-1", name: "Fake 1" }] } });
      return;
    case "session/load":
      if (process.env.FAKE_ACP_MUTE_SESSION_LOAD) return; // never replies: the resume has to time out and fall back
      if (process.env.FAKE_ACP_LOADFAIL) { fail(id, -32603, "no such session on disk"); return; }
      void loadSession(id, params);
      return;
    case "session/prompt":
      pendingPrompts.set(params.sessionId, id);
      void runTurn(id, params.sessionId, params.prompt);
      return;
    case "session/set_mode":
      journal.calls.push({ method, params });
      ok(id, {});
      return;
    case "session/set_model":
      journal.calls.push({ method, params });
      fail(id, -32601, "session/set_model is unstable and not implemented");
      return;
    default:
      journal.calls.push({ method, params });
      fail(id, -32601, `unknown method: ${method}`);
  }
}

function handleNotification(method, params) {
  journal.calls.push({ method, params });
  if (method !== "session/cancel") return;
  const id = pendingPrompts.get(params.sessionId);
  if (id === undefined) return;
  pendingPrompts.delete(params.sessionId);
  // §6: the agent MAY keep sending updates but MUST flush them before replying, and MUST still resolve the
  // original prompt with `cancelled`.
  message(params.sessionId, "bye");
  ok(id, { stopReason: "cancelled" });
}

function handleFrame(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  // A client RESPONSE to one of our requests: no method, an id, and result/error. Must be checked before the
  // request dispatcher, since the two id spaces overlap.
  if (msg.method === undefined && msg.id !== undefined && ("result" in msg || "error" in msg)) {
    const resolve = pendingRequests.get(msg.id);
    if (!resolve) return;
    pendingRequests.delete(msg.id);
    resolve({ result: msg.result, error: msg.error });
    return;
  }
  if (typeof msg.method !== "string") return;
  if (msg.id === undefined || msg.id === null) { handleNotification(msg.method, msg.params ?? {}); return; }
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
process.stdin.on("end", () => {
  if (process.env.FAKE_ACP_IGNORE_EOF) return; // outlive the client's stdin close, like an agent mid-tool-call
  // Proof for the tests that closing our stdin really did take this child down.
  if (process.env.FAKE_ACP_EXIT_MARKER) writeFileSync(process.env.FAKE_ACP_EXIT_MARKER, "bye");
  process.exit(0);
});
