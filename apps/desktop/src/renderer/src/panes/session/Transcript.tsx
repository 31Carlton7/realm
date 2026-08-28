import { Icon } from "@realm/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SessionStatus } from "@realm/contracts";
import type { PermissionDecision } from "../../state/store";
import { Markdown } from "./Markdown";
import { PermissionCard } from "./PermissionCard";
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
      {open && <div className="thinking-body">{text}</div>}
    </div>
  );
}

/** Scrolling message list. Follows the bottom while the reader is near it; otherwise offers a "new messages" pill.
 *  Content lives in a centered 680px `.transcript-col` so messages share rails with the prompter (§4);
 *  the scrollbar stays at the pane edge because `.transcript` itself is the scroller. */
export function Transcript({ transcript, sessionStatus, onDecide, visible = true, focused = false }: {
  transcript: TranscriptModel; sessionStatus: SessionStatus; onDecide: (requestId: string, d: PermissionDecision) => void; visible?: boolean;
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
            case "user": return <div key={key} className="msg-user-row" data-enter={enter || undefined}><div className="msg-user">{b.text}</div></div>;
            case "assistant": return <Markdown key={key} className="msg-assistant" text={b.text} streaming={b.streaming} enter={enter} />;
            case "thinking": return <Thinking key={key} text={b.text} enter={enter} />;
            case "tool": return <ToolCard key={key} block={b} sessionStatus={sessionStatus} enter={enter} />;
            case "error": return <div key={key} className="msg-error" role="alert" data-enter={enter || undefined}><Icon name="alert" size={14} /><pre>{b.message}</pre></div>;
          }
        })}
        {permissions.map((p, i) => <PermissionCard key={p.requestId} permission={p} autoFocus={focused && i === 0}
          enter={isEntering(permKey(p.requestId))} onDecide={(d) => onDecide(p.requestId, d)} />)}
        {sessionStatus === "running" && (!lastText || lastText.kind !== "assistant" || !lastText.streaming) && <div className="msg-working muted"><Icon name="spinner" size={13} className="spin" /> Working…</div>}
        </div>
      </div>
      {pill && <button className="new-msgs-pill" onClick={scrollToBottom}><Icon name="arrowDown" size={13} /> New messages</button>}
    </div>
  );
}
