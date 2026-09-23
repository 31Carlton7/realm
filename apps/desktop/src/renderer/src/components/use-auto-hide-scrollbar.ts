import { useEffect, type RefObject } from "react";

/** How long the thumb stays lit after the last scroll event — long enough that a flick of the wheel
 *  reads as one continuous scroll rather than a strobe, short enough that it reads as a response to
 *  scrolling rather than a fixture that happens to fade out eventually. */
const HOLD_MS = 900;

/**
 * Marks `data-scrolling` on an element for a moment after each scroll, so its own scrollbar can sit
 * quiet at rest and take the app's usual thumb only while it is actually moving.
 *
 * Scoped to the prompter's own popovers (styles.css, "on scroll, in the prompter") — the mention and
 * slash lists, the skill picker, the model picker's list and jump strip. Every other scroller in the
 * app keeps the persistent hairline this replaces: a transcript, a diff, a settings page is long
 * enough that "there is more this way" is worth saying continuously, and widening this past the
 * prompter would be answering a question nobody asked there.
 *
 * A direct DOM write, not React state: a wheel gesture fires many scroll events a second, and a
 * state update per event would re-render a popover for an attribute nothing else reads.
 */
export function useAutoHideScrollbar(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      el.dataset.scrolling = "";
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { delete el.dataset.scrolling; }, HOLD_MS);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (timer) clearTimeout(timer);
      delete el.dataset.scrolling;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount only; ref.current is read once, and every caller renders its scroller in the same pass it calls this hook
  }, []);
}
