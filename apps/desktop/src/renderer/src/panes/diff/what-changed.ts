import { artifactTypeOf, documentKindFor, type DiffFileStatus } from "@realm/contracts";
import type { IconName } from "@realm/ui";

/**
 * What kind of thing a changed file is, in the words a person sorts their own files by. The Library's
 * types (`artifactTypeOf`), so a picture is an image here and on its tile alike, with video and sound
 * folded into one kind — a session rarely makes both, and two marks for "a recording" is a distinction
 * the pill has no room for. A source file the Library has no type for is still code when the Documents
 * pane opens it in its code editor (`.mjs`, `.vue`, a Dockerfile); anything else is just a file.
 */
export type ChangeKind = "document" | "image" | "media" | "data" | "code" | "other";

/** The order kinds are listed and stacked in: what a person made before what a program reads. */
export const CHANGE_KINDS: readonly ChangeKind[] = ["document", "image", "media", "data", "code", "other"];

export function changeKindOf(path: string): ChangeKind {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  const type = artifactTypeOf(name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "");
  if (type === "video" || type === "audio") return "media";
  if (type === "other" && documentKindFor(name) === "code") return "code";
  return type;
}

/** One glyph per kind from the house set. `note` and not the Library's page, because the page is also
 *  what "other" wears, and in a stack of three marks the two would read as one. */
export const KIND_ICON: Record<ChangeKind, IconName> = {
  document: "note", image: "image", media: "play", data: "table", code: "code", other: "artifact",
};

/** A group's head in the review. */
export const KIND_LABEL: Record<ChangeKind, string> = {
  document: "Documents", image: "Images", media: "Media", data: "Data", code: "Code", other: "Other files",
};

const NOUN: Record<ChangeKind, [one: string, many: string]> = {
  document: ["document", "documents"], image: ["image", "images"], media: ["media file", "media files"],
  data: ["data file", "data files"], code: ["code file", "code files"], other: ["file", "files"],
};

const counted = (n: number, kind: ChangeKind) => `${n} ${NOUN[kind][n === 1 ? 0 : 1]}`;

/** "a", "a and b", "a, b and c". */
const listed = (parts: readonly string[]) =>
  parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

type Change = { path: string; status: DiffFileStatus };

/** The kinds present, in `CHANGE_KINDS` order, with how many of each. */
export function kindCounts(changes: readonly Change[]): { kind: ChangeKind; count: number }[] {
  const by = new Map<ChangeKind, number>();
  for (const c of changes) { const k = changeKindOf(c.path); by.set(k, (by.get(k) ?? 0) + 1); }
  return CHANGE_KINDS.filter((k) => by.has(k)).map((kind) => ({ kind, count: by.get(kind)! }));
}

/** The verb, when every file had the same thing done to it; "Changed" otherwise. A file git has never
 *  seen is new to the person as surely as one that was staged as new. */
function verbOf(changes: readonly Change[]): string {
  const all = (...s: DiffFileStatus[]) => changes.length > 0 && changes.every((c) => s.includes(c.status));
  if (all("added", "untracked")) return "Added";
  if (all("deleted")) return "Deleted";
  if (all("renamed")) return "Renamed";
  return "Changed";
}

/**
 * "Changed 3 files", "Added 2 images", "Deleted 1 document": what happened, to how many, of what — the
 * words the pill wears and the review leads with. `total` is the true count when `changes` was cut
 * short; then neither the verb nor the noun can speak for the files nobody listed, and both go general.
 * Null when nothing changed, which is the pill's cue to draw nothing.
 */
export function changePhrase(changes: readonly Change[], total = changes.length): string | null {
  if (total === 0) return null;
  const whole = total === changes.length;
  const kinds = kindCounts(changes);
  const kind = whole && kinds.length === 1 ? kinds[0]!.kind : "other";
  return `${whole ? verbOf(changes) : "Changed"} ${counted(total, kind)}`;
}

/** "1 document, 1 image and 1 code file" — the breakdown a mixed phrase leaves to its tooltip. */
export function kindBreakdown(changes: readonly Change[], total = changes.length): string {
  const parts = kindCounts(changes).map(({ kind, count }) => counted(count, kind));
  const unlisted = total - changes.length;
  if (unlisted > 0) parts.push(`${unlisted} more`);
  return listed(parts);
}

/** One line on what happened to one file. A rename names where it came from, because the old name is
 *  the one the person remembers it by. */
export function whatOf(status: DiffFileStatus, oldPath: string | null): string {
  switch (status) {
    case "added": case "untracked": return "New";
    case "deleted": return "Deleted";
    case "renamed": return oldPath ? `Renamed from ${oldPath}` : "Renamed";
    case "copied": return oldPath ? `Copied from ${oldPath}` : "Copied";
    case "conflicted": return "Conflict to resolve";
    default: return "Edited";
  }
}

/** Files grouped under their kind, in `CHANGE_KINDS` order, each group keeping the order it was given. */
export function groupByKind<T extends { path: string }>(files: readonly T[]): { kind: ChangeKind; files: T[] }[] {
  const by = new Map<ChangeKind, T[]>();
  for (const f of files) {
    const k = changeKindOf(f.path);
    const group = by.get(k);
    if (group) group.push(f); else by.set(k, [f]);
  }
  return CHANGE_KINDS.filter((k) => by.has(k)).map((kind) => ({ kind, files: by.get(kind)! }));
}
