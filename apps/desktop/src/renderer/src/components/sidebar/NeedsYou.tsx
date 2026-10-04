import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Session } from "@realm/contracts";
import { useApp } from "../../state/store";
import { PendingRequest } from "../../panes/session/PendingRequest";
import { emptyTranscript } from "../../panes/session/transcript-model";
import { NEEDS_YOU_LABEL, needsYou, type NeedsYouRow } from "./model";
import { useSidebarState } from "./use-sidebar-model";

const NO_REQUESTS = emptyTranscript().pendingPermissions;

/**
 * Needs you: the one list of what waits on an answer (Plan 27).
 *
 * Sessions waiting on a permission or a question, the longest-waiting first, then the ones that
 * failed — from every space and every profile, each naming its space (and its profile, when that is
 * not the one on screen). Drawn only when something is in it. It replaces the head band's "N need
 * you" pill and the Active section; working and unread are not here, they show in their spaces and
 * under Recent.
 *
 * A row opens its session, as every row in the sidebar does. A waiting row also answers in place:
 * its disclosure unfolds the session's own request card under it — the transcript's card, through
 * the same respond call, so an answer given anywhere takes the card away everywhere.
 */
export function NeedsYou() {
  const state = useSidebarState();
  const rows = useMemo(() => needsYou(state), [state]);
  if (rows.length === 0) return null;
  return (
    <section className="sb-needs" aria-label="Needs you">
      <div className="group-label">Needs you</div>
      <div className="item-list">
        {rows.map((r) => <NeedsYouItem key={r.session.id} row={r} />)}
      </div>
    </section>
  );
}

function NeedsYouItem({ row }: { row: NeedsYouRow }) {
  const spaces = useApp((s) => s.spaces);
  const profiles = useApp((s) => s.profiles);
  const activeProfileId = useApp((s) => s.activeProfileId());
  const revealSession = useApp((s) => s.revealSession);
  const run = useApp((s) => s.run);
  const [answering, setAnswering] = useState(false);
  const disclose = useRef<HTMLButtonElement>(null);
  const space = spaces.find((sp) => sp.id === row.spaceId);
  const profile = space && space.profileId !== activeProfileId ? profiles.find((p) => p.id === space.profileId) : undefined;
  // The space, and the profile only when it is not the one on screen — a short name kept whole while
  // the title gives way (design.md, the yielding order).
  const where = [space?.name, profile?.name].filter(Boolean).join(" · ");
  const waiting = row.status === "waiting_permission";
  const said = NEEDS_YOU_LABEL[row.status];
  const answerId = `needs-you-answer-${row.session.id}`;
  return (
    <>
      <div className="item" data-actions={waiting ? 1 : 0}>
        <button type="button" className="item-row" aria-label={`${row.title}${where ? ` in ${where}` : ""} — ${said}`}
          title={`${row.title}${where ? ` — ${where}` : ""}`} onClick={() => run(() => revealSession(row.session.id, row.spaceId))}>
          <Icon name={row.scheduled ? "clock" : "session"} size={16} />
          <span className="item-title">{row.title}</span>
          {where && <span className="item-where">{where}</span>}
          <span className="item-trail"><span className="status-dot item-status" data-status={row.status} title={said} /></span>
        </button>
        {waiting && (
          <span className="item-actions">
            <button ref={disclose} type="button" className="item-disclose" aria-expanded={answering} aria-controls={answering ? answerId : undefined}
              aria-label={`Answer ${row.title} here`} title={answering ? "Hide the question" : "Answer here"}
              onClick={() => setAnswering((v) => !v)}>
              <Icon name="chevronRight" size={12} />
            </button>
          </span>
        )}
      </div>
      {waiting && answering && (
        <AnswerHere id={answerId} session={row.session} onLeave={() => { setAnswering(false); disclose.current?.focus(); }} />
      )}
    </>
  );
}

/**
 * The request cards a session is blocked on, under its row. The transcript is loaded here when no
 * pane ever opened it, which is the board's own way of drawing a pending request.
 *
 * Escape folds the card and answers nothing: in the transcript a card takes Escape as Deny, and a
 * person leaving a list they only looked at must never send one. A field being typed in keeps its
 * own Escape.
 */
function AnswerHere({ id, session, onLeave }: { id: string; session: Session; onLeave: () => void }) {
  const loaded = useApp((s) => s.transcripts[session.id] !== undefined);
  const pending = useApp((s) => s.transcripts[session.id]?.t.pendingPermissions ?? NO_REQUESTS);
  const openSession = useApp((s) => s.openSession);
  const respondPermission = useApp((s) => s.respondPermission);
  const run = useApp((s) => s.run);
  useEffect(() => { if (!loaded) run(() => openSession(session.id)); }, [loaded, session.id, openSession, run]);
  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault(); e.stopPropagation();
    onLeave();
  };
  if (pending.length === 0) return null;
  return (
    <div className="sb-need-answer" id={id} role="group" aria-label={`Waiting in ${session.title}`} onKeyDownCapture={onKeyDownCapture}>
      {pending.map((p) => (
        <PendingRequest key={p.requestId} permission={p} ownsEscape={false}
          onDecide={(...decision) => run(() => respondPermission(session.id, p.requestId, ...decision))} />
      ))}
    </div>
  );
}
