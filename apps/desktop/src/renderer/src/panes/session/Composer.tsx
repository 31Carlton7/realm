import { AGENT_SUPPORTS_PERMISSION_MODES, AGENT_SUPPORTS_PLAN_MODE, EFFORT_LEVELS, PERMISSION_MODES, PLAN_PERMISSION_MODE, SESSION_MODES, attachmentDisposition, attachmentNote, attachmentSummary, formatAttachmentSize, isImageMime, type AgentKind, type Environment, type GitInfo, type Project, type Session, type SessionMode, type SessionStatus } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { Menu, type MenuItem } from "../../components/Menu";
import type { AgentProbe, PickedAttachment, SessionOptions } from "../../state/store";
import { ModelPicker } from "./ModelPicker";
import { SUGGESTIONS } from "./suggestions";

// ~10 lines of 13px/1.55 plus the 12px vertical padding (§4: autogrows to 10 lines).
const MAX_ROWS_PX = 226;

/** Session ids whose suggestion chips already played their stagger-in. Module-level on purpose:
 *  §4 says "never re-animate on revisit", and pane-slot keying remounts this component on every
 *  tab-back — a mount-scoped flag would replay. Lives for the app run; a fresh launch replays once. */
const staggerPlayed = new Set<string>();

/** Context row (§4 row 1): cwd chip always; git chips only when the cwd is a known repo. The diff and
 *  dirty chips hide themselves at zero — an all-clean repo shows just the branch. */
function ContextRow({ session, project, gitInfo, environment, onOpenDiff }: { session: Session; project: Project | null; gitInfo: GitInfo | null; environment: Environment | null; onOpenDiff: () => void }) {
  const cwdName = session.cwd.replace(/\/+$/, "").split("/").pop() || session.cwd;
  // A session in a worktree Realm made (W2) swaps the folder glyph for a branch one and says so in
  // the tooltip, alongside the port block its `pnpm dev` will land on. No new chip and no new colour:
  // that this session is isolated is metadata, and metadata lives in chips (design language §2.5).
  const worktree = environment?.kind === "worktree";
  const ports = environment?.portBlockStart ?? null;
  const where = [worktree ? `Worktree · ${session.cwd}` : session.cwd,
    // The block is a RANGE Realm reserved, not a promise about what is listening on it.
    ports === null ? null : `Ports ${ports}–${ports + 9} reserved`].filter(Boolean).join("\n");
  return (
    <div className="composer-context">
      <span className="composer-chip" title={where}><Icon name={worktree ? "branch" : "folder"} size={12} /><span className="chip-label">{worktree ? "Worktree · " : ""}{project ? `${project.name} · ` : ""}{cwdName}</span></span>
      {gitInfo && (
        // W3: the chips that already showed the branch and the diff counts become the way IN to the
        // diff pane. One button, not three — the whole group means "show me these changes".
        <button type="button" className="composer-git" onClick={onOpenDiff}
          title={gitInfo.dirty > 0 ? `Show ${gitInfo.dirty} changed ${gitInfo.dirty === 1 ? "file" : "files"} on ${gitInfo.branch}` : `Show changes on ${gitInfo.branch}`}>
          <span className="composer-chip git-branch"><span className="chip-label">{gitInfo.branch}</span></span>
          {(gitInfo.additions > 0 || gitInfo.deletions > 0) && (
            <span className="composer-chip git-diff">
              <span className="diff-add">+{gitInfo.additions}</span>
              <span className="diff-del">−{gitInfo.deletions}</span>
            </span>
          )}
          {gitInfo.dirty > 0 && <span className="composer-chip git-dirty">{gitInfo.dirty} changed</span>}
        </button>
      )}
    </div>
  );
}

/** Borderless ghost chip that opens an upward Menu (§4 control row). With nothing to pick it is not a
 *  control at all but a label — an agent whose CLI owns model choice still deserves its model named,
 *  and a disabled button would leave the tab order and be announced as unavailable. */
function ChipMenu({ ariaLabel, title, label, icon, items, warning }: { ariaLabel: string; title?: string; label: ReactNode; icon?: string; items: MenuItem[]; warning?: boolean }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // A sibling of chip-label, never inside it: chip-label truncates with an ellipsis, which needs a
  // plain inline box — an icon nested in there gets no gap and sits off the text's centre line.
  const glyph = icon ? <Icon name={icon} size={13} className="chip-brand" /> : null;
  if (items.length === 0) {
    return <span className="ghost-chip" data-static title={title ?? ariaLabel} data-warning={warning || undefined}>{glyph}<span className="chip-label">{label}</span></span>;
  }
  return (
    <>
      {/* Toggle, not a bare open: Menu deliberately ignores pointerdown on its own anchor, so closing
          by clicking the chip a second time is this handler's job. */}
      <button ref={btn} type="button" className="ghost-chip" aria-label={ariaLabel} title={title ?? ariaLabel} aria-haspopup="menu" aria-expanded={open}
        data-warning={warning || undefined} onClick={() => setOpen((v) => !v)}>
        {glyph}
        <span className="chip-label">{label}</span>
        <Icon name="chevronDown" size={12} className="chip-caret" />
      </button>
      {open && <Menu items={items} onClose={() => setOpen(false)} anchorRef={btn} placement="up" label={ariaLabel} />}
    </>
  );
}

/**
 * Pending attachments (§4 row 1): one removable chip per file, then one note row per distinct fate.
 *
 * The notes are the point of this row. The three adapters do three different things with the same
 * file — Claude inlines an image and DROPS a PDF without a word, Codex hands over paths, an ACP agent
 * gets a link — and the only moment that difference is actionable is before the message is sent. So
 * the note names the agent and says what will happen, and a file that will simply be discarded says so
 * in the warning tone rather than looking exactly like one that will be read.
 */
function AttachmentRow({ kind, attachments, onRemove }: { kind: AgentKind; attachments: PickedAttachment[]; onRemove: (path: string) => void }) {
  if (attachments.length === 0) return null;
  return (
    <>
      <ul className="composer-attachments" aria-label="Attachments">
        {attachments.map((a) => (
          <li key={a.path} className="attach-chip" data-disposition={attachmentDisposition(kind, a.mime)}
            title={`${a.path} · ${formatAttachmentSize(a.size)} · ${attachmentNote(kind, a.mime)}`}>
            <Icon name={isImageMime(a.mime) ? "image" : "artifact"} size={12} className="attach-glyph" />
            <span className="chip-label">{a.name}</span>
            <button type="button" className="attach-remove" aria-label={`Remove ${a.name}`} onClick={() => onRemove(a.path)}>
              <Icon name="close" size={11} />
            </button>
          </li>
        ))}
      </ul>
      {attachmentSummary(kind, attachments).map((row) => (
        <p key={row.disposition} className="composer-attach-note" data-disposition={row.disposition}>
          {row.disposition === "ignored" && <Icon name="alert" size={12} className="attach-note-glyph" />}
          <span>{row.note}</span>
          <span className="attach-note-files">{row.files.join(", ")}</span>
        </p>
      ))}
    </>
  );
}

const permissionLabel = (id: string) => PERMISSION_MODES.find((m) => m.id === id)?.label ?? id;

/** The prompter (design-language §4): one floating card, two states. `hero` centers it at ~38%
 *  viewport height with the greeting above and suggestion chips below (both absolutely positioned
 *  around the card so the hero→docked move is one element transitioning transform, §6: 320ms).
 *  Docked pins it to the pane bottom on the transcript's 680px rails.
 *
 *  ⌘/Ctrl+Enter sends; Enter inserts a newline. The draft text is owned by the store (keyed by
 *  session id, A-M9) so a suggestion chip can fill it without sending — and layout reshapes never
 *  lose it. */
export function Composer({ session, status, project, gitInfo, environment, onOpenDiff, draft, onDraftChange, attachments, onAttachPick, onAttachFiles, onRemoveAttachment, onSend, onStop, onOptions, onPickModel, onMode, planReturn, canSwitchAgent, agentProbe, hero, spaceName, onSuggestion }: {
  session: Session; status: SessionStatus; project: Project | null; gitInfo: GitInfo | null;
  /** The checkout this session runs in (W2) — null until the space's environments have loaded. */
  environment: Environment | null;
  /** Open the diff pane for that checkout (W3) — what the branch/diff chips do. */
  onOpenDiff: () => void;
  draft: string; onDraftChange: (text: string) => void;
  /** Part of the draft, and store-owned for the same reason: a remount must not drop them. */
  attachments: PickedAttachment[];
  /** The attach button — the native multi-select picker. */
  onAttachPick: () => void;
  /** Dropped or pasted Files. The store resolves paths (and writes pathless pastes out). */
  onAttachFiles: (files: File[]) => void;
  onRemoveAttachment: (path: string) => void;
  onSend: (text: string) => void; onStop: () => void; onOptions: (o: SessionOptions) => void;
  /** Sets agent AND model in one action — the picker's rows are (agent, model) pairs. */
  onPickModel: (kind: AgentKind, modelId: string | null) => void;
  /** Build ⇄ Plan. The store parks and restores the permission mode around the trip. */
  onMode: (mode: SessionMode) => void;
  /** The permission mode Plan is holding for this session, if any — what returning to Build restores. */
  planReturn: string | null;
  /** False once the session has produced an event — see ModelPicker. */
  canSwitchAgent: boolean;
  /** Latest `agents.probe`, for the picker's per-agent availability note. Empty before the first probe. */
  agentProbe: AgentProbe[];
  hero: boolean; spaceName: string; onSuggestion: (prompt: string) => void;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const running = status === "running" || status === "waiting_permission";
  const kind = session.agentKind;
  // Hidden exactly like the model menu is empty when the agent has no models: an option Realm cannot
  // transmit is worse than no option at all.
  const canSetPermissionMode = AGENT_SUPPORTS_PERMISSION_MODES[kind];
  const canPlan = AGENT_SUPPORTS_PLAN_MODE[kind];
  const inPlan = session.permissionMode === PLAN_PERMISSION_MODE;
  // bypassPermissions must never be a one-click slip (U-M7): selecting it arms an inline confirm chip
  // for 5s while the chip simply stays on the current mode; only the explicit confirm applies it.
  const [confirmBypass, setConfirmBypass] = useState(false);
  useEffect(() => {
    if (!confirmBypass) return;
    const t = setTimeout(() => setConfirmBypass(false), 5000);
    return () => clearTimeout(t);
  }, [confirmBypass]);

  // Drag depth, not a boolean: dragging across a child element fires leave-then-enter, and a boolean
  // flickers the drop target off on every internal boundary. Reset outright on drop.
  const [dragDepth, setDragDepth] = useState(0);
  // Realm already drags its own sidebar rows onto panes (DropEdge). Only a drag carrying FILES is ours;
  // anything else must fall through to the pane's own drop handling untouched.
  const carriesFiles = (e: DragEvent) => e.dataTransfer?.types?.includes("Files") ?? false;
  const onDragEnter = (e: DragEvent) => { if (!carriesFiles(e)) return; e.preventDefault(); setDragDepth((d) => d + 1); };
  const onDragOver = (e: DragEvent) => { if (!carriesFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; };
  const onDragLeave = (e: DragEvent) => { if (!carriesFiles(e)) return; setDragDepth((d) => Math.max(0, d - 1)); };
  const onDrop = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    setDragDepth(0);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) onAttachFiles(files);
  };
  /** Pasting an image: it has no path yet, which the store handles. A paste with no files is text —
   *  fall through untouched, or ⌘V would stop working in the one box people paste into most. */
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    onAttachFiles(files);
  };

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

  const effortItems: MenuItem[] = EFFORT_LEVELS.map((l) => ({ label: l, checked: session.effort === l, onSelect: () => onOptions({ effort: l }) }));
  const modeItems: MenuItem[] = SESSION_MODES.map((m) => ({
    label: m.label, checked: (m.id === "plan") === inPlan, onSelect: () => onMode(m.id),
  }));
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
      {hero && <div className="hero-greeting">What should we build in <em>{spaceName}</em>?</div>}
      {/* The whole card is the drop target — aiming at a 44px textarea with a file in hand is a chore.
          §6 forbids animating during a drag, so the state change is a static ring, not a transition. */}
      <div className="composer" data-dropping={dragDepth > 0 || undefined}
        onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        <ContextRow session={session} project={project} gitInfo={gitInfo} environment={environment} onOpenDiff={onOpenDiff} />
        <AttachmentRow kind={kind} attachments={attachments} onRemove={onRemoveAttachment} />
        <textarea ref={ta} className="composer-input" aria-label="Message" placeholder="Message the agent…" rows={1}
          value={draft} onChange={(e) => onDraftChange(e.target.value)} onKeyDown={onKeyDown} onPaste={onPaste} />
        {dragDepth > 0 && <div className="composer-drop-hint" aria-hidden="true">Drop to attach</div>}
        <div className="composer-bar">
          <div className="composer-opts">
            <ModelPicker kind={kind} model={session.model} canSwitchAgent={canSwitchAgent}
              agentProbe={agentProbe} onPick={onPickModel} />
            <ChipMenu ariaLabel="Effort" label={session.effort ?? "Effort"} items={effortItems} />
            {/* In Plan the permission mode is not in effect — Claude's `plan` replaces it outright and
                Codex forces read-only — so the control becomes a LABEL naming what Build will restore.
                Offering a picker whose selection changes nothing is the lie this split exists to end;
                hiding it instead would lose the answer to "what happens when I go back?". */}
            {canSetPermissionMode && (
              inPlan
                ? <ChipMenu ariaLabel="Permission mode" items={[]}
                    title={`Plan is read-only — returning to Build restores ${permissionLabel(planReturn ?? "default")}`}
                    label={permissionLabel(planReturn ?? "default")} />
                : <ChipMenu ariaLabel="Permission mode" warning={session.permissionMode === "bypassPermissions"}
                    label={permissionLabel(session.permissionMode)} items={permissionItems} />
            )}
            {canPlan && (
              <ChipMenu ariaLabel="Mode" title={inPlan ? "Mode: Plan — the agent researches and proposes, but does not edit" : "Mode: Build"}
                icon={inPlan ? "plan" : "tool"} label={inPlan ? "Plan" : "Build"} items={modeItems} />
            )}
            {confirmBypass && (
              <button className="composer-chip bypass-confirm"
                onClick={() => { setConfirmBypass(false); onOptions({ permissionMode: "bypassPermissions" }); }}>
                Allow everything? Confirm
              </button>
            )}
          </div>
          <div className="composer-actions">
            <button type="button" className="icon-btn composer-attach" aria-label="Attach files"
              title="Attach files (or drop them here)" onClick={onAttachPick}>
              <Icon name="attach" size={15} />
            </button>
            {/* Send↔stop morph (§6): both icons stay in the DOM; data-state cross-fades them (160ms,
                opacity + scale .25→1 + 4px blur). ⌘↵ still sends while running — only the button morphs. */}
            {/* `sessions.send` requires non-empty text (rpc.ts), so attachments alone cannot be sent.
                Rather than let the button look broken, it says why. */}
            <button className="composer-send" data-state={running ? "stop" : "send"}
              aria-label={running ? "Stop" : "Send"}
              title={running ? "Stop (interrupt)" : (!draft.trim() && attachments.length > 0 ? "Add a message to send with these files" : "Send (⌘↵)")}
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
