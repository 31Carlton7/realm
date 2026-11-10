/** Where dictated words land in the prompter's draft, and how a clean-up is taken back. */

export type Placed = { text: string; start: number; end: number };

/**
 * The draft with `words` at `at`, and where the words sit in it. A space goes either side where
 * they would otherwise run into a word already there; nothing already typed is replaced.
 */
export function placeDictation(draft: string, at: number, words: string): Placed {
  const pos = Math.max(0, Math.min(at, draft.length));
  if (!words) return { text: draft, start: pos, end: pos };
  const before = draft.slice(0, pos), after = draft.slice(pos);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  const start = pos + lead.length;
  return { text: `${before}${lead}${words}${trail}${after}`, start, end: start + words.length };
}

/** A clean-up that can still be taken back: the draft as it stood once the cleaned words landed. */
export type CleanedRecord = { draft: string; start: number; cleaned: string; raw: string };

/** The draft with the cleaned words swapped back for exactly what was heard. */
export function restoreRaw(r: CleanedRecord): Placed {
  const text = r.draft.slice(0, r.start) + r.raw + r.draft.slice(r.start + r.cleaned.length);
  return { text, start: r.start, end: r.start + r.raw.length };
}

/**
 * The mirror's runs with the words being dictated spliced in at `at`, as a run of their own so they
 * can be drawn apart from what is already typed. A run `at` falls inside is cut in two; the caller
 * never puts `at` inside a chip.
 */
export function spliceRun<T extends { text: string }>(runs: readonly T[], at: number, run: T): T[] {
  const out: T[] = [];
  let pos = 0, placed = false;
  for (const r of runs) {
    const end = pos + r.text.length;
    if (!placed && at <= end) {
      const cut = at - pos;
      if (cut > 0) out.push({ ...r, text: r.text.slice(0, cut) });
      out.push(run);
      if (cut < r.text.length) out.push({ ...r, text: r.text.slice(cut) });
      placed = true;
    } else out.push(r);
    pos = end;
  }
  if (!placed) out.push(run);
  return out;
}
