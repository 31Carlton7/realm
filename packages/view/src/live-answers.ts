import type { MeetingLine } from "@realm/contracts";

/** How much of the call a live answer reads: the last three minutes, counted back from the newest
 *  line's end. Long enough to hold the question and what led to it, short enough that an hour-long
 *  call sends the model a few hundred words, never the whole meeting. */
export const LIVE_ANSWER_WINDOW_MS = 3 * 60_000;

/** The lines a live answer is given, in the order they were said. */
export function answerWindow(lines: readonly MeetingLine[], windowMs = LIVE_ANSWER_WINDOW_MS): MeetingLine[] {
  if (lines.length === 0) return [];
  const newest = Math.max(...lines.map((l) => l.end));
  return lines.filter((l) => l.end >= newest - windowMs).sort((a, b) => a.start - b.start);
}

/** A question the other side put to me, as `questionForMe` found it: the sentence, and the span of
 *  their turn that holds it. `end` is the end of the line that finished it. */
export type AskedQuestion = { text: string; start: number; end: number };

/** Ends a sentence: a full stop, a question mark or an exclamation mark, with any closing quote. */
const SENTENCES = /[^.?!]+[.?!]+["”’)]*/g;

/** A question tacked onto a statement to check it landed, which nobody expects an answer to. */
const TAGS = /(?:^|,\s*)(?:right|ok|okay|yeah|yes|no|huh|eh|you know|see|isn't it|aren't they|don't you think|wouldn't you say|am i right|correct)\?$/;

/** Asked without a question mark: a request to say something. */
const ASKS = /^(tell me|tell us|walk me through|walk us through|talk me through|talk us through|explain|describe|give me|give us)\b/;

const plain = (s: string) => s.toLowerCase().replace(/’/g, "'").replace(/[“”"]/g, "").replace(/\s+/g, " ").trim();

function isAsk(sentence: string): boolean {
  const s = plain(sentence);
  if (TAGS.test(s)) return false;
  return s.endsWith("?") || ASKS.test(s);
}

/**
 * The question the other side has just asked me, or null.
 *
 * Read from the end of the transcript, in the order things were said:
 * - Only "them" asks. Once I have said anything after it, the question is mine to have answered,
 *   so a "me" line last means null, and a question of my own is never one.
 * - Their turn is every "them" line since my last one, read as one text, because the recogniser
 *   cuts a long sentence into lines. A turn whose last sentence has not ended yet is still being
 *   said, so it waits for the line that ends it.
 * - The question has to be the last thing they said. One they went on to answer themselves
 *   ("What does that mean? It means we ship Friday.") was rhetorical.
 * - A tag on a statement ("That's the plan, right?") is not a question to answer.
 */
export function questionForMe(lines: readonly MeetingLine[]): AskedQuestion | null {
  const said = [...lines].sort((a, b) => a.start - b.start);
  let first = said.length;
  while (first > 0 && said[first - 1]!.source === "them") first--;
  const turn = said.slice(first);
  if (turn.length === 0) return null;
  const text = turn.map((l) => l.text.trim()).filter(Boolean).join(" ");
  if (!/[.?!]["”’)]*$/.test(text)) return null;
  const last = text.match(SENTENCES)?.at(-1)?.trim();
  if (!last || !isAsk(last)) return null;
  return { text: last, start: turn[0]!.start, end: turn.at(-1)!.end };
}
