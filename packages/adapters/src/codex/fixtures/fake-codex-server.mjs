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
 * Every turn opens with the sequence the real server was captured emitting (protocol reference §2.4):
 * `thread/status/changed{active}` -> `turn/started` -> `item/started(userMessage)`. What follows is selected
 * by the text of `turn/start`'s input:
 *
 *   HANG      opens a command item and never finishes the turn        (interrupt / steer tests)
 *   SLOW      (modifier) delays the turn's notifications by 60ms      (turn-id-from-response tests)
 *   GHOST     opens a turn the server does not register as steerable  (turn/steer -> turn/start fallback)
 *   APPROVE   runs one command that needs an approval decision
 *   PATCH     edits a file and asks for a fileChange approval instead
 *   REFUSE    fails `turn/start` outright
 *   APPROVE2  runs two commands whose approvals are open at once      (waiting_permission bookkeeping)
 *   ODDBALL   asks a server request no client is expected to support  (-32601 answer path)
 *   ECHO      replies with the raw `input` array as the agent message (input-shape assertions)
 *   CRASH     opens a command item, then dies without warning          (unexpected-death path)
 *   BADSTEER  (on turn/steer) fails the steer with something other than "no active turn"
 *   anything  streams a short agent message
 *
 * `text_elements` is validated on text input exactly as the real server does — omitting it is a deserialize
 * error there, and silently accepting it here would let that regression through.
 *
 * Test-only hooks: the `$test/exit` request kills the process (so tests can tell an unexpected death from
 * an intentional dispose), `model: "explode"` fails `thread/start` with the revoked-login error shape,
 * `model: "reflect"` echoes the whole `thread/start`/`thread/resume` params object back as the model string
 * (the only field of the start response the adapter surfaces), a resumed thread id containing "busy" rejoins a
 * turn that is already running, and FAKE_CODEX_MUTE_INITIALIZE=1 makes
 * `initialize` go unanswered.
 */

let nextThreadN = 0;
let nextTurnN = 0;
let nextItemN = 0;
let nextServerRequestId = 0; // the real server numbers its own requests from 0
const threads = new Map(); // threadId -> { cwd }
const activeTurns = new Map(); // threadId -> turnId, the precondition turn/steer checks
const pendingRequests = new Map(); // server request id -> (clientReply) => void
let stdinBuf = "";

const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const ok = (id, result) => send({ id, result });
const fail = (id, code, message, data) => send({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
const notify = (method, params) => send({ method, params, emittedAtMs: Date.now() });
/** Sends a server -> client request and hands back its id plus a promise for the client's reply. */
const ask = (method, params) => {
  const id = nextServerRequestId++;
  send({ method, id, params });
  return { id, reply: new Promise((resolve) => pendingRequests.set(id, resolve)) };
};
const tick = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));
const inputText = (input) => (Array.isArray(input) ? input : []).map((p) => (p && typeof p.text === "string" ? p.text : "")).join(" ");

/** Mirrors the real server's deserialization: `text_elements` is a non-optional array on text input. */
function inputError(input) {
  if (!Array.isArray(input) || input.length === 0) return "input must be a non-empty array";
  for (const part of input) {
    if (!part || typeof part !== "object") return "input part must be an object";
    if (part.type === "text" && !Array.isArray(part.text_elements)) return "missing field `text_elements`";
    if (part.type === "localImage" && typeof part.path !== "string") return "missing field `path`";
  }
  return null;
}

const commandItem = (id, command, cwd) =>
  ({ type: "commandExecution", id, command, cwd, status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null });

function endTurn(threadId, turnId, status = "completed") {
  activeTurns.delete(threadId);
  notify("thread/status/changed", { threadId, status: { type: "idle" } });
  notify("turn/completed", { threadId, turn: { id: turnId, itemsView: "summary", items: [], status, error: null } });
}

function agentMessage(threadId, turnId, text) {
  const itemId = `msg_${nextItemN++}`;
  notify("item/started", { threadId, turnId, startedAtMs: Date.now(), item: { type: "agentMessage", id: itemId, text: "", phase: null, memoryCitation: null } });
  notify("item/completed", { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: itemId, text, phase: null, memoryCitation: null } });
}

async function openTurn(threadId, turnId, text) {
  // SLOW widens the gap between the turn/start response and the first notification, so tests can act in the
  // window where the response is the only source of the turn id.
  await tick(text.includes("SLOW") ? 60 : 1);
  notify("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
  notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress", items: [] } });
  notify("item/started", {
    threadId, turnId, startedAtMs: Date.now(),
    item: { type: "userMessage", id: `usr_${nextItemN++}`, clientId: null, content: [{ type: "text", text, text_elements: [] }] },
  });
}

/** One command item, blocked on an approval, then completed according to the decision. */
async function streamApprovalTurn(threadId, turnId, text) {
  const itemId = `call_${nextItemN++}`;
  const cwd = threads.get(threadId)?.cwd ?? process.cwd();
  const command = "/bin/zsh -lc 'echo hi'";
  await openTurn(threadId, turnId, text);
  notify("item/started", { threadId, turnId, startedAtMs: Date.now(), item: commandItem(itemId, command, cwd) });
  const { id: requestId, reply } = ask("item/commandExecution/requestApproval", {
    threadId, turnId, itemId, startedAtMs: Date.now(), environmentId: "local",
    reason: "fake approval", command, cwd, commandActions: [],
    availableDecisions: ["accept", "cancel"],
  });
  const accepted = (await reply).result?.decision === "accept";
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
  endTurn(threadId, turnId);
}

/** Two command items whose approvals are outstanding at the same time (parallel tool calls). */
async function streamTwoApprovalsTurn(threadId, turnId, text) {
  const cwd = threads.get(threadId)?.cwd ?? process.cwd();
  await openTurn(threadId, turnId, text);
  const asked = [0, 1].map((n) => {
    const itemId = `call_${nextItemN++}`;
    const command = `/bin/zsh -lc 'echo ${n}'`;
    notify("item/started", { threadId, turnId, startedAtMs: Date.now(), item: commandItem(itemId, command, cwd) });
    const { reply } = ask("item/commandExecution/requestApproval", {
      threadId, turnId, itemId, startedAtMs: Date.now(), environmentId: "local",
      reason: "fake approval", command, cwd, commandActions: [],
      availableDecisions: ["accept", "cancel"],
    });
    return { itemId, command, reply };
  });
  const replies = await Promise.all(asked.map((a) => a.reply));
  asked.forEach((a, n) => {
    const accepted = replies[n].result?.decision === "accept";
    notify("item/completed", {
      threadId, turnId, completedAtMs: Date.now(),
      item: {
        type: "commandExecution", id: a.itemId, command: a.command, cwd, commandActions: [],
        status: accepted ? "completed" : "failed", aggregatedOutput: accepted ? `${n}\n` : "", exitCode: accepted ? 0 : 1,
      },
    });
  });
  endTurn(threadId, turnId);
}

/** One fileChange item, blocked on the fileChange flavour of approval. */
async function streamPatchTurn(threadId, turnId, text) {
  const itemId = `patch_${nextItemN++}`;
  const changes = [{ path: "/repo/src/a.ts", kind: { type: "edit" }, diff: "@@\n-old\n+new" }];
  await openTurn(threadId, turnId, text);
  notify("item/started", { threadId, turnId, startedAtMs: Date.now(), item: { type: "fileChange", id: itemId, changes, status: "inProgress" } });
  const { reply } = ask("item/fileChange/requestApproval", {
    threadId, turnId, itemId, startedAtMs: Date.now(), reason: "Apply 1 edit to a.ts", grantRoot: "/repo",
    // FileChangeApprovalDecision, unlike the captured command flavour, does offer "decline".
    availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
  });
  const decision = (await reply).result?.decision;
  notify("item/completed", {
    threadId, turnId, completedAtMs: Date.now(),
    item: { type: "fileChange", id: itemId, changes, status: decision === "accept" ? "completed" : "failed", decision: decision ?? null },
  });
  endTurn(threadId, turnId);
}

async function streamMessageTurn(threadId, turnId, text) {
  const itemId = `msg_${nextItemN++}`;
  await openTurn(threadId, turnId, text);
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
  endTurn(threadId, turnId);
}

/** Opens a command item and then stops: the turn never completes on its own. */
async function streamHangTurn(threadId, turnId, text) {
  const cwd = threads.get(threadId)?.cwd ?? process.cwd();
  await openTurn(threadId, turnId, text);
  notify("item/started", { threadId, turnId, startedAtMs: Date.now(), item: commandItem(`call_${nextItemN++}`, "/bin/zsh -lc 'sleep 999'", cwd) });
}

/** Echoes the raw input array so tests can assert the exact wire shape the adapter built. */
async function streamEchoTurn(threadId, turnId, text, input) {
  await openTurn(threadId, turnId, text);
  agentMessage(threadId, turnId, JSON.stringify(input));
  endTurn(threadId, turnId);
}

/** A server request no client is expected to understand; the turn only ends once it is answered. */
async function streamOddballTurn(threadId, turnId, text) {
  await openTurn(threadId, turnId, text);
  const { reply } = ask("item/tool/requestUserInput", { threadId, turnId, itemId: `q_${nextItemN++}`, questions: [], autoResolutionMs: null });
  const answer = await reply;
  agentMessage(threadId, turnId, `refused: ${answer.error?.code ?? answer.result?.decision ?? "none"}`);
  endTurn(threadId, turnId);
}

async function streamInterrupt(threadId, turnId) {
  await tick();
  endTurn(threadId, turnId, "interrupted");
}

function startThread(id, params, threadId) {
  threads.set(threadId, { cwd: params.cwd });
  ok(id, {
    thread: { id: threadId, status: { type: "idle" }, cwd: params.cwd, turns: [] },
    model: params.model === "reflect" ? JSON.stringify(params) : (params.model ?? "gpt-5.2"),
    cwd: params.cwd,
  });
}

function handleRequest(id, method, params) {
  switch (method) {
    case "initialize":
      if (process.env.FAKE_CODEX_MUTE_INITIALIZE) return; // spawned but mute: drives the open() timeout test
      ok(id, { userAgent: "fake-codex/0.146.0", codexHome: "/tmp/fake-codex-home" });
      return;
    case "thread/start": {
      if (params.model === "explode") {
        fail(id, -32600, "failed to load configuration", { action: "relogin", statusCode: 401 });
        return;
      }
      if (params.model === "nope") {
        fail(id, -32600, "unknown model `nope`", { statusCode: 400 }); // no `action`: not a login problem
        return;
      }
      const threadId = `th_${nextThreadN++}`;
      // `model: "eager"` reproduces the race CodexConnection's buffer exists for: a thread-scoped notification
      // emitted before the response that tells the client the thread id.
      if (params.model === "eager") notify("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
      startThread(id, params, threadId);
      return;
    }
    case "thread/resume":
      startThread(id, params, params.threadId);
      // A thread id containing "busy" was mid-turn when the client went away: resuming rejoins the live turn,
      // whose id the client can only learn from turn/started (the resume response does not carry it).
      if (String(params.threadId).includes("busy")) void streamHangTurn(params.threadId, `tu_${nextTurnN++}`, "resumed");
      return;
    case "turn/start": {
      const bad = inputError(params.input);
      if (bad) { fail(id, -32602, `invalid params: ${bad}`); return; }
      const text = inputText(params.input);
      if (text.includes("REFUSE")) { fail(id, -32600, "the model refused this turn"); return; }
      const turnId = `tu_${nextTurnN++}`;
      ok(id, { turn: { id: turnId, status: "inProgress", items: [] } });
      // GHOST is the only turn the server will not accept a steer for, so the adapter's stale-turn fallback
      // has something to trip over.
      if (!text.includes("GHOST")) activeTurns.set(params.threadId, turnId);
      // Dies with a tool card still open, so the crash has something to force-close.
      if (text.includes("CRASH")) { void streamHangTurn(params.threadId, turnId, text); setTimeout(() => process.exit(9), 25); return; }
      if (text.includes("GHOST")) { void openTurn(params.threadId, turnId, text); return; }
      if (text.includes("HANG")) { void streamHangTurn(params.threadId, turnId, text); return; }
      if (text.includes("APPROVE2")) { void streamTwoApprovalsTurn(params.threadId, turnId, text); return; }
      if (text.includes("PATCH")) { void streamPatchTurn(params.threadId, turnId, text); return; }
      if (text.includes("APPROVE")) { void streamApprovalTurn(params.threadId, turnId, text); return; }
      if (text.includes("ODDBALL")) { void streamOddballTurn(params.threadId, turnId, text); return; }
      if (text.includes("ECHO")) { void streamEchoTurn(params.threadId, turnId, text, params.input); return; }
      void streamMessageTurn(params.threadId, turnId, text);
      return;
    }
    case "turn/steer": {
      const bad = inputError(params.input);
      if (bad) { fail(id, -32602, `invalid params: ${bad}`); return; }
      if (inputText(params.input).includes("BADSTEER")) { fail(id, -32603, "internal error while steering"); return; }
      const active = activeTurns.get(params.threadId);
      if (!active || active !== params.expectedTurnId) { fail(id, -32600, "no active turn to steer"); return; }
      ok(id, { turnId: active });
      agentMessage(params.threadId, active, `steered:${inputText(params.input)}`);
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
    const resolve = pendingRequests.get(msg.id);
    if (!resolve) return;
    pendingRequests.delete(msg.id);
    resolve({ result: msg.result, error: msg.error });
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
