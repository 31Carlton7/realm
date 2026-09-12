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
const NOT_SUMMARY_WORTHY = new Set<SessionEvent["type"]>([
  "status", "usage", "summary", "prompt_hint", "feedback", "assistant_delta", "rate_limit",
]);

/**
 * How long a session stays quiet before its recap is written.
 *
 * Chosen against two opposing costs rather than picked round: long enough that a back-and-forth —
 * settle, read, reply — buys one recap instead of one per turn, and short enough that the hint lands
 * while the reader is still on the transcript. Past about four seconds the swap starts happening
 * under a hand that is already reaching for ⇥, which is the one thing the hint must not do.
 */
export const RECAP_DEBOUNCE_MS = 2_500;

export type RecapGenerator = (input: { asked: string; transcript: string; facts: string })
  => Promise<{ summary: string; hint: string | null }>;

export type SummaryServiceDeps = {
  /** Every persisted event for a session, ascending. */
  listEvents: (sessionId: string) => StoredSessionEvent[];
  /** The last summary this session produced, or null. Read to avoid paying for one twice. */
  lastSummary: (sessionId: string) => SessionEvent | null;
  /** Persist + broadcast, exactly as any other event on the rail. */
  publish: (sessionId: string, event: SessionEvent) => void;
  /** Omitted on any build that must not make a billed call — tests, live-check scripts. */
  generate?: RecapGenerator;
  /** Whether the machine can actually run one. Checked BEFORE the call so a user with no Claude CLI
   *  installed pays nothing and sees the derived line, rather than a failed call per settled turn. */
  available?: () => boolean | Promise<boolean>;
  onError?: (message: string) => void;
  /**
   * How long a session must stay idle before its recap is written. 0 runs inline.
   *
   * The gate this closes: a recap fires on EVERY settle, so a rapid back-and-forth pays for one per
   * exchange — each superseded seconds later by the next, and none of them read. Waiting for the
   * session to actually go quiet spends once for the exchange instead of once per turn.
   *
   * The cost is that the model-written hint arrives LATE: the prompter shows the deterministic one
   * first and swaps when this lands. That is the same way the summary has always arrived, but the
   * hint is a target for ⇥ — so this wants to be short enough that the swap happens while the reader
   * is still on the transcript, not while their hand is on the key.
   */
  debounceMs?: number;
  /** Whether the session is idle RIGHT NOW, asked when the timer fires rather than when it is set: a
   *  new turn started during the wait means this settle's recap is about to be superseded anyway. */
  isIdle?: (sessionId: string) => boolean;
};

/**
 * Writes the model's account of a session AND the prompter's next-move hint, once per settled turn.
 *
 * One call for both, because the inputs are identical: a second `query()` on the same settle read the
 * same transcript again to answer a second short question. The coupling that buys is real and stated
 * here rather than discovered — a failed call now costs both fields, so a session falls back to the
 * derived summary line and the deterministic hint together.
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
  /** One pending write per session, re-armed by each settle. */
  private pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private d: SummaryServiceDeps) {}

  /** Drop every pending write. Called on shutdown: a timer holding the process open after close is
   *  the difference between a suite that exits and one that hangs. */
  close(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  /**
   * Fire-and-forget. Returns a promise only so tests can await it; callers `void` this.
   *
   * Re-arms rather than queues: a second settle inside the window replaces the first, so an exchange
   * of six turns buys one recap and not six. With no `debounceMs` this runs inline, which is what
   * every test and live check does.
   */
  async onSettled(sessionId: string): Promise<void> {
    const wait = this.d.debounceMs ?? 0;
    if (wait <= 0) return this.write(sessionId);
    const armed = this.pending.get(sessionId);
    if (armed) clearTimeout(armed);
    const timer = setTimeout(() => {
      this.pending.delete(sessionId);
      // A turn that started during the wait will settle on its own and re-arm this; writing now
      // would pay for a recap of a transcript that is still being added to.
      if (this.d.isIdle && !this.d.isIdle(sessionId)) return;
      void this.write(sessionId).catch(() => {});
    }, wait);
    // A recap is a nicety: it must never be the reason the process stays alive.
    timer.unref?.();
    this.pending.set(sessionId, timer);
  }

  private async write(sessionId: string): Promise<void> {
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
      const recap = await this.d.generate({
        asked: facts.asked,
        transcript: transcriptForSummary(events),
        facts: factLines(facts),
      });
      if (recap.summary.trim()) this.d.publish(sessionId, sessionEvent("summary", { text: recap.summary.trim(), throughSeq }));
      /* The prompter's hint rides the SAME answer — one call reads the transcript once and fills both
         fields. Two events rather than one, because they are consumed in different places and have
         different lifetimes: a summary stands until a newer one replaces it, and a hint is dropped
         the moment the user sends anything (see the transcript reducer). A declined hint is null and
         simply writes no event, which is what leaves the prompter on its deterministic ladder. */
      if (recap.hint?.trim()) this.d.publish(sessionId, sessionEvent("prompt_hint", { text: recap.hint.trim(), throughSeq }));
    } catch (e) {
      // One line, once — not once per settled turn on a machine that will never answer.
      this.d.onError?.(`[recap] ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.inFlight.delete(sessionId);
    }
  }
}
