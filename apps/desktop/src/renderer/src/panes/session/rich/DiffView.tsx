import { useState } from "react";
import { hunkEmphasis, type DiffHunk, type DiffLine, type FileDiff, type Span } from "./diff";

/** Lines drawn before a file folds behind "Show all". A whole-file `Write` is routinely thousands of
 *  lines, and pouring those into the transcript wedges the scroller for every message after it. */
const LINE_CLAMP = 300;

/** One line's text, with the span that actually changed tinted (see `pairEmphasis`). Split by
 *  character offset rather than by word: the offsets come from a real prefix/suffix comparison, and
 *  re-tokenising into words would move the boundary off the change. */
function LineText({ text, span }: { text: string; span: Span | undefined }) {
  // A blank line still occupies a row. An empty <span> has no line box, so it collapses and the
  // diff's rows stop lining up with its gutters — hence the explicit non-breaking space.
  if (text === "") return <span className="fd-text">{"\u00a0"}</span>;
  if (!span) return <span className="fd-text">{text}</span>;
  return (
    <span className="fd-text">
      {text.slice(0, span.start)}
      <mark className="fd-mark">{text.slice(span.start, span.end)}</mark>
      {text.slice(span.end)}
    </span>
  );
}

const SIGN: Record<DiffLine["kind"], string> = { add: "+", del: "−", ctx: " " };

/** A path with its basename protected: the directory truncates, the file name never does — the same
 *  split the diff PANE makes, and the reason neither uses `direction: rtl` to truncate from the
 *  left. That trick reorders the neutral characters at both ends, so `/repo/a.ts` renders as
 *  `repo/a.ts/` — an absolute path drawn as a relative one. */
export function PathLabel({ path, className }: { path: string; className: string }) {
  const cut = path.lastIndexOf("/");
  return (
    <span className={className} title={path}>
      {cut >= 0 && <span className="path-dir">{path.slice(0, cut + 1)}</span>}
      <span className="path-base">{path.slice(cut + 1)}</span>
    </span>
  );
}

function Hunk({ hunk, numbered }: { hunk: DiffHunk; numbered: boolean }) {
  const spans = hunkEmphasis(hunk.lines);
  return (
    <>
      {hunk.skipped > 0 && (
        <div className="fd-skip" role="separator">
          <span>{hunk.skipped === 1 ? "1 unchanged line" : `${hunk.skipped} unchanged lines`}</span>
        </div>
      )}
      {hunk.lines.map((l, i) => (
        <div className="fd-line" data-kind={l.kind} key={i}>
          {/* Both gutters are always rendered, empty where the line does not exist on that side —
              a diff whose columns shift width between hunks is unreadable. When the source did not
              know the file's numbering at all (a fragment Edit) the gutters carry nothing but keep
              their width, so the change still sits on the same rail as every other card. */}
          <span className="fd-no" aria-hidden="true">{numbered && l.oldNo !== null ? l.oldNo : ""}</span>
          <span className="fd-no" aria-hidden="true">{numbered && l.newNo !== null ? l.newNo : ""}</span>
          <span className="fd-sign" aria-hidden="true">{SIGN[l.kind]}</span>
          <LineText text={l.text} span={spans.get(i)} />
        </div>
      ))}
    </>
  );
}

/** A proportional +/− bar, five cells wide. The eye reads "mostly additions" off this before it has
 *  read either number — and unlike the numbers it stays legible at a glance in a long run of cards. */
export function statCells(add: number, del: number): ("add" | "del")[] {
  const total = add + del;
  if (total === 0) return [];
  // A change with any additions at all keeps at least one green cell, and one that also deletes
  // keeps at least one red — a 1-line deletion inside a 400-line addition rounds to zero cells, and
  // an all-green bar over "+400 −1" says the wrong thing.
  const green = add === 0 ? 0 : del === 0 ? 5 : Math.min(4, Math.max(1, Math.round((add / total) * 5)));
  return Array.from({ length: 5 }, (_, i) => (i < green ? "add" : "del"));
}

function StatBar({ add, del }: { add: number; del: number }) {
  const cells = statCells(add, del);
  if (cells.length === 0) return null;
  return <span className="fd-bar" aria-hidden="true">{cells.map((c, i) => <i key={i} data-fill={c} />)}</span>;
}

/** One file's changes (AICSS "File Diff"): a header naming the path and what it cost, then the
 *  hunks. Deliberately NOT syntax-highlighted — a diff already has a colour language, add and
 *  delete, and layering a second one over it makes both harder to read. What is coloured instead is
 *  the span inside a line that actually changed, which is the thing the reader came for. */
export function FileDiffView({ file }: { file: FileDiff }) {
  const [showAll, setShowAll] = useState(false);
  const total = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  const clamped = total > LINE_CLAMP && !showAll;
  let budget = clamped ? LINE_CLAMP : Infinity;
  const hunks: DiffHunk[] = [];
  for (const h of file.hunks) {
    if (budget <= 0) break;
    hunks.push(h.lines.length <= budget ? h : { ...h, lines: h.lines.slice(0, budget) });
    budget -= h.lines.length;
  }
  return (
    <div className="fd-file">
      <div className="fd-head">
        <PathLabel className="fd-path" path={file.path || "(unnamed file)"} />
        {(file.add > 0 || file.del > 0) && (
          <span className="fd-stat">
            {file.add > 0 && <span className="fd-add">+{file.add}</span>}
            {file.del > 0 && <span className="fd-del">−{file.del}</span>}
            <StatBar add={file.add} del={file.del} />
          </span>
        )}
      </div>
      {file.note && <div className="fd-note">{file.note}</div>}
      {hunks.length > 0 && (
        <div className="fd-body" data-numbered={file.numbered || undefined}>
          {hunks.map((h, i) => <Hunk key={i} hunk={h} numbered={file.numbered} />)}
        </div>
      )}
      {clamped && (
        <button className="tool-expand" onClick={() => setShowAll(true)}>
          Show all {total} lines
        </button>
      )}
    </div>
  );
}

export function DiffView({ files }: { files: FileDiff[] }) {
  return <div className="fd-view">{files.map((f, i) => <FileDiffView key={`${f.path}:${i}`} file={f} />)}</div>;
}
