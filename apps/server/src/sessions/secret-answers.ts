import { HIDDEN_ANSWER, secretQuestionIds, type AskAnswers, type AskCard } from "@realm/contracts";
import { REDACT_MIN_LENGTH } from "../mcp/redact";

/**
 * Masked answers, kept out of everything Realm writes down.
 *
 * A question asked with a secret field — Claude's `secret: true`, Codex's `isSecret`, a `ui_ask` text
 * marked secret — hands its answer to the agent that asked, and that is the whole of where it may go.
 * Every emitter already writes a mark in the answer's place on `permission_response`. That was not
 * enough: the answer then comes BACK, in the agent's tool result ("User has answered: token=…"), in a
 * command it runs with the token, in a sentence it says about it — each one an event Realm persists,
 * broadcasts to every window and shows in Activity.
 *
 * So the session service remembers each masked answer for the life of the process, per session, and
 * scrubs it from every event on the way to the log and the wire, and the gateway from every call it
 * records. Memory only, never a table: a list of secrets kept to hide secrets would be the leak.
 *
 * Values under the redaction floor are not scrubbed, by `redact.ts`'s reasoning: a two-letter answer
 * appears inside ordinary words everywhere, and hiding every occurrence would wreck the transcript to
 * protect something that short.
 */
export class SecretAnswers {
  private readonly bySession = new Map<string, Set<string>>();

  /** Remember the masked answers among `answers`, as the card asked them. */
  rememberFrom(sessionId: string, card: AskCard, answers: AskAnswers): void {
    for (const id of secretQuestionIds(card)) {
      const a = answers[id];
      for (const v of Array.isArray(a) ? a : a === undefined ? [] : [a]) this.remember(sessionId, v);
    }
  }

  remember(sessionId: string, value: string): void {
    if (value.length < REDACT_MIN_LENGTH || value === HIDDEN_ANSWER) return;
    let set = this.bySession.get(sessionId);
    if (!set) { set = new Set(); this.bySession.set(sessionId, set); }
    set.add(value);
    // A secret padded with whitespace is quoted back without it as often as with it.
    const trimmed = value.trim();
    if (trimmed !== value && trimmed.length >= REDACT_MIN_LENGTH) set.add(trimmed);
  }

  forget(sessionId: string): void { this.bySession.delete(sessionId); }

  /** `text` with every masked answer this session was given replaced by the mark. */
  scrubText(sessionId: string, text: string): string {
    const set = this.bySession.get(sessionId);
    if (!set) return text;
    let out = text;
    // Longest first, so a secret that contains another is replaced whole rather than in pieces.
    for (const v of [...set].sort((a, b) => b.length - a.length)) if (out.includes(v)) out = out.split(v).join(HIDDEN_ANSWER);
    return out;
  }

  /** Any value — an event payload — with every string in it scrubbed. The same object back when
   *  nothing in it needed it, which is every event of every session that was never asked a secret. */
  scrub<T>(sessionId: string, value: T): T {
    if (!this.bySession.has(sessionId)) return value;
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return this.scrubText(sessionId, v);
      if (Array.isArray(v)) { const out = v.map(walk); return out.every((x, i) => x === v[i]) ? v : out; }
      if (v && typeof v === "object") {
        let changed = false;
        const out = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => { const y = walk(x); if (y !== x) changed = true; return [k, y]; }));
        return changed ? out : v;
      }
      return v;
    };
    return walk(value) as T;
  }
}
