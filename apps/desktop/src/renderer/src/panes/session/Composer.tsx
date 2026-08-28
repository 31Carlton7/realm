import { AGENT_META, AGENT_MODELS, AGENT_SUPPORTS_PERMISSION_MODES, DEFAULT_MODEL_LABEL, EFFORT_LEVELS, PERMISSION_MODES, type GitInfo, type Project, type Session, type SessionStatus } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Menu, type MenuItem } from "../../components/Menu";
import type { SessionOptions } from "../../state/store";
import { SUGGESTIONS } from "./suggestions";

// ~10 lines of 13px/1.55 plus the 12px vertical padding (§4: autogrows to 10 lines).
const MAX_ROWS_PX = 226;

/** Session ids whose suggestion chips already played their stagger-in. Module-level on purpose:
 *  §4 says "never re-animate on revisit", and pane-slot keying remounts this component on every
 *  tab-back — a mount-scoped flag would replay. Lives for the app run; a fresh launch replays once. */
const staggerPlayed = new Set<string>();

/** Context row (§4 row 1): cwd chip always; git chips only when the cwd is a known repo. The diff and
 *  dirty chips hide themselves at zero — an all-clean repo shows just the branch. */
function ContextRow({ session, project, gitInfo }: { session: Session; project: Project | null; gitInfo: GitInfo | null }) {
  const cwdName = session.cwd.replace(/\/+$/, "").split("/").pop() || session.cwd;
  return (
    <div className="composer-context">
      <span className="composer-chip" title={session.cwd}><Icon name="folder" size={12} /><span className="chip-label">{project ? `${project.name} · ` : ""}{cwdName}</span></span>
      {gitInfo && (
        <>
          <span className="composer-chip git-branch" title={`Branch ${gitInfo.branch}`}><span className="chip-label">{gitInfo.branch}</span></span>
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

/** Borderless ghost chip that opens an upward Menu (§4 control row). With nothing to pick it is not a
 *  control at all but a label — an agent whose CLI owns model choice still deserves its model named,
 *  and a disabled button would leave the tab order and be announced as unavailable. */
function ChipMenu({ ariaLabel, label, items, warning }: { ariaLabel: string; label: ReactNode; items: MenuItem[]; warning?: boolean }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (items.length === 0) {
    return <span className="ghost-chip" data-static title={ariaLabel} data-warning={warning || undefined}><span className="chip-label">{label}</span></span>;
  }
  return (
    <>
      {/* Toggle, not a bare open: Menu deliberately ignores pointerdown on its own anchor, so closing
          by clicking the chip a second time is this handler's job. */}
      <button ref={btn} type="button" className="ghost-chip" aria-label={ariaLabel} aria-haspopup="menu" aria-expanded={open}
        data-warning={warning || undefined} onClick={() => setOpen((v) => !v)}>
        <span className="chip-label">{label}</span>
        <Icon name="chevronDown" size={12} className="chip-caret" />
      </button>
      {open && <Menu items={items} onClose={() => setOpen(false)} anchorRef={btn} placement="up" label={ariaLabel} />}
    </>
  );
}

/** The prompter (design-language §4): one floating card, two states. `hero` centers it at ~38%
 *  viewport height with the greeting above and suggestion chips below (both absolutely positioned
 *  around the card so the hero→docked move is one element transitioning transform, §6: 320ms).
 *  Docked pins it to the pane bottom on the transcript's 680px rails.
 *
 *  ⌘/Ctrl+Enter sends; Enter inserts a newline. The draft text is owned by the store (keyed by
 *  session id, A-M9) so a suggestion chip can fill it without sending — and layout reshapes never
 *  lose it. */
export function Composer({ session, status, project, gitInfo, draft, onDraftChange, onSend, onStop, onOptions, hero, spaceName, onSuggestion }: {
  session: Session; status: SessionStatus; project: Project | null; gitInfo: GitInfo | null;
  draft: string; onDraftChange: (text: string) => void;
  onSend: (text: string) => void; onStop: () => void; onOptions: (o: SessionOptions) => void;
  hero: boolean; spaceName: string; onSuggestion: (prompt: string) => void;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const running = status === "running" || status === "waiting_permission";
  const kind = session.agentKind;
  const models = AGENT_MODELS[kind] as ReadonlyArray<{ id: string; label: string }>;
  const modelLabel = session.model ? models.find((m) => m.id === session.model)?.label ?? session.model : DEFAULT_MODEL_LABEL[kind];
  // Hidden exactly like the model menu is empty when the agent has no models: an option Realm cannot
  // transmit is worse than no option at all.
  const canSetPermissionMode = AGENT_SUPPORTS_PERMISSION_MODES[kind];
  // bypassPermissions must never be a one-click slip (U-M7): selecting it arms an inline confirm chip
  // for 5s while the chip simply stays on the current mode; only the explicit confirm applies it.
  const [confirmBypass, setConfirmBypass] = useState(false);
  useEffect(() => {
    if (!confirmBypass) return;
    const t = setTimeout(() => setConfirmBypass(false), 5000);
    return () => clearTimeout(t);
  }, [confirmBypass]);

  // First-render-only stagger (§6): decided once at mount (so a mid-animation re-render — typing,
  // status — never strips the attribute and snaps the chips), then marked as played for the app run.
  const [stagger] = useState(() => hero && !staggerPlayed.has(session.id));
  useEffect(() => { if (hero) staggerPlayed.add(session.id); }, [hero, session.id]);

  useLayoutEffect(() => {
    const el = ta.current; if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(MAX_ROWS_PX, el.scrollHeight)}px`;
  }, [draft]);

  const send = () => { const t = draft.trim(); if (!t) return; onSend(t); onDraftChange(""); };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
  };

  const modelItems: MenuItem[] = models.map((m) => ({ label: m.label, checked: session.model === m.id, onSelect: () => onOptions({ model: m.id }) }));
  const effortItems: MenuItem[] = EFFORT_LEVELS.map((l) => ({ label: l, checked: session.effort === l, onSelect: () => onOptions({ effort: l }) }));
  const permissionItems: MenuItem[] = PERMISSION_MODES.map((m) => ({
    label: m.label, checked: session.permissionMode === m.id,
    onSelect: () => {
      if (m.id === "bypassPermissions" && session.permissionMode !== "bypassPermissions") { setConfirmBypass(true); return; }
      setConfirmBypass(false);
      onOptions({ permissionMode: m.id });
    },
  }));

  return (
    <div className="composer-dock">
      {hero && <div className="hero-greeting">What should we work on in <em>{spaceName}</em>?</div>}
      <div className="composer">
        <ContextRow session={session} project={project} gitInfo={gitInfo} />
        <textarea ref={ta} className="composer-input" aria-label="Message" placeholder="Message the agent…" rows={1}
          value={draft} onChange={(e) => onDraftChange(e.target.value)} onKeyDown={onKeyDown} />
        <div className="composer-bar">
          <div className="composer-opts">
            <span className="composer-agent" title={AGENT_META[kind].label}><Icon name={AGENT_META[kind].icon} size={16} /></span>
            <ChipMenu ariaLabel="Model" label={`${AGENT_META[kind].label} · ${modelLabel}`} items={modelItems} />
            <ChipMenu ariaLabel="Effort" label={session.effort ?? "Effort"} items={effortItems} />
            {canSetPermissionMode && (
              <ChipMenu ariaLabel="Permission mode" warning={session.permissionMode === "bypassPermissions"}
                label={PERMISSION_MODES.find((m) => m.id === session.permissionMode)?.label ?? session.permissionMode} items={permissionItems} />
            )}
            {confirmBypass && (
              <button className="composer-chip bypass-confirm"
                onClick={() => { setConfirmBypass(false); onOptions({ permissionMode: "bypassPermissions" }); }}>
                Allow everything? Confirm
              </button>
            )}
          </div>
          <div className="composer-actions">
            {/* Send↔stop morph (§6): both icons stay in the DOM; data-state cross-fades them (160ms,
                opacity + scale .25→1 + 4px blur). ⌘↵ still sends while running — only the button morphs. */}
            <button className="composer-send" data-state={running ? "stop" : "send"}
              aria-label={running ? "Stop" : "Send"} title={running ? "Stop (interrupt)" : "Send (⌘↵)"}
              disabled={!running && !draft.trim()}
              onClick={() => (running ? onStop() : send())}>
              <Icon name="arrowUp" size={15} className="send-icon" />
              <Icon name="stop" size={13} className="stop-icon" />
            </button>
          </div>
        </div>
      </div>
      {status === "running" && <div className="composer-thinking"><span>Thinking…</span></div>}
      {hero && (
        <div className="suggestions" data-animate={stagger || undefined}>
          {SUGGESTIONS[kind].map((s, i) => (
            <button key={s.title} type="button" className="suggestion-chip" style={{ "--i": i } as React.CSSProperties}
              onClick={() => onSuggestion(s.prompt)}>
              <span className="suggestion-title">{s.title}</span>
              <span className="suggestion-desc">{s.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
