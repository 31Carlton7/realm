/**
 * What a finished utterance means: a word to stop, an answer to the permission being asked, or a
 * message for the agent. Only a whole utterance that is nothing but the word counts — "stop the dev
 * server" is a message, "stop" is not.
 */

export type Heard =
  | { kind: "nothing" }
  | { kind: "stop" }
  | { kind: "answer"; decision: "allow" | "deny" }
  | { kind: "message"; text: string };

const STOP = new Set(["stop", "stop it", "stop that", "stop talking", "please stop", "stop please", "cancel", "cancel that",
  "never mind", "nevermind", "be quiet", "quiet", "hush", "shush"]);
const YES = new Set(["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "allow", "allow it", "approve", "go ahead", "do it",
  "yes please", "sounds good", "yes go ahead", "yes do it"]);
const NO = new Set(["no", "nope", "deny", "deny it", "don't", "dont", "do not", "no thanks", "no thank you", "reject",
  "don't do that", "no don't", "cancel", "cancel that"]);
const FILLER = /^(?:(?:um+|uh+|erm|hmm+|oh|so|well)\s+)+/;

/** Lower case, no punctuation, single spaces, fillers off the front. */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim().replace(FILLER, "");
}

export function interpret(text: string, ctx: { permissionPending: boolean }): Heard {
  const said = normalize(text);
  if (!said) return { kind: "nothing" };
  // With a question open, "cancel" declines it rather than stopping the agent: the turn is already
  // waiting on the answer, so there is nothing else for it to mean.
  if (ctx.permissionPending) {
    if (YES.has(said)) return { kind: "answer", decision: "allow" };
    if (NO.has(said)) return { kind: "answer", decision: "deny" };
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
