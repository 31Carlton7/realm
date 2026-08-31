import type { Checkpoint, RestorePreview, RestoreResult } from "@realm/contracts";
import { useApp } from "../state/store";
import { Sheet } from "./Sheet";

const KIND_LABEL: Record<Checkpoint["kind"], string> = {
  turn: "Turn", "pre-restore": "Undo point", manual: "Manual",
};

/** Coarse on purpose: a checkpoint list is scanned, not read. Seconds would be noise at the top and
 *  a lie by the time anyone looked twice. */
export function relativeTime(from: number, now: number): string {
  const s = Math.max(0, Math.round((now - from) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * What restoring would destroy, in words — the sentence the confirm button is answering.
 *
 * Two halves, and both must be said. The first is the cost: files rewritten, commits rolled back.
 * The second is the reassurance, and it is only offered because it is true — the server captures the
 * current state before it overwrites anything, so this is undoable.
 */
export function restoreSentence(p: RestorePreview): string {
  const parts: string[] = [];
  if (p.filesChanged > 0) parts.push(p.filesChanged === 1 ? "1 file" : `${p.filesChanged} files`);
  if (p.commitsRolledBack > 0) parts.push(p.commitsRolledBack === 1 ? "1 commit" : `${p.commitsRolledBack} commits`);
  if (parts.length === 0) return "This checkout already matches the checkpoint — restoring changes nothing.";
  return `This rewrites ${parts.join(" and ")} to match the checkpoint.`;
}

function RestoreReport({ result }: { result: RestoreResult }) {
  return (
    <p className="cp-report" role="status">
      Restored {result.filesChanged === 1 ? "1 file" : `${result.filesChanged} files`}
      {result.filesRemoved > 0 && `, removing ${result.filesRemoved === 1 ? "1 file" : `${result.filesRemoved} files`} that postdated it`}
      {result.headMoved && result.commitsRolledBack > 0 && `, and rolled back ${result.commitsRolledBack === 1 ? "1 commit" : `${result.commitsRolledBack} commits`}`}
      . The state it replaced is the newest undo point above.
    </p>
  );
}

/** The confirm half of the sheet: one checkpoint, everything restoring it would cost, and the two
 *  honest caveats — that the agent will not forget, and that HEAD may not move. */
function Confirm({ preview }: { preview: RestorePreview }) {
  const stale = useApp((s) => s.checkpointAckStale);
  const cancel = useApp((s) => s.cancelRestoreCheckpoint);
  const confirm = useApp((s) => s.confirmRestoreCheckpoint);
  const run = useApp((s) => s.run);
  const risky = preview.filesChanged > 0 || preview.commitsRolledBack > 0;
  return (
    <div className="form">
      <div className="cp-target">
        <span className="composer-chip"><span className="chip-label">{relativeTime(preview.createdAt, Date.now())}</span></span>
        <span className="cp-label">{preview.label}</span>
      </div>
      {!preview.intact && (
        <p className="cp-blocked" role="alert">
          This checkpoint&rsquo;s git objects are no longer in the repository, so there is nothing to restore.
        </p>
      )}
      <p className="cp-hazard" data-risky={risky || undefined}>{restoreSentence(preview)}</p>
      <p className="cp-note">
        Nothing is lost: the checkout as it is right now is captured first, and appears above as an undo point.
      </p>
      {!preview.rewindsConversation && (
        <p className="cp-note">
          Files only — the agent keeps its memory of these turns. No agent Realm supports can rewind a conversation.
        </p>
      )}
      {!preview.headMovable && preview.headReason && (
        <p className="cp-note">The branch will not move: {preview.headReason}.</p>
      )}
      {stale && (
        <p className="cp-stale" role="alert">
          The checkout changed while this was open — the numbers above are the new ones. Confirm again to proceed.
        </p>
      )}
      <div className="sheet-actions">
        <button type="button" className="btn" onClick={cancel}>Back</button>
        <button type="button" className="btn destructive" disabled={!preview.intact}
          onClick={() => run(() => confirm(preview.checkpointId))}>
          {risky ? "Restore and overwrite" : "Restore"}
        </button>
      </div>
    </div>
  );
}

/**
 * A checkout's checkpoints, and the confirm for restoring one (Plan 7 W4).
 *
 * One sheet in two states rather than two sheets, because the store holds a single overlay slot and
 * because the confirm is only ever reached from the row it is about — putting them side by side keeps
 * "which checkpoint" answerable while the confirm is up.
 */
export function CheckpointsSheet({ environmentId, sessionId }: { environmentId: string; sessionId: string | null }) {
  const list = useApp((s) => s.checkpoints[environmentId]);
  const preview = useApp((s) => s.checkpointPreview);
  const result = useApp((s) => s.restoreResult);
  const ask = useApp((s) => s.askRestoreCheckpoint);
  const capture = useApp((s) => s.captureCheckpoint);
  const closeSheet = useApp((s) => s.closeSheet);
  const run = useApp((s) => s.run);
  const now = Date.now();

  return (
    <Sheet title={preview ? "Restore this checkpoint?" : "Checkpoints"} onClose={closeSheet} width={520}>
      {preview
        ? <Confirm preview={preview} />
        : (
          <div className="form">
            {result && <RestoreReport result={result} />}
            {list === undefined && <p className="cp-note">Reading checkpoints…</p>}
            {list?.length === 0 && (
              <p className="cp-note">
                No checkpoints yet. Realm takes one before every message it sends the agent
                {sessionId ? " in this session" : ""}.
              </p>
            )}
            <ul className="cp-list">
              {(list ?? []).map((c) => (
                <li className="cp-row" key={c.id} data-kind={c.kind}>
                  <span className="cp-kind">{KIND_LABEL[c.kind]}</span>
                  <span className="cp-label">{c.label}</span>
                  <span className="cp-when">{relativeTime(c.createdAt, now)}</span>
                  <button type="button" className="btn-quiet" onClick={() => run(() => ask(c.id))}>Restore</button>
                </li>
              ))}
            </ul>
            <div className="sheet-actions">
              <button type="button" className="btn-quiet" onClick={() => run(() => capture(environmentId, sessionId))}>Checkpoint now</button>
              <span className="diff-head-spacer" />
              <button type="button" className="btn" onClick={closeSheet}>Done</button>
            </div>
          </div>
        )}
    </Sheet>
  );
}
