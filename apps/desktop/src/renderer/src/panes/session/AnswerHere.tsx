import { useEffect, type KeyboardEvent } from "react";
import type { Session } from "@realm/contracts";
import { useApp } from "../../state/store";
import { PendingRequest } from "./PendingRequest";
import { emptyTranscript } from "./transcript-model";

const NO_REQUESTS = emptyTranscript().pendingPermissions;

/**
 * The request cards a session is blocked on, answered away from its transcript — under its row in
 * Needs you, or on its card in its lead's Agents tab. The transcript is loaded here when no
 * pane ever opened it, which is the board's own way of drawing a pending request.
 *
 * Escape folds the card and answers nothing: in the transcript a card takes Escape as Deny, and a
 * person leaving a list they only looked at must never send one. A field being typed in keeps its
 * own Escape.
 */
export function AnswerHere({ id, session, asker, onLeave }: {
  id: string; session: Session;
  /** Who is asking, said above the cards — "Dark-mode toggle asks" — where the surface does not
   *  already say it (design.md: a question says who asks first). */
  asker?: string;
  onLeave: () => void;
}) {
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
    <div className="sb-need-answer" id={id} role="group" aria-label={`Waiting in ${asker ?? session.title}`} onKeyDownCapture={onKeyDownCapture}>
      {asker && <p className="sb-need-asker">{asker} asks</p>}
      {pending.map((p) => (
        <PendingRequest key={p.requestId} permission={p} ownsEscape={false}
          onDecide={(...decision) => run(() => respondPermission(session.id, p.requestId, ...decision))} />
      ))}
    </div>
  );
}
