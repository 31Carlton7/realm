import { AGENT_META, SPACE_COLORS, isRunTerminal, type Checkpoint, type Environment, type Run, type RunAttemptOutcome, type RunState, type Session, type Ship } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useRef, useState } from "react";
import { useApp, type SpacePageTab } from "../../state/store";
import { relativeTime } from "../../components/CheckpointsSheet";
import { ORIGIN_META, SESSION_STATUS_LABEL } from "../session-labels";
import { McpSection } from "../../components/sidebar/McpSection";
import { BrowserOrigins } from "../../components/sidebar/BrowserOrigins";
import { IconPicker } from "../../components/IconPicker";
import { SpaceIcon } from "../../components/SpaceIcon";
import { SkillsPanel } from "../../components/settings/SkillsPanel";
import { MemoryPanel } from "../../components/settings/MemoryPanel";
import type { PaneProps } from "../registry";

const HEX = /^#[0-9a-f]{6}$/i;

const KIND_LABEL = { primary: "Space folder", checkout: "Linked checkout", worktree: "Worktree" } as const;

/**
 * Every checkout this space knows about (Plan 7 W1/W2), and which sessions are in each (W3).
 *
 * This is the only place the split Plan 7 made is actually visible as a list — the prompter shows a
 * session its OWN environment, which answers "where am I" but never "what else is running". Removal
 * lives here too, because a worktree outlives the session that opened it: after that session is
 * deleted there is otherwise nothing left pointing at the directory.
 *
 * `environments.list` is empty for a brand-new space — the primary row is created lazily on first
 * use — so an empty list is a normal state and says so rather than rendering nothing.
 */
export function EnvironmentList({ spaceId }: { spaceId: string }) {
  const environments = useApp((s) => s.environments);
  const sessions = useApp((s) => s.sessions);
  const openDiff = useApp((s) => s.openDiff);
  const askRemoveWorktree = useApp((s) => s.askRemoveWorktree);
  const run = useApp((s) => s.run);
  const list = Object.values(environments).filter((e) => e.spaceId === spaceId);
  return (
    <div className="field">
      <span>Checkouts</span>
      {list.length === 0
        ? <p className="env-empty">This space has not run anything yet, so it has no checkout on record.</p>
        : (
          <ul className="env-list">
            {list.map((e) => {
              const here = Object.values(sessions).filter((s) => s.environmentId === e.id);
              return (
                <li key={e.id} className="env-row">
                  <div className="env-main">
                    <Icon name={e.kind === "worktree" ? "branch" : "folder"} size={14} />
                    <span className="env-name">{e.branch ?? e.path.replace(/\/+$/, "").split("/").pop()}</span>
                    <span className="env-kind">{KIND_LABEL[e.kind]}</span>
                  </div>
                  <div className="env-meta">
                    <code className="env-path">{e.path}</code>
                    {/* A RANGE Realm reserved, not a claim about what is listening on it. */}
                    {e.portBlockStart !== null && <span className="env-ports">ports {e.portBlockStart}–{e.portBlockStart + 9} reserved</span>}
                    <span className="env-sessions">{here.length === 0 ? "no sessions" : here.length === 1 ? "1 session" : `${here.length} sessions`}</span>
                  </div>
                  <div className="env-actions">
                    <button type="button" className="btn-quiet" onClick={() => run(() => openDiff(e.id))}>Changes</button>
                    {e.kind === "worktree" && (
                      <button type="button" className="btn-quiet" onClick={() => run(() => askRemoveWorktree(e.id))}>Remove…</button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
    </div>
  );
}

/** The General tab — the retired sheet's general form, verbatim: name, icon, color, profile, the
 *  checkout list, and the delete-space danger zone. */
function GeneralTab({ spaceId }: { spaceId: string }) {
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  const profiles = useApp((s) => s.profiles);
  const updateSpace = useApp((s) => s.updateSpace);
  const deleteSpace = useApp((s) => s.deleteSpace);
  const run = useApp((s) => s.run);
  const [name, setName] = useState(space?.name ?? "");
  const [hex, setHex] = useState(space?.color ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { if (space) setHex(space.color); }, [space?.color]);
  if (!space) return null;

  const commitName = () => { const n = name.trim(); if (n && n !== space.name) run(() => updateSpace({ id: space.id, name: n })); else setName(space.name); };
  const commitHex = (v: string) => { const h = v.trim().toLowerCase(); setHex(h); if (HEX.test(h) && h !== space.color) run(() => updateSpace({ id: space.id, color: h })); };

  return (
    <div className="form">
      <label className="field"><span>Name</span>
        <input aria-label="Space name" value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      </label>
      <div className="field"><span>Icon</span>
        <IconPicker icon={space.icon} profileId={space.profileId} onPick={(ic) => run(() => updateSpace({ id: space.id, icon: ic }))} />
      </div>
      <div className="field"><span>Color</span>
        <div className="swatches" role="radiogroup" aria-label="Color">
          {SPACE_COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={space.color === c} aria-label={`Color ${c}`} className="swatch" data-selected={space.color === c || undefined}
              style={{ background: c }} onClick={() => commitHex(c)} />
          ))}
          <input aria-label="Custom color" className="hex" value={hex} onChange={(e) => commitHex(e.target.value)} placeholder="#rrggbb" spellCheck={false} />
        </div>
      </div>
      <label className="field"><span>Profile</span>
        <select aria-label="Profile" value={space.profileId} onChange={(e) => run(() => updateSpace({ id: space.id, profileId: e.target.value }))}>
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <EnvironmentList spaceId={space.id} />
      <div className="form-actions danger-zone">
        {confirmDelete ? (
          <>
            <span className="muted">Delete “{space.name}” and its items?</span>
            <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
            {/* No sheet to close (the page dies with the space): deleteSpace removes the space, its
                items — this page included — and activates a neighbour. */}
            <button type="button" className="btn danger" onClick={() => run(() => deleteSpace(space.id))}>Delete</button>
          </>
        ) : <button type="button" className="btn danger" onClick={() => setConfirmDelete(true)}>Delete space…</button>}
      </div>
    </div>
  );
}

/**
 * The Memory tab (Plan 12 W3): the transcription's standing-instruction framing over the existing
 * MemoryPanel. Realm's memory doc is ONE user-editable document today, so the framing tells the true
 * half of Universe's story — "yours, no model touches it" — and stops there.
 *
 * SEAM (out of scope here): Universe splits this page at a marker line — above it the user's standing
 * instructions, below it what the agent has learned working in the space. When Realm grows an
 * agent-written half, it renders as a SECOND document under this one (its own field + provenance),
 * never interleaved into the user's doc; nothing here fakes that section in the meantime.
 */
function MemoryTab({ spaceId }: { spaceId: string }) {
  const memory = useApp((s) => s.spaceMemory[spaceId]);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const empty = memory !== undefined && memory.doc.trim() === "";
  return (
    <div className="form">
      <p className="page-lede">Every session in this space reads this before it starts. What you write here is yours — no model touches it.</p>
      {empty && (
        <div className="page-empty">
          <p>Nothing here yet. A standing instruction — a convention, a warning, a preference — travels into every new session in this space.</p>
          <button type="button" className="btn primary" onClick={() => editorRef.current?.focus()}>Write a standing instruction</button>
        </div>
      )}
      <MemoryPanel spaceId={spaceId} editorRef={editorRef} />
    </div>
  );
}

/** The Sessions tab: this space's sessions from the existing store data, newest first; each row opens
 *  the session's pane. Status dots ride the same `sessionStatus` plumbing as the sidebar rows.
 *
 *  Archived sessions are LISTED here, tagged rather than hidden. This tab is the space's inventory —
 *  "every session in this space" — and the header count beside it says exactly that; a silent
 *  omission would make the two disagree. The sidebar is where archiving is meant to be felt. */
function SessionsTab({ spaceId }: { spaceId: string }) {
  const sessions = useApp((s) => s.sessions);
  const sessionStatus = useApp((s) => s.sessionStatus);
  const environments = useApp((s) => s.environments);
  const items = useApp((s) => s.items);
  const openItem = useApp((s) => s.openItem);
  const run = useApp((s) => s.run);
  const here = Object.values(sessions).filter((s) => s.spaceId === spaceId).sort((a, b) => b.createdAt - a.createdAt);
  // The session's ITEM — the same object the sidebar row opens — matched by refId, never by title or
  // position. It carries the archived flag, which lives on the item and not on the session.
  const itemOf = (session: Session) => items.find((i) => i.kind === "session" && i.refId === session.id);
  const open = (session: Session) => {
    const it = itemOf(session);
    if (it) run(() => openItem(it.id));
  };
  if (here.length === 0) return <p className="env-empty">No sessions in this space yet — start one with ⌘N or the button above.</p>;
  return (
    <ul className="page-list">
      {here.map((s) => {
        const status = sessionStatus[s.id];
        const env = s.environmentId ? Object.values(environments).find((e) => e.id === s.environmentId) : undefined;
        // aria-label replaces the row's contents, so every visible tag has to be spelled back into it.
        const archived = itemOf(s)?.archived ?? false;
        const label = [s.title, status && SESSION_STATUS_LABEL[status], archived && "archived"].filter(Boolean).join(" — ");
        return (
          <li key={s.id}>
            <button type="button" className="page-row" aria-label={label} onClick={() => open(s)}>
              <Icon name={AGENT_META[s.agentKind].icon} size={16} colored />
              <span className="page-row-title">{s.title}</span>
              {archived && <span className="status-pill" data-tone="muted">Archived</span>}
              {env?.branch && <span className="page-row-dim"><Icon name="branch" size={12} /> {env.branch}</span>}
              <span className="page-row-dim">{relativeTime(s.createdAt, Date.now())}</span>
              {status && <span className="status-dot item-status" data-status={status} title={SESSION_STATUS_LABEL[status]} />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** How a run's state reads in the lens. Deliberately not the raw state word: `blocked` is the one
 *  the user has to ACT on, so it says so. */
const RUN_STATE_LABEL: Record<RunState, string> = {
  queued: "Queued", running: "Running", blocked: "Needs you",
  succeeded: "Finished", failed: "Failed", cancelled: "Cancelled", expired: "Expired",
};
const RUN_STATE_ICON: Record<RunState, string> = {
  queued: "clock", running: "bot", blocked: "alert",
  succeeded: "checkCircle", failed: "alert", cancelled: "close", expired: "clock",
};
const ATTEMPT_WORD: Record<RunAttemptOutcome, string> = {
  running: "in flight", succeeded: "finished", failed: "failed", blocked: "asked for a person",
  cancelled: "cancelled", expired: "expired", abandoned: "abandoned (the server restarted)",
};

/**
 * The Tasks tab — a LENS over what this space has dispatched, in two halves.
 *
 * **Durable runs** (`runs.list`) are first-class rows: a run owns a goal across attempts and outlives
 * the process, so it is the thing the user tracks, and its session is a detail of it.
 *
 * **Dispatched sessions** are the older half (Plan 13 W2): this space's sessions with a non-null
 * dispatch origin, from store data the Sessions tab already holds. Sessions whose origin is `run` are
 * EXCLUDED here — they are already on screen as their run, and listing both is the same task twice.
 * Reaching one is the run detail panel's "Open session".
 *
 * Selecting a run opens the detail panel beside the list, which is where a run's answerable states
 * live: a `blocked` run cannot be approved from a row, and its result — the deliverable — has
 * nowhere to be read in one.
 *
 * Scoped HARD to `spaceId` — the named mutant is this lens listing another space's work, and both
 * halves read the prop, never "the active space".
 */
function TasksTab({ spaceId }: { spaceId: string }) {
  const sessions = useApp((s) => s.sessions);
  const sessionStatus = useApp((s) => s.sessionStatus);
  const environments = useApp((s) => s.environments);
  const items = useApp((s) => s.items);
  const openItem = useApp((s) => s.openItem);
  const runsBySpace = useApp((s) => s.runs);
  const selectedRunId = useApp((s) => s.selectedRunId[spaceId] ?? null);
  const refreshRuns = useApp((s) => s.refreshRuns);
  const selectRun = useApp((s) => s.selectRun);
  const run = useApp((s) => s.run);
  const runs = runsBySpace[spaceId];

  // Mount-fetch, once per space. The `runs.changed` handler is held-only, so nothing arrives for a
  // space until this has asked at least once.
  useEffect(() => { run(() => refreshRuns(spaceId)); }, [spaceId, refreshRuns, run]);

  const sessionRows = Object.values(sessions)
    .filter((s) => s.spaceId === spaceId && s.dispatchedBy !== null && s.dispatchedBy.kind !== "run")
    .sort((a, b) => b.createdAt - a.createdAt);
  const runRows = (runs ?? []).filter((r) => r.spaceId === spaceId);
  const selected = runRows.find((r) => r.id === selectedRunId) ?? null;

  const jumpTo = (sessionId: string) => {
    const it = items.find((i) => i.kind === "session" && i.refId === sessionId);
    if (it) run(() => openItem(it.id));
  };

  return (
    <div className="task-lens">
      <div className="task-lens-list">
        <NewRun spaceId={spaceId} />
        {runRows.length === 0 && sessionRows.length === 0 && (
          <p className="env-empty">Nothing has been dispatched here yet. ⌘⇧↩ in a composer dispatches the draft into its own session; delegated and reviewer sessions land here too. A run is a goal that keeps its own session across attempts and survives a restart.</p>
        )}
        {runRows.length > 0 && (
          <section>
            <h3 className="task-lens-heading">Runs</h3>
            <ul className="page-list">
              {runRows.map((r) => {
                const env = r.environmentId ? environments[r.environmentId] : undefined;
                const envLabel = env ? (env.branch ?? env.path.replace(/\/+$/, "").split("/").pop()) : null;
                return (
                  <li key={r.id}>
                    <button type="button" className="page-row" data-selected={r.id === selectedRunId || undefined}
                      aria-pressed={r.id === selectedRunId}
                      aria-label={`${r.title} — run — ${RUN_STATE_LABEL[r.state]}`}
                      onClick={() => run(() => selectRun(spaceId, r.id === selectedRunId ? null : r.id))}>
                      <Icon name={RUN_STATE_ICON[r.state]} size={16} />
                      <span className="page-row-title">{r.title}</span>
                      {envLabel && <span className="page-row-dim"><Icon name={env!.kind === "worktree" ? "branch" : "folder"} size={12} /> {envLabel}</span>}
                      {/* Attempts are only worth saying once there has been more than one — a run on
                          its first try should not read like it has already struggled. */}
                      {r.attempt > 1 && <span className="page-row-dim">attempt {r.attempt}/{r.maxAttempts}</span>}
                      <span className="page-row-dim" title={new Date(r.createdAt).toLocaleString()}>created {relativeTime(r.createdAt, Date.now())}</span>
                      <span className="run-state" data-state={r.state}>{RUN_STATE_LABEL[r.state]}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {sessionRows.length > 0 && (
          <section>
            {runRows.length > 0 && <h3 className="task-lens-heading">Dispatched sessions</h3>}
            <ul className="page-list">
              {sessionRows.map((s) => {
                const origin = s.dispatchedBy!;
                const meta = ORIGIN_META[origin.kind];
                const status = sessionStatus[s.id];
                const env = environments[s.environmentId];
                const envLabel = env ? (env.branch ?? env.path.replace(/\/+$/, "").split("/").pop()) : null;
                const settled = status !== undefined && status !== "running" && status !== "waiting_permission";
                const parentId = origin.sessionId;
                const parent = parentId ? sessions[parentId] : undefined;
                return (
                  <li key={s.id}>
                    <button type="button" className="page-row"
                      aria-label={status ? `${s.title} — ${meta.label} — ${SESSION_STATUS_LABEL[status]}` : `${s.title} — ${meta.label}`}
                      onClick={() => jumpTo(s.id)}>
                      <Icon name={meta.icon} size={16} />
                      <span className="page-row-title">{s.title}</span>
                      {parentId && (
                        // The agent origins link their parent. A span styled as a link, not a nested button
                        // (the row is already one); the parent may be deleted — then the words stand alone.
                        parent
                          ? <span className="page-row-dim page-row-link" role="link" tabIndex={0}
                              onClick={(e) => { e.stopPropagation(); jumpTo(parentId); }}
                              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); jumpTo(parentId); } }}>
                              from {parent.title}
                            </span>
                          : <span className="page-row-dim">parent session gone</span>
                      )}
                      {envLabel && <span className="page-row-dim"><Icon name={env!.kind === "worktree" ? "branch" : "folder"} size={12} /> {envLabel}</span>}
                      <span className="page-row-dim" title={new Date(s.createdAt).toLocaleString()}>started {relativeTime(s.createdAt, Date.now())}</span>
                      {settled && <span className="page-row-dim" title="From the session's last update — no separate settle clock exists">settled {relativeTime(s.updatedAt, Date.now())}</span>}
                      {status && <span className="status-dot item-status" data-status={status} title={SESSION_STATUS_LABEL[status]} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
      {selected && <RunDetail run={selected} spaceId={spaceId} onJump={jumpTo} />}
    </div>
  );
}

/**
 * Starting a run. Collapsed to one button until asked for, because the lens's job is watching work,
 * not composing it — but a lens over a thing nothing can create is a lens over an empty room, and
 * until a trigger subsystem exists this is the only way a run begins.
 *
 * Goal only. Every other knob a run has (`constraints`, `dedupeKey`, `deadlineAt`, `maxAttempts`)
 * belongs to whatever fires runs on a schedule; guessing at them in a form the user opened to type
 * one sentence would be inventing policy nobody asked for.
 */
function NewRun({ spaceId }: { spaceId: string }) {
  const createRun = useApp((s) => s.createRun);
  const run = useApp((s) => s.run);
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const submit = () => {
    const g = goal.trim();
    if (!g) return;
    setGoal(""); setOpen(false);
    run(() => createRun(spaceId, g));
  };
  if (!open) {
    return (
      <div className="task-lens-new">
        <button type="button" className="btn" onClick={() => setOpen(true)}><Icon name="add" size={14} /> New run</button>
      </div>
    );
  }
  return (
    <div className="task-lens-new task-lens-new-open">
      <label className="visually-hidden" htmlFor={`new-run-${spaceId}`}>Run goal</label>
      <textarea id={`new-run-${spaceId}`} className="task-detail-note" rows={3} autoFocus value={goal}
        placeholder="What should this run accomplish? It works unattended and stops to ask if it needs you."
        onChange={(e) => setGoal(e.target.value)}
        // ⌘↩ submits, Esc backs out — the composer's own gestures, so the muscle memory carries.
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
          if (e.key === "Escape") { e.preventDefault(); setOpen(false); setGoal(""); }
        }} />
      <div className="task-detail-actions">
        <button type="button" className="btn primary" disabled={goal.trim() === ""} onClick={submit}>Start run</button>
        <button type="button" className="btn" onClick={() => { setOpen(false); setGoal(""); }}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * The run detail panel — where a run's answerable states live.
 *
 * Three things a row cannot carry: the GOAL as written, the RESULT (a run's whole deliverable is its
 * final report, and a one-line row would truncate the thing the user is waiting for), and the
 * ACTIONS. `blocked` is the one that matters most: an unattended run that stopped to ask a person is
 * useless if the person has nowhere to answer, so Approve/Decline is the panel's primary control and
 * the note field rides with it.
 *
 * Every button is guarded by the same rule the server enforces, so the UI never offers a call that
 * will be refused: approve only when blocked, cancel only while live, retry only once terminal.
 */
function RunDetail({ run: r, spaceId, onJump }: { run: Run; spaceId: string; onJump: (sessionId: string) => void }) {
  const attempts = useApp((s) => s.runAttempts[r.id]) ?? [];
  const items = useApp((s) => s.items);
  const selectRun = useApp((s) => s.selectRun);
  const cancelRun = useApp((s) => s.cancelRun);
  const retryRun = useApp((s) => s.retryRun);
  const approveRun = useApp((s) => s.approveRun);
  const run = useApp((s) => s.run);
  const [note, setNote] = useState("");
  // The note belongs to the run being answered, not to the panel — switching runs must not carry one
  // run's half-typed reply onto another's approval.
  useEffect(() => { setNote(""); }, [r.id]);

  const terminal = isRunTerminal(r.state);
  const hasSession = r.sessionId !== null && items.some((i) => i.kind === "session" && i.refId === r.sessionId);

  return (
    <aside className="task-detail" aria-label={`Run: ${r.title}`}>
      <header className="task-detail-head">
        <h3>{r.title}</h3>
        <span className="run-state" data-state={r.state}>{RUN_STATE_LABEL[r.state]}</span>
        <button type="button" className="icon-btn" aria-label="Close run detail" onClick={() => run(() => selectRun(spaceId, null))}>
          <Icon name="close" size={14} />
        </button>
      </header>

      <section className="task-detail-block">
        <h4>Goal</h4>
        <p className="task-detail-goal">{r.goal}</p>
      </section>

      {r.state === "blocked" && (
        <section className="task-detail-block task-detail-ask">
          <h4>This run needs you</h4>
          {/* The ask itself is the run's last report — shown verbatim, because paraphrasing the
              question is how a person answers the wrong one. */}
          {r.result && <p className="task-detail-result">{r.result}</p>}
          <label className="visually-hidden" htmlFor={`run-note-${r.id}`}>Your reply</label>
          <textarea id={`run-note-${r.id}`} className="task-detail-note" rows={3} value={note}
            placeholder="Your answer — sent to the run when you approve it."
            onChange={(e) => setNote(e.target.value)} />
          <div className="task-detail-actions">
            <button type="button" className="btn primary" onClick={() => run(() => approveRun(r.id, true, note.trim() || null))}>Approve &amp; resume</button>
            <button type="button" className="btn" onClick={() => run(() => approveRun(r.id, false, note.trim() || null))}>Decline</button>
          </div>
        </section>
      )}

      {r.state !== "blocked" && (r.result ?? r.error) && (
        <section className="task-detail-block">
          <h4>{r.error && !r.result ? "Why it stopped" : "Result"}</h4>
          {r.result && <p className="task-detail-result">{r.result}</p>}
          {r.error && <p className="task-detail-error">{r.error}</p>}
        </section>
      )}

      <section className="task-detail-block">
        <h4>Attempts</h4>
        {attempts.length === 0
          ? <p className="page-row-dim">Not dispatched yet.</p>
          : <ol className="task-attempts">
              {attempts.map((a) => (
                <li key={a.id}>
                  <span className="task-attempt-n">#{a.n}</span>
                  <span className="task-attempt-outcome" data-outcome={a.outcome}>{ATTEMPT_WORD[a.outcome]}</span>
                  {a.detail && <span className="page-row-dim">{a.detail}</span>}
                  <span className="page-row-dim" title={new Date(a.startedAt).toLocaleString()}>{relativeTime(a.startedAt, Date.now())}</span>
                </li>
              ))}
            </ol>}
      </section>

      <div className="task-detail-actions task-detail-foot">
        {/* Only offered when the session's ITEM still exists — a dead link into a deleted transcript
            is worse than no link. */}
        {hasSession && <button type="button" className="btn" onClick={() => onJump(r.sessionId!)}>Open session</button>}
        {!terminal && r.state !== "blocked" && <button type="button" className="btn" onClick={() => run(() => cancelRun(r.id))}>Cancel</button>}
        {terminal && <button type="button" className="btn" onClick={() => run(() => retryRun(r.id))}>Retry</button>}
      </div>
    </aside>
  );
}

const CP_KIND_LABEL: Record<Checkpoint["kind"], string> = { turn: "Turn", "pre-restore": "Undo point", manual: "Manual" };

/** The push leg's outcome as row copy. Verbatim from the log — a row must never say more than the
 *  push actually did (a rejected push saying "pushed" is the named W1 mutant, on the write side). */
const PUSH_STATE_LABEL: Record<Ship["pushState"], string> = {
  pushed: "pushed", "up-to-date": "up to date", "no-remote": "no remote", "no-upstream": "no upstream",
  rejected: "push rejected", detached: "detached", skipped: "not pushed", failed: "push failed",
};

/** One row per union member, typed so the sort below cannot silently drop a source. */
type HistoryRow =
  | { kind: "checkpoint"; at: number; key: string; c: Checkpoint; env: Environment }
  | { kind: "ship"; at: number; key: string; ship: Ship };

/**
 * The History tab: checkpoints ∪ ships (Plan 14 W1), interleaved newest first.
 *
 * Checkpoints come from `checkpoints.list` across this space's environments; ships from the durable
 * `ships.list` log — one row per commit/push that actually happened, surviving reload, so the old
 * "commits are not recorded durably" apology is gone because it stopped being true. The two get
 * distinct row treatments: a checkpoint row opens the checkpoints sheet (restore lives there); a
 * ship row is a record — its one action is the PR link, when the ship produced one.
 */
function HistoryTab({ spaceId }: { spaceId: string }) {
  const environments = useApp((s) => s.environments);
  const checkpoints = useApp((s) => s.checkpoints);
  const ships = useApp((s) => s.ships[spaceId]);
  const refreshCheckpoints = useApp((s) => s.refreshCheckpoints);
  const refreshShips = useApp((s) => s.refreshShips);
  const openCheckpoints = useApp((s) => s.openCheckpoints);
  const run = useApp((s) => s.run);
  const envs = Object.values(environments).filter((e) => e.spaceId === spaceId);
  const envIdsKey = envs.map((e) => e.id).sort().join(",");
  useEffect(() => {
    for (const id of envIdsKey.split(",")) if (id) run(() => refreshCheckpoints(id, null));
  }, [envIdsKey, refreshCheckpoints, run]);
  useEffect(() => { run(() => refreshShips(spaceId)); }, [spaceId, refreshShips, run]);

  const all: HistoryRow[] = [
    ...envs.flatMap((e) => (checkpoints[e.id] ?? []).map((c): HistoryRow => ({ kind: "checkpoint", at: c.createdAt, key: `cp-${c.id}`, c, env: e }))),
    ...(ships ?? []).map((s): HistoryRow => ({ kind: "ship", at: s.createdAt, key: `ship-${s.id}`, ship: s })),
  ].sort((a, b) => b.at - a.at);

  if (all.length === 0) {
    return (
      <p className="env-empty">
        Nothing here yet — Realm takes a checkpoint before every turn and records every commit shipped
        from the diff pane, so this fills up as the space works.
      </p>
    );
  }
  return (
    <ul className="page-list">
      {all.map((row) => row.kind === "checkpoint" ? (
        <li key={row.key}>
          <button type="button" className="page-row" aria-label={`${row.c.label} — open checkpoints for ${row.env.branch ?? row.env.path}`}
            onClick={() => run(() => openCheckpoints(row.env.id, null))}>
            <span className="cp-kind">{CP_KIND_LABEL[row.c.kind]}</span>
            <span className="page-row-title">{row.c.label}</span>
            <span className="page-row-dim">{row.env.branch ?? row.env.path.replace(/\/+$/, "").split("/").pop()}</span>
            <span className="page-row-dim">{relativeTime(row.at, Date.now())}</span>
          </button>
        </li>
      ) : (
        <li key={row.key}>
          <div className="page-row ship-row" aria-label={`Shipped ${row.ship.subject}`}>
            <span className="cp-kind ship-kind"><Icon name="commit" size={12} /> Ship</span>
            <span className="page-row-title">{row.ship.subject}</span>
            <span className="page-row-dim"><code className="ship-sha">{row.ship.sha.slice(0, 7)}</code></span>
            {row.ship.branch && <span className="page-row-dim"><Icon name="branch" size={12} /> {row.ship.branch}</span>}
            <span className="page-row-dim">{PUSH_STATE_LABEL[row.ship.pushState]}</span>
            {row.ship.prUrl && (
              <span className="page-row-dim">
                <a href={row.ship.prUrl} target="_blank" rel="noreferrer"><Icon name="pullRequest" size={12} /> PR</a>
              </span>
            )}
            <span className="page-row-dim">{relativeTime(row.at, Date.now())}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

const PAGE_TABS: { id: SpacePageTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "memory", label: "Memory" },
  { id: "skills", label: "Skills" },
  { id: "connections", label: "Connections" },
  { id: "sessions", label: "Sessions" },
  { id: "tasks", label: "Tasks" },
  { id: "history", label: "History" },
];

/**
 * The space PAGE (Plan 12 W3) — the space-settings sheet promoted to a pane, per the Universe
 * transcription (screenshot 4): header (glyph, name, session count, "+ New session"), tabs down a
 * left rail. This is the app's first full page pane; W4/W5/W6 (Library, Notifications, Settings)
 * copy its pattern: `.page` root, `.page-head` header, `.page-rail` (~180px) of radio tabs,
 * `.page-content` column capped at ~720px.
 *
 * `item.refId` is the SPACE id (the diff pane's precedent of a non-session refId). Everything is
 * read live off the store by that id — a renamed or recolored space moves the page with it, and
 * every tab's panel receives THIS spaceId, never "the active space", so a pane surviving a space
 * switch can never show another space's data.
 *
 * The tab lives in the store PER SPACE (`spacePageTab`), not in component state: openers land on a
 * section (`openSpacePage(id, "connections")`) whether or not the page is already open, and two
 * spaces' pages never share a selection.
 */
export function SpacePage({ item }: PaneProps) {
  const spaceId = item.refId;
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  const sessions = useApp((s) => s.sessions);
  const tab = useApp((s) => s.spacePageTab[spaceId] ?? "general");
  const setSpacePageTab = useApp((s) => s.setSpacePageTab);
  // A tab IS a change of what this pane shows, so it is a stop on the pane's back/forward trail.
  const navigateInPane = useApp((s) => s.navigateInPane);
  const newSessionInstant = useApp((s) => s.newSessionInstant);
  const run = useApp((s) => s.run);

  if (!space) return <div className="pane-placeholder muted">This space no longer exists.</div>;
  const count = Object.values(sessions).filter((s) => s.spaceId === spaceId).length;

  return (
    // `.page` establishes the pattern; the modifier is `space-page-pane` (`.space-page` is taken —
    // it is the swiper's per-space sidebar column).
    <div className="page space-page-pane">
      <header className="page-head">
        <span className="page-glyph" style={{ color: space.color }}><SpaceIcon icon={space.icon} size={20} /></span>
        <div className="page-title">
          <h1>{space.name}</h1>
          <span className="page-sub">{count === 1 ? "1 session" : `${count} sessions`}</span>
        </div>
        <button type="button" className="btn primary" onClick={() => run(() => newSessionInstant())}>
          <Icon name="add" size={14} /> New session
        </button>
      </header>
      <div className="page-body">
        {/* The sheet's native-radio tab idiom, stood upright: arrow keys move, one tab stop. */}
        <fieldset className="page-rail">
          <legend className="visually-hidden">Space page section</legend>
          {PAGE_TABS.map((t) => (
            <label key={t.id} className="settings-tab page-rail-tab" data-selected={tab === t.id || undefined}>
              <input type="radio" name={`space-page-tab-${spaceId}`} value={t.id} checked={tab === t.id} onChange={() => { setSpacePageTab(spaceId, t.id); navigateInPane(item.id, t.id); }} />
              {t.label}
            </label>
          ))}
        </fieldset>
        <div className="page-content" data-wide={tab === "tasks" || undefined}>
          {tab === "general" && <GeneralTab spaceId={spaceId} />}
          {tab === "memory" && <MemoryTab spaceId={spaceId} />}
          {tab === "skills" && <SkillsPanel spaceId={spaceId} />}
          {/* Plan 9's gateway-era MCP surface IS this tab — one settings surface for one set of
              servers, exactly as it was in the retired sheet. */}
          {tab === "connections" && <>
            <McpSection spaceId={spaceId} />
            {/* The per-space browser origin allowlist (Plan 14 W4) — same tab as the other things
                agents reach out through. Its own settings-panel block, below the servers. */}
            <div className="form settings-panel"><BrowserOrigins spaceId={spaceId} /></div>
          </>}
          {tab === "sessions" && <SessionsTab spaceId={spaceId} />}
          {tab === "tasks" && <TasksTab spaceId={spaceId} />}
          {tab === "history" && <HistoryTab spaceId={spaceId} />}
        </div>
      </div>
    </div>
  );
}
