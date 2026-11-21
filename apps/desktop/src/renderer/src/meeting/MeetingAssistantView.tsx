import { Icon } from "@realm/ui";
import type { MeetingSummaryOutcome } from "@realm/contracts";
import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { useDissolve } from "../components/ScrollFades";
import { Sheet } from "../components/Sheet";
import { useApp } from "../state/store";
import type { TranscriptLine, TranscriptSource } from "../voice/transcript";
import {
  LONG_CUSTOM_INFO, customInfoText, type AskedQuestion, type AssistantState, type LiveAnswer, type MeetingAssistant, type MeetingNotesState,
} from "./assistant";

function useAssistant(assistant: MeetingAssistant): AssistantState {
  return useSyncExternalStore(assistant.subscribe, assistant.getState);
}

const NO_SUBSCRIPTION = () => () => {};
const NO_STATE = () => null;

/** The assistant's state where there may be no assistant: a Realm window's quick chat has none. */
export function useAssistantState(assistant: MeetingAssistant | null): AssistantState | null {
  return useSyncExternalStore(assistant?.subscribe ?? NO_SUBSCRIPTION, assistant?.getState ?? NO_STATE);
}

/** The panel page's hold on its assistant: the notes' progress, the menu bar's Stop and the
 *  assistant's chords while it is mounted, and the run ended when the page itself goes. StrictMode
 *  rehearses this effect in dev, so the ending waits for `pagehide` rather than a cleanup. */
export function useAssistantPage(assistant: MeetingAssistant | null): void {
  useEffect(() => {
    if (!assistant) return;
    void assistant.load();
    const bridge = window.realm?.meetingAssistant;
    const offs = [assistant.watchNotes(), bridge?.onStop(() => void assistant.stop()), bridge?.onKey?.((action) => assistant.key(action))];
    bridge?.keysReady?.();
    const onPageHide = () => assistant.dispose();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      for (const off of offs) off?.();
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [assistant]);
}

function isListening(s: AssistantState): boolean {
  return s.phase !== "idle";
}

/** What the prompter sends while the assistant is shown: a question, or something to keep in mind. */
export type AssistantTarget = "ask" | "context";

export const ASSISTANT_PLACEHOLDER: Record<AssistantTarget, string> = {
  ask: "Ask about the call",
  context: "Tell the assistant what to keep in mind",
};

/** The line "Tell the room" puts on the clipboard, for the meeting's chat. */
export const TELL_THE_ROOM = "I'm using Realm to transcribe this call. It keeps the words only, no audio.";

const SPEAKER: Record<TranscriptSource, string> = { me: "Me", them: "Them" };

/** The red mark, in words beside it. Drawn whenever the assistant is listening, whatever else is
 *  set: hiding the panel from screen sharing leaves it out of a capture, never off his own screen. */
export function ListeningMark({ assistant }: { assistant: MeetingAssistant }) {
  const state = useAssistant(assistant);
  if (!isListening(state)) return null;
  return (
    <span className="meeting-mark" role="status">
      <span className="meeting-mark-dot" aria-hidden="true" />
      {state.phase === "stopping" ? "Stopping" : "Listening"}
    </span>
  );
}

/** The panel's middle while the assistant is shown: the sheet, the transcript, the answer and the notes. */
export function AssistantBody({ assistant }: { assistant: MeetingAssistant }) {
  const s = useAssistant(assistant);
  const scroller = useRef<HTMLDivElement>(null);
  useDissolve(scroller);
  // New words arrive at the foot, so the column follows them there.
  const count = s.lines.length + s.asked.length + s.customInfo.length + Object.keys(s.partial).length;
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);
  // Fn J and Fn K: a page of the words at a time, as Page Down and Page Up move one.
  useEffect(() => assistant.onScroll((direction) => {
    const el = scroller.current;
    if (el) el.scrollTop += direction * el.clientHeight;
  }), [assistant]);

  const empty = count === 0;
  return (
    <>
      {s.sheet && <ConsentSheet assistant={assistant} />}
      {empty ? (
        <p className="quick-chat-empty meeting-empty">
          {s.stoppedAt !== null ? "Stopped. Nothing was heard." : "Start listening to see the call's words here, as Me and Them."}
          <span>Words only. No audio is saved.</span>
        </p>
      ) : (
        <div ref={scroller} className="meeting-feed" data-selectable="">
          {s.customInfo.length > 0 && (
            <section className="meeting-context" aria-label="What the assistant keeps in mind">
              {s.customInfo.map((info, i) => <p key={i}>{info}</p>)}
            </section>
          )}
          <ol className="meeting-lines" aria-label="Transcript">
            {feed(s).map((item) => (item.kind === "line"
              ? <Line key={`l${item.i}`} line={item.line} startedAt={s.startedAt} />
              : item.kind === "partial"
                ? <li key={`p${item.source}`} className="meeting-line" data-source={item.source} data-partial="">
                    <span className="meeting-who">{SPEAKER[item.source]}</span><span className="meeting-words">{item.text}</span>
                  </li>
                : <li key={`q${item.q.id}`} className="meeting-asked">{item.q.text}</li>))}
          </ol>
          {s.stoppedAt !== null && <p className="meeting-stopped">Stopped.</p>}
        </div>
      )}
      {s.answer && <Answer answer={s.answer} onDismiss={() => assistant.dismissAnswer()} />}
      {s.notes && <NotesLine notes={s.notes} assistant={assistant} />}
      {s.problem && <p className="meeting-problem" role="alert">{s.problem}</p>}
    </>
  );
}

type FeedItem =
  | { kind: "line"; line: TranscriptLine; i: number; at: number }
  | { kind: "partial"; source: TranscriptSource; text: string; at: number }
  | { kind: "asked"; q: AskedQuestion; at: number };

/** Lines and typed questions in the order they happened, with what each side is saying now at the foot. */
function feed(s: AssistantState): FeedItem[] {
  const items: FeedItem[] = [
    ...s.lines.map((line, i) => ({ kind: "line" as const, line, i, at: line.at })),
    ...s.asked.map((q) => ({ kind: "asked" as const, q, at: q.at })),
  ].sort((a, b) => a.at - b.at);
  for (const source of ["them", "me"] as const) {
    const text = s.partial[source];
    if (text) items.push({ kind: "partial", source, text, at: Infinity });
  }
  return items;
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function Line({ line, startedAt }: { line: TranscriptLine; startedAt: number | null }) {
  return (
    <li className="meeting-line" data-source={line.source}>
      <span className="meeting-who">{SPEAKER[line.source]}</span>
      <span className="meeting-words">{line.text}</span>
      {startedAt !== null && <time className="meeting-time">{clock(line.at - startedAt)}</time>}
    </li>
  );
}

/** The live answer on screen, under the words: the newest one, streaming as it comes. */
function Answer({ answer, onDismiss }: { answer: LiveAnswer; onDismiss: () => void }) {
  return (
    <section className="meeting-answer" aria-label="Live answer" data-state={answer.state} data-selectable="">
      <button type="button" className="icon-btn meeting-answer-dismiss" aria-label="Dismiss the answer"
        title={answer.state === "streaming" ? "Stop and dismiss the answer" : "Dismiss the answer"} onClick={onDismiss}>
        <Icon name="close" size={12} />
      </button>
      {answer.state === "failed"
        ? <p className="meeting-answer-text" role="alert">{answer.error || "The answer did not come."}</p>
        : <p className="meeting-answer-text" aria-live="polite" aria-busy={answer.state === "streaming"}>{answer.text || "Answering…"}</p>}
    </section>
  );
}

const WITHOUT_SUMMARY: Partial<Record<MeetingSummaryOutcome, string>> = {
  unavailable: "Saved without a summary: the quick chat model's agent is not set up.",
  failed: "Saved without a summary: the summary could not be written.",
  cancelled: "Saved without a summary.",
};

/** Where Stop put the notes, and how the summary went. The path opens the file in Realm. */
function NotesLine({ notes, assistant }: { notes: MeetingNotesState; assistant: MeetingAssistant }) {
  const said = notes.stage === "saving" ? "Saving the notes…"
    : notes.stage === "summarising" ? "Writing the summary…"
    : (notes.summary && WITHOUT_SUMMARY[notes.summary]) ?? "Notes saved.";
  return (
    <p className="meeting-notes" role="status">
      <span>{said}</span>
      {notes.path && (
        <button type="button" className="meeting-notes-path" title="Open in Realm" onClick={() => assistant.openNotes()}>{notes.path}</button>
      )}
      {notes.stage === "summarising" && (
        <button type="button" className="btn-quiet" onClick={() => assistant.cancelSummary()}>Cancel summary</button>
      )}
    </p>
  );
}

/** The bar's switch for answering a question the other side asks, without the answer key. */
export function AutoAnswersSwitch({ assistant }: { assistant: MeetingAssistant }) {
  const s = useAssistant(assistant);
  return (
    <label className="meeting-auto" title="When the other side asks a question, an answer starts without a key. Off, only the answer key and a typed question ask.">
      Auto-answer
      <input type="checkbox" role="switch" className="switch" checked={s.autoAnswers}
        onChange={(e) => assistant.setAutoAnswers(e.target.checked)} />
    </label>
  );
}

/** The row over the prompter: where the prompter sends, the notice for the room, and Start or Stop. */
export function AssistantStrip({ assistant, target, onTarget, draft }: {
  assistant: MeetingAssistant; target: AssistantTarget; onTarget: (t: AssistantTarget) => void;
  /** What the prompter holds now, which counts toward the custom info while it sends to Context. */
  draft: string;
}) {
  const s = useAssistant(assistant);
  const info = customInfoText(target === "context" && draft.trim() ? [...s.customInfo, draft.trim()] : s.customInfo).length;
  const toast = useApp((st) => st.toast);
  const ids = useId();
  const listening = isListening(s);
  const tellTheRoom = () => {
    void navigator.clipboard.writeText(TELL_THE_ROOM).then(
      () => toast({ tone: "success", text: "Copied. Paste it in the meeting's chat.", icon: "copy" }),
      () => toast({ tone: "error", text: "Realm could not copy the notice." }),
    );
  };
  return (
    <>
    <div className="meeting-strip">
      <fieldset className="seg">
        <legend className="visually-hidden">The prompter sends</legend>
        {(["ask", "context"] as const).map((t) => (
          <label key={t} className="seg-opt" data-selected={target === t || undefined}>
            <input type="radio" name={`${ids}-target`} value={t} checked={target === t} onChange={() => onTarget(t)} />
            {t === "ask" ? "Ask" : "Context"}
          </label>
        ))}
      </fieldset>
      <button type="button" className="btn-quiet meeting-tell" title={`Copies a notice to paste in the meeting's chat: "${TELL_THE_ROOM}"`}
        onClick={tellTheRoom}>
        Tell the room
      </button>
      {listening ? (
        <button type="button" className="btn-quiet meeting-stop" disabled={s.phase === "stopping"} onClick={() => void assistant.stop()}>
          Stop
        </button>
      ) : (
        <button type="button" className="btn-quiet meeting-start" disabled={s.sheet} onClick={() => void assistant.start()}>
          {s.stoppedAt !== null ? "Start again" : "Start listening"}
        </button>
      )}
    </div>
    {info > LONG_CUSTOM_INFO && (
      <p className="meeting-long">Every answer sends all {info.toLocaleString("en-US")} characters of custom info.</p>
    )}
    </>
  );
}

/** Before the first listen: what listening means, and that telling people is his to do. */
function ConsentSheet({ assistant }: { assistant: MeetingAssistant }) {
  return (
    <Sheet title="Before you start listening" width={340} onClose={() => assistant.dismissSheet()}
      footer={<>
        <button type="button" className="btn" onClick={() => assistant.dismissSheet()}>Not now</button>
        <button type="button" className="btn primary" onClick={() => void assistant.accept()}>Start listening</button>
      </>}>
      <ul className="meeting-consent">
        <li>Telling the people on the call is your job. Tell the room puts a notice on your clipboard.</li>
        <li>In California, everyone on the call has to agree before it is recorded.</li>
        <li>Realm keeps the words only. No audio is saved.</li>
        <li>Each live answer sends the last three minutes of transcript, your custom info and any question you typed to Anthropic, through the Claude CLI on your own Claude account.</li>
        <li>When you stop, the summary sends the transcript, your questions and your custom info to the model chosen for quick chat. If that model runs through an agent other than Claude or Codex, that agent's app keeps its usual copy on the Mac.</li>
        <li>Nothing else leaves the Mac.</li>
      </ul>
    </Sheet>
  );
}
