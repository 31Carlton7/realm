import { Icon } from "@realm/ui";
import { useEffect, useRef, useState } from "react";
import type { SessionStatus } from "@realm/contracts";
import type { Block } from "./transcript-model";
import { clip, prettyJson, toolIcon, toolSummary } from "./tool-summary";
import { formatToolRun, summarizeToolRun, type ToolBlock } from "./tool-group";

type ToolState = "running" | "ok" | "error" | "none";

/** How long the copy button holds its ✓ before cross-fading back to the copy glyph (§6 icon swap). */
const COPIED_MS = 1400;

/** Giant tool results are clamped to this many chars behind a "Show all" expander (A-M2) — an agent
 *  cat-ing a bundle must not wedge the transcript. Copy always takes the full text. */
export const RESULT_CLAMP = 50 * 1024;

/** One labelled recessed well (Input / Result / Error) with a copy button (A-M3) and, past the clamp,
 *  a "Show all (N KB)" expander. `label` doubles as the copy button's accessible object ("Copy result"). */
function Well({ label, text, error = false }: { label: string; text: string; error?: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const clamped = text.length > RESULT_CLAMP && !showAll;
  const copy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };
  return (
    <div className="tool-section">
      <div className="tool-label">
        <span>{label}</span>
        {/* §6 icon swap: both glyphs stay in the DOM and cross-fade (opacity + scale + blur, 160ms);
            the label never changes, so the button keeps one accessible name throughout. */}
        <button className="tool-copy" aria-label={`Copy ${label.toLowerCase()}`} title="Copy"
          data-copied={copied || undefined} onClick={copy}>
          <Icon name="copy" size={12} className="copy-icon" />
          <Icon name="check" size={12} className="copied-icon" />
        </button>
      </div>
      <pre className="tool-well" data-error={error || undefined}>{clamped ? text.slice(0, RESULT_CLAMP) : text}</pre>
      {clamped && (
        <button className="tool-expand" onClick={() => setShowAll(true)}>
          Show all ({Math.ceil(text.length / 1024)} KB)
        </button>
      )}
    </div>
  );
}

/** A tool call the agent made: compact row, click to expand input + result. */
export function ToolCard({ block, sessionStatus, enter = false }: { block: ToolBlock; sessionStatus: SessionStatus; enter?: boolean }) {
  const [open, setOpen] = useState(false);
  const everOpened = useRef(false);
  everOpened.current ||= open;
  const live = sessionStatus === "running" || sessionStatus === "waiting_permission";
  const state: ToolState = block.result ? (block.result.isError ? "error" : "ok") : live ? "running" : "none";
  const summary = clip(toolSummary(block.name, block.input));
  return (
    <div className="tool-card" data-state={state} data-open={open || undefined} data-enter={enter || undefined}>
      <button className="tool-row" aria-expanded={open} aria-label={`${block.name} tool call`} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevronRight" size={12} className="tool-chevron" />
        <Icon name={toolIcon(block.name)} size={16} />
        <span className="tool-name">{block.name}</span>
        <span className="tool-summary" title={summary}>{summary}</span>
        <span className="tool-status" aria-label={state === "running" ? "running" : state === "ok" ? "done" : state === "error" ? "failed" : "no result"}>
          {state === "running" && <Icon name="spinner" size={14} className="spin" />}
          {state === "ok" && <Icon name="checkCircle" size={14} />}
          {state === "error" && <Icon name="errorCircle" size={14} />}
        </span>
      </button>
      {/* §6 expands the row by transitioning grid-template-rows 0fr→1fr, which only animates if the
          content is in the DOM on both sides of the flip. So the body is built on first open and
          stays built: collapsing animates too, and re-opening is instant. `inert` keeps the hidden
          copy buttons and expanders out of the tab order and the accessibility tree. */}
      <div className="tool-body-wrap">
        <div className="tool-body-clip" inert={!open || undefined}>
          {everOpened.current && (
            <div className="tool-body">
              <Well label="Input" text={prettyJson(block.input)} />
              {block.result && <Well label={block.result.isError ? "Error" : "Result"} text={block.result.content || "(empty)"} error={block.result.isError} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** §2.8/§5: a run of consecutive tool calls, folded behind one ledger line with a dashed connector.
 *  It opens itself while the agent is still working through the run — collapsing live activity out
 *  of sight is the one thing this treatment must not do — and a manual toggle then wins for good. */
export function ToolGroup({ steps, sessionStatus }: {
  steps: { key: string; block: ToolBlock; enter: boolean }[]; sessionStatus: SessionStatus;
}) {
  const [manual, setManual] = useState<boolean | null>(null);
  const live = sessionStatus === "running" || sessionStatus === "waiting_permission";
  const open = manual ?? (live && steps.some((s) => !s.block.result));
  const line = formatToolRun(summarizeToolRun(steps.map((s) => s.block)));
  return (
    <div className="tool-group" data-open={open || undefined}>
      <button className="tool-group-row" aria-expanded={open} aria-label={`${steps.length} tool calls`} onClick={() => setManual(!open)}>
        <Icon name="chevronRight" size={12} className="tool-chevron" />
        <span className="tool-group-summary">{line}</span>
      </button>
      {open && (
        <div className="tool-group-steps">
          {steps.map((s) => <ToolCard key={s.key} block={s.block} sessionStatus={sessionStatus} enter={s.enter} />)}
        </div>
      )}
    </div>
  );
}
