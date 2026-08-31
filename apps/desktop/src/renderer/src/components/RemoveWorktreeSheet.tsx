import type { WorktreeStatus } from "@realm/contracts";
import { useApp } from "../state/store";
import { Sheet } from "./Sheet";

const files = (n: number) => (n === 1 ? "1 uncommitted file" : `${n} uncommitted files`);
const commits = (n: number) => (n === 1 ? "1 unpushed commit" : `${n} unpushed commits`);

/** What removal would destroy, in words — the sentence the confirm button is answering. */
export function hazardSentence(status: WorktreeStatus): string {
  const parts: string[] = [];
  if (status.dirtyFiles > 0) parts.push(files(status.dirtyFiles));
  if (status.unpushedCommits > 0) parts.push(commits(status.unpushedCommits));
  if (parts.length === 0) return "Nothing here is unsaved: every change is committed and pushed.";
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
 */
export function RemoveWorktreeSheet({ environmentId }: { environmentId: string }) {
  const status = useApp((s) => s.worktreeStatuses[environmentId]);
  const env = useApp((s) => s.environments[environmentId]);
  const stale = useApp((s) => s.worktreeAckStale === environmentId);
  const confirmRemoveWorktree = useApp((s) => s.confirmRemoveWorktree);
  const closeSheet = useApp((s) => s.closeSheet);
  const run = useApp((s) => s.run);
  if (!status) return null;
  const risky = status.dirtyFiles > 0 || status.unpushedCommits > 0;
  return (
    <Sheet title="Remove this worktree?" onClose={closeSheet} width={460}>
      <div className="form">
        <div className="wt-target">
          <span className="composer-chip"><span className="chip-label">{status.branch ?? "no branch"}</span></span>
          <code className="wt-path">{status.path}</code>
        </div>
        {!status.present && <p className="wt-note">The directory is already gone; removing only clears git's record of it.</p>}
        <p className="wt-hazard" data-risky={risky || undefined}>{hazardSentence(status)}</p>
        {stale && (
          <p className="wt-stale" role="alert">
            The worktree changed while this was open — the counts above are the new ones. Confirm again to proceed.
          </p>
        )}
        {!status.removable && (
          <p className="wt-blocked" role="alert">
            {status.blockedBy === "ENVIRONMENT_IN_USE"
              ? "A session still runs here. Close it first."
              : "Realm did not create this checkout, so it will not remove it."}
          </p>
        )}
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={closeSheet}>Keep it</button>
          <button type="button" className="btn destructive" disabled={!status.removable}
            onClick={() => run(() => confirmRemoveWorktree(environmentId))}>
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
