import type { Session } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect } from "react";
import { emptyTranscript } from "../session/transcript-model";
import { PendingRequest } from "../session/PendingRequest";
import { useApp } from "../../state/store";

const NO_REQUESTS = emptyTranscript().pendingPermissions;

/**
 * What a session waiting on you is waiting FOR, answered where you are.
 *
 * The request comes from the same transcript pipeline the session's own pane reads — loaded here if
 * that pane was never opened, as the Notifications page does — so the board and the transcript can
 * never disagree about what is pending: an answer from either removes the entry, and this draws
 * nothing. The card is the transcript's own (`PendingRequest`): the same Allow / Allow always / Deny,
 * the same question with its options and its field for an answer of your own, the same respond call.
 *
 * Nothing here navigates. The card sits beside the row that opens the session, never inside it, so
 * answering a question cannot also be a click that takes you somewhere else.
 */
export function AgentAsk({ session }: { session: Session }) {
  const loaded = useApp((s) => s.transcripts[session.id] !== undefined);
  const pending = useApp((s) => s.transcripts[session.id]?.t.pendingPermissions ?? NO_REQUESTS);
  const openSession = useApp((s) => s.openSession);
  const respondPermission = useApp((s) => s.respondPermission);
  const run = useApp((s) => s.run);
  useEffect(() => { if (!loaded) void run(() => openSession(session.id)); }, [loaded, session.id, run, openSession]);
  if (pending.length === 0) return null;
  return (
    <div className="agents-ask">
      {pending.map((p) => (
        <PendingRequest key={p.requestId} permission={p}
          onDecide={(...decision) => run(() => respondPermission(session.id, p.requestId, ...decision))} />
      ))}
    </div>
  );
}

/** Stop the turn a session is on — the composer's Stop, without opening the session to reach it. */
export function AgentStop({ session }: { session: Session }) {
  const interruptSession = useApp((s) => s.interruptSession);
  const run = useApp((s) => s.run);
  return (
    <button type="button" className="btn-quiet agents-stop" aria-label={`Stop ${session.title}`}
      title="Stop the turn this agent is on" onClick={() => run(() => interruptSession(session.id))}>
      <Icon name="stop" size={12} />Stop
    </button>
  );
}
