import { DOCUMENT_MAX_BYTES } from "@realm/contracts";
import type { Buffer } from "./buffers";

/**
 * What the reader typed that the documents pane has not got onto disk, kept across the unmount a
 * session or space switch causes — the pane is a tab of a session's side panel, and goes with it — for
 * the run, as the pane's view is (view-memory.ts).
 *
 * A buffer here is one the reader typed into: one in conflict with what an agent wrote, one whose file
 * was deleted under the typing, or one whose write as the pane went had not been seen to land. The first
 * two wait for the reader — Keep mine, Take theirs, or closing the tab — and nothing writes them on its
 * own; the pane comes back with them as they were, Needs attention and all, reconciled with whatever
 * disk did while no pane was there to hear it. A write that lands forgets its copy, so typing already on
 * disk never comes back as typing over an agent's later change.
 *
 * While the pane is up its own buffers are the truth, and this is what they were when it last went:
 * every unmount writes it again for every tab the pane holds (kept if typed into, forgotten if not), and
 * closing a tab forgets that file's. Not persisted, as the scroll and the view are not: a relaunch is a
 * new sitting, and a buffer laid back over a file changed by who knows what since would be a guess.
 */

/** Two copies of the largest file the pane opens: the reader's text and, in a conflict, theirs. */
export const KEPT_TYPING_MAX_CHARS = 2 * DOCUMENT_MAX_BYTES;

const kept = new Map<string, Map<string, Buffer>>();

/** Keep this buffer for the pane's return, or forget the file's copy when the buffer holds no typing —
 *  or more than may be kept. Says whether it is kept. */
export function keepTyping(documentsId: string, b: Buffer): boolean {
  const size = b.text.length + (b.conflict?.theirs.length ?? 0);
  if (!b.dirty || size > KEPT_TYPING_MAX_CHARS) { forgetKeptTyping(documentsId, b.path); return false; }
  let files = kept.get(documentsId);
  if (!files) { files = new Map(); kept.set(documentsId, files); }
  files.set(b.path, b);
  return true;
}

/** What one workspace's pane left, by path. A copy: the pane reads it across awaits. */
export function keptTyping(documentsId: string): Map<string, Buffer> {
  return new Map(kept.get(documentsId));
}

/** Forget a file's copy — its tab was closed — or, given `only`, forget it if that is still the copy
 *  kept: a write that lands must not forget typing kept again since it was sent. */
export function forgetKeptTyping(documentsId: string, path: string, only?: Buffer): void {
  const files = kept.get(documentsId);
  if (!files || (only !== undefined && files.get(path) !== only)) return;
  files.delete(path);
  if (files.size === 0) kept.delete(documentsId);
}

/** Test seam, as `forgetAllScroll` is: the copies are process-wide. */
export function forgetAllKeptTyping(): void {
  kept.clear();
}
