import { Icon } from "@realm/ui";
import { useEffect } from "react";
import { AGENT_META } from "@realm/contracts";
import { useApp } from "../../state/store";
import type { PaneProps } from "../registry";
import { Composer } from "./Composer";
import { Transcript } from "./Transcript";
import { emptyTranscript } from "./transcript-model";

const STATUS_LABEL = { idle: "Idle", running: "Running", waiting_permission: "Needs permission", error: "Error", ended: "Ended" } as const;

const fmtCost = (usd: number) => (usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`);

/** Header strip + transcript + composer for one agent session (item.refId = session id). */
export function SessionPane({ item, visible }: PaneProps) {
  const id = item.refId;
  const session = useApp((s) => s.sessions[id]);
  const status = useApp((s) => s.sessionStatus[id] ?? s.sessions[id]?.status ?? "idle");
  const entry = useApp((s) => s.transcripts[id]);
  const projects = useApp((s) => s.projects);
  const openSession = useApp((s) => s.openSession);
  const sendMessage = useApp((s) => s.sendMessage);
  const interruptSession = useApp((s) => s.interruptSession);
  const respondPermission = useApp((s) => s.respondPermission);
  const setSessionOptions = useApp((s) => s.setSessionOptions);
  const run = useApp((s) => s.run);
  const transcript = entry?.t ?? emptyTranscript();

  useEffect(() => { run(() => openSession(id)); }, [id, openSession, run]);

  if (!session) return <div className="pane-placeholder muted">Loading session…</div>;
  const project = session.projectId ? projects.find((p) => p.id === session.projectId) ?? null : null;
  const model = session.model ?? transcript.init?.model ?? null;
  return (
    <div className="session-pane" data-visible={visible || undefined}>
      <div className="session-header">
        <Icon name={AGENT_META[session.agentKind].icon} size={15} className="session-agent-icon" />
        <span className="session-title" title={item.title}>{item.title}</span>
        <span className="status-dot" data-status={status} title={STATUS_LABEL[status]} aria-label={`Status: ${STATUS_LABEL[status]}`} />
        <span className="session-meta muted">
          {model && <span>{model}</span>}
          {transcript.usage.numTurns > 0 && <span>{fmtCost(transcript.usage.costUsd)} · {transcript.usage.numTurns} {transcript.usage.numTurns === 1 ? "turn" : "turns"}</span>}
        </span>
      </div>
      <Transcript transcript={transcript} sessionStatus={status} visible={visible}
        onDecide={(d) => { const p = transcript.pendingPermission; if (p) run(() => respondPermission(id, p.requestId, d)); }}
        empty={<div className="transcript-empty muted"><Icon name={AGENT_META[session.agentKind].icon} size={28} /><div>Say something to start the session.</div></div>} />
      <Composer session={session} status={status} project={project}
        onSend={(text) => run(() => sendMessage(id, text))}
        onStop={() => run(() => interruptSession(id))}
        onOptions={(o) => run(() => setSessionOptions(id, o))} />
    </div>
  );
}
