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
 * The agents this session has in flight, on a tab attached to the top of its prompter.
 *
 * A delegated child has always been a real session with a pane of its own, but the parent's
 * transcript said nothing at all while it worked — the child's report arrives as one MCP tool result
 * at the very end, so for however long the child ran the parent showed a shimmer and no reason for
 * it. This is the reason, and the way over to it.
 *
 * It wears the PLAN strip's geometry (`.composer-todos`) rather than a shape of its own, because it
 * is the same kind of object: standing context about the run, pinned to the prompter so it cannot
 * scroll away from a reader who went back to re-read something. Two answers to "what is happening
 * right now" drawn two different ways is two things to learn; one band of tabs above the card is one.
 *
 * A tab rather than a pane of its own, deliberately. The engine's registry lives in the server's
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

export function DelegatedRuns({ sessionId }: { sessionId: string }) {
  const running = useApp((s) => s.delegatedRuns[sessionId]);
  const blocks = useApp((s) => s.transcripts[sessionId]?.t.blocks ?? NO_BLOCKS);
  const refreshDelegatedRuns = useApp((s) => s.refreshDelegatedRuns);
  const run = useApp((s) => s.run);
  // Covers the runs that began before this window connected — a reload, a second window, a pane
  // opened ten minutes into a delegation. Every later change arrives on `delegation.changed`.
  useEffect(() => { run(() => refreshDelegatedRuns(sessionId)); }, [sessionId, refreshDelegatedRuns, run]);
  const inHarness = useMemo(() => harnessSubagents(blocks), [blocks]);
  if ((!running || running.length === 0) && inHarness.length === 0) return null;
  return <Dock sessionId={sessionId} running={running ?? NO_RUNS} harness={inHarness} />;
}

const NO_BLOCKS: readonly Block[] = [];
const NO_RUNS: readonly DelegatedRun[] = [];

/** Split out so the hooks below only ever run for a session that actually has runs — and so the
 *  open/closed choice is discarded with the dock rather than surviving until the next delegation. */
function Dock({ sessionId, running, harness }: {
  sessionId: string;
  running: readonly DelegatedRun[];
  /** Sub-agents the harness is running in-process — no session, no pane, no jump. */
  harness: { id: string; label: string; startedAt: number }[];
}) {
  const sessions = useApp((s) => s.sessions);
  const sessionStatus = useApp((s) => s.sessionStatus);
  const items = useApp((s) => s.items);
  const openItemBeside = useApp((s) => s.openItemBeside);
  const revealSession = useApp((s) => s.revealSession);
  const docked = useApp((s) => s.sessionDock[sessionId]);
  const toggleSessionDock = useApp((s) => s.toggleSessionDock);
  const run = useApp((s) => s.run);
  const [open, setOpen] = useState(true);
  const watched = docked?.kind === "subagent" ? docked.toolUseId : null;
  const rows = [...running].sort((a, b) => a.startedAt - b.startedAt);
  const total = rows.length + harness.length;
  // The oldest thing in flight, whichever kind it is — the header's clock is "how long has this
  // session been waiting on anyone", and starting it at the newest would keep resetting it.
  const since = Math.min(...rows.map((r) => r.startedAt), ...harness.map((h) => h.startedAt));
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
    /* The plan strip's tab, not a list of its own: same fill, same inset, same collapse. `data-open`
       is what the stylesheet keys the caret and the clip on, exactly as `.composer-todos` does. */
    <div className="composer-agents" data-open={open || undefined}>
      {/* "running", not "waiting on": an `agent_start` the parent deliberately backgrounded is in
          this list too, and that parent is not blocked on anything. Everything here has an
          unsettled drain, which is precisely what "still running" means. */}
      <button type="button" className="composer-agents-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        aria-label={`${count} in flight for ${title}`}>
        <Icon name="bot" size={12} className="composer-agents-mark" />
        <span className="composer-agents-count">{count} running</span>
        <span className="composer-agents-elapsed">{formatDuration(elapsed)}</span>
        <Icon name="chevronRight" size={12} className="composer-agents-caret" />
      </button>
      <div className="composer-agents-wrap">
        <div className="composer-agents-clip" inert={!open || undefined}>
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
                  {/* A delegated child is a whole session — a transcript, a composer, permissions of
                      its own — so it opens as the pane it already has, beside this one. The panel
                      below would be a lesser copy of a thing that exists. */}
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
            {/* The harness's own sub-agents. No session behind one of these and so no status dot —
                but there IS something to watch: the calls it makes arrive in this transcript nested
                under its launching call, and that is a sub-agent's whole working life. The row opens
                them on the panel docked to this pane's right edge. */}
            {harness.map((h) => (
              <li key={h.id}>
                <button type="button" className="delegation-item" data-selected={watched === h.id || undefined}
                  aria-label={`Watch ${h.label}`} aria-pressed={watched === h.id}
                  onClick={() => toggleSessionDock(sessionId, { kind: "subagent", toolUseId: h.id })}>
                  <Icon name="bot" size={14} />
                  <span className="delegation-title">{h.label}</span>
                  <span className="delegation-dim">in the agent</span>
                  <span className="delegation-dim">{formatDuration(Math.max(0, now - h.startedAt))}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
