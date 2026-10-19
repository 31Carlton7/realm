import type { DiffSummary } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { KIND_ICON, changePhrase, kindBreakdown, kindCounts } from "../diff/what-changed";

/** Marks the stack draws before it stops: three still read as a stack beside 11px words, and the
 *  tooltip names every kind anyway. */
const STACKED = 3;

/** Whether the checkout has anything to say — the over-strip's cue to draw itself at all. */
export function hasChanges(changes: DiffSummary | null): changes is DiffSummary {
  return changes !== null && changes.totalFiles > 0;
}

/**
 * What the session's checkout has changed, in the words a person would use for their own files —
 * "Changed 3 files", "Added 2 images" — behind a small stack of the kinds involved, and the way into
 * the review of it. The branch and the line counts it used to lead with are inside that review: they
 * describe how git keeps the work, and the pill is about the work. Draws nothing when nothing changed,
 * on whatever branch, so a clean checkout costs the prompter no strip.
 */
export function WhatChanged({ changes, onOpen }: { changes: DiffSummary | null; onOpen: () => void }) {
  if (!hasChanges(changes)) return null;
  const phrase = changePhrase(changes.files, changes.totalFiles);
  const kinds = kindCounts(changes.files).slice(0, STACKED);
  return (
    <button type="button" className="ghost-chip what-changed" onClick={onOpen}
      title={`Review what changed: ${kindBreakdown(changes.files, changes.totalFiles)}`}>
      {kinds.length > 0 && (
        <span className="what-changed-kinds" aria-hidden="true">
          {kinds.map(({ kind }) => <span key={kind} className="what-changed-kind" data-kind={kind}><Icon name={KIND_ICON[kind]} size={12} /></span>)}
        </span>
      )}
      <span className="chip-label">{phrase}</span>
    </button>
  );
}
