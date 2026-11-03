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
 * `~/Realm/worktrees/01M6…/fix-tests` becomes `~/Realm/worktrees/…/fix-tests`. Long inner segments
 * go first, then inner segments from the left, until it fits in `max` characters.
 */
export function shortPath(path: string, max = 44): string {
  const parts = tildePath(path).split("/");
  if (parts.join("/").length <= max || parts.length <= 3) return parts.join("/");
  const head = parts[0] === "" ? 2 : 1; // "/var" keeps "var"; "~" is a segment of its own
  const last = parts.length - 1;
  const kept = parts.map((s, i) => (i >= head && i < last && s.length > LONG_SEGMENT ? "…" : s));
  const joined = () => kept.filter((s, i) => !(s === "…" && kept[i - 1] === "…")).join("/");
  for (let i = head; i < last && joined().length > max; i++) kept[i] = "…";
  return joined();
}
