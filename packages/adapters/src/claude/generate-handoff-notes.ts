import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { BACKGROUND_MODEL } from "./background-model";

type QueryFn = typeof sdkQuery;

/** How much transcript the model is shown, from the end. A hand-off is written once per switch and
 *  read by an agent that has nothing else to go on, so it gets the long view a per-turn recap does
 *  not: the ask that opened the session is often a hundred turns back. */
const TAIL_CHARS = 120_000;

export type HandoffNotesInput = {
  /** The session's title, for the model to orient by. */
  title: string;
  /** The first thing the user asked, already clipped by the caller. */
  asked: string;
  /** The transcript as prose, oldest first, tool calls named rather than dumped. Clipped from the END. */
  transcript: string;
  /** What Realm counted, files edited by path among it. Handed in as FACTS: a model reading a
   *  transcript miscounts, and a hand-off that names the wrong files sends the next agent to them. */
  facts: string;
  /** The two sides, by name: "Claude Opus 5.5" to "Codex GPT-5.6". */
  from: string;
  to: string;
};

/**
 * The body of a switch's hand-off note: what another agent needs to pick a session up in place.
 *
 * Markdown under five fixed headings, because the reader is an agent with no memory of any of it and
 * the person who opens the file later — both read it faster when the same question is always in the
 * same place. Realm adds the files it counted and the last turns verbatim itself; the model is asked
 * only for what takes judgement.
 *
 * `BACKGROUND_MODEL`, whatever either side of the switch runs, like every other call Realm makes on
 * its own: the owner's never-downgrade rule, and a hand-off is the one summary whose mistakes the
 * next agent acts on. Throws when the call fails or comes back empty — the caller carries the
 * conversation verbatim instead, never a cheaper model's account of it.
 */
export async function generateHandoffNotes(input: HandoffNotesInput, deps: { query?: QueryFn } = {}): Promise<string> {
  const query = deps.query ?? sdkQuery;
  const tail = input.transcript.length > TAIL_CHARS ? input.transcript.slice(-TAIL_CHARS) : input.transcript;
  const q = query({
    prompt: [
      `Session: ${input.title}`,
      input.asked ? `The user opened with: ${input.asked}` : "",
      input.facts ? `What Realm counted (these are correct — use them, do not recount):\n${input.facts}` : "",
      `Transcript${tail.length < input.transcript.length ? " (most recent part)" : ""}:\n${tail}`,
    ].filter(Boolean).join("\n\n"),
    options: {
      maxTurns: 1,
      allowedTools: [],
      model: BACKGROUND_MODEL,
      systemPrompt: [
        `A coding session is moving from ${input.from} to ${input.to} mid-conversation. The new agent`,
        "starts with no memory of it and works in the same folder. Write the hand-off it will read",
        "first. Reply with Markdown under exactly these five headings, in this order, and nothing",
        "before the first:",
        "",
        "## The ask — what the user wants, in their terms, including anything they refined later.",
        "## Decisions — what was settled and why, including approaches tried and rejected.",
        "## What changed and where — each change by file or component, one line each.",
        "## Open questions — what is undecided or waiting on the user. Write None if nothing is.",
        "## Current state — where the work stands right now and the next concrete step.",
        "",
        "Be thorough but plain: bullets, exact names, paths, commands and error text as written.",
        "Never invent work the transcript does not show, and never restate the counts you are given",
        "as your own findings. No preamble, no closing remarks, no code fence around the whole reply.",
      ].join(" "),
    },
  });
  let result = "";
  for await (const msg of q) {
    if (msg.type === "result") {
      if (msg.subtype !== "success") throw new Error(`hand-off notes failed: ${msg.subtype}`);
      result = msg.result;
    }
  }
  const notes = cleanNotes(result);
  if (!notes) throw new Error("hand-off notes came back empty");
  return notes;
}

/** The reply without the fence a model wraps Markdown in when told not to, or anything ahead of the
 *  first heading — a "Here is the hand-off:" line would be the first thing the next agent reads. */
export function cleanNotes(text: string): string {
  let t = text.trim();
  const fenced = t.match(/^`{3,}(?:markdown|md)?\n([\s\S]*?)\n`{3,}$/);
  if (fenced) t = fenced[1]!.trim();
  const first = t.search(/^##\s/m);
  return first > 0 ? t.slice(first).trim() : t;
}
