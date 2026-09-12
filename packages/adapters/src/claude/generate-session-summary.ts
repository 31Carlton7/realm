/* The summary FIELD of a session's recap: its ceiling and its cleanup. The call that fills it
   lives in `generate-session-recap.ts`, which answers this field and the prompter's hint together. */

/** Two sentences of prose, and a hard ceiling so a model that ignores the brief cannot push the
 *  transcript's closing line into a paragraph. The model is told this number too (see the system
 *  prompt) — a budget it can write to is what keeps the ceiling from ever being reached. */
export const SUMMARY_MAX = 400;

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
 * Strips the wrappers a model adds around prose it was told not to wrap, and clips an over-budget
 * summary to whole sentences.
 *
 * The clip keeps every COMPLETE sentence that fits and drops the one that does not, rather than
 * cutting at the ceiling and marking the wound with an ellipsis. The model's habitual shape is a
 * short opener ("You asked …") followed by a long second sentence, so a rule that demanded the cut
 * land late in the window rejected the only sentence end there was and truncated mid-word every
 * time — the trailing "…" was the ceiling showing through, not the model trailing off.
 *
 * An ellipsis remains possible for exactly one input: a first sentence that is itself over budget.
 * There is no whole sentence to keep there, so the cut falls on a word boundary and says so.
 */
export function cleanSummary(text: string): string {
  const joined = text.trim().split(/\n{2,}/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  const unquoted = joined.replace(/^["'“”]+|["'“”]+$/g, "").replace(/^(?:summary|tl;?dr)\s*:\s*/i, "").trim();
  if (unquoted.length <= SUMMARY_MAX) return unquoted;
  // Searched one char past the ceiling so a sentence ending exactly ON it still counts: the space
  // that proves it is a sentence end sits at index SUMMARY_MAX.
  const window = unquoted.slice(0, SUMMARY_MAX + 1);
  const lastStop = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (lastStop >= 0) return window.slice(0, lastStop + 1);
  const cut = unquoted.slice(0, SUMMARY_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd().replace(/[,;:]$/, "")}…`;
}
