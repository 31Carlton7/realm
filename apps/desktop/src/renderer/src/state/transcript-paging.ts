import type { SessionEvent, StoredSessionEvent } from "@realm/contracts";
import type { Earlier } from "../panes/session/transcript-model";

/**
 * How a transcript is read from its end.
 *
 * A session can be tens of thousands of events long — one here is 48,000, about 100 MB over the wire
 * — and the pane draws a few hundred blocks of it. So an open reads back from the end until it has at
 * least `TAIL_EVENTS` and has reached a prompt, and the reader's scrolling up reads further back the
 * same way, `EARLIER_EVENTS` at a time. Every stretch read starts on a prompt, so a turn — a call and
 * its result, a run and its line — is never split across two reads.
 */
export const TAIL_EVENTS = 300;
export const EARLIER_EVENTS = 1000;
export const PAGE_BACK = 1000;
/** What an open paints first: the last screenful or so, from a page small enough to come back in a
 *  frame or two. The rest of the tail, up to `TAIL_EVENTS`, is read in front of it straight after. */
export const FIRST_EVENTS = 60;
export const FIRST_PAGE = 150;
/** How far an open will read back to put the "new since you were here" rule where it belongs. A
 *  reader gone for longer than this starts at the end, with no rule. */
export const MARK_REACH = 5000;
/** What the prompter and the meter read off the log's last word on it, wherever that was said: the
 *  model and its options, the context meter, the written account, the suggested next move. Fetched
 *  on their own, a few events, so a tail that does not reach them still knows them. */
export const CARRIED_TYPES: SessionEvent["type"][] = ["init", "usage", "summary", "prompt_hint"];
export const CARRIED_LIMIT = 64;

export type ReadBefore = (beforeSeq: number, limit: number) => Promise<StoredSessionEvent[]>;

/**
 * Events before `beforeSeq`, read a page at a time back from there, until there are at least `want`
 * of them and the first is a prompt — or until the log's start (`earlier` null). With `reach`, the
 * first must also be at or before that seq, for as long as `MARK_REACH` allows. `firstPage` sizes the
 * first read only; any read after it is a `PAGE_BACK`.
 */
export async function readBack(read: ReadBefore, beforeSeq: number, want: number, reach: number | null = null, firstPage = PAGE_BACK): Promise<{ events: StoredSessionEvent[]; earlier: Earlier | null }> {
  let events: StoredSessionEvent[] = [];
  let before = beforeSeq;
  for (let size = firstPage; ; size = PAGE_BACK) {
    const page = await read(before, size);
    events = [...page, ...events];
    if (page.length < size) return { events, earlier: null };
    before = page[0]!.seq;
    const reached = (seq: number) => reach === null || seq <= reach || events.length >= MARK_REACH;
    for (let i = events.length - want; i >= 0; i--) {
      const e = events[i]!;
      if (e.event.type === "user_message" && reached(e.seq)) return { events: events.slice(i), earlier: { from: e.seq, settledAt: settledBefore(events, i) } };
    }
  }
}

/** When the turn before `events[at]` settled, if the events read reach back to it: the last status
 *  that settles a run, which is the time the reducer gives that turn's run line. */
function settledBefore(events: readonly StoredSessionEvent[], at: number): number | null {
  for (let i = at - 1; i >= 0; i--) {
    const e = events[i]!.event;
    if (e.type === "status" && e.payload.status !== "running" && e.payload.status !== "waiting_permission") return e.ts;
  }
  return null;
}
