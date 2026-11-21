import { mkdir } from "node:fs/promises";
import type { AdapterRegistry, AgentAdapter, ProbeResult } from "@realm/adapters";
import type { QuickChatModel } from "@realm/view";

/** The quick chat model's agent is not installed, or not signed in. */
export class SummaryUnavailable extends Error {}
export class SummaryCancelled extends Error {}

/** Ask the model for a meeting's summary. Rejects with `SummaryUnavailable`, `SummaryCancelled`, or
 *  the reason the call failed. */
export type Summarise = (prompt: string, signal: AbortSignal) => Promise<string>;

/** A summary reads up to a few hours of transcript; past this the engine has hung. */
const SUMMARY_TIMEOUT_MS = 5 * 60_000;

/**
 * One turn on one agent, and what it said.
 *
 * The agent is started here, on the adapter, and not as a Realm session: a session's messages are
 * rows in `realm.db`, and the prompt is a meeting's whole transcript. Nothing of this turn is stored
 * by Realm. What it reads is other people's speech, so it is started answer-only: on Claude that is
 * no tool at all and none of the person's own settings. Every engine gets none of Realm's tools, a
 * folder of its own to stand in, and a no to anything it asks permission for.
 */
export async function summaryTurn(turn: {
  adapter: AgentAdapter; model: string | null; cwd: string; prompt: string; signal: AbortSignal; timeoutMs?: number;
}): Promise<string> {
  if (turn.signal.aborted) throw new SummaryCancelled();
  const handle = turn.adapter.start({ cwd: turn.cwd, model: turn.model, permissionMode: "default", mcpServers: [], answerOnly: true, persistSession: false });
  let timedOut = false;
  const end = () => { void handle.dispose().catch(() => {}); };
  const timer = setTimeout(() => { timedOut = true; end(); }, turn.timeoutMs ?? SUMMARY_TIMEOUT_MS);
  turn.signal.addEventListener("abort", end, { once: true });
  const said: string[] = [];
  let problem: string | null = null;
  let running = false;
  try {
    await handle.send({ text: turn.prompt, attachments: [] });
    for await (const ev of handle.events) {
      if (ev.type === "assistant_text") said.push(ev.payload.text);
      else if (ev.type === "error") problem = ev.payload.message;
      else if (ev.type === "permission_request") handle.respondPermission(ev.payload.requestId, "deny");
      else if (ev.type === "status") {
        const { status } = ev.payload;
        if (status === "running") running = true;
        // The agent says idle once when it starts, before it has been sent anything.
        else if (status === "error" || status === "ended" || (status === "idle" && running)) break;
      }
    }
  } finally {
    clearTimeout(timer);
    turn.signal.removeEventListener("abort", end);
    await handle.dispose().catch(() => {});
  }
  if (turn.signal.aborted) throw new SummaryCancelled();
  if (timedOut) throw new Error("the model took too long to answer");
  if (problem !== null) throw new Error(problem);
  return said.join("\n\n");
}

/** The summary turn on whatever the Quick chat model setting names when the meeting ends. */
export function quickChatSummariser(d: {
  adapters: AdapterRegistry; model: () => QuickChatModel; probes: () => readonly ProbeResult[]; cwd: string; timeoutMs?: number;
}): Summarise {
  return async (prompt, signal) => {
    const { agentKind, model } = d.model();
    const adapter = d.adapters[agentKind];
    const probe = d.probes().find((p) => p.kind === agentKind);
    if (!adapter || (probe && (!probe.available || probe.loggedIn === false))) throw new SummaryUnavailable();
    await mkdir(d.cwd, { recursive: true });
    return summaryTurn({ adapter, model, cwd: d.cwd, prompt, signal, ...(d.timeoutMs ? { timeoutMs: d.timeoutMs } : {}) });
  };
}
