import { reviewDraftHeld } from "./panes/code-review/held";
import { unsavedTyping } from "./panes/documents/kept-typing";
import { memoryDocEdited } from "./components/settings/memory-doc-edits";

/**
 * Whether this window's page may be unloaded for having gone unlooked-at (main's window-idle.ts).
 * Unloading ends the renderer, and with it everything held only here: a prompt typed and not sent and
 * the files, tabs, chips and sessions picked for it (beside an empty box too), a commit message not
 * committed, a code review being written, a memory document typed into and not yet saved, typing a
 * documents pane has not got onto disk (in conflict with an agent's write, or on a file deleted under
 * it), and whatever a sheet or a dialog is in the middle of asking. While any of these is there the
 * page answers "unsaved" and stays; the next sweep asks again.
 */
export type UnsavedState = {
  drafts: Record<string, string>;
  pendingAttachments: Record<string, readonly unknown[]>;
  commitMessages: Record<string, string>;
  draftTabs: Record<string, readonly unknown[]>;
  draftElements: Record<string, readonly unknown[]>;
  draftLinks: Record<string, readonly unknown[]>;
  draftSessionRefs: Record<string, readonly unknown[]>;
  draftRefs: Record<string, readonly unknown[]>;
};

export function unloadRefusal(state: UnsavedState, doc: Document): "unsaved" | null {
  const typed = (texts: Record<string, string>) => Object.values(texts).some((t) => t.trim() !== "");
  if (typed(state.drafts) || typed(state.commitMessages)) return "unsaved";
  const picked = (lists: Record<string, readonly unknown[]>) => Object.values(lists).some((list) => list.length > 0);
  if ([state.pendingAttachments, state.draftTabs, state.draftElements, state.draftLinks, state.draftSessionRefs, state.draftRefs].some(picked)) return "unsaved";
  if (reviewDraftHeld() || unsavedTyping() || memoryDocEdited()) return "unsaved";
  if (doc.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]')) return "unsaved";
  return null;
}
