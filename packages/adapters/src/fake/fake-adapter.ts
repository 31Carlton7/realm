import { newId, sessionEvent, type SessionEvent } from "@realm/contracts";
import { AsyncQueue } from "../event-queue";
import type { AgentAdapter, AgentHandle, PermissionDecision, ProbeResult, StartOptions, UserMessage } from "../types";

export type FakeStep =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: Record<string, unknown>; needsPermission?: boolean; result: string }
  | { kind: "throw"; message: string };
export type FakeScript = { on: string; emit: FakeStep[] }[];

/** Scripted adapter for tests and UI development. Messages matching `on` replay the scripted steps; others echo. */
export class FakeAdapter implements AgentAdapter {
  readonly kind = "fake" as const;
  constructor(private cfg: { script: FakeScript; delayMs?: number } = { script: [] }) {}

  async probe(): Promise<ProbeResult> { return { kind: this.kind, available: true, version: "fake", loggedIn: true, reason: null }; }

  start(opts: StartOptions): AgentHandle {
    const q = new AsyncQueue<SessionEvent>();
    const pending = new Map<string, (d: PermissionDecision) => void>();
    const delay = this.cfg.delayMs ?? 0;
    const sleep = () => new Promise((r) => setTimeout(r, delay));
    let disposed = false;
    let interrupted = false;

    q.push(sessionEvent("init", { providerSessionId: `fake-${newId()}`, model: opts.model ?? "fake", tools: ["Bash", "Read"], cwd: opts.cwd }));
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
        if (st.kind === "text") {
          const id = newId();
          for (const ch of st.text) q.push(sessionEvent("assistant_delta", { messageId: id, delta: ch }));
          q.push(sessionEvent("assistant_text", { messageId: id, text: st.text }));
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
      q.push(sessionEvent("status", { status: "idle" }));
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
