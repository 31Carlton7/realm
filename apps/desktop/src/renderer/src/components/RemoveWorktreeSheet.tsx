import { useState } from "react";
import type { WorktreeStatus } from "@realm/contracts";
import { useApp } from "../state/store";
import { SESSION_STATUS_LABEL } from "../panes/session-labels";
import { Sheet } from "./Sheet";

const files = (n: number) => (n === 1 ? "1 uncommitted file" : `${n} uncommitted files`);
const commits = (n: number) => (n === 1 ? "1 unpushed commit" : `${n} unpushed commits`);
const sessionsWord = (n: number) => (n === 1 ? "1 session" : `${n} sessions`);

/** What removal would destroy, in words — the sentence the confirm button is answering. A branch
 *  that is kept keeps its commits, so then only the uncommitted files are lost. */
export function hazardSentence(status: WorktreeStatus, deleteBranch = true): string {
  const parts: string[] = [];
  if (status.dirtyFiles > 0) parts.push(files(status.dirtyFiles));
  if (deleteBranch && status.unpushedCommits > 0) parts.push(commits(status.unpushedCommits));
  if (parts.length === 0) {
    return status.unpushedCommits > 0
      ? `Nothing is lost: the ${status.unpushedCommits === 1 ? "commit stays" : `${status.unpushedCommits} commits stay`} on the branch.`
      : "Nothing here is unsaved: every change is committed and pushed.";
  }
  return `This will destroy ${parts.join(" and ")}. There is no undo.`;
}

/**
 * The one destructive confirm in Plan 7 (W3), and the only place `git worktree remove --force` and
 * `branch -D` are reachable from.
 *
 * It names exactly what would be lost, and the *store* — not this component — re-reads those counts
 * at the moment of confirming, because an agent running in that worktree may have written another
 * file while this sheet was open. If the numbers moved, nothing is removed and the sheet says so:
 * the user gets to say yes to a number they have actually seen.
 *
 * Two choices ride on the confirm, each named for what it does. The branch goes too by default only
 * when it holds nothing of its own; one with unpushed commits is kept unless asked, because keeping
 * it is what keeps them. And a worktree that sessions still work in can only go with them, since a
 * session's transcript describes the tree it ran in: the sheet lists them, offers Stop on one that is
 * running, and removes nothing until deleting them too has been ticked.
 */
export function RemoveWorktreeSheet({ environmentId }: { environmentId: string }) {
  const status = useApp((s) => s.worktreeStatuses[environmentId]);
  const env = useApp((s) => s.environments[environmentId]);
  const stale = useApp((s) => s.worktreeAckStale === environmentId);
  const sessions = useApp((s) => s.sessions);
  const sessionStatus = useApp((s) => s.sessionStatus);
  const confirmRemoveWorktree = useApp((s) => s.confirmRemoveWorktree);
  const interruptSession = useApp((s) => s.interruptSession);
  const closeSheet = useApp((s) => s.closeSheet);
  const run = useApp((s) => s.run);
  const [deleteBranch, setDeleteBranch] = useState(() => (status?.unpushedCommits ?? 0) === 0);
  const [deleteSessions, setDeleteSessions] = useState(false);
  if (!status) return null;
  const here = Object.values(sessions).filter((x) => x.environmentId === environmentId);
  const busy = (id: string) => sessionStatus[id] === "running" || sessionStatus[id] === "waiting_permission";
  const anyBusy = here.some((x) => busy(x.id));
  const risky = status.dirtyFiles > 0 || (deleteBranch && status.unpushedCommits > 0);
  // In use by sessions this window does not hold (another profile's): nothing here can clear that.
  const heldElsewhere = status.blockedBy === "ENVIRONMENT_IN_USE" && here.length === 0;
  const notOurs = !status.removable && status.blockedBy !== "ENVIRONMENT_IN_USE";
  const ready = !notOurs && !heldElsewhere && (here.length === 0 || (deleteSessions && !anyBusy));
  return (
    <Sheet title="Remove this worktree?" onClose={closeSheet} width={460}>
      <div className="form">
        <div className="wt-target">
          <span className="composer-chip"><span className="chip-label">{status.branch ?? "no branch"}</span></span>
          <code className="wt-path">{status.path}</code>
        </div>
        {!status.present && <p className="wt-note">The directory is already gone; removing only clears git's record of it.</p>}
        <p className="wt-hazard" data-risky={risky || undefined}>{hazardSentence(status, deleteBranch)}</p>
        {stale && (
          <p className="wt-stale" role="alert">
            The worktree changed while this was open — the counts above are the new ones. Confirm again to proceed.
          </p>
        )}
        {status.branch && !notOurs && (
          <label className="wt-choice">
            <input type="checkbox" className="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
            <span>Also delete the branch <code className="wt-branch">{status.branch}</code></span>
          </label>
        )}
        {here.length > 0 && (
          <div className="wt-sessions">
            <p className="wt-note">{sessionsWord(here.length)} still {here.length === 1 ? "works" : "work"} here, and go{here.length === 1 ? "es" : ""} with it.</p>
            <ul className="wt-session-list">
              {here.map((x) => (
                <li key={x.id} className="wt-session">
                  <span className="wt-session-title">{x.title}</span>
                  <span className="wt-session-state">{SESSION_STATUS_LABEL[sessionStatus[x.id] ?? x.status]}</span>
                  {busy(x.id) && (
                    <button type="button" className="btn-quiet" onClick={() => run(() => interruptSession(x.id))}>Stop</button>
                  )}
                </li>
              ))}
            </ul>
            <label className="wt-choice">
              <input type="checkbox" className="checkbox" checked={deleteSessions} disabled={anyBusy} onChange={(e) => setDeleteSessions(e.target.checked)} />
              <span>Delete {here.length === 1 ? "this session" : `these ${here.length} sessions`} and {here.length === 1 ? "its transcript" : "their transcripts"} too</span>
            </label>
            {anyBusy && <p className="wt-blocked" role="alert">A session here is running. Stop it first.</p>}
          </div>
        )}
        {heldElsewhere && (
          <p className="wt-blocked" role="alert">A session in another profile still works here. Remove it from there.</p>
        )}
        {notOurs && (
          <p className="wt-blocked" role="alert">Realm did not create this checkout, so it will not remove it.</p>
        )}
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={closeSheet}>Keep it</button>
          <button type="button" className="btn destructive" disabled={!ready}
            onClick={() => run(() => confirmRemoveWorktree(environmentId, { deleteBranch, deleteSessions: here.length > 0 && deleteSessions }))}>
            {risky ? "Remove and lose that work" : "Remove"}
          </button>
        </div>
        {env?.portBlockStart !== null && env?.portBlockStart !== undefined && (
          <p className="wt-note">Ports {env.portBlockStart}–{env.portBlockStart + 9} return to the pool.</p>
        )}
      </div>
    </Sheet>
  );
}
