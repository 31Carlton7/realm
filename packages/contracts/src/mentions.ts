/**
 * `@`-mention scanning for the prompter (Plan 8 W4).
 *
 * The rule that governs everything here: **a literal `@name` must never reach an agent.** `@` means
 * nothing defined on any of the three wires (spec §4.4), so a mention is a Realm-side affordance that
 * resolves before the message leaves — Claude gets `/realm:<name>` prepended in its adapter, Codex gets
 * a native `{ type: "skill" }` input item. What travels on `sessions.send` alongside the raw text is
 * the list of skill ids the prompter recognised as mentions; the server re-validates them against the
 * live library and strips every one's `@` from the wire text (`stripMentionAts`), whether or not it
 * still resolves. The transcript's `user_message` keeps the raw text — the `@` is what the user wrote.
 *
 * This module is shared by the renderer (which decides what counts as a mention while typing) and the
 * server (which re-scans the sent text against the declared ids) so the two can never disagree about
 * where a token starts and ends.
 */

/** One recognised `@id` occurrence: `start` is the `@`, `end` is one past the id's last character. */
export type MentionToken = { id: string; start: number; end: number };

/** The characters a skill id may contain (`SkillIdSchema` minus the leading-character rule). */
const ID_CHAR = /[A-Za-z0-9._-]/;

/**
 * Every occurrence of `@<id>` in `text` where `<id>` exactly matches one of `ids`, in text order.
 *
 * Deliberately conservative — no fuzzy matching, ever (the plan's own constraint: only a mention that
 * was explicitly picked or exactly matches an enabled skill id may resolve):
 *
 * - The `@` must be token-initial: at the start of the text or after whitespace. `user@example.com`
 *   never matches, because its `@` follows a letter.
 * - The candidate is the MAXIMAL run of id characters after the `@`, compared whole. `@mac-extras`
 *   never resolves a skill named `mac`, and — since `.` is a legal id character — `@mac.` at the end
 *   of a sentence does not match `mac` either. The picker inserts `@id ` with a trailing space, which
 *   is the canonical form; prose that happens to abut punctuation degrades to plain text, which is
 *   the safe direction.
 */
export function scanMentions(text: string, ids: Iterable<string>): MentionToken[] {
  const set = new Set(ids);
  const out: MentionToken[] = [];
  if (set.size === 0) return out;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@") continue;
    const before = i === 0 ? " " : text[i - 1]!;
    if (!/\s/.test(before)) continue; // not token-initial: an email address, not a mention
    let j = i + 1;
    while (j < text.length && ID_CHAR.test(text[j]!)) j++;
    const id = text.slice(i + 1, j);
    if (id && set.has(id)) out.push({ id, start: i, end: j });
    i = j - 1; // the run holds no further `@`; skipping it keeps the scan linear
  }
  return out;
}

/**
 * The wire form of a mentioned message: the same text with each token's `@` removed and everything
 * else — including the id itself — left in place, so the sentence still reads ("use @mac to list…" →
 * "use mac to list…"). Applied to EVERY declared mention, resolved or not: a skill that was disabled
 * or deleted between typing and sending degrades to plain text, never to a literal `@name` on a wire
 * where `@` means nothing.
 *
 * `tokens` must come from `scanMentions` over the same `text` (ascending, non-overlapping).
 */
export function stripMentionAts(text: string, tokens: readonly MentionToken[]): string {
  let out = "";
  let prev = 0;
  for (const t of tokens) {
    out += text.slice(prev, t.start);
    prev = t.start + 1; // drop exactly the `@`
  }
  return out + text.slice(prev);
}

/** The distinct mentioned ids in text order — what `sessions.send` carries as `mentions`. */
export function mentionIds(text: string, ids: Iterable<string>): string[] {
  return [...new Set(scanMentions(text, ids).map((t) => t.id))];
}
