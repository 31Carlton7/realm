import type { SessionStatus } from "@realm/contracts";
import { summarize } from "./session-summary";
import type { Block } from "./transcript-model";

/**
 * What a session produced, in one line, at the end of its transcript.
 *
 * Counts only. This sits a few pixels below a transcript you can still scroll, so anything longer
 * would be re-reading the session at you — and it is derived from the same pure fold the summary
 * panel uses, so the two can never disagree.
 *
 * Null when the session did nothing worth counting. A line reading "no outputs" under every
 * conversational answer would be noise attached to the ordinary case, and that gate is the reason
 * this can be shown by default at all.
 */
export function summaryLine(blocks: readonly Block[]): string | null {
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
 * The quiet closing line of a session.
 *
 * It exists because a transcript gives you no way to see what it amounted to without scrolling it.
 * It used to wait five minutes for the session to go idle, and read "Idle for 12 minutes — this
 * session produced …": a summary you could only get by leaving and coming back, on a transcript
 * whose whole value is that it is still open in front of you. The wait is gone. What remains gated
 * is what always was:
 *
 *   - **Settled only.** Mid-turn the counts are still moving, and a total that climbs while you read
 *     it is not a summary of anything. It appears the moment the turn ends.
 *   - **Something to count.** See `summaryLine`.
 *
 * The elapsed time went with the threshold rather than being kept as decoration: it was there to
 * justify the wait ("you have been away this long, here is what you missed"), and a line that is
 * simply always present has nothing to explain.
 */
export function TranscriptSummary({ blocks, status }: {
  blocks: readonly Block[];
  status: SessionStatus;
}) {
  if (status === "running" || status === "waiting_permission") return null;
  const what = summaryLine(blocks);
  if (!what) return null;
  return (
    <p className="msg-transcript-summary" role="note">
      This session produced {what}.
    </p>
  );
}
