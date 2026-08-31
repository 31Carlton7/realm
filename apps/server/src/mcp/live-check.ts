import { spawn } from "node:child_process";
import type { McpServerRow } from "../store/mcp";

/**
 * `mcp.test` — reach the server the way a session would, and say what happened.
 *
 * The whole point is that this runs INSIDE realm-server: the same process, PATH and environment that
 * spawn the adapters at session start. A definition-time validation in the renderer would check a
 * different world (the plan documents that lie as banned); this checks the real one, by actually
 * connecting.
 *
 * `detail` reaches the UI, so it is built only from things that cannot be secrets: spawn errors
 * (command + errno), exit codes, HTTP statuses, and the server's own `serverInfo`. Stored env values
 * and headers go into the connection and never into the result — stderr is deliberately not quoted,
 * because a child that echoes its environment would smuggle a key straight onto the screen.
 */
export type McpTestResult = { reached: boolean; detail: string };

export const MCP_TEST_TIMEOUT_MS = 5000;

/** MCP's own hello. Any JSON-RPC answer to it — result or error — proves an MCP endpoint is there. */
const initializeRequest = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "realm-connection-test", version: "0" } },
});

export async function liveCheck(row: McpServerRow, timeoutMs: number = MCP_TEST_TIMEOUT_MS): Promise<McpTestResult> {
  return row.transport === "stdio" ? stdioCheck(row, timeoutMs) : remoteCheck(row, timeoutMs);
}

/** Spawn the command, send `initialize` (newline-delimited JSON, MCP's stdio framing), await any reply. */
function stdioCheck(row: McpServerRow, timeoutMs: number): Promise<McpTestResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: McpTestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve(r);
    };
    const child = spawn(row.command, row.args, {
      env: { ...process.env, ...row.secrets },
      stdio: ["pipe", "pipe", "ignore"], // stderr ignored on purpose: a child that echoes its env must not reach `detail`
    });
    const timer = setTimeout(() => done({ reached: false, detail: `started, but no response to the MCP initialize request within ${Math.round(timeoutMs / 1000)}s` }), timeoutMs);
    child.on("error", (e) => done({ reached: false, detail: `could not start: ${e.message}` }));
    child.on("exit", (code) => done({ reached: false, detail: `the command exited (code ${code ?? "unknown"}) before answering the initialize request` }));
    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: unknown; result?: { serverInfo?: { name?: string; version?: string } }; error?: { message?: string } };
          if (msg.id !== 1) continue; // a notification or someone else's frame; keep listening
          const info = msg.result?.serverInfo;
          done({
            reached: true,
            detail: msg.error
              ? "reached — the server answered initialize with an error, but it is speaking MCP"
              : `reached${info?.name ? ` — ${info.name}${info.version ? ` ${info.version}` : ""}` : ""}`,
          });
          return;
        } catch { /* not JSON: some servers log to stdout before speaking; keep listening */ }
      }
    });
    child.stdin.write(initializeRequest + "\n");
  });
}

/** POST initialize (http) or open the stream (sse). Any HTTP response at all means the host is there. */
async function remoteCheck(row: McpServerRow, timeoutMs: number): Promise<McpTestResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = row.transport === "http"
      ? await fetch(row.url, {
          method: "POST",
          headers: { ...row.secrets, "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: initializeRequest,
          signal: ctl.signal,
        })
      : await fetch(row.url, { headers: { ...row.secrets, accept: "text/event-stream" }, signal: ctl.signal });
    await res.body?.cancel().catch(() => {});
    const auth = res.status === 401 || res.status === 403 ? " — it refused the credentials" : "";
    return { reached: true, detail: `reached — HTTP ${res.status}${auth}` };
  } catch (e) {
    if (ctl.signal.aborted) return { reached: false, detail: `no response within ${Math.round(timeoutMs / 1000)}s` };
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : e instanceof Error ? e.message : String(e);
    return { reached: false, detail: `could not connect: ${cause}` };
  } finally {
    clearTimeout(timer);
  }
}
