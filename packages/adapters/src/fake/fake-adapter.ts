import { newId, sessionEvent, type SessionEvent } from "@realm/contracts";
import { AsyncQueue } from "../event-queue";
import type { AgentAdapter, AgentHandle, PermissionDecision, ProbeResult, StartOptions, UserMessage } from "../types";

export type FakeStep =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: Record<string, unknown>; needsPermission?: boolean; result: string };
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

    q.push(sessionEvent("init", { providerSessionId: `fake-${newId()}`, model: opts.model ?? "fake", tools: ["Bash", "Read"], cwd: opts.cwd }));
    q.push(sessionEvent("status", { status: "idle" }));

    const run = async (msg: UserMessage) => {
      q.push(sessionEvent("status", { status: "running" }));
      const step = this.cfg.script.find((s) => msg.text.includes(s.on));
      for (const st of step?.emit ?? [{ kind: "text", text: `echo: ${msg.text}` } as FakeStep]) {
        await sleep();
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
            q.push(sessionEvent("permission_response", { requestId, decision }));
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
      send: (m) => { chain = chain.then(() => run(m)); },
      respondPermission: (id, d) => { pending.get(id)?.(d); pending.delete(id); },
      interrupt: async () => { q.push(sessionEvent("status", { status: "idle" })); },
      setOptions: async () => {},
      dispose: async () => { q.push(sessionEvent("status", { status: "ended" })); q.close(); },
    };
  }
}
