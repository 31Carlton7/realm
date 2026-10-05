import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { newId, sessionEvent, type AgentKind, type AgentModel, type SessionEvent, type SessionEventPayload } from "@realm/contracts";
import { AsyncQueue } from "../event-queue";
import type { AgentAdapter, AgentHandle, PermissionDecision, ProbeResult, StartOptions, UserMessage } from "../types";
import { gatewayClient } from "./gateway-call";

export type FakeStep =
  /** `paceMs` streams the text a word at a time, this far apart — the way a real agent's deltas
   *  arrive. Without it the whole message lands in one burst, which is all a test needs and too
   *  fast for anything that animates arrival (the prose's fade) to be seen doing it. */
  | { kind: "text"; text: string; paceMs?: number }
  /** `apply` makes a `Write` or an `Edit` really happen, in the session's working directory: what lets
   *  a scripted turn leave a checkout that checkpoints, diffs and the turn's edit summary can measure.
   *  A failed edit (the text to replace is not there) settles the call as an error, as a real one would. */
  | { kind: "tool"; name: string; input: Record<string, unknown>; needsPermission?: boolean; result: string; apply?: boolean }
  /** A plan, in either shape the `plan` event carries. Re-using a `planId` revises that plan in
   *  place, which is what the real agents do and the one plan behaviour a script must be able to
   *  reproduce. */
  | { kind: "plan"; planId: string; text?: string; steps?: { text: string; status: "pending" | "in_progress" | "completed" }[] }
  | { kind: "throw"; message: string }
  /** One of Realm's own tools, called for REAL through the gateway this session was handed — the way
   *  an agent's CLI calls it — and recorded as the call and its result. `tool` is the gateway's name
   *  for it (`realm-agent__agent_start`); the transcript shows it under Claude's prefix. The one step
   *  that reaches past the script: what answers it is the production path. */
  | { kind: "call"; tool: string; input: Record<string, unknown> }
  /** A plan-quota reading, as `SDKRateLimitEvent` produces one on the real Claude wire. The scripted
   *  adapter is the only kind that can drive the limits path end to end in a test. */
  | { kind: "rateLimit"; payload: SessionEventPayload<"rate_limit"> };
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

    const resumeOutcome = opts.resume ? this.cfg.resume : undefined;
    // Made on first use, and once: the gateway keeps one MCP session per Realm session.
    const entry = opts.mcpServers.find((m) => m.transport === "http" || m.transport === "sse");
    const gateway = entry && entry.transport !== "stdio" ? gatewayClient({ url: entry.url, headers: entry.headers }) : null;
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
        if (st.kind === "call") {
          const toolUseId = newId();
          q.push(sessionEvent("tool_call", { toolUseId, name: `mcp__realm__${st.tool}`, input: st.input, parentToolUseId: null }));
          const answer = gateway
            ? await gateway.call(st.tool, st.input).catch((e: unknown) => ({ text: (e as Error).message ?? String(e), isError: true }))
            : { text: "no Realm gateway was handed to this session", isError: true };
          if (disposed) return;
          q.push(sessionEvent("tool_result", { toolUseId, content: answer.text, isError: answer.isError }));
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
          const failed = st.apply ? applyEdit(opts.cwd, st.name, st.input) : null;
          q.push(sessionEvent("tool_result", { toolUseId, content: failed ?? st.result, isError: failed !== null }));
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

/** Make a scripted `Write` or `Edit` real, under `cwd` and nowhere else. The error message, or null. */
function applyEdit(cwd: string, name: string, input: Record<string, unknown>): string | null {
  const named = typeof input["file_path"] === "string" ? input["file_path"] : "";
  const path = isAbsolute(named) ? named : join(cwd, named);
  const rel = relative(cwd, path);
  if (!named || rel.startsWith("..") || isAbsolute(rel)) return `${named || "(no path)"} is outside the working directory`;
  try {
    if (name === "Write" && typeof input["content"] === "string") {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, input["content"]);
      return null;
    }
    const before = input["old_string"], after = input["new_string"];
    if (name === "Edit" && typeof before === "string" && typeof after === "string") {
      const text = readFileSync(path, "utf8");
      if (!text.includes(before)) return `String to replace not found in ${named}`;
      writeFileSync(path, text.replace(before, after));
      return null;
    }
    return `${name} cannot be applied`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * The scripted adapter answering to a real agent's name — for a live check that has to show work
 * handed ACROSS harnesses, where a sub-agent on the real Codex would be a billed turn. It probes as
 * `kind`, reporting `models` as that harness's catalog (null: let the curated list stand, as Claude's
 * does), and every session it starts runs the fake's own script.
 */
export function fakeStandIn(fake: FakeAdapter, kind: AgentKind, models: AgentModel[] | null): AgentAdapter {
  return {
    kind,
    probe: async () => ({ kind, available: true, version: "fake", loggedIn: true, reason: null, models }),
    start: (opts) => fake.start(opts),
  };
}
