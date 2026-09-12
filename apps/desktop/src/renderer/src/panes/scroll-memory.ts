import { useCallback } from "react";

/**
 * Where a reader had a scroller parked, kept across the unmount that a space switch causes.
 *
 * `selectSpace` clears `items` and `sessions` (state/store.ts), so every pane in the space being
 * left is torn down and every scroller in it goes with it. Coming back rebuilds the pane from data
 * the store still holds — the transcript cache and the document workspace both survive the switch —
 * but the DOM offset does not, so a reader who had scrolled back to re-read something returned to
 * the bottom of the log, or the top of the file, with nothing to do but find their place again.
 *
 * Keeping the panes mounted instead would preserve all of this for free, and is the wrong trade: a
 * space's panes own pty sessions, xterm instances and native browser views, and holding every
 * space's set of those alive so that one number survives is a large permanent cost for a small
 * transient one. What is actually lost is a handful of integers, so a handful of integers is what
 * is kept.
 *
 * Module-level, and deliberately NOT persisted. This restores a reading position within one run of
 * the app; a relaunch is a different sitting, and the transcript's rule for a cold start — open at
 * the newest message — is the right one to keep. Nothing here outlives the window.
 *
 * Keys name what is being READ rather than the pane doing the reading: a session id, a documents id
 * and path and view. Two panes showing one session therefore share a mark, which is the honest
 * answer — they are two views of one log, and the last scroll either of them made is the most
 * recent truth about where its reader is.
 */

/** How close to the end still counts as being at it. Shared with the transcript's follow-the-bottom
 *  rule so that "at the end" means one thing: a mark taken here and a pin taken there cannot
 *  disagree about a reader sitting 40px off the bottom. */
export const NEAR_END_PX = 80;

/** A scroller's position, plus whether that position was the end — which is not derivable from the
 *  offset alone once the content has grown, and is the difference between putting a reader back
 *  where they were and following new messages down for them. */
export type ScrollMark = { top: number; atEnd: boolean };

/** How long a restore keeps trying to land before it gives up. A scroller can exist before its
 *  content does, and one assignment to an empty box is silently clamped to 0 — so the offset is
 *  re-applied while the content is still arriving, for this long and no longer. Exported because
 *  the transcript runs the same discipline against its own scroller rather than through the hook:
 *  it has a follow-the-bottom pin of its own that the hook would fight. */
export const SETTLE_MS = 1000;

const marks = new Map<string, ScrollMark>();

/** Read an element's current position as a mark. */
export function markOf(el: HTMLElement): ScrollMark {
  return { top: el.scrollTop, atEnd: el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END_PX };
}

/** Put a scroller at `top`, and say whether it took. A browser silently clamps an offset the
 *  content cannot reach yet, so the answer is the only way to know a restore is still owed. */
export function applyScrollTop(el: HTMLElement, top: number): boolean {
  el.scrollTop = top;
  return Math.abs(el.scrollTop - top) < 1;
}

export function rememberScroll(key: string, mark: ScrollMark): void {
  marks.set(key, mark);
}

export function recallScroll(key: string): ScrollMark | null {
  return marks.get(key) ?? null;
}

/** Test seam only: the marks are process-wide, so a suite that did not clear them would let one
 *  test's scroll position decide another test's first paint. */
export function forgetAllScroll(): void {
  marks.clear();
}

/**
 * Remember and restore one scroller, for panes whose scroller has no follow-the-content rule of its
 * own — a document's source view, the rich editor's column. The transcript does NOT use this: it
 * already owns a scroll handler and a pin, and this hook would fight both.
 *
 * Returns a ref callback rather than taking a ref object because the element it wants can appear
 * later than the component that renders it, and a ref callback is told when.
 *
 * `key` of null attaches nothing at all, which is what the read-only mounts want.
 */
export function useScrollMemory(key: string | null): (el: HTMLElement | null) => void {
  return useCallback((el: HTMLElement | null) => {
    if (!el || !key) return;
    const wanted = recallScroll(key);

    /* Restoring is not one assignment. A scroller can be in the DOM before the content that fills
       it: the rich editor's wrapper mounts empty and ProseMirror appends into it a beat later, and
       a `scrollTop` written to a zero-height box is silently clamped to 0 — the restore would
       report success and put the reader at the top. So the offset is re-applied while the content
       is still growing, and stops the moment it takes. */
    let settling = wanted !== null;
    // Declared before the two closures that clear it so neither has to reach forward into a `const`
    // that does not exist yet — `apply` runs once before the observer is ever built.
    let ro: ResizeObserver | null = null;
    const giveUp = () => { settling = false; ro?.disconnect(); ro = null; };
    const apply = () => {
      if (!settling || !wanted) return;
      // A clamped write falls short, which means the content is still arriving — leave the loop
      // armed and try again when the box next changes size.
      if (applyScrollTop(el, wanted.top)) giveUp();
    };
    apply();

    // Only built when there is something left to land: the common case (the content was already
    // there, or there was no mark) costs no observer and no timer.
    if (settling) { ro = new ResizeObserver(apply); ro.observe(el); }
    // Bounded two ways. Content that never grows back to its old height — the file shrank, the pane
    // is wider now — must not leave an observer waiting for a frame that is not coming; and a reader
    // who reaches for the scroller mid-restore owns it from that moment, rather than being dragged
    // back to a position they have just left.
    const timer = settling ? setTimeout(giveUp, SETTLE_MS) : null;
    if (settling) {
      el.addEventListener("wheel", giveUp, { passive: true });
      el.addEventListener("pointerdown", giveUp);
      el.addEventListener("keydown", giveUp);
    }

    const onScroll = () => {
      // While settling, every scroll event is the echo of our own write; recording it would remember
      // the clamped position we are in the middle of correcting.
      if (settling) return;
      rememberScroll(key, markOf(el));
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      giveUp();
      if (timer !== null) clearTimeout(timer);
      el.removeEventListener("wheel", giveUp);
      el.removeEventListener("pointerdown", giveUp);
      el.removeEventListener("keydown", giveUp);
      el.removeEventListener("scroll", onScroll);
    };
  }, [key]);
}
