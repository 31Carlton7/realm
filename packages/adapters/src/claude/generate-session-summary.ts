import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

type QueryFn = typeof sdkQuery;

/** Two sentences of prose, and a hard ceiling so a model that ignores the brief cannot push the
 *  transcript's closing line into a paragraph. */
const SUMMARY_MAX = 320;

/** How much transcript the model is shown. A summary is worth one small call, not a large one: the
 *  tail is where the answer is, and the ask at the top is passed separately so it survives the clip. */
const TAIL_CHARS = 6000;

export type SummaryInput = {
  /** The first thing the user asked, already clipped by the caller. */
  asked: string;
  /** The transcript as prose, oldest first. Clipped from the END here. */
  transcript: string;
  /** The derived line — what Realm counted. Given to the model as FACTS, not as a draft to rewrite:
   *  counts are the one thing a language model should never be asked to produce from a transcript. */
  facts: string;
};

/**
 * A short, model-written account of what a session did.
 *
 * The same one-shot shape as `generateSessionTitle`: the SDK's `query()` directly rather than a full
 * `ClaudeAdapter` session, `maxTurns: 1`, no tools, and the cheapest model in the fleet regardless of
 * what the SESSION is running. A summary is a nicety attached to every settled turn, so it is priced
 * like one — and being harness-independent is what lets a Codex or Cursor session have one at all.
 *
 * The counts are handed in rather than asked for. A model reading a transcript will cheerfully
 * miscount the files it touched, and a summary that says "edited 8 files" when it was 3 is worse
 * than the derived line it replaced, because it reads like it was checked.
 *
 * Throws on any non-success result or empty text; callers treat that as "no summary" and keep the
 * derived one.
 */
export async function generateSessionSummary(input: SummaryInput, deps: { query?: QueryFn } = {}): Promise<string> {
  const query = deps.query ?? sdkQuery;
  const tail = input.transcript.length > TAIL_CHARS ? input.transcript.slice(-TAIL_CHARS) : input.transcript;
  const q = query({
    prompt: [
      input.asked ? `The user opened with: ${input.asked}` : "",
      input.facts ? `What Realm counted (these numbers are correct — use them, do not recount):\n${input.facts}` : "",
      `Transcript (most recent part):\n${tail}`,
    ].filter(Boolean).join("\n\n"),
    options: {
      maxTurns: 1,
      allowedTools: [],
      model: "claude-haiku-4-5",
      systemPrompt: [
        "You summarize a coding assistant's session for someone returning to it later.",
        "Write at most two sentences of plain prose. Say what the user wanted and what actually",
        "happened — what changed, what was decided, whether anything is unfinished or failed.",
        "Prefer the outcome over the process; never narrate the steps in order.",
        "Use the counts you are given verbatim and never invent your own.",
        "Respond with ONLY the summary: no markdown, no bullet points, no preamble like",
        '"This session". Write in past tense, and address the reader as "you" where the user acted.',
      ].join(" "),
    },
  });
  let result = "";
  for await (const msg of q) {
    if (msg.type === "result") {
      if (msg.subtype !== "success") throw new Error(`summary generation failed: ${msg.subtype}`);
      result = msg.result;
    }
  }
  const text = cleanSummary(result);
  if (!text) throw new Error("summary generation returned no text");
  return text;
}

/** Strips the wrappers a model adds around prose it was told not to wrap, and clips to the ceiling
 *  on a sentence boundary where there is one — a summary cut mid-word reads as a truncation bug. */
export function cleanSummary(text: string): string {
  const joined = text.trim().split(/\n{2,}/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  const unquoted = joined.replace(/^["'“”]+|["'“”]+$/g, "").replace(/^(?:summary|tl;?dr)\s*:\s*/i, "").trim();
  if (unquoted.length <= SUMMARY_MAX) return unquoted;
  const cut = unquoted.slice(0, SUMMARY_MAX);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return lastStop > SUMMARY_MAX / 2 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}…`;
}
