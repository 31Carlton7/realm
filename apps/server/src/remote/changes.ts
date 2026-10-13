import type { FileDiff, TurnFile } from "@realm/contracts";
import type { MobileResult } from "@realm/remote";

/**
 * A turn's changes for a phone (`session.changes`, `session.diff`): the files, then one file's patch
 * as unified diff lines, a page at a time.
 *
 * The patch is the desktop's own (`checkpoints.turnDiff`), already capped by the Mac at 512 KB and
 * 4,000 lines. A page is capped again here, by lines and by the bytes its lines take as JSON, so no
 * answer comes near the relay's 1 MiB frame however the file is shaped: a minified line is cut, and a
 * file of control characters (six bytes each, escaped) fills a page at a sixth of the lines.
 */

/** Lines one page carries at most. */
export const DIFF_PAGE_LINES = 2_000;
/** What one page's lines may take, written as JSON. */
export const DIFF_PAGE_BYTES = 256 * 1024;
/** A longer line is cut here, and says so. */
export const DIFF_LINE_CHARS = 4_000;

export type DiffPage = MobileResult<"session.diff">;

const cutLine = (line: string): string => (line.length <= DIFF_LINE_CHARS ? line : `${line.slice(0, DIFF_LINE_CHARS)}… (cut at ${DIFF_LINE_CHARS} characters)`);

/** The patch as a unified diff: the two file headers, then each hunk's header and its lines. */
export function unifiedLines(file: TurnFile, diff: FileDiff): string[] {
  if (diff.binary) return [];
  const before = file.status === "added" ? "/dev/null" : `a/${file.oldPath ?? file.path}`;
  const after = file.status === "deleted" ? "/dev/null" : `b/${file.path}`;
  const out = [`--- ${before}`, `+++ ${after}`];
  for (const h of diff.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.header ? ` ${h.header}` : ""}`);
    for (const l of h.lines) out.push(l.kind === "add" ? `+${l.text}` : l.kind === "del" ? `-${l.text}` : l.kind === "context" ? ` ${l.text}` : `\\ ${l.text}`);
  }
  return out;
}

/** The page of `lines` that starts at `from`: as many lines as fit both caps, and at least one. */
export function diffPage(file: TurnFile, diff: FileDiff, from: number): DiffPage {
  const all = unifiedLines(file, diff);
  const start = Math.min(from, all.length);
  const lines: string[] = [];
  let bytes = 0;
  for (let i = start; i < all.length && lines.length < DIFF_PAGE_LINES; i++) {
    const line = cutLine(all[i]!);
    const cost = Buffer.byteLength(JSON.stringify(line)) + 1;
    if (lines.length > 0 && bytes + cost > DIFF_PAGE_BYTES) break;
    lines.push(line);
    bytes += cost;
  }
  const end = start + lines.length;
  return {
    path: file.path, oldPath: file.oldPath, status: file.status, binary: diff.binary, additions: diff.additions, deletions: diff.deletions,
    lines, from: start, next: end < all.length ? end : null, total: all.length, truncated: diff.truncated, truncatedReason: diff.truncatedReason,
  };
}
