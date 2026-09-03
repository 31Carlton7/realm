/** Defensive coercion for decoded agent payloads: every field an adapter reads off the wire is
 *  `unknown` until proven otherwise, and a malformed one must degrade to an empty value rather than
 *  throw mid-stream. `num` is deliberately NOT here — codex and acp disagree on what a bad number
 *  means (0 vs null), so each owns its own. */
export type Bag = Record<string, unknown>;

export const obj = (v: unknown): Bag => (v && typeof v === "object" ? (v as Bag) : {});
export const str = (v: unknown): string => (typeof v === "string" ? v : "");
