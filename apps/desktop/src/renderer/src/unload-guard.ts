import { reviewDraftHeld } from "./panes/code-review/held";
import { unsavedTyping } from "./panes/documents/kept-typing";

/**
 * Whether this window's page may be unloaded for having gone unlooked-at (main's window-idle.ts).
 * Unloading ends the renderer, and with it everything held only here: a prompt typed and not sent and
 * the files picked for it, a commit message not committed, a code review being written, typing a
 * documents pane has not got onto disk (in conflict with an agent's write, or on a file deleted under
 * it), and whatever a sheet or a dialog is in the middle of asking. While any of these is there the
 * page answers "unsaved" and stays; the next sweep asks again.
 */
export type UnsavedState = {
  drafts: Record<string, string>;
  pendingAttachments: Record<string, readonly unknown[]>;
  commitMessages: Record<string, string>;
};

export function unloadRefusal(state: UnsavedState, doc: Document): "unsaved" | null {
  const typed = (texts: Record<string, string>) => Object.values(texts).some((t) => t.trim() !== "");
  if (typed(state.drafts) || typed(state.commitMessages)) return "unsaved";
  if (Object.values(state.pendingAttachments).some((files) => files.length > 0)) return "unsaved";
  if (reviewDraftHeld() || unsavedTyping()) return "unsaved";
  if (doc.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]')) return "unsaved";
  return null;
}
