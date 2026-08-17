import { readFileSync } from "node:fs";
import { query as sdkQuery, type Options, type PermissionResult, type PermissionUpdate, type SDKUserMessage, type Query } from "@anthropic-ai/claude-agent-sdk";
import { newId, sessionEvent, type SessionEvent } from "@realm/contracts";
import { AsyncQueue } from "../event-queue";
import { createSdkMapper } from "./map-sdk-message";
import { probeClaude } from "./probe";
import type { AgentAdapter, AgentHandle, PermissionDecision, ProbeResult, StartOptions, UserMessage } from "../types";

type QueryFn = typeof sdkQuery;

/** Claude adapter on the Agent SDK in streaming-input mode. `canUseTool` is bridged to permission_request/response events. */
export class ClaudeAdapter implements AgentAdapter {
  readonly kind = "claude" as const;
  private queryFn: QueryFn;
  constructor(deps: { query?: QueryFn } = {}) { this.queryFn = deps.query ?? sdkQuery; }

  async probe(): Promise<ProbeResult> { const p = await probeClaude(); return { kind: this.kind, ...p }; }

  start(opts: StartOptions): AgentHandle {
    const events = new AsyncQueue<SessionEvent>();
    const input = new AsyncQueue<SDKUserMessage>();
    const pending = new Map<string, { resolve: (r: PermissionResult) => void; suggestions: PermissionUpdate[] }>();
    const abort = new AbortController();
    const mapper = createSdkMapper();
    let q: Query | null = null;
    let running = false;

    const canUseTool: NonNullable<Options["canUseTool"]> = async (toolName, toolInput, o) => {
      const requestId = newId();
      const suggestions = o.suggestions ?? [];
      events.push(sessionEvent("status", { status: "waiting_permission" }));
      events.push(sessionEvent("permission_request", { requestId, toolName, input: toolInput, title: o.title ?? `Allow ${toolName}?`, suggestions: suggestions as unknown[] }));
      const result = await new Promise<PermissionResult>((resolve) => {
        pending.set(requestId, { resolve, suggestions });
        o.signal.addEventListener("abort", () => { if (pending.delete(requestId)) resolve({ behavior: "deny", message: "aborted" }); }, { once: true });
      });
      events.push(sessionEvent("status", { status: running ? "running" : "idle" }));
      return result;
    };

    const options: Options = {
      cwd: opts.cwd,
      model: opts.model ?? undefined,
      effort: (opts.effort ?? undefined) as Options["effort"],
      permissionMode: (opts.permissionMode ?? "default") as Options["permissionMode"],
      canUseTool,
      includePartialMessages: true,
      abortController: abort,
      resume: opts.resume ?? undefined,
      systemPrompt: opts.systemContext ? { type: "preset", preset: "claude_code", append: opts.systemContext } : undefined,
      mcpServers: Object.fromEntries(opts.mcpServers.map((s) => [s.name, { type: "stdio" as const, command: s.command, args: s.args, env: s.env }])),
      env: { ...process.env, ...opts.env },
      stderr: (d) => { if (d.trim()) events.push(sessionEvent("error", { message: d.trim() })); },
      pathToClaudeCodeExecutable: process.env.REALM_CLAUDE_BIN,
    };

    const pump = async () => {
      try {
        q = this.queryFn({ prompt: input, options });
        for await (const msg of q) {
          if (msg.type === "system" && (msg as { subtype?: string }).subtype === "init") {
            for (const e of mapper.map(msg)) events.push(e);
            events.push(sessionEvent("status", { status: running ? "running" : "idle" }));
            continue;
          }
          if (msg.type === "result") {
            for (const e of mapper.map(msg)) events.push(e);
            running = false;
            events.push(sessionEvent("status", { status: "idle" }));
            continue;
          }
          for (const e of mapper.map(msg)) events.push(e);
        }
      } catch (e) {
        events.push(sessionEvent("error", { message: (e as Error).message ?? String(e) }));
      } finally {
        events.push(sessionEvent("status", { status: "ended" }));
        events.close();
      }
    };
    void pump();

    return {
      events,
      send: (m: UserMessage) => {
        running = true;
        events.push(sessionEvent("user_message", { text: m.text, attachments: m.attachments }));
        events.push(sessionEvent("status", { status: "running" }));
        const content: Array<Record<string, unknown>> = [{ type: "text", text: m.text }];
        for (const a of m.attachments) {
          if (a.mime.startsWith("image/")) content.push({ type: "image", source: { type: "base64", media_type: a.mime, data: readFileSync(a.path).toString("base64") } });
        }
        input.push({ type: "user", message: { role: "user", content: content as never }, parent_tool_use_id: null, session_id: "" } as SDKUserMessage);
      },
      respondPermission: (requestId: string, d: PermissionDecision) => {
        const p = pending.get(requestId); if (!p) return;
        pending.delete(requestId);
        events.push(sessionEvent("permission_response", { requestId, decision: d }));
        if (d === "deny") p.resolve({ behavior: "deny", message: "User denied" });
        else if (d === "allow_always") p.resolve({ behavior: "allow", updatedPermissions: p.suggestions });
        else p.resolve({ behavior: "allow" });
      },
      interrupt: async () => {
        await q?.interrupt();
        if (running) { running = false; events.push(sessionEvent("status", { status: "idle" })); }
      },
      setOptions: async (o) => {
        if (o.model) await q?.setModel(o.model);
        if (o.permissionMode) await q?.setPermissionMode(o.permissionMode as never);
      },
      dispose: async () => { input.close(); abort.abort(); },
    };
  }
}
