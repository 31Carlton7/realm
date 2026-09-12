import type { CodexSetupRuntime } from "@realm/contracts";
import { CodexConnection } from "./connection";
import { JsonRpcCallError } from "../jsonrpc/stdio";

type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string | null => typeof v === "string" ? v : null;
const bool = (v: unknown): boolean | null => typeof v === "boolean" ? v : null;

export function unavailableCodexSetup(): CodexSetupRuntime {
  return {
    state: "unavailable", components: { config: "unavailable", skills: "unavailable", hooks: "unavailable" },
    settings: { model: null, provider: null, reasoning: null, approvalPolicy: null, sandbox: null },
    skills: [], hooks: [], connections: [],
  };
}

/** No raw config, hook commands, headers, env, or provider errors cross this boundary. */
export async function readCodexSetup(request: Request, cwd: string): Promise<CodexSetupRuntime> {
  const out = unavailableCodexSetup();
  const replies = await Promise.allSettled([
    request("config/read", { cwd, includeLayers: false }),
    request("skills/list", { cwds: [cwd], forceReload: true }),
    request("hooks/list", { cwds: [cwd] }),
  ]);
  const components = ["config", "skills", "hooks"] as const;
  for (const [i, reply] of replies.entries()) {
    const component = components[i]!;
    if (reply.status === "rejected") {
      if (reply.reason instanceof JsonRpcCallError && reply.reason.code === -32601) out.components[component] = "unsupported";
      continue;
    }
    const value = reply.value;
    if (!record(value)) continue;
    if (component === "config") {
      if (!record(value.config)) continue;
      const c = value.config;
      out.settings = { model: text(c.model), provider: text(c.model_provider), reasoning: text(c.model_reasoning_effort), approvalPolicy: text(c.approval_policy), sandbox: text(c.sandbox_mode) };
      if (record(c.mcp_servers)) for (const [name, server] of Object.entries(c.mcp_servers)) {
        if (!record(server)) continue;
        out.connections.push({ name, transport: typeof server.command === "string" ? "stdio" : typeof server.url === "string" ? "http" : "unknown", enabled: bool(server.enabled), authentication: "not_checked" });
      }
      out.components.config = "available";
      continue;
    }
    if (!Array.isArray(value.data)) continue;
    const group = value.data.find((v: unknown) => record(v) && v.cwd === cwd);
    if (!record(group) || !Array.isArray(group[component])) continue;
    let partial = (Array.isArray(group.errors) && group.errors.length > 0) || (Array.isArray(group.warnings) && group.warnings.length > 0);
    for (const row of group[component]) {
      if (!record(row)) { partial = true; continue; }
      if (component === "skills") {
        if (typeof row.name !== "string" || typeof row.path !== "string") { partial = true; continue; }
        out.skills.push({ name: row.name, path: row.path, enabled: bool(row.enabled), origin: "native" });
      } else {
        if (typeof row.eventName !== "string") { partial = true; continue; }
        out.hooks.push({ event: row.eventName, sourcePath: text(row.sourcePath), enabled: bool(row.enabled), trust: text(row.trustStatus) });
      }
    }
    out.components[component] = partial ? "partial" : "available";
  }
  const states = Object.values(out.components);
  out.state = states.every(s => s === "available") ? "available" : states.every(s => s === "unavailable" || s === "unsupported") ? "unavailable" : "partial";
  return out;
}

/** Inspection only: never start a thread, run a turn, or attempt login. */
export async function inspectCodexSetup(opts: { cwd: string; codexHome: string; bin?: string; timeoutMs?: number }): Promise<CodexSetupRuntime> {
  let connection: CodexConnection | undefined;
  try {
    connection = await CodexConnection.open({ bin: opts.bin ?? process.env.REALM_CODEX_BIN ?? "codex", cwd: opts.cwd, env: { CODEX_HOME: opts.codexHome }, initializeTimeoutMs: opts.timeoutMs ?? 5000 });
    return await readCodexSetup((method, params) => connection!.request(method, params, opts.timeoutMs ?? 5000), opts.cwd);
  } catch { return unavailableCodexSetup(); }
  finally { try { await connection?.dispose(); } catch { /* Do not expose subprocess diagnostics. */ } }
}
