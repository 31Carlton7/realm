/** The hero prompter's greeting line. Ara's copy was "What should we build in <space>?" — but a
 *  space is as often a course, an inbox or a set of documents as it is a repo, so the line asks what
 *  we are DOING here instead of assuming we are building. One phrasing would go stale on sight, so
 *  there is a small pool; when the host knows the person's name, the time-of-day greetings join it.
 *
 *  The pick is seeded by session id, not random: a re-render (or a tab away and back) must not
 *  reshuffle the words under the reader, while a NEW session gets a fresh line. */

/** A run of the greeting. `em` marks the varying proper noun — the space, or the person. */
export type GreetingPart = { text: string; em?: true };

export type DayPart = "morning" | "afternoon" | "evening";

/** The small hours read as evening: someone up at 2am is still having tonight, not tomorrow. */
export function dayPart(at: Date): DayPart {
  const h = at.getHours();
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 18) return "afternoon";
  return "evening";
}

type Ctx = { space: string; name: string; part: DayPart };
type Variant = (c: Ctx) => GreetingPart[];

const t = (text: string): GreetingPart => ({ text });
const em = (text: string): GreetingPart => ({ text, em: true });

/** Always in the pool: these need nothing but the space's name. */
const ANY: Variant[] = [
  (c) => [t("What should we do in "), em(c.space), t(" today?")],
  (c) => [t("Where should we start in "), em(c.space), t("?")],
  (c) => [t("What's next in "), em(c.space), t("?")],
  (c) => [t("What are we working on in "), em(c.space), t("?")],
  (c) => [t("What's on your mind in "), em(c.space), t("?")],
];

/** Only in the pool when a name is known — the alternative is greeting a blank. */
const NAMED: Variant[] = [
  (c) => [t(`Good ${c.part}, `), em(c.name), t(".")],
  (c) => [t(`Good ${c.part}, `), em(c.name), t(" — what's next in "), em(c.space), t("?")],
  (c) => [t("What should we do in "), em(c.space), t(", "), em(c.name), t("?")],
];

/** FNV-1a, for a stable spread of session ids over the pool. */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

export function heroGreeting({ spaceName, userName = "", seed, at = new Date() }: {
  spaceName: string;
  /** "" when the host reports no real name — then the named variants sit the round out. */
  userName?: string;
  /** Session id: one greeting per session, held for the session's life. */
  seed: string;
  at?: Date;
}): GreetingPart[] {
  const name = userName.trim();
  const pool = name ? [...ANY, ...NAMED] : ANY;
  const variant = pool[hash(seed) % pool.length]!;
  return variant({ space: spaceName, name, part: dayPart(at) });
}
