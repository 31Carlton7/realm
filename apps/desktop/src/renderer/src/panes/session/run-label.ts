/**
 * What a run is called while it works, and what it says once it is done.
 *
 * "Working…" was the same three syllables for every prompt of every session, which made the one
 * moving thing on screen the least interesting thing on it. Two rules keep the replacement from
 * being noise:
 *
 *  - one word per RUN, held for that run's whole life. A label that changed every few seconds would
 *    read as progress the session is not making;
 *  - the settled line reuses the SAME word in the past tense, so the reader watches "Cooking…"
 *    become "Cooked for 2m 14s" instead of meeting a stranger at the end of the wait.
 */
export type RunLabel = { present: string; past: string };

export const RUN_LABELS: readonly RunLabel[] = [
  { present: "Cooking", past: "Cooked" },
  { present: "Constructing", past: "Constructed" },
  { present: "Making things shake", past: "Made things shake" },
  { present: "Making magic happen", past: "Made magic happen" },
  { present: "Conjuring", past: "Conjured" },
  { present: "Tinkering", past: "Tinkered" },
  { present: "Noodling", past: "Noodled" },
  { present: "Percolating", past: "Percolated" },
  { present: "Wrangling", past: "Wrangled" },
  { present: "Brewing", past: "Brewed" },
  { present: "Assembling", past: "Assembled" },
  { present: "Spelunking", past: "Spelunked" },
  { present: "Finagling", past: "Finagled" },
  { present: "Whittling", past: "Whittled" },
  { present: "Untangling", past: "Untangled" },
  { present: "Sculpting", past: "Sculpted" },
  { present: "Summoning", past: "Summoned" },
  { present: "Herding cats", past: "Herded cats" },
  { present: "Riffing", past: "Riffed" },
  { present: "Marinating", past: "Marinated" },
  { present: "Plotting", past: "Plotted" },
  { present: "Simmering", past: "Simmered" },
];

/**
 * The label for a run, keyed on the millisecond it started.
 *
 * Deterministic, not random. A `Math.random()` here would re-roll on every re-render — and a
 * streaming run re-renders a dozen times a second — and the settled line, which is rebuilt from the
 * persisted event log on every reload, would name a different verb than the one the user actually
 * watched. Hashing the start time gives both for free: stable within a run, spread across runs.
 */
export function runLabelFor(startedAt: number): RunLabel {
  // xorshift-multiply (splittable-hash shape): ms timestamps one prompt apart differ only in their
  // low bits, and taking those modulo the list length directly would walk the list in order.
  let h = Math.trunc(startedAt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return RUN_LABELS[((h ^ (h >>> 16)) >>> 0) % RUN_LABELS.length]!;
}
