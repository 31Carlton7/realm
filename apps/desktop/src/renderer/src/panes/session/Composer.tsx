import { AGENT_MODELS, AGENT_SUPPORTS_PERMISSION_MODES, EFFORT_LEVELS, PERMISSION_MODES, type GitInfo, type Project, type Session, type SessionStatus } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { SessionOptions } from "../../state/store";

const MAX_ROWS_PX = 220;

/** Context row (spec §A2): cwd chip always; git chips only when the cwd is a known repo. The diff and
 *  dirty chips hide themselves at zero — an all-clean repo shows just the branch. */
function ContextRow({ session, project, gitInfo }: { session: Session; project: Project | null; gitInfo: GitInfo | null }) {
  const cwdName = session.cwd.replace(/\/+$/, "").split("/").pop() || session.cwd;
  return (
    <div className="composer-context">
      <span className="composer-chip" title={session.cwd}><Icon name="folder" size={12} />{project ? `${project.name} · ` : ""}{cwdName}</span>
      {gitInfo && (
        <>
          <span className="composer-chip git-branch" title={`Branch ${gitInfo.branch}`}>{gitInfo.branch}</span>
          {(gitInfo.additions > 0 || gitInfo.deletions > 0) && (
            <span className="composer-chip git-diff">
              <span className="diff-add">+{gitInfo.additions}</span>
              <span className="diff-del">−{gitInfo.deletions}</span>
            </span>
          )}
          {gitInfo.dirty > 0 && <span className="composer-chip git-dirty">{gitInfo.dirty} changed</span>}
        </>
      )}
    </div>
  );
}

/** Message box + option selects. ⌘/Ctrl+Enter sends; Enter inserts a newline.
 *  The draft text is owned by the store (keyed by session id, A-M9) so a suggestion chip in the empty
 *  state can fill it without sending — and layout reshapes never lose it. */
export function Composer({ session, status, project, gitInfo, draft, onDraftChange, onSend, onStop, onOptions }: {
  session: Session; status: SessionStatus; project: Project | null; gitInfo: GitInfo | null;
  draft: string; onDraftChange: (text: string) => void;
  onSend: (text: string) => void; onStop: () => void; onOptions: (o: SessionOptions) => void;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const running = status === "running" || status === "waiting_permission";
  const models = AGENT_MODELS[session.agentKind] as ReadonlyArray<{ id: string; label: string }>;
  // Hidden exactly like the model picker is when the agent has no models: an option Realm cannot transmit
  // is worse than no option at all.
  const canSetPermissionMode = AGENT_SUPPORTS_PERMISSION_MODES[session.agentKind];
  // bypassPermissions must never be a one-click slip (U-M7): selecting it arms an inline confirm chip
  // for 5s while the (controlled) select simply stays on the current mode; only the explicit confirm
  // actually applies the option.
  const [confirmBypass, setConfirmBypass] = useState(false);
  useEffect(() => {
    if (!confirmBypass) return;
    const t = setTimeout(() => setConfirmBypass(false), 5000);
    return () => clearTimeout(t);
  }, [confirmBypass]);

  useLayoutEffect(() => {
    const el = ta.current; if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(MAX_ROWS_PX, el.scrollHeight)}px`;
  }, [draft]);

  const send = () => { const t = draft.trim(); if (!t) return; onSend(t); onDraftChange(""); };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
  };

  return (
    <div className="composer">
      <ContextRow session={session} project={project} gitInfo={gitInfo} />
      <textarea ref={ta} className="composer-input" aria-label="Message" placeholder="Message the agent… (⌘↵ to send)" rows={1}
        value={draft} onChange={(e) => onDraftChange(e.target.value)} onKeyDown={onKeyDown} />
      <div className="composer-bar">
        <div className="composer-opts">
          {models.length > 0 && (
            <select aria-label="Model" className="composer-select" value={session.model ?? ""} onChange={(e) => { if (e.target.value) onOptions({ model: e.target.value }); }}>
              {!session.model && <option value="">Default model</option>}
              {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          )}
          <select aria-label="Effort" className="composer-select" value={session.effort ?? ""} onChange={(e) => { if (e.target.value) onOptions({ effort: e.target.value }); }}>
            {!session.effort && <option value="">Default effort</option>}
            {EFFORT_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          {canSetPermissionMode && (
            <select aria-label="Permission mode" className="composer-select" data-warning={session.permissionMode === "bypassPermissions" || undefined}
              value={session.permissionMode}
              onChange={(e) => {
                const mode = e.target.value;
                if (mode === "bypassPermissions" && session.permissionMode !== "bypassPermissions") { setConfirmBypass(true); return; }
                setConfirmBypass(false);
                onOptions({ permissionMode: mode });
              }}>
              {PERMISSION_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          )}
          {confirmBypass && (
            <button className="composer-chip bypass-confirm"
              onClick={() => { setConfirmBypass(false); onOptions({ permissionMode: "bypassPermissions" }); }}>
              Allow everything? Confirm
            </button>
          )}
        </div>
        <div className="composer-actions">
          {running
            ? <button className="composer-btn stop" aria-label="Stop" title="Stop (interrupt)" onClick={onStop}><Icon name="stop" size={15} /></button>
            : null}
          <button className="composer-btn send" aria-label="Send" title="Send (⌘↵)" disabled={!draft.trim()} onClick={send}><Icon name="send" size={15} /></button>
        </div>
      </div>
    </div>
  );
}
