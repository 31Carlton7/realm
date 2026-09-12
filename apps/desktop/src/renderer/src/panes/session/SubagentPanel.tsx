import { Icon } from "@realm/ui";
import { useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import type { SessionStatus } from "@realm/contracts";
import { ScrollFades } from "../../components/ScrollFades";
import { useApp } from "../../state/store";
import { DOCK_PIN_MIN_PANE, useDockDismiss, useDockPinned, usePaneRect } from "./pane-dock";
import { labelOf, stillWorking } from "./DelegatedRuns";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";
import { findToolNode, flattenRun, formatDuration, summarizeToolRun, withEnter, type ToolNode } from "./tool-group";
import type { Block } from "./transcript-model";
import { useElapsed } from "./use-elapsed";

/**
 * One harness sub-agent, watched while it works — on the panel that docks to the session pane's
 * right-hand strip, the same one the summary uses.
 *
 * Docked rather than split into the pane, and the reason is what this is for: you open it to glance
 * at what an agent is doing and then go back to reading the transcript. A split takes width from
 * the transcript for as long as it is open and has to be sized; a docked panel gets out of the way
 * on Escape, and where the pane is wide enough it pins beside the transcript instead of over it. It
 * shares `sessionDock` with the summary because it shares the strip — two panels holding their own
 * open state is how one comes to be drawn over the other.
 *
 * A `Task`/`Agent`/`Workflow` sub-agent has no session, no row and no pane — it lives and dies inside
 * the CLI process. What it DOES leave is real and complete: every call it makes arrives in the
 * parent's transcript carrying its launching call's id (`parentToolUseId`), which is what
 * `findToolNode` hangs them off. Those calls, in order, with their results, are the whole of a
 * sub-agent's visible working life. This is that, and nothing invented around it.
 *
 * It draws the transcript's own `ToolCard`, unchanged, because a sub-agent's calls ARE tool calls and
 * a second renderer for them would be a fork of the one that already reads well. What the panel adds
 * is the frame the transcript cannot give them: the brief it was handed, a clock, and its report.
 */
export function SubagentPanel({ sessionId, toolUseId, anchorRef, onClose }: {
  sessionId: string;
  toolUseId: string;
  /** Something inside the pane this panel docks to — the pane's own node will do. */
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const blocks = useApp((s) => s.transcripts[sessionId]?.t.blocks ?? NO_BLOCKS);
  const sessionStatus = useApp((s) => s.sessionStatus[sessionId] ?? "idle");
  const node = useMemo(() => findToolNode(blocks, toolUseId), [blocks, toolUseId]);
  const ref = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const rect = usePaneRect(anchorRef);
  const pinned = (rect?.width ?? 0) >= DOCK_PIN_MIN_PANE;
  useDockPinned(rect, pinned);
  /* `anchorRef` is the whole pane, so it cannot be in `keepOpenIn` — every click in the transcript
     would count as inside and nothing would ever dismiss it. The strip's row is what must not
     dismiss, and it does not need to be listed: it TOGGLES, so a click there closes the panel by its
     own route and re-opening on the same mousedown is not something either handler can do. */
  useDockDismiss({ pinned, onClose, keepOpenIn: [ref] });
  const label = node ? labelOf(node.block.input) : "Sub-agent";

  return createPortal(
    <div ref={ref} className="subagent-dock pane-dock" role="dialog" aria-label={`Sub-agent: ${label}`}
      data-pinned={pinned || undefined}
      style={{ position: "fixed", right: rect?.right ?? 0, top: rect?.top ?? 0,
        "--dock-pane-h": `${rect?.height ?? window.innerHeight}px` } as React.CSSProperties}>
      <header className="subagent-bar">
        <Icon name="bot" size={14} className="subagent-mark" />
        <span className="subagent-title" title={label}>{label}</span>
        {node && <Clock block={node.block} />}
        {/* The trash, not a ×. This panel is a VIEW opened at a moment and finished with: there is
            no object under it to keep and nothing of it in the space, so a close that promised to
            preserve something would be promising what it cannot deliver (design.md). The sub-agent
            itself is untouched — it goes on working, and its calls go on landing in the transcript. */}
        <button type="button" className="icon-btn" aria-label="Close this sub-agent view" title="Close"
          onClick={onClose}>
          <Icon name="trash" size={14} />
        </button>
      </header>
      {/* Bands only where something is genuinely under them — the panel is content-height, so a
          short agent's panel wears none at all. */}
      <div className="subagent-scroll-wrap">
        <ScrollFades scroller={scroller} />
        <div className="subagent-body" ref={scroller}>
          {node === null
            // The one honest failure: a call this transcript does not hold. It happens when the
            // panel outlives a compaction that dropped the launching call, and saying so beats an
            // empty panel.
            ? <p className="subagent-empty">This agent's call is no longer in the transcript.</p>
            : <Body block={node.block} nested={node.nested} sessionStatus={sessionStatus} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

const NO_BLOCKS: readonly Block[] = [];

/** How long it has been going, ticking while it is — and what it came to, once it is not. Stopped,
 *  the clock is the span it ran for rather than a number that keeps climbing after the agent left. */
function Clock({ block }: { block: Extract<Block, { kind: "tool" }> }) {
  const working = stillWorking(block);
  const live = useElapsed(block.ts, working);
  return (
    <span className="subagent-elapsed" data-working={working || undefined}>
      {working ? formatDuration(live) : "finished"}
    </span>
  );
}

/**
 * The brief, the working, and the report — in the order they happened.
 *
 * The brief is the prompt the parent wrote, which is the one thing that explains everything below it
 * and the one thing the dock's eighty-character label had to cut. It is prose the parent's own agent
 * composed, so it renders as prose.
 */
function Body({ block, nested, sessionStatus }: {
  block: Extract<Block, { kind: "tool" }>;
  /** The calls this agent made, hung off its launching call by `findToolNode`. */
  nested: readonly ToolNode[];
  sessionStatus: SessionStatus;
}) {
  const brief = typeof block.input.prompt === "string" ? block.input.prompt : "";
  // Nothing entering: these cards are being read, not streamed into view, and §6's rise is the
  // transcript's own entrance for blocks arriving at its bottom edge.
  const steps = useMemo(() => withEnter(nested, () => false), [nested]);
  const counts = useMemo(() => summarizeToolRun(flattenRun(nested)), [nested]);

  return (
    <>
      {brief && (
        <section className="subagent-brief">
          <h3 className="subagent-head">What it was asked</h3>
          <Markdown text={brief} className="subagent-prose" />
        </section>
      )}
      <section className="subagent-work">
        <h3 className="subagent-head">
          What it has done
          {/* The same arithmetic the collapsed ledger reports in the transcript, so a reader who
              opened this panel from a run group is not given a different count of the same work. */}
          {nested.length > 0 && <span className="subagent-count">{`${counts.tools} ${counts.tools === 1 ? "call" : "calls"}`}</span>}
        </h3>
        {nested.length === 0
          /* Not an error, and not an empty list either. A sub-agent that has not called anything yet
             is thinking, and a background one may run for a minute before its first call lands. */
          ? <p className="subagent-empty">{stillWorking(block) ? "Nothing yet — it is still working out what to do." : "It finished without calling any tools."}</p>
          : <div className="subagent-steps">
              {steps.map((s) => <ToolCard key={s.key} block={s.block} sessionStatus={sessionStatus} nested={s.nested} />)}
            </div>}
      </section>
      {/* The report, which is the whole point of having delegated: what the parent is handed back.
          Drawn only once it exists — a heading over nothing would claim a result that has not come. */}
      {block.result && (
        <section className="subagent-report" data-error={block.result.isError || undefined}>
          <h3 className="subagent-head">{block.result.isError ? "It failed" : "What it reported"}</h3>
          <Markdown text={block.result.content} className="subagent-prose" />
        </section>
      )}
    </>
  );
}
