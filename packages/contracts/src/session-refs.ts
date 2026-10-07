import { z } from "zod";
import { IdSchema } from "./entities";
import { fenceUntrusted } from "./fence";

/**
 * Another session, pointed at from the prompter.
 *
 * NOT a chip, and the distinction is forced rather than chosen. A chip is paint over the draft
 * string — `draft-format.ts` states the rule: a painted run "may change colour, background and
 * underline, and may never change weight, family, size or spacing", because the mirror sits under a
 * real textarea and the caret is the textarea's. An icon inside a run moves every glyph after it. So
 * a reference that shows a mark and a title cannot live in the text, and lives beside it — an
 * attachment, in everything but what it carries.
 *
 * What reaches the agent is an ID, never a transcript. Realm already gives every session `agent_ask`
 * and `agent_peers`, so the useful thing to hand over is the handle the agent can ask THROUGH: a
 * transcript inlined here would be a copy that is stale the moment it is made, unbounded in size,
 * and a second place the other session's words live.
 */

/** Eight, for the reason every other prompter bound exists: these are read by a person in a composer
 *  before they are sent, and a row of references nobody can scan is a row nobody checks. */
export const MAX_SESSION_REFS = 8;

export type SessionRef = {
  sessionId: string;
  /** The session's title WHEN IT WAS DROPPED. Deliberately a copy: a title is re-summarised as a
   *  conversation goes on, and a reference that silently renamed itself between the drop and the
   *  send would be a chip the user did not agree to. The id is what resolves; this is what reads. */
  title: string;
  /** Which agent is on the other end, so the pill can wear its mark. */
  agent: string;
};

export const SessionRefSchema = z.object({
  sessionId: IdSchema,
  title: z.string().max(200),
  agent: z.string().max(40),
});

/**
 * What the agent is told about the sessions the user pointed at.
 *
 * The IDS sit outside the fence and the TITLES inside it, which is the opposite way round from how
 * it first looks. An id is Realm's own — a ULID this process minted, and the only part the agent
 * acts on. A title is written by an agent summarising a conversation this one cannot see, which
 * makes it the one field here that another model's context can reach: fencing it is the difference
 * between "a session called X" and a sentence that reads as an instruction.
 *
 * Names the tool explicitly. An agent told only that a session exists tends to say so back to the
 * user; an agent told how to reach it asks it something.
 */
export function sessionRefContext(refs: readonly SessionRef[]): string {
  if (refs.length === 0) return "";
  const index = refs.map((r) => `  ${r.sessionId} — ${r.agent}`).join("\n");
  const titles = refs.map((r) => `${r.sessionId}: ${r.title}`).join("\n");
  return `\n\nThe user pointed at other agent sessions in this space:\n${index}\n\n`
    + `Their titles, as those sessions currently summarise themselves:\n${fenceUntrusted(titles)}\n`
    + `Consult one with agent_ask(sessionId, question) rather than guessing what it holds. `
    + `agent_peers says which are askable right now — a session that is idle or finished may not answer.`;
}
