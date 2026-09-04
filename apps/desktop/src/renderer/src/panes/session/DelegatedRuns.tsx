import { Icon } from "@realm/ui";
import { useEffect, useState } from "react";
import type { DelegatedRun } from "@realm/contracts";
import { useApp } from "../../state/store";
import { ORIGIN_META, SESSION_STATUS_LABEL } from "../session-labels";
import { formatDuration } from "./tool-group";
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
export function DelegatedRuns({ sessionId }: { sessionId: string }) {
  const running = useApp((s) => s.delegatedRuns[sessionId]);
  const refreshDelegatedRuns = useApp((s) => s.refreshDelegatedRuns);
  const run = useApp((s) => s.run);
  // Covers the runs that began before this window connected — a reload, a second window, a pane
  // opened ten minutes into a delegation. Every later change arrives on `delegation.changed`.
  useEffect(() => { run(() => refreshDelegatedRuns(sessionId)); }, [sessionId, refreshDelegatedRuns, run]);
  if (!running || running.length === 0) return null;
  return <Dock sessionId={sessionId} running={running} />;
}

/** Split out so the hooks below only ever run for a session that actually has runs — and so the
 *  open/closed choice is discarded with the dock rather than surviving until the next delegation. */
function Dock({ sessionId, running }: { sessionId: string; running: readonly DelegatedRun[] }) {
  const sessions = useApp((s) => s.sessions);
  const sessionStatus = useApp((s) => s.sessionStatus);
  const items = useApp((s) => s.items);
  const openItemBeside = useApp((s) => s.openItemBeside);
  const revealSession = useApp((s) => s.revealSession);
  const run = useApp((s) => s.run);
  const [open, setOpen] = useState(true);
  const rows = [...running].sort((a, b) => a.startedAt - b.startedAt);
  const since = rows[0]!.startedAt;
  // Always ticking: this component only exists while the engine is holding runs open, so the clock
  // stops by unmounting rather than by a flag. One clock for every row too — reading `Date.now()`
  // per row instead would have them disagree with the header by however long the render took.
  const elapsed = useElapsed(since, true);
  const now = since + elapsed;
  const count = rows.length === 1 ? "1 agent" : `${rows.length} agents`;
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
        <Icon name="bot" size={13} />
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
        </ul>
      )}
    </div>
  );
}
