import { useEffect, useState } from "react";
import type { SessionStatus } from "@realm/contracts";
import { summarize } from "./session-summary";
import type { Block } from "./transcript-model";

/** How long a settled session sits before the line appears. Five minutes is long enough that it
 *  never lands on someone who is mid-thought between two messages, and short enough that coming
 *  back from lunch finds it already there. */
export const IDLE_AFTER_MS = 5 * 60 * 1000;

/** Recomputed on this beat while a session is settled and short of the threshold. A minute, because
 *  the line it decides to draw is itself rounded to minutes — a faster tick would re-render the
 *  transcript for a number that has not changed. */
const TICK_MS = 30_000;

/** "12 minutes", "1 hour", "3 hours" — the granularity the sentence actually uses. */
export function idleFor(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} minutes`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? "an hour" : `${hours} hours`;
}

/**
 * What a settled session produced, in one line.
 *
 * Counts only. This is a summary of a transcript you can still scroll, sitting a few pixels below
 * the transcript itself, so anything longer would be re-reading the session at you — and it is
 * derived from the same pure fold the summary panel uses, so the two can never disagree.
 *
 * Null when the session did nothing worth counting. A line that said "no outputs" under every
 * conversational answer would be noise attached to the ordinary case.
 */
export function idleSummaryText(blocks: readonly Block[]): string | null {
  const { outputs, uploads, plans } = summarize(blocks);
  const files = outputs.filter((o) => o.kind === "file").length;
  const links = outputs.length - files;
  const parts = [
    files > 0 ? `${files} ${files === 1 ? "file" : "files"}` : null,
    links > 0 ? `${links} ${links === 1 ? "link" : "links"}` : null,
    plans.length > 0 ? `${plans.length} ${plans.length === 1 ? "plan" : "plans"}` : null,
    uploads.length > 0 ? `${uploads.length} attached` : null,
  ].filter(Boolean);
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * The quiet line at the end of a session nobody has touched in a while.
 *
 * It exists because a transcript you come back to gives you no way to see what it amounted to
 * without scrolling it — and the moment you are most likely to need that is the moment you have been
 * away. It draws nothing at all while a turn is live, and nothing on a session that produced nothing
 * to count.
 */
export function IdleSummary({ blocks, status, lastActivity }: {
  blocks: readonly Block[];
  status: SessionStatus;
  /** When the transcript last moved. Null for an empty session, which has nothing to summarise. */
  lastActivity: number | null;
}) {
  const settled = status !== "running" && status !== "waiting_permission";
  const [now, setNow] = useState(() => Date.now());
  const idle = lastActivity === null ? 0 : now - lastActivity;
  // Ticking only while it could still matter: a settled session short of the threshold. Once the
  // line is up its text is rounded to whole minutes and re-rendering the transcript to advance it is
  // work for a number nobody is watching.
  const waiting = settled && lastActivity !== null && idle < IDLE_AFTER_MS;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, [waiting]);

  if (!settled || lastActivity === null || idle < IDLE_AFTER_MS) return null;
  const what = idleSummaryText(blocks);
  if (!what) return null;
  return (
    <p className="msg-idle-summary" role="note">
      Idle for {idleFor(idle)} — this session produced {what}.
    </p>
  );
}
