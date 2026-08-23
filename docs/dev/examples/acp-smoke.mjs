#!/usr/bin/env node
// ACP smoke test — self-contained, zero deps.
//
//   node acp-smoke.mjs <command> [args...] [-- <prompt>]
//
//   node acp-smoke.mjs cursor-agent acp
//   node acp-smoke.mjs gemini --acp -- "Reply with exactly: ACP OK"
//
// Env: ACP_CWD (default process.cwd()), ACP_TIMEOUT_MS (default 90000).
//
// Speaks raw newline-delimited JSON-RPC 2.0 over the child's stdin/stdout.
// Logs every frame in both directions, auto-answers permission requests with
// the first `reject_once` option, and always kills the child on exit.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import process from "node:process";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const cmdParts = sep === -1 ? argv : argv.slice(0, sep);
const promptText =
  sep === -1 ? "Reply with exactly: ACP OK" : argv.slice(sep + 1).join(" ");

if (cmdParts.length === 0) {
  console.error("usage: node acp-smoke.mjs <command> [args...] [-- <prompt>]");
  process.exit(2);
}

const TIMEOUT_MS = Number(process.env.ACP_TIMEOUT_MS ?? 90_000);
const CWD = process.env.ACP_CWD ?? process.cwd();

const child = spawn(cmdParts[0], cmdParts.slice(1), {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: CWD,
  env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
});

let done = false;
const cleanup = () => {
  if (done) return;
  done = true;
  try {
    child.kill("SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
  }, 1500).unref();
};
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => (cleanup(), process.exit(130)));

const hardTimer = setTimeout(() => {
  console.error(`\n[smoke] TIMEOUT after ${TIMEOUT_MS}ms`);
  cleanup();
  process.exit(1);
}, TIMEOUT_MS);
hardTimer.unref();

child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => process.stderr.write(`[agent stderr] ${d}`));
child.on("error", (e) => {
  console.error(`[smoke] spawn failed: ${e.message}`);
  process.exit(1);
});
child.on("exit", (code, sig) => {
  console.error(`\n[smoke] child exited code=${code} signal=${sig}`);
  clearTimeout(hardTimer);
  if (!done) process.exit(code ?? 0);
});

// ---- ndjson JSON-RPC plumbing -------------------------------------------
let nextId = 0;
const pending = new Map();

function send(obj) {
  console.log("→", JSON.stringify(obj));
  child.stdin.write(JSON.stringify(obj) + "\n");
}
function request(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}
function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log("[non-json stdout]", line);
    return;
  }
  console.log("←", JSON.stringify(msg));

  // Response to one of our requests.
  if (msg.id !== undefined && msg.method === undefined) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error
      ? p.reject(Object.assign(new Error(msg.error.message), msg.error))
      : p.resolve(msg.result);
    return;
  }

  // Request or notification from the agent — we are the client.
  handleIncoming(msg).catch((e) => console.error("[smoke] handler error", e));
});

async function handleIncoming(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "session/update":
      return; // already logged above
    case "session/request_permission": {
      const opts = params?.options ?? [];
      const pick =
        opts.find((o) => o.kind === "reject_once") ??
        opts.find((o) => o.kind === "reject_always") ??
        opts[0];
      console.log(`[smoke] auto-answering permission optionId=${pick?.optionId}`);
      return respond(id, {
        outcome: { outcome: "selected", optionId: pick?.optionId },
      });
    }
    case "fs/read_text_file": {
      const { readFile } = await import("node:fs/promises");
      try {
        return respond(id, { content: await readFile(params.path, "utf8") });
      } catch (e) {
        return respondError(id, -32603, String(e));
      }
    }
    case "fs/write_text_file":
      // The smoke test refuses writes on purpose.
      return respondError(id, -32603, "smoke test: writes disabled");
    default:
      // Catch-all: never leave an agent request unanswered.
      if (id !== undefined)
        return respondError(id, -32601, `method not found: ${method}`);
  }
}

// ---- happy path ----------------------------------------------------------
try {
  const init = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: false,
    },
  });
  console.log("[smoke] agentCapabilities:", JSON.stringify(init.agentCapabilities));
  console.log("[smoke] authMethods:", JSON.stringify(init.authMethods));

  let session;
  try {
    session = await request("session/new", { cwd: CWD, mcpServers: [] });
  } catch (e) {
    if (e.code === -32000) {
      console.error(
        "[smoke] AUTH REQUIRED (-32000). Log in with the agent's own CLI, then retry.",
      );
    }
    throw e;
  }
  console.log("[smoke] sessionId:", session.sessionId);
  if (session.modes) console.log("[smoke] modes:", JSON.stringify(session.modes));
  if (session.models) console.log("[smoke] models:", JSON.stringify(session.models));

  const res = await request("session/prompt", {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: promptText }],
  });
  console.log("[smoke] stopReason:", res.stopReason);

  // Exercise session/load if the agent advertises it.
  if (init.agentCapabilities?.loadSession) {
    console.log("[smoke] agent advertises loadSession; replaying session…");
    await request("session/load", {
      sessionId: session.sessionId,
      cwd: CWD,
      mcpServers: [],
    });
    console.log("[smoke] session/load OK");
  } else {
    console.log("[smoke] agent does NOT advertise loadSession");
  }

  console.log("[smoke] PASS");
  cleanup();
  process.exit(0);
} catch (err) {
  console.error("[smoke] FAIL:", err?.code ?? "", err?.message ?? err);
  if (err?.data) console.error("[smoke] error data:", JSON.stringify(err.data));
  cleanup();
  process.exit(1);
}
