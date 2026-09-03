import { Icon } from "@realm/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SessionStatus } from "@realm/contracts";
import { AttachmentTile } from "./AttachmentTile";
import type { PermissionDecision } from "../../state/store";
import { Markdown } from "./Markdown";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard, questionCardFor } from "./QuestionCard";
import { ToolCard, ToolGroup } from "./ToolCard";
import { groupTranscript } from "./tool-group";
import { blockKey, type Transcript as TranscriptModel } from "./transcript-model";
import { useEnterTracker } from "./transcript-enter";

const NEAR_BOTTOM_PX = 80;
/** Permission cards share the blocks' key space; the prefix keeps a requestId from colliding with one. */
const permKey = (requestId: string) => `perm:${requestId}`;

function Thinking({ text, enter }: { text: string; enter?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="msg-thinking" data-enter={enter || undefined}>
      <button className="thinking-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Icon name="idea" size={13} /><span>Thinking…</span></button>
      {open && <Markdown text={text} className="thinking-body" />}
    </div>
  );
}

/** Scrolling message list. Follows the bottom while the reader is near it; otherwise offers a "new messages" pill.
 *  Content lives in a centered 680px `.transcript-col` so messages share rails with the prompter (§4);
 *  the scrollbar stays at the pane edge because `.transcript` itself is the scroller. */
export function Transcript({ transcript, sessionStatus, onDecide, visible = true, focused = false }: {
  transcript: TranscriptModel; sessionStatus: SessionStatus; onDecide: (requestId: string, d: PermissionDecision, answers?: Record<string, string>) => void; visible?: boolean;
  /** The pane sits in the focused leaf: the first pending permission card autofocuses (U-H4). */
  focused?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [pill, setPill] = useState(false);
  const count = transcript.blocks.length;
  const lastText = transcript.blocks.at(-1);
  const lastLen = lastText && "text" in lastText ? lastText.text.length : 0;
  // Permission cards only make sense while the adapter is actually waiting; stale requests (crash, restart) are closed server-side.
  const permissions = sessionStatus === "waiting_permission" ? transcript.pendingPermissions : [];
  // §6: 180ms enter, new items only. Everything on screen at mount is seeded as already-seen, so
  // re-rendering, scrolling, or coming back to this session never replays an entrance.
  const isEntering = useEnterTracker([
    ...transcript.blocks.map(blockKey),
    ...permissions.map((p) => permKey(p.requestId)),
  ]);

  const onScroll = () => {
    const el = ref.current; if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (atBottom.current) setPill(false);
  };
  const scrollToBottom = () => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; atBottom.current = true; setPill(false); };

  useLayoutEffect(() => {
    if (atBottom.current) { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }
    else if (count > 0) setPill(true);
  }, [count, lastLen, permissions.length, visible]);
  useEffect(() => { scrollToBottom(); }, []); // first paint of a restored transcript starts at the end

  return (
    <div className="transcript-wrap">
      <div className="transcript" ref={ref} onScroll={onScroll} role="log" aria-live="polite" aria-label="Transcript">
        <div className="transcript-col">
        {groupTranscript(transcript.blocks).map((it) => {
          if (it.kind === "group")
            // The group container itself never animates in: when a run crosses the grouping
            // threshold the cards it swallows are already on screen, and wrapping them in a fresh
            // entrance would replay motion for items the reader has been watching.
            return <ToolGroup key={it.key} sessionStatus={sessionStatus}
              steps={it.steps.map((s) => ({ ...s, enter: isEntering(s.key) }))} />;
          const b = it.block, key = it.key, enter = isEntering(key);
          switch (b.kind) {
            case "user": return (
              // Attachments sit ABOVE the bubble, not inside it (and not below): what was sent was a
              // stack of files with a note under it, and the tiles are the subject rather than a
              // footnote to the text. It is also the only arrangement that survives the two
              // degenerate cases — an attachment-only message has no bubble to sit inside, and a long
              // message would otherwise push its own files off the bottom of the card.
              <div key={key} className="msg-user-row" data-enter={enter || undefined} data-from={b.from ? "" : undefined}>
                {/* A question another session asked is NOT the user's words. Rendering it as a plain
                    user bubble would have the user believing they typed it — a lie by omission — so
                    the bubble is attributed and styled apart. The fenced text itself is left exactly
                    as the peer received it: the user should see what the agent was actually handed. */}
                {b.from && <span className="msg-user-from">Asked by {b.from.title}</span>}
                {b.attachments && (
                  <ul className="msg-user-files" aria-label="Attached files">
                    {b.attachments.map((a) => (
                      <li key={a.path}><AttachmentTile path={a.path} mime={a.mime} /></li>
                    ))}
                  </ul>
                )}
                {/* An attachment-only message has no text at all, and an empty bubble would read as a
                    send that lost its words rather than one that carried only files. */}
                {b.text && <div className="msg-user">{b.text}</div>}
              </div>);
            case "assistant": return <Markdown key={key} className="msg-assistant" text={b.text} streaming={b.streaming} enter={enter} />;
            case "thinking": return <Thinking key={key} text={b.text} enter={enter} />;
            case "tool": return <ToolCard key={key} block={b} sessionStatus={sessionStatus} enter={enter} />;
            case "error": return <div key={key} className="msg-error" role="alert" data-enter={enter || undefined}><Icon name="alert" size={14} /><pre>{b.message}</pre></div>;
          }
        })}
        {permissions.map((p, i) => {
          // A question-shaped tool call gets the question card; everything else is a permission and
          // keeps the Allow / Allow always / Deny gate.
          const questions = questionCardFor(p);
          if (questions) return <QuestionCard key={p.requestId} questions={questions} autoFocus={focused && i === 0}
            enter={isEntering(permKey(p.requestId))}
            onAnswer={(answers) => onDecide(p.requestId, "allow", answers)} onSkip={() => onDecide(p.requestId, "deny")} />;
          return <PermissionCard key={p.requestId} permission={p} autoFocus={focused && i === 0}
            enter={isEntering(permKey(p.requestId))} onDecide={(d) => onDecide(p.requestId, d)} />;
        })}
        {/* Plan 9 W2: BUI LoadingState's shimmer label — shown by the session's real status, never a clock. */}
        {sessionStatus === "running" && (!lastText || lastText.kind !== "assistant" || !lastText.streaming) && <div className="msg-working muted"><span className="shimmer-text">Working…</span></div>}
        </div>
      </div>
      {pill && <button className="new-msgs-pill" onClick={scrollToBottom}><Icon name="arrowDown" size={13} /> New messages</button>}
    </div>
  );
}
