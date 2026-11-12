/**
 * What a finished utterance means: a word to stop, an answer to the permission being asked, or a
 * message for the agent. A stop has to be the whole utterance — "stop the dev server" is a message,
 * "stop" is not. An answer only has to open it, and only if nothing after takes it back.
 */

export type Heard =
  | { kind: "nothing" }
  | { kind: "stop" }
  | { kind: "answer"; decision: "allow" | "deny"; rest: string }
  | { kind: "unclear" }
  | { kind: "message"; text: string };

const STOP = new Set(["stop", "stop it", "stop that", "stop talking", "please stop", "stop please", "cancel", "cancel that",
  "never mind", "nevermind", "be quiet", "quiet", "hush", "shush"]);
/** Answers that stand apart from what follows them: "yes, run the tests" says two things. */
const YES_WORDS = ["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "go ahead", "do it", "sounds good"];
const NO_WORDS = ["no", "nope", "nah"];
/** Answers that are verbs, and govern what follows them. They stay in the message: "don't run the
 *  migration" must not reach the agent as "run the migration". */
const YES_VERBS = ["allow", "approve", "always allow"];
const NO_VERBS = ["don't", "dont", "do not", "deny", "reject", "stop", "cancel"];
/** Anything here makes an answer unclear, whichever way it opened. */
const HEDGED = /\b(?:but|however|though|although|except|unless|if|only|without|wait|actually|maybe|perhaps|hold on|hang on|one sec|one second|second thought|i mean|sorry)\b/;
const CONTRARY_TO_YES = /\b(?:no|nope|nah|not|never|stop|cancel|deny|reject|refuse|instead|rather|later|first|before|after|until|dont|wont|cant|\w+n't)\b/;
const CONTRARY_TO_NO = /\b(?:yes|yeah|yep|yup|sure|ok|okay|allow|approve|go ahead|do it|sounds good|no problem|no worries|no doubt|don'?t (?:stop|worry|mind|care))\b/;
/** A yes that a no has already taken back, so "don't allow it" is not contrary to itself. */
const NEGATED_YES = /\b(?:don't|dont|do not|not|never) (?:do it|go ahead|allow|approve)\b/g;
/** Words that only repeat an answer: sent alone, they would start a turn saying nothing. */
const ONLY_THE_ANSWER = new Set(["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "thing", "please", "thanks", "thank", "you", "and",
  "allow", "approve", "always", "it", "this", "that", "just", "once", "for", "now", "go", "ahead", "do", "good", "sounds",
  "no", "nope", "nah", "don't", "dont", "not", "deny", "reject", "stop", "cancel"]);
const FILLER = /^(?:(?:um+|uh+|erm|hmm+|oh|so|well)\s+)+/;

/** Lower case, no punctuation, single spaces, fillers off the front. */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim().replace(FILLER, "");
}

function opener(said: string, answers: string[]): string | undefined {
  return answers.find((a) => said === a || said.startsWith(`${a} `));
}

/** What was said after the first `answer`, as it was said; nothing if it only repeats the answer.
 *  With no `answer`, what was said from the top. */
function restAfter(text: string, answer: string | undefined): string {
  const words = [...text.matchAll(/[\p{L}\p{N}'’]+/gu)];
  const fillers = words.length - normalize(text).split(" ").length;
  const from = words[fillers + (answer ? answer.split(" ").length : 0)]?.index;
  if (from === undefined) return "";
  const rest = text.slice(from).trim();
  return normalize(rest).split(" ").every((w) => ONLY_THE_ANSWER.has(w)) ? "" : rest;
}

/**
 * How an utterance answers a permission card, and what else it said. This opens a gate, so it fails
 * towards asking again: anything not a clear yes or a clear no is unclear. There is no answer here
 * for "allow always" — however it is put, voice only ever allows once.
 */
export function answerToCard(text: string): { answer: "allow" | "deny" | "unclear"; rest: string } {
  const said = normalize(text);
  const unclear = { answer: "unclear", rest: "" } as const;
  if (text.includes("?") || HEDGED.test(said)) return unclear;
  const yesWord = opener(said, YES_WORDS);
  if (yesWord || opener(said, YES_VERBS)) return CONTRARY_TO_YES.test(said) ? unclear : { answer: "allow", rest: restAfter(text, yesWord) };
  const noWord = opener(said, NO_WORDS);
  if (noWord || opener(said, NO_VERBS)) return CONTRARY_TO_NO.test(said.replace(NEGATED_YES, "")) ? unclear : { answer: "deny", rest: restAfter(text, noWord) };
  return unclear;
}

export function interpret(text: string, ctx: { permissionPending: boolean }): Heard {
  const said = normalize(text);
  if (!said) return { kind: "nothing" };
  if (ctx.permissionPending) {
    // With a question open, "cancel" declines it rather than stopping the agent: the turn is already
    // waiting on the answer, so there is nothing else for it to mean.
    if (STOP.has(said) && !said.startsWith("cancel")) return { kind: "stop" };
    const { answer, rest } = answerToCard(text);
    return answer === "unclear" ? { kind: "unclear" } : { kind: "answer", decision: answer, rest };
  }
  if (STOP.has(said)) return { kind: "stop" };
  return { kind: "message", text: text.trim() };
}

/**
 * Whether words heard while Realm was talking are only Realm itself, come back through the
 * microphone: most of them are in what it has just said. Echo cancellation takes nearly all of it;
 * this is for the rest, which must not cut Realm off mid-sentence.
 */
export function isEcho(heard: string, recentlySaid: readonly string[]): boolean {
  const words = normalize(heard).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const said = new Set(recentlySaid.flatMap((s) => normalize(s).split(" ")));
  const echoed = words.filter((w) => said.has(w)).length;
  return echoed / words.length >= 0.6;
}
