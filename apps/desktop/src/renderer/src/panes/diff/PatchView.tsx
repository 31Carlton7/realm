import type { FileDiff } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { Fragment, useMemo, type ReactNode } from "react";
import { rowKeys, splitRows, type SideCell } from "./split-rows";

const MARK: Record<string, string> = { add: "+", del: "−", meta: "\\", context: " " };

/**
 * One file's patch, unified — the diff pane's own view, and Code Review's when a split would be too
 * narrow to read. Renders nothing but lines: whoever draws it has already named the file and the
 * side, and a second header here would be noise.
 */
export function UnifiedPatch({ patch }: { patch: FileDiff | undefined }) {
  if (!patch) return <div className="diff-loading">Loading…</div>;
  if (patch.binary) return <div className="diff-note">Binary file — no preview.</div>;
  if (patch.hunks.length === 0) return <div className="diff-note">No textual changes.</div>;
  return (
    <div className="diff-hunks">
      {patch.hunks.map((h, i) => (
        <div className="diff-hunk" key={`${h.oldStart}-${h.newStart}-${i}`}>
          <div className="diff-hunk-head">@@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@{h.header ? ` ${h.header}` : ""}</div>
          {h.lines.map((l, j) => (
            <div className="diff-line" data-kind={l.kind} key={j}>
              <span className="diff-gutter">{l.oldLine ?? ""}</span>
              <span className="diff-gutter">{l.newLine ?? ""}</span>
              <span className="diff-mark">{MARK[l.kind]}</span>
              <span className="diff-text">{l.text}</span>
            </div>
          ))}
        </div>
      ))}
      {patch.truncated && <div className="diff-note">Cut short — {patch.truncatedReason}. Open the file to see the rest.</div>}
    </div>
  );
}

/** One side of a split row. An empty side is hatched: the other file has no line here. */
function Cell({ cell, side, onComment }: { cell: SideCell | null; side: "LEFT" | "RIGHT"; onComment?: (side: "LEFT" | "RIGHT", line: number) => void }) {
  if (!cell) return <div className="diff-split-cell" data-kind="empty" aria-hidden="true" />;
  return (
    <div className="diff-split-cell" data-kind={cell.kind} data-side={side} data-line={`${side}:${cell.line}`}>
      <span className="diff-gutter">{cell.line}</span>
      {onComment && (
        <button type="button" className="diff-line-comment" aria-label={`Comment on ${side === "LEFT" ? "old" : "new"} line ${cell.line}`}
          title="Comment on this line" onClick={() => onComment(side, cell.line)}>
          <Icon name="add" size={12} />
        </button>
      )}
      <span className="diff-mark">{MARK[cell.kind]}</span>
      <span className="diff-text">{cell.text}</span>
    </div>
  );
}

/**
 * One file's patch side by side: the base on the left, the head on the right, a changed line beside
 * what it became. What neither side changed is folded into a band that says how many lines it holds,
 * and opens from the head's text when there is some to open it with (`headLines`).
 *
 * Long lines wrap rather than scroll. Two sides scrolling apart is two places to look for one line,
 * and a wrapped line keeps its number at the start of the row it began on.
 *
 * `notes` are drawn under the line they belong to, on its side — a reviewer's finding, a comment
 * being written — keyed `RIGHT:14` (`rowLineKey`).
 */
export function SplitPatch({ patch, open, headLines = null, trailing = true, onOpenBand, notes, onComment }: {
  patch: FileDiff;
  open?: ReadonlySet<number>;
  headLines?: readonly string[] | null;
  trailing?: boolean;
  onOpenBand?: (index: number) => void;
  notes?: ReadonlyMap<string, ReactNode>;
  onComment?: (side: "LEFT" | "RIGHT", line: number) => void;
}) {
  const rows = useMemo(() => splitRows(patch.hunks, { open, headLines, trailing }), [patch.hunks, open, headLines, trailing]);
  return (
    <div className="diff-split">
      {rows.map((r) => {
        if (r.kind === "note") return <div key={r.key} className="diff-split-note">{r.text}</div>;
        if (r.kind === "band") {
          const what = r.count === null ? "Show the rest of the file" : r.count === 1 ? "1 unchanged line" : `${r.count} unchanged lines`;
          return (
            <button key={r.key} type="button" className="diff-band" disabled={!onOpenBand} onClick={() => onOpenBand?.(r.index)}
              title={onOpenBand ? "Show these lines" : undefined}>
              <Icon name={r.at === "end" ? "chevronDown" : r.at === "start" ? "chevronUp" : "unfold"} size={12} />
              <span>{what}</span>
            </button>
          );
        }
        const hung = notes ? rowKeys(r).flatMap((k) => (notes.has(k) ? [[k, notes.get(k)] as const] : [])) : [];
        return (
          <Fragment key={r.key}>
            <div className="diff-split-row">
              <Cell cell={r.left} side="LEFT" onComment={onComment} />
              <Cell cell={r.right} side="RIGHT" onComment={onComment} />
            </div>
            {hung.map(([k, node]) => <div key={`${r.key}:${k}`} className="diff-split-notes" data-side={k.split(":")[0]}>{node}</div>)}
          </Fragment>
        );
      })}
      {patch.truncated && <div className="diff-note">Cut short — {patch.truncatedReason}.</div>}
    </div>
  );
}
