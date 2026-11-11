/**
 * What a run is called while it works, and what it says once it is done.
 *
 * One plain verb: "Working…", settling into "Worked for 2m 14s". The settled line is read as a record
 * of the turn, and a house pool of whimsy ("Noodled for 13s", "Made magic happen for 4s") was theatre
 * about the agent on a surface design.md keeps quietly technical. Play lives behind the easter-egg
 * switch, below, where design.md fences it.
 */
export type RunLabel = { present: string; past: string };

export const RUN_LABEL: RunLabel = { present: "Working", past: "Worked" };

/**
 * What the easter-egg switch gives someone who has not unlocked a friend pack, about one run in four.
 * The settled line is recomputed from the event log rather than stored, so which runs get one is a
 * hash of the start time: the same turn keeps the same line on every reload.
 *
 * NO NAMES HERE, and that is the rule rather than an accident. The lines that name real people live
 * in the sealed packs (`egg-pack.ts`) and arrive at runtime from a group that typed its own word —
 * Realm is open source, and somebody's friends' nicknames are not Realm's to publish. What is left
 * in the clear is what anyone would find funny without knowing anyone.
 *
 * NOR ANYONE ELSE AT WORK. A line under a finished turn is read as what happened in it, so a joke may
 * not claim a party the turn never had: "Got a second opinion" read as a second model having
 * reviewed the work, and "Consulted the group chat" as the work having been shown to people.
 */
export const EGG_RUN_LABELS: readonly RunLabel[] = [
  { present: "Scheming", past: "Schemed" },
  { present: "Plotting", past: "Plotted" },
  { present: "Conspiring", past: "Conspired" },
  { present: "Overthinking", past: "Overthought" },
  { present: "Doodling in the margins", past: "Doodled in the margins" },
];

/**
 * What a run is called when the session is PLANNING.
 *
 * Plan mode looked exactly like every other run: a playful verb, then prose arriving in the
 * transcript. Nothing on the screen said the agent was working out what it would do rather than
 * doing it — which is the whole distinction the mode exists to draw, and the reason a plan lands as
 * a proposal to approve rather than as work already done.
 */
export const PLAN_RUN_LABEL: RunLabel = { present: "Planning", past: "Planned" };

/**
 * The label for a run, keyed on the millisecond it started.
 *
 * Deterministic, not random, for the switch's sake. A `Math.random()` here would re-roll on every
 * re-render — and a streaming run re-renders a dozen times a second — and the settled line, which is
 * rebuilt from the persisted event log on every reload, would name a different verb than the one the
 * user actually watched.
 */
export function runLabelFor(startedAt: number, mode?: string, eggs = false, packLabels: readonly RunLabel[] = []): RunLabel {
  if (mode === "plan") return PLAN_RUN_LABEL;
  if (!eggs) return RUN_LABEL;
  // xorshift-multiply (splittable-hash shape): ms timestamps one prompt apart differ only in their
  // low bits, and taking those modulo the list length directly would walk the list in order.
  let h = Math.trunc(startedAt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  const spread = (h ^ (h >>> 16)) >>> 0;
  /* An unlocked pack takes the whole vocabulary: the names were the reason to unlock anything, and a
     group that typed its word and then watched three runs in four say "Working" got the plain app
     with a rare surprise in it instead of their app. */
  if (packLabels.length) return packLabels[spread % packLabels.length]!;
  /* With no pack unlocked there is nothing to name, so these stay one run in four: a joke that
     arrives every single time is the way the app talks, not an egg. */
  const egg = Math.imul(spread ^ (spread >>> 16), 0x45d9f3b) >>> 0;
  return egg % 4 === 0 ? EGG_RUN_LABELS[(egg >>> 2) % EGG_RUN_LABELS.length]! : RUN_LABEL;
}
