import { AGENT_MODELS, AGENT_SUPPORTS_PERMISSION_MODES, EFFORT_LEVELS, PERMISSION_MODES, type Project, type Session, type SessionStatus } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { SessionOptions } from "../../state/store";

const MAX_ROWS_PX = 220;

/** Message box + option selects. ⌘/Ctrl+Enter sends; Enter inserts a newline. */
export function Composer({ session, status, project, onSend, onStop, onOptions }: {
  session: Session; status: SessionStatus; project: Project | null;
  onSend: (text: string) => void; onStop: () => void; onOptions: (o: SessionOptions) => void;
}) {
  const [text, setText] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const running = status === "running" || status === "waiting_permission";
  const models = AGENT_MODELS[session.agentKind] as ReadonlyArray<{ id: string; label: string }>;
  // Hidden exactly like the model picker is when the agent has no models: an option Realm cannot transmit
  // is worse than no option at all.
  const canSetPermissionMode = AGENT_SUPPORTS_PERMISSION_MODES[session.agentKind];
  const cwdName = session.cwd.replace(/\/+$/, "").split("/").pop() || session.cwd;

  useLayoutEffect(() => {
    const el = ta.current; if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(MAX_ROWS_PX, el.scrollHeight)}px`;
  }, [text]);

  const send = () => { const t = text.trim(); if (!t) return; onSend(t); setText(""); };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
  };

  return (
    <div className="composer">
      <textarea ref={ta} className="composer-input" aria-label="Message" placeholder="Message the agent… (⌘↵ to send)" rows={1}
        value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} />
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
            <select aria-label="Permission mode" className="composer-select" value={session.permissionMode} onChange={(e) => onOptions({ permissionMode: e.target.value })}>
              {PERMISSION_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          )}
          <span className="composer-chip" title={session.cwd}><Icon name="folder" size={12} />{project ? `${project.name} · ` : ""}{cwdName}</span>
        </div>
        <div className="composer-actions">
          {running
            ? <button className="composer-btn stop" aria-label="Stop" title="Stop (interrupt)" onClick={onStop}><Icon name="stop" size={15} /></button>
            : null}
          <button className="composer-btn send" aria-label="Send" title="Send (⌘↵)" disabled={!text.trim()} onClick={send}><Icon name="send" size={15} /></button>
        </div>
      </div>
    </div>
  );
}
