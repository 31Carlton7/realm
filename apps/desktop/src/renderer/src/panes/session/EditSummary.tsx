import { Icon } from "@realm/ui";
import { useState } from "react";
import { editTotals, type EditedFile, type TurnEdits, type UndoOffer } from "./turn-edits";

/** Rows before "Show all": a turn that touched forty files is still one card a reader can scan. */
const SHOWN = 8;

const plural = (n: number) => (n === 1 ? "1 file" : `${n} files`);

/** `+17 −2`, green and red with the sign beside each, a zero side dropped — "−0" on a pure addition
 *  is a count of nothing that reads as a deletion until the eye gets to the digit. */
function Counts({ additions, deletions }: { additions: number | null; deletions: number | null }) {
  if (additions === null || deletions === null || (additions === 0 && deletions === 0)) return null;
  return (
    <span className="edit-counts">
      {additions > 0 && <span className="edit-add">+{additions}</span>}
      {deletions > 0 && <span className="edit-del">−{deletions}</span>}
    </span>
  );
}

/** Why a row has no numbers, for its tooltip — said rather than guessed at. Git counts every text
 *  file, so a measured file without numbers is binary; a tool call counts only what it states. */
function unknownWhy(f: EditedFile, source: TurnEdits["source"]): string | null {
  if (f.additions !== null && f.deletions !== null) return null;
  return source === "git" ? "No line counts for a binary file."
    : "No line counts: the agent wrote this file whole, and there was no checkpoint to compare it with.";
}

/** One file: the directory dimmed and the name bright, the way the diff pane names them, and its own
 *  counts at the far end. A deleted file has nothing left to open, so it is a row and not a button. */
function FileRow({ file, source, onOpen }: { file: EditedFile; source: TurnEdits["source"]; onOpen: (path: string) => void }) {
  const cut = file.shown.lastIndexOf("/");
  const body = (
    <>
      <span className="edit-file-path">
        {cut >= 0 && <span className="edit-file-dir">{file.shown.slice(0, cut + 1)}</span>}
        <span className="edit-file-name">{file.shown.slice(cut + 1)}</span>
      </span>
      {file.status === "renamed" && file.oldShown && <span className="edit-file-note">from {file.oldShown}</span>}
      {file.status === "deleted" && <span className="edit-file-note">Deleted</span>}
      <Counts additions={file.additions} deletions={file.deletions} />
    </>
  );
  const why = unknownWhy(file, source);
  return (
    <li>
      {file.status === "deleted"
        ? <div className="edit-file" data-deleted="">{body}</div>
        : <button type="button" className="edit-file" title={why ?? `Open ${file.shown}`} onClick={() => onOpen(file.path)}>{body}</button>}
    </li>
  );
}

/**
 * What a turn did to the checkout, at its end: Codex's "Edited 2 files +20 −3" card — a row per file,
 * Review for the turn's own diff, and Undo where a checkpoint really covers the turn.
 *
 * Undo is offered only when restoring the turn's checkpoint would put back exactly this turn's work
 * (`undoOffer`); it opens the checkpoint restore's own confirmation, which says what it will rewrite
 * and makes the state it replaces an undo point of its own. Where no checkpoint covers the turn the
 * card says so in place of the button, because a card that just lacked one would read as an Undo
 * someone forgot.
 */
export function EditSummary({ edits, undo, onOpen, onReview, onUndo, enter = false }: {
  edits: TurnEdits;
  undo: UndoOffer;
  /** §6's entrance, decided by the transcript's tracker: the card lands a beat after its run line,
   *  and a card the reader scrolled back to must not replay its arrival. */
  enter?: boolean;
  onOpen: (path: string) => void;
  /** The turn's own diff in the diff pane. Absent where only tool calls describe the turn — there is
   *  no measured "after" to diff against, and the working tree is a different question. */
  onReview?: () => void;
  onUndo: (checkpointId: string) => void;
}) {
  const [all, setAll] = useState(false);
  const totals = editTotals(edits.files);
  const rows = all ? edits.files : edits.files.slice(0, SHOWN);
  const unlisted = edits.totalFiles - edits.files.length;
  return (
    <section className="edit-summary" aria-label={`Edited ${plural(edits.totalFiles)}`} data-source={edits.source} data-enter={enter || undefined}>
      <div className="edit-summary-head">
        <span className="edit-summary-title">Edited {plural(edits.totalFiles)}</span>
        {totals && <Counts additions={totals.additions} deletions={totals.deletions} />}
        <span className="edit-summary-actions">
          {undo.kind === "undo" && (
            <button type="button" className="btn-quiet edit-summary-undo" title="Put these files back the way they were before this turn"
              onClick={() => onUndo(undo.checkpointId)}>
              Undo<Icon name="undo" size={12} />
            </button>
          )}
          {undo.kind === "none" && <span className="edit-summary-quiet" title={undo.why}>No checkpoint</span>}
          {onReview && <button type="button" className="btn" onClick={onReview}>Review</button>}
        </span>
      </div>
      <ul className="edit-summary-files">
        {rows.map((f) => <FileRow key={f.path} file={f} source={edits.source} onOpen={onOpen} />)}
      </ul>
      {(edits.files.length > SHOWN && !all) && (
        <button type="button" className="btn-quiet edit-summary-more" onClick={() => setAll(true)}>
          Show {edits.files.length - SHOWN} more
        </button>
      )}
      {unlisted > 0 && <p className="edit-summary-quiet">And {plural(unlisted)} more than Realm lists in one turn.</p>}
    </section>
  );
}
