import { useEffect } from "react";
import type { Item } from "@realm/contracts";
import { useApp } from "../../state/store";
import type { PaneProps } from "../registry";
import { Composer } from "./Composer";
import { Transcript } from "./Transcript";
import { emptyTranscript } from "./transcript-model";

const STATUS_LABEL = { idle: "Idle", running: "Running", waiting_permission: "Needs permission", error: "Error", ended: "Ended" } as const;

const fmtCost = (usd: number) => (usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`);

/** PanelBar right-side meta for a session item: model label, cost (only once real spend exists), status dot.
 *  PanelBar owns the icon + title; this is everything the old .session-header showed on its right. */
export function SessionMeta({ item }: { item: Item }) {
  const id = item.refId;
  const status = useApp((s) => s.sessionStatus[id] ?? s.sessions[id]?.status ?? "idle");
  const model = useApp((s) => s.sessions[id]?.model ?? s.transcripts[id]?.t.init?.model ?? null);
  const usage = useApp((s) => s.transcripts[id]?.t.usage ?? null);
  return (
    <>
      {model && <span>{model}</span>}
      {usage && usage.costUsd > 0 && <span>{fmtCost(usage.costUsd)} · {usage.numTurns} {usage.numTurns === 1 ? "turn" : "turns"}</span>}
      <span className="status-dot" data-status={status} title={STATUS_LABEL[status]} aria-label={`Status: ${STATUS_LABEL[status]}`} />
    </>
  );
}

/** Transcript + composer for one agent session (item.refId = session id). PanelBar renders the header. */
export function SessionPane({ item, visible, focused = false }: PaneProps) {
  const id = item.refId;
  const session = useApp((s) => s.sessions[id]);
  const status = useApp((s) => s.sessionStatus[id] ?? s.sessions[id]?.status ?? "idle");
  const entry = useApp((s) => s.transcripts[id]);
  const projects = useApp((s) => s.projects);
  const spaces = useApp((s) => s.spaces);
  const openSession = useApp((s) => s.openSession);
  const sendMessage = useApp((s) => s.sendMessage);
  const interruptSession = useApp((s) => s.interruptSession);
  const respondPermission = useApp((s) => s.respondPermission);
  const setSessionOptions = useApp((s) => s.setSessionOptions);
  const run = useApp((s) => s.run);
  const transcript = entry?.t ?? emptyTranscript();
  // Store-owned, keyed by session id (A-M9): layout reshapes/remounts never lose typed text, and a
  // suggestion chip in the empty state can fill the draft without sending it.
  const draft = useApp((s) => s.drafts[id] ?? "");
  const setDraft = useApp((s) => s.setDraft);
  const gitInfo = useApp((s) => { const cwd = s.sessions[id]?.cwd; return cwd ? s.gitInfo[cwd] ?? null : null; });

  useEffect(() => { run(() => openSession(id)); }, [id, openSession, run]);

  if (!session) return <div className="pane-placeholder muted">Loading session…</div>;
  const project = session.projectId ? projects.find((p) => p.id === session.projectId) ?? null : null;
  const space = spaces.find((s) => s.id === session.spaceId);
  // Hero vs docked (§4): the prompter centers as the hero only while there is nothing to read —
  // no transcript blocks and no visible permission cards (pending ones only show while waiting).
  const hero = transcript.blocks.length === 0 && (status !== "waiting_permission" || transcript.pendingPermissions.length === 0);
  return (
    <div className="session-pane" data-visible={visible || undefined} data-composer={hero ? "hero" : "docked"}>
      <Transcript transcript={transcript} sessionStatus={status} visible={visible} focused={focused}
        onDecide={(requestId, d) => run(() => respondPermission(id, requestId, d))} />
      <Composer session={session} status={status} project={project} gitInfo={gitInfo} draft={draft} onDraftChange={(t) => setDraft(id, t)}
        onSend={(text) => run(() => sendMessage(id, text))}
        onStop={() => run(() => interruptSession(id))}
        onOptions={(o) => run(() => setSessionOptions(id, o))}
        hero={hero} spaceName={space?.name ?? "this space"} onSuggestion={(p) => setDraft(id, p)} />
    </div>
  );
}
