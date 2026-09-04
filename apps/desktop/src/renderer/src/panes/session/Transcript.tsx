import { Icon } from "@realm/ui";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { basenameOf, isPlayablePath, mediaCandidatesIn, type MediaFile, type SessionStatus } from "@realm/contracts";
import { AttachmentTile } from "./AttachmentTile";
import type { PermissionDecision } from "../../state/store";
import { Markdown } from "./Markdown";
import { PermissionCard } from "./PermissionCard";
import { PlanCard, PlanDecision, isPlanDecision } from "./PlanCard";
import { QuestionCard, questionCardFor } from "./QuestionCard";
import { ToolCard, ToolGroup } from "./ToolCard";
import { formatDuration, groupTranscript, withEnter } from "./tool-group";
import { blockKey, type Transcript as TranscriptModel } from "./transcript-model";
import { runLabelFor } from "./run-label";
import { useEnterTracker } from "./transcript-enter";
import { MediaLightbox, MediaStrip } from "./media/MediaView";
import { useMediaByCandidate, useMediaFiles } from "./media/use-media";

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

/**
 * The tiles above a user message. Media among them opens in the lightbox on click.
 *
 * A screenshot was already visible as a 56px thumbnail, which answers "did I attach the right file"
 * and nothing else; a video attachment could not be played at all. Both are files the user chose,
 * so both are files they should be able to look at without leaving for Finder.
 *
 * Non-media attachments keep the plain tile. A PDF's tile shows its first page and there is nothing
 * more Realm can do with it here, so making it look clickable would be a promise it cannot keep.
 */
function UserAttachments({ attachments }: { attachments: readonly { path: string; mime: string }[] }) {
  const candidates = useMemo(
    () => attachments.filter((a) => isPlayablePath(a.path)).map((a) => a.path),
    [attachments],
  );
  const byCandidate = useMediaByCandidate(candidates);
  const [open, setOpen] = useState<MediaFile | null>(null);
  return (
    <>
      <ul className="msg-user-files" aria-label="Attached files">
        {attachments.map((a) => {
          const file = byCandidate.get(a.path);
          const tile = <AttachmentTile path={a.path} mime={a.mime} />;
          return (
            <li key={a.path}>
              {file
                ? <button type="button" className="msg-user-file-open" aria-label={`Open ${basenameOf(a.path)}`} onClick={() => setOpen(file)}>{tile}</button>
                : tile}
            </li>
          );
        })}
      </ul>
      {open && <MediaLightbox file={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/**
 * An assistant message, plus whatever media it is pointing at.
 *
 * The strip is deliberately NOT part of the markdown. A message that says "the three videos are in
 * `~/Desktop/mockups/`" and lists their names has embedded nothing — there is no `![](…)` to fill —
 * but it is unmistakably telling the reader to go and look, and having to leave for Finder to find
 * out whether the render is any good is the gap this closes.
 *
 * Nothing is drawn while the message is still streaming. Half a path is a different path, and a
 * strip that appeared, changed and disappeared as the sentence completed would be worse than one
 * that waits for the full stop.
 */
function AssistantMessage({ text, streaming, enter, cwd }: { text: string; streaming: boolean; enter: boolean; cwd: string | null }) {
  const candidates = useMemo(() => (streaming ? [] : mediaCandidatesIn(text, cwd)), [streaming, text, cwd]);
  const files = useMediaFiles(candidates);
  return (
    <>
      <Markdown className="msg-assistant" text={text} enter={enter} />
      <MediaStrip files={files} />
    </>
  );
}

/** Scrolling message list. Follows the bottom while the reader is near it; otherwise offers a "new messages" pill.
 *  Content lives in a centered 680px `.transcript-col` so messages share rails with the prompter (§4);
 *  the scrollbar stays at the pane edge because `.transcript` itself is the scroller. */
export function Transcript({ transcript, sessionStatus, onDecide, visible = true, focused = false, cwd = null, sends = 0 }: {
  transcript: TranscriptModel; sessionStatus: SessionStatus; onDecide: (requestId: string, d: PermissionDecision, answers?: Record<string, string>) => void; visible?: boolean;
  /** The pane sits in the focused leaf: the first pending permission card autofocuses (U-H4). */
  focused?: boolean;
  /** The session's working directory — the base a message's bare filenames are joined against when
   *  it names no directory of its own. Null in tests and wherever the session is not yet known. */
  cwd?: string | null;
  /** How many messages the prompter below has sent, counted by the pane. Sending is an unambiguous
   *  statement that the bottom is where the reader wants to be, so it re-pins from wherever they had
   *  scrolled to — and because the pin is `atBottom` itself, it holds across the RPC until the
   *  `user_message` block lands, which is what stops a send answering itself with the pill. */
  sends?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [pill, setPill] = useState(false);
  const count = transcript.blocks.length;
  const lastText = transcript.blocks.at(-1);
  // `?? 0` because not every text-bearing block has text: a checklist-only plan carries none.
  const lastLen = lastText && "text" in lastText ? lastText.text?.length ?? 0 : 0;
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
  // First paint of a restored transcript starts at the end, and so does every send.
  useLayoutEffect(() => { scrollToBottom(); }, [sends]);

  /* Content that grows AFTER its block arrived. The effect above fires on new blocks and on the
     streaming message getting longer, and neither describes a media strip: it appears once main has
     confirmed the files, several frames later, and then grows again as each picture decodes. Without
     this the reader is left looking at the top of a video whose controls are under the prompter.
     Only while already at the bottom — a reader who has scrolled up must not be yanked down. */
  useLayoutEffect(() => {
    const col = ref.current?.querySelector(".transcript-col");
    if (!col) return;
    const ro = new ResizeObserver(() => {
      const el = ref.current;
      if (atBottom.current && el) el.scrollTop = el.scrollHeight;
    });
    ro.observe(col);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="transcript-wrap">
      <div className="transcript" ref={ref} onScroll={onScroll} role="log" aria-live="polite" aria-label="Transcript">
        <div className="transcript-col">
        {groupTranscript(transcript.blocks).map((it) => {
          if (it.kind === "group")
            // The group container itself never animates in: when a run crosses the grouping
            // threshold the cards it swallows are already on screen, and wrapping them in a fresh
            // entrance would replay motion for items the reader has been watching.
            return <ToolGroup key={it.key} sessionStatus={sessionStatus} steps={withEnter(it.steps, isEntering)} />;
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
                {b.attachments && <UserAttachments attachments={b.attachments} />}
                {/* An attachment-only message has no text at all, and an empty bubble would read as a
                    send that lost its words rather than one that carried only files. */}
                {b.text && <div className="msg-user">{b.text}</div>}
              </div>);
            case "assistant": return <AssistantMessage key={key} text={b.text} streaming={b.streaming} enter={enter} cwd={cwd} />;
            case "thinking": return <Thinking key={key} text={b.text} enter={enter} />;
            case "tool": return <ToolCard key={key} block={b} sessionStatus={sessionStatus} enter={enter} nested={withEnter(it.nested, isEntering)} />;
            case "plan": return <PlanCard key={key} text={b.text} steps={b.steps} enter={enter} />;
            case "error": return <div key={key} className="msg-error" role="alert" data-enter={enter || undefined}><Icon name="alert" size={14} /><pre>{b.message}</pre></div>;
            // The shimmer the reader was watching, settled: same verb, past tense, with the wait it
            // cost them. It stays in the scrollback rather than vanishing with the spinner — "how
            // long did that take" is a question asked after the fact, not during.
            case "run": return <div key={key} className="msg-run muted" data-enter={enter || undefined}>{runLabelFor(b.startedAt).past} for {formatDuration(b.ms)}</div>;
          }
        })}
        {permissions.map((p, i) => {
          // Only what really is a permission keeps the Allow / Allow always / Deny gate.
          const questions = questionCardFor(p);
          if (questions) return <QuestionCard key={p.requestId} questions={questions} autoFocus={focused && i === 0}
            enter={isEntering(permKey(p.requestId))}
            onAnswer={(answers) => onDecide(p.requestId, "allow", answers)} onSkip={() => onDecide(p.requestId, "deny")} />;
          // A plan is not a permission. The plan itself is already a block above (mapped off the same
          // tool call), so this is only the answer to it — repeating the markdown here would print the
          // plan twice.
          if (isPlanDecision(p)) return <PlanDecision key={p.requestId} autoFocus={focused && i === 0}
            enter={isEntering(permKey(p.requestId))} onDecide={(d) => onDecide(p.requestId, d)} />;
          return <PermissionCard key={p.requestId} permission={p} autoFocus={focused && i === 0}
            enter={isEntering(permKey(p.requestId))} onDecide={(d) => onDecide(p.requestId, d)} />;
        })}
        {/* Plan 9 W2: BUI LoadingState's shimmer label — shown by the session's real status, never a clock.
            The word is this run's (run-label.ts), and `run.startedAt` holds it still: seeding it on
            anything that moves would re-roll the verb on every streaming delta. */}
        {sessionStatus === "running" && (!lastText || lastText.kind !== "assistant" || !lastText.streaming) && <div className="msg-working muted"><span className="shimmer-text">{runLabelFor(transcript.run?.startedAt ?? 0).present}…</span></div>}
        </div>
      </div>
      {/* The transcript dissolves into the prompter instead of being clipped by it — a sibling of the
          scroller (not a child) so its backdrop-filter still sees the text scrolling underneath. */}
      <div className="transcript-fade" aria-hidden="true" />
      {pill && <button className="new-msgs-pill" onClick={scrollToBottom}><Icon name="arrowDown" size={13} /> New messages</button>}
    </div>
  );
}
