import { basenameOf, type MovePlace } from "@realm/contracts";
import { tildePath } from "../documents/home-model";

/** One end of a move as the sheet's header names it: the folder, and its branch when it has one. */
export const placeName = (p: Pick<MovePlace, "cwd" | "branch">): string =>
  p.branch ? `${basenameOf(p.cwd)} (${p.branch})` : basenameOf(p.cwd);

/** The moved line. Paths stay in its tooltip; the line names each end by folder and branch. */
export function movedSentence(b: { from: MovePlace; to: MovePlace; conversation: "native" | "notes" }): string {
  const how = b.conversation === "native" ? "The conversation continued." : "The conversation continued from notes.";
  return `Moved from ${placeName(b.from)} to ${placeName(b.to)}. ${how}`;
}

/** A segment this long is an id or a temp name, which says nothing a reader can use. */
const LONG_SEGMENT = 20;

/**
 * A path `~`-shortened and cut in the middle, so its first folder and its tail stay readable:
 * `~/Realm/worktrees/01M6…/fix-tests` becomes `~/Realm/worktrees/…/fix-tests`. The tail is read back
 * from the last folder until `max` characters; an id just above the last folder is cut to "…", and
 * any other long segment ends the tail, since nothing before it would read better.
 */
export function shortPath(path: string, max = 44): string {
  const whole = tildePath(path);
  const parts = whole.split("/");
  if (whole.length <= max || parts.length <= 3) return whole;
  const head = parts[0] === "" ? 2 : 1; // "/var" keeps "var"; "~" is a segment of its own
  const last = parts.length - 1;
  const tail = [parts[last]];
  let i = last - 1;
  for (; i >= head; i--) {
    const long = parts[i].length > LONG_SEGMENT;
    if (long && i !== last - 1) break;
    const seg = long ? "…" : parts[i];
    if ([...parts.slice(0, head), "…", seg, ...tail].join("/").length > max) break;
    tail.unshift(seg);
  }
  return [...parts.slice(0, head), ...(i >= head ? ["…"] : []), ...tail].join("/");
}
