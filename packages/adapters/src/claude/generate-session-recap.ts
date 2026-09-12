import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { SUMMARY_MAX, cleanSummary } from "./generate-session-summary";
import { HINT_MAX, cleanHint } from "./generate-prompt-hint";

type QueryFn = typeof sdkQuery;

/** How much transcript the model is shown. The summary's budget, not the hint's smaller one: one
 *  call now answers both, and the summary is the field that needs the longer view. */
const TAIL_CHARS = 6000;

export type RecapInput = {
  /** The first thing the user asked, already clipped by the caller. */
  asked: string;
  /** The transcript as prose, oldest first. Clipped from the END here. */
  transcript: string;
  /** The derived line — what Realm counted. Given to the model as FACTS, not as a draft to rewrite:
   *  counts are the one thing a language model should never be asked to produce from a transcript. */
  facts: string;
};

export type Recap = {
  /** Two sentences for someone returning to the session. */
  summary: string;
  /** The next message the user would send, or null when there is no obvious next move — which is the
   *  common answer after a greeting or a finished one-off question. */
  hint: string | null;
};

/**
 * One call, two answers: what this session did, and what the user would say next.
 *
 * These were two separate `query()` calls on the same settle, which meant two model calls per turn to
 * read the same transcript twice. Folded because the inputs are identical and the outputs are both
 * short — the cost of a second round trip bought nothing but the ability to disable one and not the
 * other, and that was never asked for.
 *
 * The coupling it introduces is real and worth stating: a call that fails now costs BOTH fields, so a
 * session gets the derived summary line and the deterministic hint together rather than one of each.
 * That is the honest trade for halving the per-turn spend, and both fallbacks already existed.
 *
 * Still the one-shot shape: `maxTurns: 1`, no tools, and the cheapest model in the fleet regardless
 * of what the SESSION runs — which is what lets a Codex or Cursor session have either field at all.
 *
 * The counts are handed in rather than asked for, for the reason the summary always had: a model
 * reading a transcript will cheerfully miscount the files it touched, and "edited 8 files" when it
 * was 3 is worse than the derived line, because it reads like it was checked.
 *
 * Throws only when the CALL failed or the summary came back empty. A missing or declined hint is not
 * a failure — the prompter has a deterministic one — so it comes back as `hint: null`.
 */
export async function generateSessionRecap(input: RecapInput, deps: { query?: QueryFn } = {}): Promise<Recap> {
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
        "You read a coding assistant's session and reply with exactly two lines, each on its own line,",
        "each beginning with its label. No markdown, no preamble, no blank line between them.",
        "",
        `SUMMARY: at most two sentences of plain prose, under ${SUMMARY_MAX} characters, for someone`,
        "returning to this session later. Say what the user wanted and what actually happened — what",
        "changed, what was decided, whether anything is unfinished or failed. Prefer the outcome over",
        "the process; never narrate the steps in order. Use the counts you are given verbatim and never",
        'invent your own. Past tense, and address the reader as "you" where the user acted.',
        "",
        `HINT: the next message the USER would send, typed into their prompt box verbatim — so write it`,
        "as them, an instruction to the assistant, never advice to the user. Imperative mood, at most",
        `${HINT_MAX} characters, ideally a few words. Name the specific next move: the file, the thing`,
        "decided, the thing left unfinished. Never quote the transcript, an error message, or the user's",
        "own earlier words back at them.",
        "Write exactly NONE when there is no obvious next move — a greeting, a finished one-off",
        "question, small talk — or when the only thing you could write is generic. The prompter has its",
        "own plain placeholder for that case, and a vague suggestion is worse than none, because it",
        "costs a keystroke to find out it was vague.",
      ].join(" "),
    },
  });
  let result = "";
  for await (const msg of q) {
    if (msg.type === "result") {
      if (msg.subtype !== "success") throw new Error(`recap generation failed: ${msg.subtype}`);
      result = msg.result;
    }
  }
  return splitRecap(result);
}

/**
 * The two labelled lines, separated and cleaned by the field's own rules.
 *
 * Tolerant about the label because a model told "no markdown" still reaches for `**SUMMARY:**` now
 * and then, and about ORDER because there is no reason to fail a good summary over a transposition.
 * An unlabelled answer is read as summary-only: that is the shape a model falls back to when it
 * ignores the format, and the summary is the field worth salvaging.
 */
export function splitRecap(raw: string): Recap {
  const label = (name: string): string | null => {
    // Emphasis is allowed on BOTH sides of the colon: `**SUMMARY:**` is the shape a model reaches for,
    // and matching only the opening pair left the closing one on the front of the value.
    const m = raw.match(new RegExp(`^[*_\\s]*${name}[*_\\s]*:[*_\\s]*(.+)$`, "im"));
    return m?.[1]?.replace(/[*_]+$/, "").trim() ?? null;
  };
  const summaryLine = label("SUMMARY");
  const hintLine = label("HINT");
  // No labels at all: take the whole answer as the summary rather than discarding a usable one.
  const summary = cleanSummary(summaryLine ?? (hintLine ? "" : raw));
  if (!summary) throw new Error("recap generation returned no summary");
  let hint: string | null = null;
  // A decline and a malformed hint are the same outcome — the prompter keeps its deterministic one —
  // so both land here as null rather than failing the summary that came back with it.
  if (hintLine) { try { hint = cleanHint(hintLine); } catch { hint = null; } }
  return { summary, hint };
}
