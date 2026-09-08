import { Icon } from "@realm/ui";
import { useEffect, useMemo, useState } from "react";
import type { DelegatedRun } from "@realm/contracts";
import { useApp } from "../../state/store";
import { ORIGIN_META, SESSION_STATUS_LABEL } from "../session-labels";
import { formatDuration } from "./tool-group";
import type { Block } from "./transcript-model";
import { useElapsed } from "./use-elapsed";

/** A peer `agent_ask` reached is NOT a session this one spawned: it was doing its own work before the
 *  question arrived and goes on doing it afterwards. Calling it a sub-agent would be wrong twice. */
const ASKED_META = { icon: "session", label: "Asked a question (agent_ask)" };

/**
 * The agents this session has in flight, docked between its transcript and its prompter.
 *
 * A delegated child has always been a real session with a pane of its own, but the parent's
 * transcript said nothing at all while it worked — the child's report arrives as one MCP tool result
 * at the very end, so for however long the child ran the parent showed a shimmer and no reason for
 * it. This is the reason, and the way over to it.
 *
 * Docked rather than a pane of its own, deliberately. The engine's registry lives in the server's
 * memory and dies with the process, while a pane is a layout leaf that persists — a pane kind for
 * this would leave an empty panel behind from a run that finished yesterday, and would keep pointing
 * at a session after the layout had moved on from it. Living inside the delegating session's pane IS
 * the link to that session: it cannot be dragged away from what it describes, and it leaves when the
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
 * Sub-agents the HARNESS is running, read off the transcript.
 *
 * These are a different animal to a delegated run and the difference is why they were invisible:
 * `agent_run` creates a real Realm session, with a row, a pane and a place in the layout, and the
 * dock below lists those. Claude's own `Task` tool creates none of that — the subagent lives and
 * dies inside the CLI process, and Realm never hears about it except as a tool call that has not
 * come back yet. So ten `Task` calls in flight showed nothing at all here.
 *
 * What they get is the same card and honestly less than a real run does: elapsed time and what they
 * were asked, but no jump — there is no pane to jump to. Pretending otherwise would be a button that
 * cannot work.
 */
function harnessSubagents(blocks: readonly Block[], now: number): { id: string; label: string; ms: number }[] {
  return blocks
    .filter((b): b is Extract<Block, { kind: "tool" }> =>
      b.kind === "tool" && SUBAGENT_TOOLS.has(b.name) && b.result === null
      // A call made UNDER another Task is that Task's business, not a second row here.
      && b.parentToolUseId === undefined)
    .map((b) => ({
      id: b.toolUseId,
      // `name` is what a Workflow calls itself; `description` is Task's. Falling through both before
      // the prompt, because a prompt's first eighty characters are usually boilerplate.
      label: labelOf(b.input).slice(0, 80),
      ms: Math.max(0, now - b.ts),
    }));
}

/** What to call an in-flight sub-agent run. A Workflow names itself in its script's `meta`, which is
 *  the only place its name exists — so it is dug out rather than left as "Sub-agent". */
function labelOf(input: Record<string, unknown>): string {
  const direct = input.description ?? input.name;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const script = typeof input.script === "string" ? input.script : "";
  const named = script.match(/name:\s*['"`]([^'"`]+)['"`]/)?.[1];
  if (named) return named;
  const prompt = input.prompt;
  return typeof prompt === "string" && prompt.trim() ? prompt.trim() : "Sub-agent";
}

export function DelegatedRuns({ sessionId }: { sessionId: string }) {
  const running = useApp((s) => s.delegatedRuns[sessionId]);
  const blocks = useApp((s) => s.transcripts[sessionId]?.t.blocks ?? NO_BLOCKS);
  const refreshDelegatedRuns = useApp((s) => s.refreshDelegatedRuns);
  const run = useApp((s) => s.run);
  // Covers the runs that began before this window connected — a reload, a second window, a pane
  // opened ten minutes into a delegation. Every later change arrives on `delegation.changed`.
  useEffect(() => { run(() => refreshDelegatedRuns(sessionId)); }, [sessionId, refreshDelegatedRuns, run]);
  const inHarness = useMemo(() => harnessSubagents(blocks, Date.now()), [blocks]);
  if ((!running || running.length === 0) && inHarness.length === 0) return null;
  return <Dock sessionId={sessionId} running={running ?? NO_RUNS} harness={inHarness} />;
}

/**
 * Scroll the transcript to a tool card and open it.
 *
 * By DOM rather than through the store, because a tool card's open/closed state is component-local
 * (ToolCard owns it, so a card keeps its state as the transcript re-renders around it) and there is
 * no store field to set. `click()` on the row's own button is the same gesture a user would make.
 */
function revealToolCard(toolUseId: string): void {
  const card = document.querySelector<HTMLElement>(`[data-tool-use-id="${CSS.escape(toolUseId)}"]`);
  if (!card) return;
  // Optional-called: jsdom has no `scrollIntoView`, and a throw here would take the OPEN with it —
  // the part that matters. Scrolling is the nicety; showing the card is the job.
  card.scrollIntoView?.({ block: "center", behavior: "smooth" });
  const toggle = card.querySelector<HTMLButtonElement>("button[aria-expanded]");
  if (toggle && toggle.getAttribute("aria-expanded") === "false") toggle.click();
}

const NO_BLOCKS: readonly Block[] = [];
const NO_RUNS: readonly DelegatedRun[] = [];

/** Split out so the hooks below only ever run for a session that actually has runs — and so the
 *  open/closed choice is discarded with the dock rather than surviving until the next delegation. */
function Dock({ sessionId, running, harness }: {
  sessionId: string;
  running: readonly DelegatedRun[];
  /** Sub-agents the harness is running in-process — no session, no pane, no jump. */
  harness: { id: string; label: string; ms: number }[];
}) {
  const sessions = useApp((s) => s.sessions);
  const sessionStatus = useApp((s) => s.sessionStatus);
  const items = useApp((s) => s.items);
  const openItemBeside = useApp((s) => s.openItemBeside);
  const revealSession = useApp((s) => s.revealSession);
  const run = useApp((s) => s.run);
  const [open, setOpen] = useState(true);
  const rows = [...running].sort((a, b) => a.startedAt - b.startedAt);
  const total = rows.length + harness.length;
  // The oldest thing in flight, whichever kind it is — the header's clock is "how long has this
  // session been waiting on anyone", and starting it at the newest would keep resetting it.
  const since = Math.min(...rows.map((r) => r.startedAt), ...harness.map((h) => Date.now() - h.ms));
  // Always ticking: this component only exists while the engine is holding runs open, so the clock
  // stops by unmounting rather than by a flag. One clock for every row too — reading `Date.now()`
  // per row instead would have them disagree with the header by however long the render took.
  const elapsed = useElapsed(since, true);
  const now = since + elapsed;
  const count = total === 1 ? "1 agent" : `${total} agents`;
  const title = sessions[sessionId]?.title ?? "this session";

  const jump = (childId: string) => {
    const it = items.find((i) => i.kind === "session" && i.refId === childId);
    // Beside, never in place: the point of going to look is to watch the child WITH the parent that
    // spawned it, and openItem would evict the pane the user pressed the button in. A child in
    // another space has no item here, and revealing it is the only way through.
    run(() => (it ? openItemBeside(it.id) : revealSession(childId, null)));
  };

  return (
    <div className="delegation-dock">
      {/* "running", not "waiting on": an `agent_start` the parent deliberately backgrounded is in
          this list too, and that parent is not blocked on anything. Everything here has an
          unsettled drain, which is precisely what "still running" means. */}
      <button type="button" className="delegation-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        aria-label={`${count} in flight for ${title}`}>
        <Icon name="bot" size={12} />
        <span className="delegation-summary">{count} running</span>
        <span className="delegation-elapsed">{formatDuration(elapsed)}</span>
        <Icon name="chevronRight" size={12} className="tool-chevron" />
      </button>
      {open && (
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
                <button type="button" className="delegation-item" title={meta.label}
                  aria-label={`${child?.title ?? "Starting"} — ${meta.label}`} onClick={() => jump(r.sessionId)}>
                  <Icon name={meta.icon} size={14} />
                  {/* The row lands before the session row does often enough to matter: `agent_run`
                      registers the run and only then sends the child its first message. */}
                  <span className="delegation-title">{child?.title ?? "Starting…"}</span>
                  {/* `detached` is the difference between "this session is blocked until you finish"
                      and "go at your own pace" — the parent kept working after agent_start. */}
                  {r.detached && <span className="delegation-dim">not collected yet</span>}
                  <span className="delegation-dim">{formatDuration(now - r.startedAt)}</span>
                  {status && <span className="status-dot item-status" data-status={status} title={SESSION_STATUS_LABEL[status]} />}
                </button>
              </li>
            );
          })}
          {/* The harness's own sub-agents, after the runs that have panes. No jump and no status dot:
              there is no session behind one of these, and a control that could only no-op is worse
              than none. The elapsed clock is the honest part — it is what "still running" means. */}
          {harness.map((h) => (
            <li key={h.id}>
              {/* It CAN be looked at, just not in a pane: the tool card in the transcript is where
                  this run's own calls appear as they land, so the row scrolls to it and opens it.
                  A jump to a pane would be a button that cannot work — there is no session here. */}
              <button type="button" className="delegation-item" aria-label={`Show ${h.label} in the transcript`}
                onClick={() => revealToolCard(h.id)}>
                <Icon name="bot" size={14} />
                <span className="delegation-title">{h.label}</span>
                <span className="delegation-dim">in the agent</span>
                <span className="delegation-dim">{formatDuration(h.ms)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
