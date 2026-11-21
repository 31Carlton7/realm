import type { TranscriptLine } from "../voice/transcript";

/** A question typed into the assistant during the call, and what came back for it. */
export type MeetingNote = { question: string; answer: string; at: number };

/** What one listening run leaves behind, from Start to Stop. */
export type MeetingRecord = {
  transcript: readonly TranscriptLine[];
  notes: readonly MeetingNote[];
  /** What he told the assistant to keep in mind, in the order he gave it. */
  customInfo: readonly string[];
};

/**
 * Stop hands the run to this. M4 plugs the summary and the Markdown file in `meetings/` in here;
 * until then it does nothing.
 */
export type MeetingSummaryHook = (record: MeetingRecord) => void | Promise<void>;
export const noSummary: MeetingSummaryHook = () => {};

/** What an answer is asked from: the question, and what the assistant may read to answer it. */
export type AnswerRequest = {
  question: string;
  transcript: readonly TranscriptLine[];
  customInfo: readonly string[];
};

/** An answer as it streams in: text arrives in pieces, then it ends one way or the other. */
export type AnswerEvent = { t: "text"; text: string } | { t: "done" } | { t: "error"; message: string };

/**
 * The live answer's engine. M5 plugs it in (built by the engines team); the panel only draws the
 * stream. `answer` starts one and returns a cancel.
 */
export interface AnswerEngine {
  answer(request: AnswerRequest, onEvent: (event: AnswerEvent) => void): () => void;
}
