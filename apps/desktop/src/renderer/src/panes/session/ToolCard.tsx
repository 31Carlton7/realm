import { Icon } from "@realm/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SessionStatus } from "@realm/contracts";
import { Spinner } from "../../components/Spinner";
import { clip, editStat, prettyJson, toolSummary } from "./tool-summary";
import { formatDuration, formatToolRun, summarizeToolRun, type ToolBlock } from "./tool-group";
import { ToolInputBody, ToolResultBody } from "./rich/ToolViews";
import { DRAW_LIMIT, toolInputView, toolResultView } from "./rich/tool-view";

type ToolState = "running" | "ok" | "error" | "none";

/** How long the copy button holds its ✓ before cross-fading back to the copy glyph (§6 icon swap). */
const COPIED_MS = 1400;

/** Giant tool results are clamped to this many chars behind a "Show all" expander (A-M2) — an agent
 *  cat-ing a bundle must not wedge the transcript. Copy always takes the full text.
 *  It is the same number `tool-view.ts` stops DRAWING a result at, and deliberately one constant:
 *  two thresholds would leave a band where a result is neither drawn nor clamped. */
export const RESULT_CLAMP = DRAW_LIMIT;

/** One labelled section of the card body (Input / Result / Error): a copy button (A-M3) over either
 *  a recessed well of raw text or, when `rich` is given, a DRAWN view of the same payload — a
 *  diff, a plan, a terminal, a file preview (rich/ToolViews.tsx).
 *
 *  Copy always takes `text`, the raw payload, whichever is drawn. What a reader pastes into a shell
 *  or a bug report has to be the thing the tool was actually handed, not a transcription of the
 *  picture Realm drew of it. `label` doubles as the button's accessible object ("Copy result"). */
function Well({ label, text, error = false, rich = null }: { label: string; text: string; error?: boolean; rich?: ReactNode }) {
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
      {rich ?? <pre className="tool-well" data-error={error || undefined}>{clamped ? text.slice(0, RESULT_CLAMP) : text}</pre>}
      {!rich && clamped && (
        <button className="tool-expand" onClick={() => setShowAll(true)}>
          Show all ({Math.ceil(text.length / 1024)} KB)
        </button>
      )}
    </div>
  );
}

/** A tool call the agent made: BUI ThinkingState's coding-row shape (Plan 9 W2) — a leading status
 *  glyph whose spinner→muted-check progression is the block's REAL settled state (result present),
 *  never a clock; the tool name; the target as a mono chip (ToolChips' chip language); measured
 *  +/− counts where the edit's payload carries both sides. Click still expands input + result. */
export function ToolCard({ block, sessionStatus, enter = false }: { block: ToolBlock; sessionStatus: SessionStatus; enter?: boolean }) {
  const [open, setOpen] = useState(false);
  const everOpened = useRef(false);
  everOpened.current ||= open;
  const live = sessionStatus === "running" || sessionStatus === "waiting_permission";
  const state: ToolState = block.result ? (block.result.isError ? "error" : "ok") : live ? "running" : "none";
  const summary = clip(toolSummary(block.name, block.input));
  const stat = editStat(block.name, block.input);
  /* The drawn forms of this call's payloads, or null where the raw well is still the best showing
     (rich/tool-view.ts). Computed only once the body has been built — a transcript of 300 collapsed
     cards must not diff 300 payloads to render a row nobody opened. */
  const inputView = everOpened.current ? toolInputView(block.name, block.input) : null;
  const resultView = everOpened.current && block.result ? toolResultView(block.name, block.input, block.result.content, block.result.isError) : null;
  return (
    <div className="tool-card" data-state={state} data-open={open || undefined} data-enter={enter || undefined}>
      <button className="tool-row" aria-expanded={open} aria-label={`${block.name} tool call`} onClick={() => setOpen((o) => !o)}>
        <span className="tool-status" aria-label={state === "running" ? "running" : state === "ok" ? "done" : state === "error" ? "failed" : "no result"}>
          {/* 16, not the 14 the settled glyphs use: the orb fills the status slot, and 40 dots at
              0.12–1 opacity carry far less weight than a 1.5px stroke, so it reads lighter even so. */}
          {state === "running" && <Spinner size={16} />}
          {state === "ok" && <Icon name="check" size={14} />}
          {state === "error" && <Icon name="errorCircle" size={14} />}
        </span>
        <span className="tool-name">{block.name}</span>
        {summary && <span className="tool-summary" title={summary}>{summary}</span>}
        {stat && (
          /* A zero side is dropped rather than printed: "−0" on a pure addition is a count of
             nothing, and it reads as a deletion until the eye gets to the digit. */
          <span className="tool-stat">
            {stat.add > 0 && <span className="tool-stat-add">+{stat.add}</span>}
            {stat.del > 0 && <span className="tool-stat-del">−{stat.del}</span>}
          </span>
        )}
        <Icon name="chevronRight" size={12} className="tool-chevron" />
      </button>
      {/* §6 expands the row by transitioning grid-template-rows 0fr→1fr, which only animates if the
          content is in the DOM on both sides of the flip. So the body is built on first open and
          stays built: collapsing animates too, and re-opening is instant. `inert` keeps the hidden
          copy buttons and expanders out of the tab order and the accessibility tree. */}
      <div className="tool-body-wrap">
        <div className="tool-body-clip" inert={!open || undefined}>
          {everOpened.current && (
            <div className="tool-body">
              <Well label="Input" text={prettyJson(block.input)} rich={inputView && <ToolInputBody view={inputView} />} />
              {block.result && (
                <Well label={block.result.isError ? "Error" : "Result"} text={block.result.content || "(empty)"} error={block.result.isError}
                  rich={resultView && <ToolResultBody view={resultView} />} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The collapsed row's duration (Ara refresh §4: `Worked for <duration> ›`). While the run is still
 *  working it ticks live off the group's own first timestamp; once settled it freezes on the ledger's
 *  first→last span — the same duration the counts line has always computed. */
function useWorkedFor(working: boolean, firstTs: number, settledMs: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!working) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [working]);
  return formatDuration(working ? Math.max(0, now - firstTs) : settledMs);
}

/** §2.8/§5: a run of consecutive tool calls, folded behind one ledger line with a dashed connector.
 *  It opens itself while the agent is still working through the run — collapsing live activity out
 *  of sight is the one thing this treatment must not do — and a manual toggle then wins for good.
 *  The collapsed row reads `Worked for <duration> ›` (Ara refresh §4); the counts line the ledger
 *  still computes ("3 tools · 1 file · 2 commands") survives as the row's tooltip. */
export function ToolGroup({ steps, sessionStatus }: {
  steps: { key: string; block: ToolBlock; enter: boolean }[]; sessionStatus: SessionStatus;
}) {
  const [manual, setManual] = useState<boolean | null>(null);
  const live = sessionStatus === "running" || sessionStatus === "waiting_permission";
  const working = live && steps.some((s) => !s.block.result);
  const open = manual ?? working;
  const summary = summarizeToolRun(steps.map((s) => s.block));
  const workedFor = useWorkedFor(working, steps[0]!.block.ts, summary.durationMs);
  return (
    <div className="tool-group" data-open={open || undefined} data-working={working || undefined}>
      {/* Plan 9 W2: the row wears ThinkingState's header treatment — while the run is live the label
          shimmers (BUI's working treatment); the label itself stays the kept Ara decision,
          `Worked for <duration>`, ticking live and freezing on settle. */}
      <button className="tool-group-row" aria-expanded={open} aria-label={`${steps.length} tool calls`}
        title={formatToolRun(summary)} onClick={() => setManual(!open)}>
        <span className="tool-group-summary">Worked for {workedFor}</span>
        <Icon name="chevronRight" size={12} className="tool-chevron" />
      </button>
      {open && (
        <div className="tool-group-steps">
          {steps.map((s) => <ToolCard key={s.key} block={s.block} sessionStatus={sessionStatus} enter={s.enter} />)}
        </div>
      )}
    </div>
  );
}
