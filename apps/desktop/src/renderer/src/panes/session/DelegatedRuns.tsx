import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { bareToolName, type DelegatedRun, type Session } from "@realm/contracts";
import { useApp } from "../../state/store";
import { useAnchoredPopover } from "../../components/use-anchored-popover";
import { CHILD_ORIGINS, ORIGIN_META, SESSION_STATUS_LABEL } from "../session-labels";
import { formatDuration, type ToolBlock } from "./tool-group";
import type { Block } from "./transcript-model";
import { useElapsed } from "./use-elapsed";

/** A peer `agent_ask` reached is NOT a session this one spawned: it was doing its own work before the
 *  question arrived and goes on doing it afterwards. Calling it a sub-agent would be wrong twice. */
const ASKED_META = { icon: "session", label: "Asked a question (agent_ask)" };

/**
 * The agents this session has in flight, as one control at the top right of its pane.
 *
 * A delegated child is a real session, but it no longer gets a pane: a fan-out of eight was eight
 * columns too narrow to read. This control is how the user sees them instead — a count in the bar,
 * and a click opens the list. A row previews that child as a tab of this session's side pane, beside
 * the browsers its agents opened, so looking at one never rearranges the workspace.
 *
 * In the pane bar rather than a pane of its own, deliberately. The engine's registry lives in the
 * server's memory and dies with the process, while a pane is a layout leaf that persists — a pane
 * kind for this would leave an empty panel behind from a run that finished yesterday. Living in the
 * delegating session's own bar IS the link to that session, and the control leaves when the
 * session's runs do.
 */
/**
 * Tool names that spawn sub-agents INSIDE the harness.
 *
 * `Workflow` is here because it is what a real run turned out to use — a request for ten research
 * agents produced one `Workflow` call, not ten `Task` ones, so a list that knew only about `Task`
 * showed nothing for exactly the case that prompted asking for this card.
 */
const SUBAGENT_TOOLS = new Set(["Task", "Agent", "Workflow"]);

/**
 * Whether this call still has an agent working behind it — the two ways that can be true, because
 * the harness runs sub-agents in two modes and they look nothing alike on the wire.
 *
 * **Blocking**: the call stays open for the agent's whole life, so an unfinished call IS a running
 * agent. Recognised by tool name, which is all there is to go on before a result exists.
 *
 * **Background**: the call returns in about a second — "Async agent launched successfully" — and the
 * agent then runs for minutes. The result being present says nothing about whether it is done. This
 * is the case that showed nothing at all: ten background agents were ten completed tool calls as far
 * as this list could tell. `background` is set by the adapter, off the harness's own launch text and
 * completion notification, and it is the only honest signal for the mode.
 */
export function stillWorking(b: Extract<Block, { kind: "tool" }>): boolean {
  if (b.background !== undefined) return b.background === "running";
  return SUBAGENT_TOOLS.has(b.name) && b.result === null;
}

/**
 * Sub-agents the HARNESS is running, read off the transcript.
 *
 * These are a different animal to a delegated run and the difference is why they were invisible:
 * `agent_run` creates a real Realm session, with a row, a pane and a place in the layout, and the
 * dock below lists those. Claude's own `Task`/`Agent` tools create none of that — the subagent lives
 * and dies inside the CLI process, and the only trace it leaves on the wire is its launching call.
 * See `stillWorking` for the two very different shapes that trace takes.
 *
 * What they get is the same card and honestly less than a real run does: elapsed time and what they
 * were asked, but no jump — there is no pane to jump to. Pretending otherwise would be a button that
 * cannot work.
 */
export function harnessSubagents(blocks: readonly Block[]): { id: string; label: string; startedAt: number }[] {
  return blocks
    .filter((b): b is Extract<Block, { kind: "tool" }> =>
      b.kind === "tool" && stillWorking(b)
      // A call made UNDER another Task is that Task's business, not a second row here.
      && b.parentToolUseId === undefined)
    .map((b) => ({
      id: b.toolUseId,
      // `name` is what a Workflow calls itself; `description` is Task's. Falling through both before
      // the prompt, because a prompt's first eighty characters are usually boilerplate.
      label: labelOf(b.input).slice(0, 80),
      // The START, not an elapsed span frozen at the moment this list was last rebuilt. A background
      // agent produces no transcript events while it runs, so the list is rebuilt once and then not
      // again for ten minutes — a precomputed duration would sit at "0s" for the entire run, next to
      // a header clock that ticks. The Dock's one clock subtracts this instead.
      startedAt: b.ts,
    }));
}

/** What to call an in-flight sub-agent run. A Workflow names itself in its script's `meta`, which is
 *  the only place its name exists — so it is dug out rather than left as "Sub-agent". */
export function labelOf(input: Record<string, unknown>): string {
  const direct = input.description ?? input.name;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const script = typeof input.script === "string" ? input.script : "";
  const named = script.match(/name:\s*['"`]([^'"`]+)['"`]/)?.[1];
  if (named) return named;
  const prompt = input.prompt;
  return typeof prompt === "string" && prompt.trim() ? prompt.trim() : "Sub-agent";
}

/** The delegation calls whose RESULT names the sessions they started or collected, by the name every
 *  harness ends it with (`bareToolName`). The input names none: the child did not exist yet. */
const DELEGATION_CALLS = new Set(["agent_run", "agent_start", "agent_wait", "browser_agent_run", "agent_review"]);
const SESSION_ID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;

/**
 * The ids a delegation call's result names, first mention first — the server's own trail after each
 * report (`Child session: {…}`, `agent_start`'s handle, each `agent_wait` heading, the browser agent's
 * and the reviewer's). Candidates, not children: `ChildSessions` keeps only the ones this window knows
 * as a delegated session, so an id that happens to sit inside a child's REPORT is never made a link.
 */
export function delegatedChildIds(b: ToolBlock): string[] {
  if (!b.result || !DELEGATION_CALLS.has(bareToolName(b.name))) return [];
  return [...new Set(b.result.content.match(SESSION_ID) ?? [])];
}

/** Preview a delegated child as a tab of its lead's side pane — the point of going to look is to see
 *  the child beside the session that spawned it, and `openItem` would evict the pane the click came
 *  from. The keyboard stays with the lead, whose prompter the user is in. A lead that is not on
 *  screen leaves nothing to be beside, so the child opens beside the focused pane; a child this
 *  window holds no item for (another space) is revealed. One way in, for the control and for the
 *  call's own rows, because it is one object. */
export function useOpenChild(): (childId: string) => void {
  const items = useApp((s) => s.items);
  const sessions = useApp((s) => s.sessions);
  const openInSidePane = useApp((s) => s.openInSidePane);
  const openItemBeside = useApp((s) => s.openItemBeside);
  const revealSession = useApp((s) => s.revealSession);
  const run = useApp((s) => s.run);
  return (childId) => {
    const it = items.find((i) => i.kind === "session" && i.refId === childId);
    const lead = sessions[childId]?.dispatchedBy?.sessionId ?? null;
    run(async () => {
      if (!it) { await revealSession(childId, null); return; }
      if (lead && await openInSidePane(lead, it.id)) return;
      await openItemBeside(it.id);
    });
  };
}

/**
 * The delegated sessions a call started or reported, hanging off the call itself.
 *
 * The dock above the prompter lists a child only while it RUNS, and Realm takes a finished child's
 * pane back out of the layout — so without this, the moment a child was done its transcript was one
 * sidebar search away from the report it produced. The call is where that report lands, so the way
 * back lives on it: the dock's own row and the dock's own jump, on the trace rail a sub-agent's calls
 * hang from, because it is the same object reached from a second place.
 */
export function ChildSessions({ ids }: { ids: readonly string[] }) {
  const sessions = useApp((s) => s.sessions);
  const sessionStatus = useApp((s) => s.sessionStatus);
  const open = useOpenChild();
  const children = ids.map((id) => sessions[id])
    .filter((c): c is Session => c?.dispatchedBy != null && CHILD_ORIGINS.has(c.dispatchedBy.kind));
  if (children.length === 0) return null;
  return (
    <ul className="delegation-list" aria-label="Delegated sessions">
      {children.map((c) => {
        const meta = ORIGIN_META[c.dispatchedBy!.kind];
        const status = sessionStatus[c.id] ?? c.status;
        return (
          <li key={c.id}>
            <button type="button" className="delegation-item" title={meta.label}
              aria-label={`${c.title} — ${meta.label}`} onClick={() => open(c.id)}>
              <Icon name={meta.icon} size={14} />
              <span className="delegation-title">{c.title}</span>
              <span className="status-dot item-status" data-status={status} title={SESSION_STATUS_LABEL[status]} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function RunningAgents({ sessionId }: { sessionId: string }) {
  const running = useApp((s) => s.delegatedRuns[sessionId]);
  const blocks = useApp((s) => s.transcripts[sessionId]?.t.blocks ?? NO_BLOCKS);
  const refreshDelegatedRuns = useApp((s) => s.refreshDelegatedRuns);
  const run = useApp((s) => s.run);
  // Covers the runs that began before this window connected — a reload, a second window, a pane
  // opened ten minutes into a delegation. Every later change arrives on `delegation.changed`.
  useEffect(() => { run(() => refreshDelegatedRuns(sessionId)); }, [sessionId, refreshDelegatedRuns, run]);
  const inHarness = useMemo(() => harnessSubagents(blocks), [blocks]);
  if ((!running || running.length === 0) && inHarness.length === 0) return null;
  return <Control sessionId={sessionId} running={running ?? NO_RUNS} harness={inHarness} />;
}

const NO_BLOCKS: readonly Block[] = [];
const NO_RUNS: readonly DelegatedRun[] = [];

/** Split out so the hooks below only ever run for a session that actually has agents working — and
 *  so the open popover is discarded with the control rather than surviving until the next one. */
function Control({ sessionId, running, harness }: {
  sessionId: string;
  running: readonly DelegatedRun[];
  /** Sub-agents the harness is running in-process — no session, no pane, no preview. */
  harness: { id: string; label: string; startedAt: number }[];
}) {
  const sessions = useApp((s) => s.sessions);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const rows = [...running].sort((a, b) => a.startedAt - b.startedAt);
  const total = rows.length + harness.length;
  // The oldest thing in flight, whichever kind it is — "how long has this session been waiting on
  // anyone", and starting it at the newest would keep resetting it.
  const since = Math.min(...rows.map((r) => r.startedAt), ...harness.map((h) => h.startedAt));
  // Always ticking: this component only exists while something is in flight, so the clock stops by
  // unmounting rather than by a flag. One clock for every row, so the rows and the head agree.
  const elapsed = useElapsed(since, true);
  const count = total === 1 ? "1 agent" : `${total} agents`;
  const title = sessions[sessionId]?.title ?? "this session";
  return (
    <>
      {/* "working", not "waiting on": an `agent_start` the lead deliberately backgrounded is here too,
          and that lead is not blocked on anything. */}
      <button ref={anchor} type="button" className="agents-chip" aria-haspopup="dialog" aria-expanded={open}
        aria-label={`${count} working for ${title}`} title={`${count} working · ${formatDuration(elapsed)}`}
        onClick={() => setOpen((o) => !o)}>
        <Icon name="bot" size={14} />
        <span className="agents-chip-count">{total} working</span>
      </button>
      {open && <AgentsPopover anchor={anchor} sessionId={sessionId} rows={rows} harness={harness}
        since={since} elapsed={elapsed} count={count} onClose={() => setOpen(false)} />}
    </>
  );
}

function AgentsPopover({ anchor, sessionId, rows, harness, since, elapsed, count, onClose }: {
  anchor: RefObject<HTMLButtonElement | null>;
  sessionId: string;
  rows: DelegatedRun[];
  harness: { id: string; label: string; startedAt: number }[];
  since: number; elapsed: number; count: string;
  onClose: () => void;
}) {
  const sessions = useApp((s) => s.sessions);
  const sessionStatus = useApp((s) => s.sessionStatus);
  const docked = useApp((s) => s.sessionDock[sessionId]);
  const toggleSessionDock = useApp((s) => s.toggleSessionDock);
  const preview = useOpenChild();
  const ref = useRef<HTMLDivElement>(null);
  const { pos, closing, close } = useAnchoredPopover({ ref, anchorRef: anchor, align: "right", onClose, returnFocusRef: anchor, exit: true });
  const watched = docked?.kind === "subagent" ? docked.toolUseId : null;
  const now = since + elapsed;
  const style: CSSProperties = { position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999,
    visibility: pos ? "visible" : "hidden", transformOrigin: pos?.origin ?? "top right" };
  return createPortal(
    <div ref={ref} role="dialog" aria-label={`${count} working`} className="menu agents-pop" style={style}
      data-closing={closing || undefined} inert={closing}>
      <div className="agents-pop-head">
        <span>{count} working</span>
        <span className="delegation-dim">{formatDuration(elapsed)}</span>
      </div>
      <ul className="delegation-list">
        {rows.map((r) => {
          const child = sessions[r.sessionId];
          const status = sessionStatus[r.sessionId] ?? child?.status;
          // The Tasks lens's own vocabulary for how a session came to exist, so a delegated child
          // is named the same here as it is there. A child whose row has not landed yet (the
          // session and the run are announced separately) still gets its origin from the run.
          const meta = r.owned ? ORIGIN_META[child?.dispatchedBy?.kind ?? "agent_run"] : ASKED_META;
          return (
            <li key={r.sessionId}>
              {/* A delegated child is a whole session — a transcript, a composer, permissions of its
                  own — so the preview is that session, as a tab of this one's side pane. */}
              <button type="button" className="delegation-item" title={meta.label}
                aria-label={`Preview ${child?.title ?? "Starting"} — ${meta.label}`} onClick={() => { preview(r.sessionId); close(); }}>
                <Icon name={meta.icon} size={14} />
                {/* The row lands before the session row does often enough to matter: `agent_run`
                    registers the run and only then sends the child its first message. */}
                <span className="delegation-title">{child?.title ?? "Starting…"}</span>
                {/* `detached` is the difference between "this session is blocked until you finish"
                    and "go at your own pace" — the lead kept working after agent_start. */}
                {r.detached && <span className="delegation-dim">not collected yet</span>}
                <span className="delegation-dim">{formatDuration(now - r.startedAt)}</span>
                {status && <span className="status-dot item-status" data-status={status} title={SESSION_STATUS_LABEL[status]} />}
              </button>
            </li>
          );
        })}
        {/* The harness's own sub-agents. No session behind one of these and so no status dot — but
            there IS something to watch: the calls it makes arrive in this transcript nested under its
            launching call. The row opens them on the panel docked to this pane's right edge. */}
        {harness.map((h) => (
          <li key={h.id}>
            <button type="button" className="delegation-item" data-selected={watched === h.id || undefined}
              aria-label={`Watch ${h.label}`} aria-pressed={watched === h.id}
              onClick={() => { toggleSessionDock(sessionId, { kind: "subagent", toolUseId: h.id }); close(); }}>
              <Icon name="bot" size={14} />
              <span className="delegation-title">{h.label}</span>
              <span className="delegation-dim">in the agent</span>
              <span className="delegation-dim">{formatDuration(Math.max(0, now - h.startedAt))}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>,
    document.body,
  );
}
