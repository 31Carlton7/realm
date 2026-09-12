import { AGENT_META, sessionModeOf } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Composer } from "../panes/session/Composer";
import { emptyTranscript } from "../panes/session/transcript-model";
import { Transcript } from "../panes/session/Transcript";
import { useApp, useBrowserRects } from "../state/store";
import { useFileDrop } from "./use-file-drop";
import { complementOf } from "../state/no-overlay";

/** The window's size. Fixed rather than resizable: it is a corner of the screen you ask something
 *  in, and a chat you want to size is a chat that wanted a pane. */
const W = 380;
const H = 520;
/** How far the window sits from the window's edges when it has not been dragged. */
const MARGIN = 16;

/**
 * The quick chat — a session in a window instead of a pane.
 *
 * The thing it is FOR is the question you do not want to rearrange your workspace to ask. Opening a
 * session normally splits a pane, which is right when the answer is the work and wrong when the
 * answer is one paragraph you wanted while looking at something else. So this takes no layout at
 * all: it floats over whatever is already on screen, it drags to wherever it is in the way least,
 * and closing it takes the conversation with it.
 *
 * It is an ORDINARY session underneath — the same row in the space, the same transcript, the same
 * agent, the same skills. What the window drops is chrome, never capability: no browser, no
 * documents, no terminal, no summary, no permission or mode chips, because every one of those is a
 * fact about a workspace and this is a question in a corner. The model picker stays, and files still
 * drop onto the card, because those change what the next send IS.
 */
export function QuickChat() {
  const chat = useApp((s) => s.quickChat);
  /* Whichever space is active, and across relaunches. It belongs to the app, not to a space's list
     of work — it has no item row to be in one — so a space switch neither hides it nor closes it.
     The session's own row still names a space, because an agent needs a working directory to run
     commands in; that is where its work lands, not where the window lives. */
  if (!chat) return null;
  return <ChatWindow key={chat.sessionId} sessionId={chat.sessionId} />;
}

/** Split out so every hook below belongs to one live chat and is discarded with it — a closed chat
 *  must not leave a drag listener or a transcript subscription behind. */
function ChatWindow({ sessionId }: { sessionId: string }) {
  const session = useApp((s) => s.sessions[sessionId]);
  const status = useApp((s) => s.sessionStatus[sessionId] ?? s.sessions[sessionId]?.status ?? "idle");
  const entry = useApp((s) => s.transcripts[sessionId]);
  const draft = useApp((s) => s.drafts[sessionId] ?? "");
  const attachments = useApp((s) => s.pendingAttachments[sessionId] ?? NO_ATTACHMENTS);
  const modelFavorites = useApp((s) => s.modelFavorites);
  const modelInfo = useApp((s) => s.modelInfo);
  const agentProbe = useApp((s) => s.agentProbe);
  const submitKey = useApp((s) => s.submitKey);
  const pos = useApp((s) => s.quickChatPos);
  const setQuickChatPos = useApp((s) => s.setQuickChatPos);
  const closeQuickChat = useApp((s) => s.closeQuickChat);
  const setDraft = useApp((s) => s.setDraft);
  const sendMessage = useApp((s) => s.sendMessage);
  const interruptSession = useApp((s) => s.interruptSession);
  const setSessionOptions = useApp((s) => s.setSessionOptions);
  const setSessionAgent = useApp((s) => s.setSessionAgent);
  const attachFromPicker = useApp((s) => s.attachFromPicker);
  const attachFiles = useApp((s) => s.attachFiles);
  const removeAttachment = useApp((s) => s.removeAttachment);
  const respondPermission = useApp((s) => s.respondPermission);
  const retryLastTurn = useApp((s) => s.retryLastTurn);
  const toggleModelFavorite = useApp((s) => s.toggleModelFavorite);
  const run = useApp((s) => s.run);

  const transcript = entry?.t ?? EMPTY_TRANSCRIPT;
  const [sends, setSends] = useState(0);
  /* The WINDOW takes a dropped file, not the card inside it — the same reach the session pane gives
     a file dropped anywhere on it, and for a stronger reason here: the card is the bottom fifth of a
     380px window, and everything above it is the transcript you were reading when you picked the
     file up. The prompter does not claim the drag in compact (Composer.tsx), so one drag lights one
     thing wherever it is held. */
  const fileDrop = useFileDrop((files) => run(() => attachFiles(sessionId, files)));
  const drag = useDrag({ pos, onMove: setQuickChatPos });
  const said = transcript.blocks.length > 0;
  const [confirming, setConfirming] = useState(false);

  /* Escape closes an EMPTY chat and nothing else. A chat with a conversation in it is something a
     stray key would cost you, and Escape is not a key anyone presses deliberately to delete. */
  useEffect(() => {
    if (said) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); run(() => closeQuickChat()); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [said, closeQuickChat, run]);

  if (!session) return null;
  const kind = session.agentKind;

  return createPortal(
    <section className="quick-chat" style={{ left: drag.x, top: drag.y, width: W, height: H }}
      role="dialog" aria-label="Quick chat"
      data-dropping={fileDrop.dropping || undefined} {...fileDrop.handlers}>
      {/* The bar is the handle. There is no title to speak of — the chat has no name until it has a
          conversation — so what it carries is the agent it will ask and the way out. */}
      <header className="quick-chat-bar" data-dragging={drag.dragging || undefined} onPointerDown={drag.onPointerDown}>
        <Icon name={AGENT_META[kind].icon} size={14} colored className="quick-chat-mark" />
        {/* "Quick chat" until the conversation has named itself. The session's own title is "New
            session" until the agent writes one, and a window whose bar says "New session" is a
            window telling you the one thing you already knew. */}
        <span className="quick-chat-title">{said ? session.title : "Quick chat"}</span>
        {/* The trash, not a ×. Closing DELETES — this window is the only place the conversation was
            ever shown, so a close that promised to keep it would be promising what it does not do
            (design.md: name the consequence, and distinguish removing from a layout from deleting
            the object). It arms first once there is something to lose, and not before: a confirm on
            an empty chat guards nothing. */}
        {confirming ? (
          <button type="button" className="btn-quiet quick-chat-confirm" autoFocus
            onClick={() => run(() => closeQuickChat())} onBlur={() => setConfirming(false)}>
            Delete this chat?
          </button>
        ) : (
          <button type="button" className="icon-btn" aria-label="Close quick chat" title={said ? "Delete this chat" : "Close"}
            onClick={() => (said ? setConfirming(true) : run(() => closeQuickChat()))}>
            <Icon name="trash" size={14} />
          </button>
        )}
      </header>
      {/* The window's middle, as its own box — the transcript or the empty state, and the drag glow
          that belongs to exactly that region. It exists for the glow: an overlay hung off the WINDOW
          spans the prompter too, and a drop target drawn around the card says the card takes the
          file, which it does not. The box ends where the prompter begins, so the ring cannot reach
          it by construction rather than by a z-index that has to be got right. */}
      <div className="quick-chat-body">
        {/* An empty chat says what this window IS, and — once — what closing it does. Stated here
            rather than only at the moment of deletion, because "closing removes the chat" is a fact
            worth having before you have typed anything into one, not after. It is also the only thing
            that keeps 400px of empty surface from reading as a pane that failed to load. */}
        {said ? (
          <Transcript transcript={transcript} sessionStatus={status} visible focused
            cwd={session.cwd} mode={sessionModeOf(session.permissionMode)} sends={sends} scrollKey={sessionId}
            onDecide={(requestId, d, answers) => run(() => respondPermission(sessionId, requestId, d, answers))}
            onRetry={() => { setSends((n) => n + 1); run(() => retryLastTurn(sessionId)); }} />
        ) : (
          <p className="quick-chat-empty">
            A chat that floats over your work and takes no pane.
            <span>Drag the bar to move it. Closing it deletes the conversation.</span>
          </p>
        )}
        {/* The pane's own glow, over the reading area alone — one layer now, wash and stroke
            together, because a ring inside this box has no card to be hidden behind. It names the
            gesture in the middle: at 380px the glow alone is a lit rectangle, and a rectangle is
            not an instruction. The word is the whole of the label's job — what actually happens is
            said by the attachment tile that lands in the prompter. */}
        {fileDrop.dropping && (
          <div className="session-drop quick-chat-drop" aria-hidden="true">
            <span className="quick-chat-drop-label"><Icon name="attach" size={14} />Drop files to attach</span>
          </div>
        )}
      </div>
      {/* The pane's own prompter, in compact: no plan strip, no branch, no permission or mode chips,
          no under-strip. One card, the model, and send. */}
      <Composer compact session={session} status={status} gitInfo={null} hero={false} spaceName=""
        onOpenDiff={NOOP} draft={draft} onDraftChange={(t) => setDraft(sessionId, t)}
        attachments={attachments}
        onAttachPick={() => run(() => attachFromPicker(sessionId))}
        onAttachFiles={(files) => run(() => attachFiles(sessionId, files))}
        onRemoveAttachment={(path) => removeAttachment(sessionId, path)}
        onSend={(text) => { setSends((n) => n + 1); run(() => sendMessage(sessionId, text)); }}
        onStop={() => run(() => interruptSession(sessionId))}
        onOptions={(o) => run(() => setSessionOptions(sessionId, o))}
        onPickModel={(pickKind, modelId) => run(async () => {
          // Same order as the pane's, and for the same reason: setAgent clears `model`, so the model
          // has to land after it or the pick would drop the one thing the user actually chose.
          if (pickKind !== kind) await setSessionAgent(sessionId, pickKind);
          if (modelId !== null) await setSessionOptions(sessionId, { model: modelId });
        })}
        onMode={NOOP} planReturn={null}
        canSwitchAgent={transcript.blocks.length === 0}
        agentProbe={agentProbe} modelFavorites={modelFavorites} modelInfo={modelInfo}
        onToggleModelFavorite={(key) => run(() => toggleModelFavorite(key))}
        submitKey={submitKey} />
    </section>,
    document.body,
  );
}

const NO_ATTACHMENTS: never[] = [];
const EMPTY_TRANSCRIPT = emptyTranscript();
const NOOP = () => {};

/**
 * Dragging the window by its bar, and keeping it on screen.
 *
 * Pointer events rather than mouse: they carry capture, so a fast drag that outruns the pointer does
 * not drop the window the moment the cursor leaves the 34px bar. Position is committed to the store
 * on every move — the drag is the only writer, and a local copy would have to be reconciled with the
 * store's on every mount.
 *
 * Where it sits when it has NOT been dragged is the bottom-right corner of the largest part of the
 * window no browser pane is covering. A `WebContentsView` composites above everything the renderer
 * draws (design.md), so a window placed in a corner a browser is filling is a window that is simply
 * not there — and the one thing a floating chat cannot afford is to open invisibly.
 */
function useDrag({ pos, onMove }: { pos: { x: number; y: number } | null; onMove: (p: { x: number; y: number }) => void }) {
  const browserRects = useBrowserRects();
  const [dragging, setDragging] = useState(false);
  // The viewport, as state: the clamp below reads it, and a resize has to re-render for the window
  // to be drawn back inside the new bounds.
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const from = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  const free = useMemo(
    () => complementOf({ x: 0, y: 0, width: viewport.w, height: viewport.h }, browserRects),
    [browserRects, viewport],
  );
  /* Total, and that is not defensiveness for its own sake: a pointer event that arrives without
     coordinates makes `p.x` NaN, and NaN survives min/max unchanged — so the clamp would return NaN,
     the re-clamp below would compare `NaN !== NaN` as "still wrong", and the two would write to the
     store forever. A non-finite coordinate is no coordinate; it takes the axis's floor. */
  const clamp = useCallback((p: { x: number; y: number }) => {
    const fit = (v: number, max: number) => (Number.isFinite(v) ? Math.min(Math.max(v, MARGIN), Math.max(MARGIN, max)) : MARGIN);
    return { x: fit(p.x, viewport.w - W - MARGIN), y: fit(p.y, viewport.h - H - MARGIN) };
  }, [viewport]);
  const corner = clamp({ x: free.x + free.width - W - MARGIN, y: free.y + free.height - H - MARGIN });
  const at = pos ? clamp(pos) : corner;

  /* The clamp is a RENDERING concern, and the stored position is the user's decision — so a window
     that is briefly too small to hold the chat draws it pulled in, and does not write that back.

     The bug this closes: Electron's window is fractionally sized for a moment during startup, which
     fires a resize while the restored position is still the one the user dragged to. Writing the
     clamped value back moved the window to that transient window's corner and forgot where they had
     put it — permanently, and only on some launches. Rendering clamped costs nothing and forgets
     nothing: grow the window back and the chat returns to where it was left. */

  const onPointerDown = (e: React.PointerEvent) => {
    // Only the bar itself, never a control on it: the close button is inside the handle, and a drag
    // that started on it would eat the click.
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).closest(".quick-chat-title")) return;
    e.preventDefault();
    /* Capture is a NICETY — it keeps the browser delivering moves to this element when the pointer
       outruns a 34px bar — and the window-level listeners below are what actually carry the drag.
       It is also the one call here that can throw: `setPointerCapture` rejects a pointer id it does
       not recognise, and jsdom does not implement it at all. Either way the drag must still start,
       so the failure is swallowed rather than allowed to take the gesture with it. */
    try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* the listeners below carry it */ }
    from.current = { px: e.clientX, py: e.clientY, x: at.x, y: at.y };
    setDragging(true);
  };
  useEffect(() => {
    if (!dragging) return;
    const onMoveEv = (e: PointerEvent) => {
      const f = from.current; if (!f) return;
      onMove(clamp({ x: f.x + (e.clientX - f.px), y: f.y + (e.clientY - f.py) }));
    };
    const onUp = () => { from.current = null; setDragging(false); };
    window.addEventListener("pointermove", onMoveEv);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMoveEv);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging, clamp, onMove]);

  return { x: at.x, y: at.y, dragging, onPointerDown };
}
