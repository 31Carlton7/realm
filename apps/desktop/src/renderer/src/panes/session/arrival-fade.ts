/**
 * Streamed prose fades in as it arrives, instead of stamping onto the column a chunk at a time.
 *
 * The obvious way — wrap each new chunk in a span that fades — does not survive this renderer. The
 * prose is markdown turned into HTML and written with `innerHTML` on EVERY delta (see `Markdown`),
 * so a span made on one frame is gone on the next, and its fade with it: a chunk would show its
 * first frame of opacity and then snap. So nothing here lives in the DOM between renders. What is
 * kept is when each run of text ARRIVED, measured in the rendered text's own offsets; after every
 * write, the runs still young enough to be fading are wrapped again, each with a negative
 * `animation-delay` equal to its age — which starts the animation that far along, so a fade the
 * last write destroyed resumes exactly where it was.
 *
 * Offsets are the rendered text's, not the markdown source's: `**bold**` is eight characters of
 * source and four on screen, and only the screen's count survives the trip through `marked`. A run
 * that restructures under the reader — a `**` that closes and stops being literal — can shift the
 * boundaries by a few characters, which reads as a word fading twice. That is the whole cost.
 *
 * Whitespace-only text nodes are not in the count at all. `marked` ends every block with a bare
 * newline OUTSIDE it, so the last thing in the text is always a newline that sits after the text
 * still growing — counted, it pushes every new run one character late, and the first letter of each
 * one pops in unfaded. They are the newlines between blocks: nothing on screen to fade either way.
 */

/** A run of text that arrived at `t`, starting `at` characters into the rendered text. */
export type Arrival = { at: number; t: number };

/** What has been seen of one message: how much text, and which runs of it are still arriving.
 *  `shown` is null until the first observation. */
export type Arrivals = { shown: number | null; runs: readonly Arrival[] };

export const NO_ARRIVALS: Arrivals = { shown: null, runs: [] };

/** How long a run is kept after it arrived. Longer than any fade it could be carrying, so the
 *  stylesheet owns the duration; a run older than its animation just renders at full opacity. */
export const ARRIVAL_HORIZON_MS = 1000;

/**
 * Fold one render's text length into the record.
 *
 * The FIRST observation is seeded as already seen, and that is the rule that keeps history still:
 * a transcript restored at launch, a session switched back to, a pane opened onto a message halfway
 * through — none of that text was just written, it was already there. Only growth after the first
 * look is an arrival.
 */
export function noteArrival(prev: Arrivals, total: number, now: number): Arrivals {
  if (prev.shown === null) return { shown: total, runs: [] };
  // A shrink is markdown restructuring (a closing `**` swallowing its markers), not text leaving:
  // the runs past the new end describe characters that no longer exist.
  const runs = prev.runs.filter((r) => now - r.t < ARRIVAL_HORIZON_MS && r.at < total);
  const shown = Math.min(prev.shown, total);
  return total > shown ? { shown: total, runs: [...runs, { at: shown, t: now }] } : { shown, runs };
}

/** Text that is not prose: formula markup a screen reader is handed separately, and drawings. A
 *  span dropped into MathML or SVG is an HTML element where neither expects one. */
const SKIP = "math, svg, .katex-mathml";

/** The text nodes the offsets are counted over, in reading order: all of them but whitespace. */
function countedText(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (/\S/.test((n as Text).data)) out.push(n as Text);
  return out;
}

/** How much text `root` holds, in the offsets runs are recorded in. */
export const arrivalLength = (root: HTMLElement): number => countedText(root).reduce((n, t) => n + t.data.length, 0);

/**
 * Wrap each young run's text in a `.md-arrival` span, its fade resumed at the run's age.
 *
 * The text itself is never altered — only split across spans — so `textContent`, selection and
 * copy read exactly what they did. Whitespace-only nodes are never wrapped (nor counted): a span
 * placed between two table rows or list items is an element where the content model allows none.
 */
export function markArrivals(root: HTMLElement, runs: readonly Arrival[], now: number): void {
  if (runs.length === 0) return;
  const spans = runs.map((r, i) => ({ start: r.at, end: runs[i + 1]?.at ?? Infinity, delay: Math.round(r.t - now) }));
  let offset = 0;
  for (const node of countedText(root)) {
    const from = offset;
    const to = from + node.data.length;
    offset = to;
    // Counted before any skip: the offsets are the whole rendered text's, the same count `total`
    // was taken from, or every run after a formula would land on the wrong characters.
    if (to <= spans[0]!.start || node.parentElement?.closest(SKIP)) continue;
    const frag = root.ownerDocument.createDocumentFragment();
    let cursor = from;
    for (const s of spans) {
      const start = Math.max(s.start, from);
      const end = Math.min(s.end, to);
      if (start >= end) continue;
      if (start > cursor) frag.append(node.data.slice(cursor - from, start - from));
      const span = root.ownerDocument.createElement("span");
      span.className = "md-arrival";
      span.style.animationDelay = `${s.delay}ms`;
      span.textContent = node.data.slice(start - from, end - from);
      frag.append(span);
      cursor = end;
    }
    // No tail to append: the runs are contiguous from the first to the end of the text (the last
    // one never ends), so a node they reach is covered to its end.
    if (cursor === from) continue;
    node.replaceWith(frag);
  }
}
