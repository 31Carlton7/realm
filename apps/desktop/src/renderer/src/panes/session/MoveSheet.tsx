import { AGENT_META, basenameOf, type MoveOptions, type MovePlace, type MoveTarget, type MoveWhen } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useState } from "react";
import { Sheet } from "../../components/Sheet";
import { Spinner } from "../../components/Spinner";
import { useApp } from "../../state/store";
import { shortPath } from "./move-place";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const filesWord = (n: number) => (n === 1 ? "1 changed file" : `${n} changed files`);

/** A checkout by its folder's name and branch, with its path quiet under them, cut in the middle so the tail shows. */
function Place({ path, branch }: { path: string; branch: string | null }) {
  return <>
    <span className="move-name">{basenameOf(path)}</span>{branch && <span className="move-branch">{branch}</span>}
    <code className="move-path" title={path}>{shortPath(path)}</code>
  </>;
}

/** The destination in the words the prompter's queue uses while a move waits. */
function moveTargetLabel(to: MoveTarget, options: Pick<MoveOptions, "environments">): string {
  if (to.kind === "worktree") return "a new worktree";
  const env = options.environments.find((e) => e.environmentId === to.environmentId);
  return env ? env.branch ?? basenameOf(env.path) : "another checkout";
}

function Destination({ to, options }: { to: MoveTarget; options: MoveOptions }) {
  if (to.kind === "worktree") {
    return <span className="move-new">New worktree{options.from.branch && <> off <span className="move-branch">{options.from.branch}</span></>}</span>;
  }
  const env = options.environments.find((e) => e.environmentId === to.environmentId);
  return env ? <Place path={env.path} branch={env.branch} /> : <span className="move-new">Another checkout</span>;
}

function Ends({ from, to, options }: { from: MovePlace; to: MoveTarget; options: MoveOptions }) {
  return (
    <dl className="move-ends">
      <dt>From</dt><dd><Place path={from.cwd} branch={from.branch} /></dd>
      <dt>To</dt><dd><Destination to={to} options={options} /></dd>
    </dl>
  );
}

/**
 * Moving a started session to another checkout of its space, or to a new worktree, on this Mac.
 * A permission still open has to be answered before the move can wait for the turn, because a turn
 * waiting on a person never ends on its own; Stop and move denies it instead.
 */
export function MoveSheet({ sessionId, to }: { sessionId: string; to: MoveTarget }) {
  const closeSheet = useApp((s) => s.closeSheet);
  const sessionMoveOptions = useApp((s) => s.sessionMoveOptions);
  const moveSession = useApp((s) => s.moveSession);
  const cancelSessionMove = useApp((s) => s.cancelSessionMove);
  const run = useApp((s) => s.run);
  const agentKind = useApp((s) => s.sessions[sessionId]?.agentKind);
  const status = useApp((s) => s.sessionStatus[sessionId]);
  const asking = useApp((s) => (s.transcripts[sessionId]?.t.pendingPermissions.length ?? 0) > 0);
  const [options, setOptions] = useState<MoveOptions | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [keepSourceChanges, setKeepSourceChanges] = useState(true);

  useEffect(() => {
    let live = true;
    sessionMoveOptions(sessionId).then((o) => { if (live) setOptions(o); }, (e: unknown) => { if (live) setFailure(`Realm couldn't read what this move would take: ${reason(e)}`); });
    return () => { live = false; };
  }, [sessionId, sessionMoveOptions]);

  const agent = agentKind ? AGENT_META[agentKind].label : "The agent";
  const busy = status === "running" || status === "waiting_permission" || (options?.busy ?? false);
  const waitingOnYou = status === "waiting_permission" || asking;
  const unavailable = to.kind === "worktree" && options && !options.worktree.available ? options.worktree.reason ?? "A worktree can't be made here." : null;
  const blocked = options?.blocked ?? unavailable;
  const ready = options !== null && !blocked && !options.pending;
  const move = (when: MoveWhen) => {
    if (!options) return;
    void run(() => moveSession(sessionId, to, { keepSourceChanges, when, toLabel: moveTargetLabel(to, options), busy }));
  };
  const named = (options?.leftBehind ?? []).filter((n) => !/terminal/i.test(n));

  return (
    <Sheet title="Move this session" onClose={closeSheet} width={480}
      footer={<>
        <button type="button" className="btn" onClick={closeSheet}>Cancel</button>
        {busy ? <>
          <button type="button" className="btn" disabled={!ready} onClick={() => move("stop")}>Stop and move</button>
          <button type="button" className="btn primary" disabled={!ready || waitingOnYou} onClick={() => move("after-turn")}>Move after this turn</button>
        </> : (
          <button type="button" className="btn primary" disabled={!ready} onClick={() => move("now")}>Move</button>
        )}
      </>}>
      {!options && !failure && <p className="share-sheet-reading"><Spinner size={14} /> Reading the session…</p>}
      {options && (
        <div className="move-sheet">
          <Ends from={options.from} to={to} options={options} />
          <section className="move-group" aria-label="Goes with it">
            <h4 className="move-group-head">Goes with it</h4>
            <ul className="move-list">
              <li><Icon name="check" size={12} />The conversation. {agent} {options.conversation === "native" ? "resumes exactly" : "continues from notes"}.</li>
              {options.changedFiles > 0 && <li><Icon name="check" size={12} />{filesWord(options.changedFiles)}</li>}
              <li><Icon name="check" size={12} />Its attachments</li>
            </ul>
          </section>
          <section className="move-group" aria-label="Stays here">
            <h4 className="move-group-head">Stays here</h4>
            <ul className="move-list" data-stays>
              <li><Icon name="minus" size={12} />The terminal, which closes</li>
              <li><Icon name="minus" size={12} />Simulators and screens</li>
              <li><Icon name="minus" size={12} />Browser panes</li>
              <li><Icon name="minus" size={12} />Dev servers the agent started</li>
              <li><Icon name="minus" size={12} />Ignored files{named.length > 0 && <>, including {named.map((n, i) => <span key={n}>{i > 0 && ", "}<code>{n}</code></span>)}</>}</li>
              <li><Icon name="minus" size={12} />Rewinding to before the move</li>
            </ul>
          </section>
          <div className="settings-group move-options">
            <label className="settings-row">
              <div className="settings-row-main">
                <span className="settings-row-name">Leave my changes here too</span>
                <span className="settings-row-desc">Turn off to reset this checkout to its last commit. A checkpoint keeps your changes.</span>
              </div>
              <input type="checkbox" role="switch" className="switch" aria-label="Leave my changes here too"
                checked={keepSourceChanges} onChange={(e) => setKeepSourceChanges(e.target.checked)} />
            </label>
          </div>
          {busy && waitingOnYou && <p className="share-sheet-note">{agent} is waiting on a request. Answer it first to move after this turn, or Stop and move, which denies it.</p>}
          {busy && !waitingOnYou && <p className="share-sheet-note">{agent} is working. The move can wait for this turn to end, or stop it.</p>}
          {options.pending && (
            <p className="share-sheet-note move-pending">A move is already waiting for this turn.
              <button type="button" className="btn-quiet" onClick={() => void run(async () => { await cancelSessionMove(sessionId); closeSheet(); })}>Cancel that move</button>
            </p>
          )}
          {blocked && <p className="share-sheet-note" role="alert">{blocked}</p>}
        </div>
      )}
      {failure && <p className="share-sheet-note" role="alert" data-tone="danger">{failure}</p>}
    </Sheet>
  );
}
