import { Icon } from "@realm/ui";
import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { SessionStatus } from "@realm/contracts";
import { Spinner } from "../../components/Spinner";
import { useDissolve } from "../../components/ScrollFades";
import { fileIconFor } from "../../components/file-icon";
import { clip, editStat, editTarget, failureReason, mcpParts, prettyJson, readTarget, resultEditStat, statedExit, toolGlyph, toolSummary, toolVerb } from "./tool-summary";
import { flattenRun, formatDuration, formatToolRun, runWork, summarizeToolRun, type ToolBlock, type ToolStep } from "./tool-group";
import { ErrorPanel, ToolInputBody, ToolPanelBody, ToolResultBody } from "./rich/ToolViews";
import { DRAW_LIMIT, mediaWorkFor, toolInputView, toolPanel, toolResultView } from "./rich/tool-view";
import { GeneratingCanvas, ToolMedia } from "./media/MediaView";
import { ChildSessions, delegatedChildIds } from "./DelegatedRuns";
import { DelegationLine, DelegationWait, isDelegationLine, isDelegationWait } from "./DelegationLine";
import { useElapsed } from "./use-elapsed";
import { AppView } from "../app-view/AppView";

type ToolState = "running" | "waiting" | "ok" | "error" | "none";

/** What the lead slot tells a screen reader, per state. "none" is a call that never got a result —
 *  the session ended or was stopped first. */
const STATE_LABEL: Record<ToolState, string> = { running: "running", waiting: "waiting for you", ok: "done", error: "failed", none: "stopped" };

/** A running call says how long it has been at it once that is worth reading: under this, the number
 *  would flicker onto every quick read and off again. */
const ELAPSED_AFTER_MS = 3_000;

/** The calls the agent is blocked on for a permission, by id (`waitingToolIds`). Context rather than a
 *  prop so a sub-agent's cards, nested two components down, are told too; each card reduces it to
 *  one boolean before its memoized body, so a request opening re-renders the row it names and no
 *  other. */
export const ToolWaiting = createContext<ReadonlySet<string>>(new Set());

/** How long the copy button holds its ✓ before cross-fading back to the copy glyph (§6 icon swap). */
const COPIED_MS = 1400;

/** The session's directory, for saying an edited file's path from where the agent stands. Provided
 *  by the transcript; absent — a card drawn somewhere with no session — the path is said whole. */
export const ToolCwd = createContext<string | null>(null);

/**
 * The file a call read or changed, named the way the turn's edit card and the prose name it: the
 * directory dimmed and the name bright. One shape for Claude's `Edit`, Codex's `apply_patch` and an
 * ACP agent's edit, because to the reader they are the same act — and a mono chip of the raw path
 * said less, at more width, than the parts of it a reader looks for. The file's mark is the row's
 * lead glyph, so it is not drawn twice.
 */
function ToolFile({ path, more }: { path: string; more: number }) {
  const cwd = useContext(ToolCwd)?.replace(/\/+$/, "") ?? null;
  const shown = cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
  const cut = shown.lastIndexOf("/");
  return (
    <span className="tool-file" title={path}>
      <span className="tool-file-path">
        {cut >= 0 && <span className="tool-file-dir">{shown.slice(0, cut + 1)}</span>}
        <span className="tool-file-name">{shown.slice(cut + 1)}</span>
      </span>
      {more > 0 && <span className="tool-file-more">and {more} more</span>}
    </span>
  );
}

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
  const well = useRef<HTMLPreElement>(null);
  useDissolve(well);
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
      {rich ?? <pre className="tool-well" ref={well} data-error={error || undefined}>{clamped ? text.slice(0, RESULT_CLAMP) : text}</pre>}
      {!rich && clamped && (
        <button className="tool-expand" onClick={() => setShowAll(true)}>
          Show all ({Math.ceil(text.length / 1024)} KB)
        </button>
      )}
    </div>
  );
}

/** The exact payloads, one quiet control under the panel: what the tool was handed and what it
 *  answered, as they came, with their copy buttons. Kept available without competing with the panel,
 *  and built only once asked for. */
function RawWells({ block }: { block: ToolBlock }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="tool-raw">
      <button type="button" className="tool-raw-toggle" aria-expanded={shown} onClick={() => setShown(!shown)}>
        {shown ? "Hide raw" : "Show raw"}
      </button>
      {shown && (
        <>
          <Well label="Input" text={prettyJson(block.input)} />
          {block.result && <Well label={block.result.isError ? "Error" : "Result"} text={block.result.content || "(empty)"} error={block.result.isError} />}
        </>
      )}
    </div>
  );
}

/**
 * Opening a card with ⌥ held opens every card in the same transcript — Finder's gesture on a
 * disclosure triangle, and the modifier this app already spells "the other way to do this" on a
 * sidebar row. Nothing advertises it; a plain click is untouched.
 *
 * The siblings are driven through their OWN rows rather than by lifting `open` into shared state: a
 * long transcript holds hundreds of cards, and a subscription each would be a standing cost paid by
 * every reader who never finds this. A synthetic click carries no `altKey`, so one press cannot
 * cascade. Only rows that DISAGREE with the target are pressed, so they end up matching the card you
 * opened instead of each flipping to its own opposite.
 *
 * Returns `next` so the caller's own state moves whether or not the modifier was held.
 */
function expand(e: ReactMouseEvent<HTMLButtonElement>, next: boolean): boolean {
  if (!e.altKey) return next;
  const self = e.currentTarget;
  for (const row of self.closest(".transcript-col")?.querySelectorAll<HTMLButtonElement>(".tool-row") ?? [])
    if (row !== self && (row.getAttribute("aria-expanded") === "true") !== next) row.click();
  return next;
}

type ToolCardProps = {
  block: ToolBlock; sessionStatus: SessionStatus; enter?: boolean;
  /** The calls a sub-agent made under this one (`groupTranscript`). Empty for every card but a
   *  Task/Agent one whose child did some work — and empty via `withEnter`'s shared array, which is
   *  what keeps the memo above holding for the other 299 cards. */
  nested?: readonly ToolStep[];
};

/** A tool call the agent made: BUI ThinkingState's coding-row shape (Plan 9 W2) — a leading status
 *  glyph whose spinner→muted-check progression is the block's REAL settled state (result present),
 *  never a clock; the tool name; the target as a mono chip (ToolChips' chip language); measured
 *  +/− counts where the edit's payload carries both sides. Click still expands input + result.
 *
 *  Memoized because a streaming answer re-renders the whole transcript around it. The reducer rebuilds
 *  the block ARRAY on each update but keeps every settled block's object, so a card whose call has
 *  landed compares equal on all four props and is skipped — a 300-call transcript stops re-deriving
 *  300 summaries and edit stats behind an assistant message that is still typing. `enter` is stable
 *  for a key's whole life (transcript-enter.ts), so memoizing cannot strand a card mid-animation.
 *
 *  A call that starts a Realm sub-agent is drawn as its line instead (DelegationLine) — a different
 *  component rather than a branch inside this one, because a call can turn from one into the other
 *  when a refusal lands, and the two hold different hooks. */
export const ToolCard = memo(function ToolCard(props: ToolCardProps) {
  const waiting = useContext(ToolWaiting).has(props.block.toolUseId);
  if (isDelegationLine(props.block)) return <DelegationLine block={props.block} sessionStatus={props.sessionStatus} enter={props.enter} />;
  if (isDelegationWait(props.block)) return <DelegationWait block={props.block} sessionStatus={props.sessionStatus} enter={props.enter} />;
  return <ToolCardBody {...props} waiting={waiting} />;
});

/** The row's object: what the act was done TO. A path is the file's three parts; a command is code;
 *  a query or a description is prose, a query in quotes. An MCP call names its server first, the
 *  way a question names who is asking. None of it wears a chip: thirty rows each carrying a ringed
 *  field read as a column of outlines rather than as a ledger. */
function ToolObject({ block, summary }: { block: ToolBlock; summary: string }) {
  const edit = editTarget(block);
  if (edit) return <ToolFile path={edit.path} more={edit.more} />;
  const read = readTarget(block);
  if (read) return <ToolFile path={read} more={0} />;
  const verb = toolVerb(block.name, block.toolKind);
  const mcp = mcpParts(block.name);
  const where = typeof block.input["path"] === "string" ? (block.input["path"] as string) : null;
  const code = verb === "Run" || verb === "Find files";
  const quoted = verb === "Search" || verb === "Search web";
  const text = verb === "Fetch" ? summary.replace(/^https?:\/\//, "") : summary;
  return (
    <>
      {mcp && <span className="tool-server">{mcp.server}</span>}
      {text && (
        <span className="tool-summary" data-form={code ? "code" : "prose"} title={summary}>
          {quoted ? `“${text}”` : text}
          {verb === "Search" && where && <span className="tool-where"> in {where}</span>}
        </span>
      )}
    </>
  );
}

const ToolCardBody = memo(function ToolCardBody({ block, sessionStatus, enter = false, nested, waiting }: ToolCardProps & { waiting: boolean }) {
  const [open, setOpen] = useState(false);
  const everOpened = useRef(false);
  everOpened.current ||= open;
  const live = sessionStatus === "running" || sessionStatus === "waiting_permission";
  const state: ToolState = block.result ? (block.result.isError ? "error" : "ok") : !live ? "none" : waiting ? "waiting" : "running";
  const summary = clip(toolSummary(block.name, block.input));
  const verb = toolVerb(block.name, block.toolKind);
  /* An edit names its counts, from the call's own two sides where it carries them, or from the diff
     an ACP agent's result carries (map-acp.ts). */
  const file = editTarget(block)?.path ?? readTarget(block);
  const glyph = file ? fileIconFor(file) : toolGlyph(block.name, block.toolKind);
  const stat = editStat(block.name, block.input) ?? resultEditStat(block);
  const elapsed = useElapsed(block.ts, state === "running");
  const exit = block.result?.isError ? statedExit(block.result.content) : null;
  const reason = state === "error" ? failureReason(block.result!.content) : "";
  /* The panel for this call's kind (rich/tool-view.ts), or — where Realm has none — the drawn forms of
     its two payloads for the wells. Computed only once the body has been built: a transcript of 300
     collapsed cards must not diff 300 payloads to render a row nobody opened. */
  const panel = everOpened.current ? toolPanel(block) : null;
  const inputView = everOpened.current && !panel ? toolInputView(block.name, block.input) : null;
  const resultView = everOpened.current && !panel && block.result ? toolResultView(block.name, block.input, block.result.content, block.result.isError) : null;
  const cwd = useContext(ToolCwd);
  /* The one state aicss.dev's image-generation component has, on the one call it belongs to: media
     being made, right now. Bound to `state === "running"` — the call's REAL settled state — so the
     canvas cannot outlive the work, and a failure leaves a failed card rather than a shimmer. */
  const work = state === "running" ? mediaWorkFor(block.name, block.input) : null;
  /* Every other call answers with an empty list on the name alone, before the result is read. */
  const children = delegatedChildIds(block);
  return (
    /* The id on the element, so anything that needs to point AT a specific call can find it. */
    <div className="tool-card" data-tool-use-id={block.toolUseId}
      data-state={state} data-open={open || undefined} data-enter={enter || undefined}>
      <button className="tool-row" aria-expanded={open} aria-label={`${block.name} tool call`} title={block.name}
        onClick={(e) => setOpen(expand(e, !open))}>
        {/* The lead slot: what KIND of act this was, at rest, and the call's state in its place while
            that state is the news — running, waiting on the person, failed. A settled call wears no
            tick: thirty identical ticks carry nothing. The two layers turn over on the shared icon
            swap; the state layer's glyph is bound to the block's real result, never a clock. */}
        <span className="tool-status icon-swap" data-on={state === "running" || state === "waiting" || state === "error" || undefined}
          role="img" aria-label={STATE_LABEL[state]}>
          <span className="swap-off" data-glyph={glyph}><Icon name={glyph} size={14} /></span>
          <span className="swap-on">
            {/* 16, not the 14 the glyphs use: the orb fills the slot, and 40 dots at 0.12–1 opacity
                carry far less weight than a 1.5px stroke, so it reads lighter even so. */}
            {state === "running" && <Spinner size={16} />}
            {state === "waiting" && <Icon name="shieldQuestion" size={14} />}
            {state === "error" && <Icon name="errorCircle" size={14} />}
          </span>
        </span>
        <span className="tool-name">{verb}</span>
        <span className="tool-object"><ToolObject block={block} summary={summary} /></span>
        {stat && (
          /* A zero side is dropped rather than printed: "−0" on a pure addition is a count of
             nothing, and it reads as a deletion until the eye gets to the digit. The signs stay, so
             colour is never the only thing saying which is which. */
          <span className="tool-stat">
            {stat.add > 0 && <span className="tool-stat-add">+{stat.add}</span>}
            {stat.del > 0 && <span className="tool-stat-del">−{stat.del}</span>}
          </span>
        )}
        {/* The state in a word, so it is never colour or a glyph alone. */}
        {state === "running" && elapsed >= ELAPSED_AFTER_MS && <span className="tool-meta" data-tone="quiet">{formatDuration(elapsed)}</span>}
        {state === "waiting" && <span className="tool-meta" data-tone="warning">Waiting for you</span>}
        {state === "error" && <span className="tool-meta" data-tone="danger">{exit ? `exit ${exit.code}` : "Failed"}</span>}
        {state === "none" && <span className="tool-meta" data-tone="quiet">Stopped</span>}
        <Icon name="chevronRight" size={12} className="tool-chevron" />
      </button>
      {/* Why it failed, without opening it: that is the thing a reader of a failed call came for. */}
      {reason && <div className="tool-reason" title={block.result!.content}>{reason}</div>}
      {/* Outside the expander on purpose: the placeholder's whole job is to be seen while the work
          happens, and a canvas the reader has to open a card to find would be a spinner with extra
          steps. It leaves of its own accord when the result lands. */}
      {work && <GeneratingCanvas label={work.label} detail={work.detail} aspect={work.aspect} />}
      {/* The view the server drew for this call, outside the expander: it is what the call was for,
          and a reader should not have to open a card to find it. */}
      {block.view && <AppView viewId={block.view.viewId} viewRef={block.view} mode="inline" />}
      {/* The sessions a delegation call started or collected, outside the expander for the ledger's
          reason below: a finished child's pane may already be gone from the layout, and this is the
          way back to it from the report it produced. */}
      {children.length > 0 && <ChildSessions ids={children} />}
      {/* The sub-agent's own ledger, hanging off the call that spawned it and ABOVE the expander:
          what the child is doing is the thing worth seeing, and burying it under the raw input and
          result wells would make it something the reader has to go looking for. */}
      {nested && nested.length > 0 && <ToolGroup steps={nested} sessionStatus={sessionStatus} subagent />}
      {/* §6 expands the row by transitioning grid-template-rows 0fr→1fr, which only animates if the
          content is in the DOM on both sides of the flip. So the body is built on first open and
          stays built: collapsing animates too, and re-opening is instant. `inert` keeps the hidden
          copy buttons and expanders out of the tab order and the accessibility tree. */}
      <div className="tool-body-wrap">
        <div className="tool-body-clip" inert={!open || undefined}>
          {everOpened.current && (
            <div className="tool-body">
              {panel ? (
                <>
                  {panel.kind === "media"
                    ? <><ToolMedia path={panel.path} />{panel.error && <ErrorPanel text={panel.error} />}</>
                    : <ToolPanelBody panel={panel} cwd={cwd} />}
                  <RawWells block={block} />
                </>
              ) : (
                /* No panel for this kind: the payload itself, labelled for what it is, drawn where a
                   view exists for it and raw where none does. */
                <>
                  <Well label="Arguments" text={prettyJson(block.input)} rich={inputView && <ToolInputBody view={inputView} />} />
                  {block.result && (
                    <Well label={block.result.isError ? "Error" : "Result"} text={block.result.content || "(empty)"} error={block.result.isError}
                      rich={resultView && <ToolResultBody view={resultView} />} />
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

/** The collapsed row's duration (Ara refresh §4: `Worked for <duration> ›`). While the run is still
 *  working it ticks live off the group's own first timestamp; once settled it freezes on the ledger's
 *  first→last span — the same duration the counts line has always computed. */
/**
 * Draw the run's work only as wide as the parts that fit on its one line. The parts that do not fit
 * wrap onto a line the box never shows (styles.css), but a wrapped box keeps the width it shrank to,
 * so the reserved "1 failed" stood a gap away from the last count it followed. Measured against the
 * group, whose width the head cannot change, so the measure never feeds itself.
 */
function useWorkFit(key: string) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const work = ref.current;
    const group = work?.closest(".tool-group");
    if (!work || !group) return;
    const fit = () => {
      work.style.maxWidth = "";
      if (work.getBoundingClientRect().width === 0) return; // not laid out (a folded or hidden pane)
      const parts = [...work.children];
      const first = parts[0]?.getBoundingClientRect();
      if (!first) return;
      const shown = parts.filter((p) => Math.abs(p.getBoundingClientRect().top - first.top) < 2);
      const right = shown[shown.length - 1]!.getBoundingClientRect().right;
      work.style.maxWidth = `${Math.ceil(right - work.getBoundingClientRect().left)}px`;
    };
    fit();
    if (typeof ResizeObserver === "undefined") return; // jsdom
    const ro = new ResizeObserver(fit);
    ro.observe(group);
    return () => ro.disconnect();
  }, [key]);
  return ref;
}

function useWorkedFor(working: boolean, firstTs: number, settledMs: number): string {
  const elapsed = useElapsed(firstTs, working);
  return formatDuration(working ? elapsed : settledMs);
}

/** §2.8/§5: a run of consecutive tool calls, folded behind one ledger line with a rail under it.
 *  It opens itself while the agent is still working through the run — collapsing live activity out
 *  of sight is the one thing this treatment must not do — and a manual toggle then wins for good.
 *
 *  The head names the WORK, not only its length: "Worked for 2m 4s · 6 reads · 2 edits +31 −4 ·
 *  3 commands", and while the run is live, the call in flight instead ("· Run pnpm test"). A failure
 *  inside it is on the head too, last and reserved, so the one fact worth surfacing from a folded run
 *  can never be the part an ellipsis takes. The counts line stays the tooltip. */
export function ToolGroup({ steps, sessionStatus, subagent = false, endsTurn = false }: {
  steps: readonly ToolStep[]; sessionStatus: SessionStatus;
  /** These steps are a sub-agent's, not a run of the agent's own calls. Sitting directly under a
   *  Task row, an unqualified "Worked for 42s" would read as that Task's own elapsed time. */
  subagent?: boolean;
  /** Nothing the agent said or did came after this run in its turn. A run that ENDS a turn on a
   *  failure opens itself, as it does while live: the agent stopped there, and the failure is why. */
  endsTurn?: boolean;
}) {
  const [manual, setManual] = useState<boolean | null>(null);
  const live = sessionStatus === "running" || sessionStatus === "waiting_permission";
  // The whole subtree, not the top level: a run whose only unfinished work is inside a sub-agent is
  // still working, and a ledger that counted only the parent's own calls would under-report the run
  // AND end its clock at the moment the Task was CALLED — the row would shrink from 5m to <1s on
  // settle, having just spent five minutes ticking upward.
  const blocks = flattenRun(steps);
  const working = live && blocks.some((b) => !b.result);
  const last = steps[steps.length - 1]!.block;
  const stoppedOnFailure = endsTurn && !live && last.result?.isError === true;
  const open = manual ?? (working || stoppedOnFailure);
  const summary = summarizeToolRun(blocks);
  const work = runWork(summary);
  // The run's first call really is its earliest: blocks arrive in order, and a sub-agent's calls
  // postdate the one that spawned them. Only the END of the span needs looking for (summarizeToolRun).
  const workedFor = useWorkedFor(working, blocks[0]!.ts, summary.durationMs);
  const workRef = useWorkFit(working && summary.liveStep ? summary.liveStep : formatToolRun(summary));
  return (
    <div className="tool-group" data-subagent={subagent || undefined} data-open={open || undefined} data-working={working || undefined}>
      <button className="tool-group-row" aria-expanded={open} aria-label={`${blocks.length} ${subagent ? "sub-agent " : ""}tool calls`}
        title={formatToolRun(summary)} onClick={() => setManual(!open)}>
        <span className="tool-group-summary">{subagent ? "Sub-agent worked for" : "Worked for"} {workedFor}</span>
        {/* Parts in reading order, yielding from the right as the pane narrows. */}
        <span className="tool-group-work" ref={workRef}>
          {(working && summary.liveStep ? [summary.liveStep] : [
            work.reads,
            work.edits && <>{work.edits}
              {summary.add > 0 && <span className="tool-stat-add"> +{summary.add}</span>}
              {summary.del > 0 && <span className="tool-stat-del"> −{summary.del}</span>}</>,
            work.searches,
            work.commands,
          ]).filter(Boolean).map((part, i) => <span key={i}> · {part}</span>)}
        </span>
        {summary.failed > 0 && (
          <span className="tool-group-failed">
            <span className="tool-group-failed-dot">·</span><Icon name="errorCircle" size={12} />{summary.failed} failed
          </span>
        )}
        <Icon name="chevronRight" size={12} className="tool-chevron" />
      </button>
      {open && (
        <div className="tool-group-steps">
          {steps.map((s) => <ToolCard key={s.key} block={s.block} sessionStatus={sessionStatus} enter={s.enter} nested={s.nested} />)}
        </div>
      )}
    </div>
  );
}
