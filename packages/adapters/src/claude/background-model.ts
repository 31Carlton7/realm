/**
 * The model Realm's own background calls run on — a session's sidebar title and per-turn recap, what
 * it learns from a quiet session for memory, and the pass that keeps that memory tidy.
 *
 * The owner's rule: never downgrade, and that holds for work nobody watches as much as for a session.
 * What lands in memory is read back by every later session in every engine, so a cheaper model's
 * mistake there is paid for many times over. One constant, so the rule is kept in one place.
 */
export const BACKGROUND_MODEL = "claude-opus-5-5";
