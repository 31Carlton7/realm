import { Icon } from "@realm/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SessionStatus } from "@realm/contracts";
import type { PermissionDecision } from "../../state/store";
import { Markdown } from "./Markdown";
import { PermissionCard } from "./PermissionCard";
import { ToolCard } from "./ToolCard";
import type { Transcript as TranscriptModel } from "./transcript-model";

const NEAR_BOTTOM_PX = 80;

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="msg-thinking">
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
        {transcript.blocks.map((b, i) => {
          switch (b.kind) {
            case "user": return <div key={i} className="msg-user-row"><div className="msg-user">{b.text}</div></div>;
            case "assistant": return <Markdown key={i} className="msg-assistant" text={b.text} streaming={b.streaming} />;
            case "thinking": return <Thinking key={i} text={b.text} />;
            case "tool": return <ToolCard key={b.toolUseId} block={b} sessionStatus={sessionStatus} />;
            case "error": return <div key={i} className="msg-error" role="alert"><Icon name="alert" size={14} /><pre>{b.message}</pre></div>;
          }
        })}
        {permissions.map((p, i) => <PermissionCard key={p.requestId} permission={p} autoFocus={focused && i === 0} onDecide={(d) => onDecide(p.requestId, d)} />)}
        {sessionStatus === "running" && (!lastText || lastText.kind !== "assistant" || !lastText.streaming) && <div className="msg-working muted"><Icon name="spinner" size={13} className="spin" /> Working…</div>}
        </div>
      </div>
      {pill && <button className="new-msgs-pill" onClick={scrollToBottom}><Icon name="arrowDown" size={13} /> New messages</button>}
    </div>
  );
}
