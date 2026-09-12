import { AGENT_META, SELECTABLE_AGENT_KINDS, type AgentKind, type Checkpoint, type RestorePreview, type RestoreResult } from "@realm/contracts";
import { useState } from "react";
import { useApp } from "../state/store";
import { Menu } from "./Menu";
import { Sheet } from "./Sheet";

/**
 * The agents a fork may land on: the ancestor's own first, then every other selectable kind.
 *
 * The ancestor's kind leads because a same-agent fork is the ordinary case and a menu that buried it
 * would be a menu punishing the common choice. It is listed rather than assumed because the point of
 * the menu is that the choice is now visible — a plain "Fork" button that silently means "on Claude"
 * hides exactly the decision this feature exists to offer.
 */
export function forkTargets(ancestor: AgentKind | null): AgentKind[] {
  const rest = SELECTABLE_AGENT_KINDS.filter((k) => k !== ancestor);
  return ancestor ? [ancestor, ...rest] : [...rest];
}

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
      {/* Both branches, because the old copy said no agent Realm supports can rewind a conversation and
          that is no longer true: Claude's truncating resume can, when this checkpoint recorded the
          cursors and the session still holds the provider conversation they name. The negative copy is
          deliberately unspecific — it is true of every way a rewind can be unavailable (wrong agent, no
          cursor recorded, a cursor the CLI refused, a conversation that has moved on) and naming one
          of them here would be a guess. */}
      <p className="cp-note">
        {preview.rewindsConversation
          ? "The conversation rewinds too: this session's transcript is cut back to this point, and the agent picks up from here with no memory of the turns after it."
          : "Files only — the agent keeps its memory of these turns."}
      </p>
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
  const fork = useApp((s) => s.forkFromCheckpoint);
  const capture = useApp((s) => s.captureCheckpoint);
  const closeSheet = useApp((s) => s.closeSheet);
  const run = useApp((s) => s.run);
  /* The ancestor's kind comes off the CHECKPOINT's session, not the sheet's. The sheet is often
     opened at environment level (`sessionId` null) over a list whose rows each belong to a different
     session, and reading the sheet's would name the wrong agent — or, at environment level, none. */
  const sessions = useApp((s) => s.sessions);
  /** Which row's fork menu is open, whose agent it forks from, and the button it hangs off. */
  const [forkMenu, setForkMenu] = useState<{ checkpointId: string; ancestor: AgentKind | null; at: HTMLElement } | null>(null);
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
                  {/* Fork (Plan 16 W3): only for checkpoints a session's turn took — a fork carries an
                      ancestor transcript, and a manual/environment checkpoint has none to carry. */}
                  {c.sessionId && (
                    <button type="button" className="btn-quiet" aria-haspopup="menu"
                      onClick={(e) => setForkMenu({ checkpointId: c.id, ancestor: sessions[c.sessionId!]?.agentKind ?? null, at: e.currentTarget })}>Fork…</button>
                  )}
                  <button type="button" className="btn-quiet" onClick={() => run(() => ask(c.id))}>Restore</button>
                </li>
              ))}
            </ul>
            {(list ?? []).some((c) => c.sessionId !== null) && (
              <p className="cp-note">
                Fork opens a NEW worktree restored to that checkpoint, with a new session beside the old
                one. It is a workspace fork: the agent&rsquo;s conversation cannot be rewound, so the
                ancestor transcript is carried into the new session as text (capped, and it says so).
                That is also what lets a fork run on a DIFFERENT agent — the transcript travels as
                text either way, so continuing on Codex costs nothing a same-agent fork does not.
              </p>
            )}
            {/* At sheet level rather than inside the row, so it outlives the row's re-render while a
                fork is in flight — and so exactly one is ever open. */}
            {forkMenu && (
              <Menu label="Fork onto" anchorRef={{ current: forkMenu.at }} onClose={() => setForkMenu(null)}
                items={forkTargets(forkMenu.ancestor).map((k) => ({
                  label: k === forkMenu.ancestor ? `Fork on ${AGENT_META[k].label}` : `Fork onto ${AGENT_META[k].label}`,
                  // Undefined rather than the kind for a same-agent fork, so the wire carries exactly
                  // what every existing fork carried and the server's default keeps meaning something.
                  onSelect: () => run(() => fork(forkMenu.checkpointId, k === forkMenu.ancestor ? undefined : k)),
                }))} />
            )}
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
