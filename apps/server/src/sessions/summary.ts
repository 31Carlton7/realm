import { factLines, nothingToSummarize, sessionEvent, sessionFacts, type SessionEvent, type StoredSessionEvent } from "@realm/contracts";

/** What the model is shown of the conversation, oldest first. Tool calls are named, not dumped: a
 *  summary is about what happened, and a `Read` result is ten thousand characters of what was
 *  already true. */
export function transcriptForSummary(events: readonly StoredSessionEvent[]): string {
  const lines: string[] = [];
  for (const { event: e } of events) {
    if (e.type === "user_message" && !e.payload.from && e.payload.text.trim()) lines.push(`User: ${e.payload.text.trim()}`);
    else if (e.type === "assistant_text" && e.payload.text.trim()) lines.push(`Assistant: ${e.payload.text.trim()}`);
    else if (e.type === "tool_call") lines.push(`[tool: ${e.payload.name}]`);
    else if (e.type === "error") lines.push(`[error: ${e.payload.message}]`);
  }
  return lines.join("\n");
}

/** Event types that say nothing a summary would repeat: the meter, the session's own state, and the
 *  summaries themselves. */
const NOT_SUMMARY_WORTHY = new Set<SessionEvent["type"]>(["status", "usage", "summary", "feedback", "assistant_delta"]);

export type SummaryGenerator = (input: { asked: string; transcript: string; facts: string }) => Promise<string>;

export type SummaryServiceDeps = {
  /** Every persisted event for a session, ascending. */
  listEvents: (sessionId: string) => StoredSessionEvent[];
  /** The last summary this session produced, or null. Read to avoid paying for one twice. */
  lastSummary: (sessionId: string) => SessionEvent | null;
  /** Persist + broadcast, exactly as any other event on the rail. */
  publish: (sessionId: string, event: SessionEvent) => void;
  /** Omitted on any build that must not make a billed call — tests, live-check scripts. */
  generate?: SummaryGenerator;
  /** Whether the machine can actually run one. Checked BEFORE the call so a user with no Claude CLI
   *  installed pays nothing and sees the derived line, rather than a failed call per settled turn. */
  available?: () => boolean | Promise<boolean>;
  onError?: (message: string) => void;
};

/**
 * Writes the model's account of a session, once per settled turn.
 *
 * Gated four ways before it spends anything, because this fires on EVERY settle and a summary is a
 * nicety attached to the ordinary case:
 *
 *   1. **A generator is configured.** Tests and live checks pass none and get today's behaviour.
 *   2. **The machine can run one.** `available()` — no Claude CLI, no call. After the first refusal
 *      the whole service switches off for the process rather than retrying per turn.
 *   3. **Something happened.** A greeting and its answer are not worth a call; the derived line says
 *      as much as anything could.
 *   4. **Something happened SINCE the last summary.** A status flap, a reconnect or a second settle
 *      on an unchanged log all re-enter here, and `throughSeq` is what makes them free.
 *
 * Never awaited by a turn and never able to fail one: every path swallows, and the panes fall back
 * to the derived text whenever no summary exists.
 */
export class SessionSummaryService {
  /** Sessions with a call in flight. A slow model and a fast user can settle twice before the first
   *  answer lands, and two calls would race to write the same summary. */
  private inFlight = new Set<string>();
  /** Latched off once the machine says it cannot run one. */
  private disabled = false;

  constructor(private d: SummaryServiceDeps) {}

  /** Fire-and-forget. Returns a promise only so tests can await it; callers `void` this. */
  async onSettled(sessionId: string): Promise<void> {
    if (this.disabled || !this.d.generate || this.inFlight.has(sessionId)) return;
    const events = this.d.listEvents(sessionId);
    if (events.length === 0) return;
    // Anchored to the last event that could CHANGE what a summary says. A settle writes a `status`
    // row and a `usage` row of its own, so anchoring to the newest event of any kind would make
    // every re-settle on an unchanged transcript — a reconnect, a status flap, an interrupted turn
    // that produced nothing — look new and buy a call to say the same sentence again.
    const meaningful = events.filter((e) => !NOT_SUMMARY_WORTHY.has(e.event.type));
    if (meaningful.length === 0) return;
    const throughSeq = meaningful[meaningful.length - 1]!.seq;
    const last = this.d.lastSummary(sessionId);
    if (last?.type === "summary" && last.payload.throughSeq >= throughSeq) return;

    const facts = sessionFacts(events.map((e) => e.event));
    if (nothingToSummarize(facts)) return;

    if (this.d.available) {
      let ok = false;
      try { ok = await this.d.available(); } catch { ok = false; }
      if (!ok) { this.disabled = true; return; }
    }

    this.inFlight.add(sessionId);
    try {
      const text = await this.d.generate({
        asked: facts.asked,
        transcript: transcriptForSummary(events),
        facts: factLines(facts),
      });
      if (text.trim()) this.d.publish(sessionId, sessionEvent("summary", { text: text.trim(), throughSeq }));
    } catch (e) {
      // One line, once — not once per settled turn on a machine that will never answer.
      this.d.onError?.(`[summary] ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.inFlight.delete(sessionId);
    }
  }
}
