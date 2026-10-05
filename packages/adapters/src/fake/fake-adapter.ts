import { newId, sessionEvent, type SessionEvent, type SessionEventPayload } from "@realm/contracts";
import { AsyncQueue } from "../event-queue";
import type { AgentAdapter, AgentHandle, McpServerConfig, PermissionDecision, ProbeResult, StartOptions, UserMessage } from "../types";

export type FakeStep =
  /** `paceMs` streams the text a word at a time, this far apart — the way a real agent's deltas
   *  arrive. Without it the whole message lands in one burst, which is all a test needs and too
   *  fast for anything that animates arrival (the prose's fade) to be seen doing it. */
  | { kind: "text"; text: string; paceMs?: number }
  | { kind: "tool"; name: string; input: Record<string, unknown>; needsPermission?: boolean; result: string }
  /** A plan, in either shape the `plan` event carries. Re-using a `planId` revises that plan in
   *  place, which is what the real agents do and the one plan behaviour a script must be able to
   *  reproduce. */
  | { kind: "plan"; planId: string; text?: string; steps?: { text: string; status: "pending" | "in_progress" | "completed" }[] }
  | { kind: "throw"; message: string }
  /** A plan-quota reading, as `SDKRateLimitEvent` produces one on the real Claude wire. The scripted
   *  adapter is the only kind that can drive the limits path end to end in a test. */
  | { kind: "rateLimit"; payload: SessionEventPayload<"rate_limit"> }
  /** A call to one of Realm's own tools (`realm-schedule__schedule_create`) through the gateway the
   *  session was handed — the route a real agent takes, so a live check can drive a tool end to end
   *  rather than writing the row the tool would have written. */
  | { kind: "mcp"; tool: string; args: Record<string, unknown> };
export type FakeScript = { on: string; emit: FakeStep[] }[];

/** Scripted adapter for tests and UI development. Messages matching `on` replay the scripted steps; others echo. */
export class FakeAdapter implements AgentAdapter {
  readonly kind = "fake" as const;
  /** `resume` makes this fake report a resume outcome when it is handed one — the scripted adapter
   *  holds no conversation of its own (`AGENT_SESSION_RESUME.fake` is `none`), so it says nothing
   *  about resuming unless a test asks it to stand in for an agent that does. */
  constructor(private cfg: { script: FakeScript; delayMs?: number; resume?: "continued" | "declined" | "unsupported" } = { script: [] }) {}

  async probe(): Promise<ProbeResult> { return { kind: this.kind, available: true, version: "fake", loggedIn: true, reason: null }; }

  start(opts: StartOptions): AgentHandle {
    const q = new AsyncQueue<SessionEvent>();
    const pending = new Map<string, (d: PermissionDecision) => void>();
    const delay = this.cfg.delayMs ?? 0;
    const sleep = () => new Promise((r) => setTimeout(r, delay));
    let disposed = false;
    let interrupted = false;
    const gateway = gatewayClient(opts.mcpServers);

    const resumeOutcome = opts.resume ? this.cfg.resume : undefined;
    q.push(sessionEvent("init", {
      // A continued resume keeps the id it was handed, as a real adapter does; anything else is a
      // fresh conversation with a fresh id.
      providerSessionId: resumeOutcome === "continued" && opts.resume ? opts.resume : `fake-${newId()}`,
      model: opts.model ?? "fake", tools: ["Bash", "Read"], cwd: opts.cwd,
      ...(resumeOutcome ? { resumeRequested: true, resumeOutcome } : {}),
    }));
    q.push(sessionEvent("status", { status: "idle" }));

    const resolvePermission = (requestId: string, decision: PermissionDecision) => {
      const res = pending.get(requestId); if (!res) return;
      pending.delete(requestId);
      q.push(sessionEvent("permission_response", { requestId, decision }));
      res(decision);
    };
    const denyAllPending = () => { for (const id of [...pending.keys()]) resolvePermission(id, "deny"); };

    const run = async (msg: UserMessage) => {
      interrupted = false;
      q.push(sessionEvent("status", { status: "running" }));
      const step = this.cfg.script.find((s) => msg.text.includes(s.on));
      for (const st of step?.emit ?? [{ kind: "text", text: `echo: ${msg.text}` } as FakeStep]) {
        if (disposed) return;
        if (interrupted) break; // like the real adapter: interrupt stops the turn; the turn's natural end still emits usage + idle
        await sleep();
        if (st.kind === "throw") throw new Error(st.message);
        if (st.kind === "rateLimit") { q.push(sessionEvent("rate_limit", st.payload)); continue; }
        if (st.kind === "plan") { q.push(sessionEvent("plan", { planId: st.planId, ...(st.text ? { text: st.text } : {}), ...(st.steps ? { steps: st.steps } : {}) })); continue; }
        if (st.kind === "mcp") {
          // Named as the harnesses name a gateway tool, so the transcript draws it as one.
          const toolUseId = newId();
          q.push(sessionEvent("tool_call", { toolUseId, name: `mcp__realm__${st.tool}`, input: st.args, parentToolUseId: null }));
          const out = await gateway.call(st.tool, st.args).catch((e: unknown) => ({ text: e instanceof Error ? e.message : String(e), isError: true }));
          if (disposed) return;
          q.push(sessionEvent("tool_result", { toolUseId, content: out.text, isError: out.isError }));
          continue;
        }
        if (st.kind === "text") {
          const id = newId();
          if (st.paceMs === undefined) {
            for (const ch of st.text) q.push(sessionEvent("assistant_delta", { messageId: id, delta: ch }));
            q.push(sessionEvent("assistant_text", { messageId: id, text: st.text }));
          } else {
            // A stop mid-sentence ends the message where it got to, as a real one does — the final
            // text is what was said, never the rest of the script.
            let said = "";
            for (const word of st.text.match(/\S+\s*|\s+/g) ?? []) {
              if (disposed || interrupted) break;
              said += word;
              q.push(sessionEvent("assistant_delta", { messageId: id, delta: word }));
              await new Promise((r) => setTimeout(r, st.paceMs));
            }
            if (disposed) return;
            q.push(sessionEvent("assistant_text", { messageId: id, text: said }));
          }
        } else {
          const toolUseId = newId();
          q.push(sessionEvent("tool_call", { toolUseId, name: st.name, input: st.input, parentToolUseId: null }));
          if (st.needsPermission) {
            const requestId = newId();
            q.push(sessionEvent("status", { status: "waiting_permission" }));
            q.push(sessionEvent("permission_request", { requestId, toolName: st.name, input: st.input, title: `Allow ${st.name}?`, suggestions: [] }));
            const decision = await new Promise<PermissionDecision>((res) => pending.set(requestId, res));
            if (disposed) return;
            if (interrupted) break;
            q.push(sessionEvent("status", { status: "running" }));
            if (decision === "deny") { q.push(sessionEvent("assistant_text", { messageId: newId(), text: "Okay, I won't run that." })); continue; }
          }
          q.push(sessionEvent("tool_result", { toolUseId, content: st.result, isError: false }));
        }
      }
      q.push(sessionEvent("usage", { costUsd: 0.001, inputTokens: 10, outputTokens: 10, numTurns: 1 }));
      // Carries `interrupted` as the real adapters do (claude-adapter's result branch): the settle is
      // what tells "you stopped this" apart from "this finished".
      q.push(sessionEvent("status", { status: "idle", ...(interrupted ? { interrupted: true } : {}) }));
    };

    let chain = Promise.resolve();
    return {
      events: q,
      send: async (m) => {
        if (disposed) { q.push(sessionEvent("error", { message: "session ended" })); return; }
        chain = chain.then(() => run(m)).catch((e: unknown) => {
          q.push(sessionEvent("error", { message: (e as Error).message ?? String(e) }));
          q.push(sessionEvent("status", { status: "idle" }));
        });
      },
      respondPermission: resolvePermission,
      interrupt: async () => { interrupted = true; denyAllPending(); },
      setOptions: async () => {},
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        denyAllPending();
        await chain;
        q.push(sessionEvent("status", { status: "ended" }));
        q.close();
      },
    };
  }
}

/**
 * The least an MCP client can be and still be one: Streamable HTTP, JSON-RPC over POST, the session
 * id the server hands back on `initialize` carried on every later request, and a response read
 * whether the server answered as JSON or as one SSE event. Initialised once per handle, because the
 * gateway is stateful per Realm session and refuses a second `initialize`.
 */
function gatewayClient(servers: McpServerConfig[]) {
  const gw = servers.find((s): s is Extract<McpServerConfig, { transport: "http" | "sse" }> => s.transport === "http");
  let session: Promise<string | null> | null = null;
  const post = async (body: unknown, sessionId: string | null) => {
    if (!gw) throw new Error("this session was handed no Realm gateway");
    const res = await fetch(gw.url, {
      method: "POST", body: JSON.stringify(body),
      headers: { ...gw.headers, "content-type": "application/json", accept: "application/json, text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
    });
    const raw = await res.text();
    const json = raw.trimStart().startsWith("{") ? raw : raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop() ?? "";
    return { sessionId: res.headers.get("mcp-session-id") ?? sessionId, message: json ? JSON.parse(json) as { result?: unknown; error?: { message: string } } : null };
  };
  const open = async () => {
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "realm-fake", version: "0" } } }, null);
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId);
    return init.sessionId;
  };
  let id = 1;
  return {
    async call(tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
      session ??= open();
      const { message } = await post({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: tool, arguments: args } }, await session);
      if (!message || message.error) return { text: message?.error?.message ?? "no answer from the gateway", isError: true };
      const result = message.result as { content?: { type: string; text?: string }[]; isError?: boolean };
      return { text: (result.content ?? []).map((c) => c.text ?? "").join("\n"), isError: result.isError === true };
    },
  };
}
