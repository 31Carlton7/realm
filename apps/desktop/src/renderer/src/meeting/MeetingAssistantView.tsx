import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { useDissolve } from "../components/ScrollFades";
import { Sheet } from "../components/Sheet";
import { useApp } from "../state/store";
import type { TranscriptLine, TranscriptSource } from "../voice/transcript";
import type { AssistantQuestion, AssistantState, MeetingAssistant } from "./assistant";

export function useAssistant(assistant: MeetingAssistant): AssistantState {
  return useSyncExternalStore(assistant.subscribe, assistant.getState);
}

export function isListening(s: AssistantState): boolean {
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

/** The panel's middle while the assistant is shown: the sheet, or the transcript and the answers. */
export function AssistantBody({ assistant }: { assistant: MeetingAssistant }) {
  const s = useAssistant(assistant);
  const scroller = useRef<HTMLDivElement>(null);
  useDissolve(scroller);
  // New words arrive at the foot, so the column follows them there.
  const count = s.lines.length + s.questions.length + s.customInfo.length + Object.keys(s.partial).length;
  const answered = s.questions.reduce((n, q) => n + q.answer.length, 0);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count, answered]);

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
                : <Question key={`q${item.q.id}`} q={item.q} />))}
          </ol>
          {s.stoppedAt !== null && <p className="meeting-stopped">Stopped.</p>}
        </div>
      )}
      {s.problem && <p className="meeting-problem" role="alert">{s.problem}</p>}
    </>
  );
}

type FeedItem =
  | { kind: "line"; line: TranscriptLine; i: number; at: number }
  | { kind: "partial"; source: TranscriptSource; text: string; at: number }
  | { kind: "question"; q: AssistantQuestion; at: number };

/** Lines and questions in the order they happened, with what each side is saying now at the foot. */
export function feed(s: AssistantState): FeedItem[] {
  const items: FeedItem[] = [
    ...s.lines.map((line, i) => ({ kind: "line" as const, line, i, at: line.at })),
    ...s.questions.map((q) => ({ kind: "question" as const, q, at: q.at })),
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

/** A typed question and its answer as it streams (the M5 engine's `AnswerEvent`s). */
function Question({ q }: { q: AssistantQuestion }) {
  return (
    <li className="meeting-question">
      <p className="meeting-asked">{q.question}</p>
      <AnswerStream q={q} />
    </li>
  );
}

export function AnswerStream({ q }: { q: AssistantQuestion }) {
  if (q.state === "unanswered") return <p className="meeting-answer" data-state="none">Live answers are not built yet.</p>;
  if (q.state === "failed") return <p className="meeting-answer" data-state="failed" role="alert">{q.error || "The answer did not come."}</p>;
  return (
    <p className="meeting-answer" data-state={q.state} aria-live="polite" aria-busy={q.state === "streaming"}>
      {q.answer || (q.state === "streaming" ? "Answering…" : "")}
    </p>
  );
}

/** The row over the prompter: where the prompter sends, the notice for the room, and Start or Stop. */
export function AssistantStrip({ assistant, target, onTarget }: {
  assistant: MeetingAssistant; target: AssistantTarget; onTarget: (t: AssistantTarget) => void;
}) {
  const s = useAssistant(assistant);
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
        <li>The transcript goes to the model only when you ask for an answer.</li>
      </ul>
    </Sheet>
  );
}
