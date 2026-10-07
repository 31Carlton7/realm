import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { useAutoHideScrollbar } from "./use-auto-hide-scrollbar";

afterEach(() => { cleanup(); vi.useRealTimers(); });

/** A bare scroller wrapping the hook, the way every real caller does: one ref, made in the same
 *  render that hands it to a scrollable element. */
function Scroller() {
  const ref = useRef<HTMLDivElement>(null);
  useAutoHideScrollbar(ref);
  return <div ref={ref} data-testid="scroller" />;
}

const scrolling = (el: HTMLElement) => el.hasAttribute("data-scrolling");

describe("useAutoHideScrollbar", () => {
  it("marks the element only while it is being scrolled", () => {
    render(<Scroller />);
    const el = screen.getByTestId("scroller");
    expect(scrolling(el)).toBe(false);
    fireEvent.scroll(el);
    expect(scrolling(el)).toBe(true);
  });

  it("clears the mark a still moment after the last scroll, not on the next tick", () => {
    vi.useFakeTimers();
    render(<Scroller />);
    const el = screen.getByTestId("scroller");
    fireEvent.scroll(el);
    expect(scrolling(el)).toBe(true);
    act(() => { vi.advanceTimersByTime(800); });
    expect(scrolling(el)).toBe(true); // still inside the hold
    act(() => { vi.advanceTimersByTime(200); });
    expect(scrolling(el)).toBe(false);
  });

  it("a second scroll before the hold expires restarts the clock rather than stacking timers", () => {
    vi.useFakeTimers();
    render(<Scroller />);
    const el = screen.getByTestId("scroller");
    fireEvent.scroll(el);
    act(() => { vi.advanceTimersByTime(700); });
    fireEvent.scroll(el); // a continuous scroll, not a fresh one
    act(() => { vi.advanceTimersByTime(700); });
    expect(scrolling(el)).toBe(true); // 700ms since the SECOND scroll, still under the 900ms hold
    act(() => { vi.advanceTimersByTime(300); });
    expect(scrolling(el)).toBe(false);
  });

  it("removes the mark and its timer on unmount, rather than writing to a detached node", () => {
    vi.useFakeTimers();
    const { unmount } = render(<Scroller />);
    const el = screen.getByTestId("scroller");
    fireEvent.scroll(el);
    expect(scrolling(el)).toBe(true);
    unmount();
    expect(scrolling(el)).toBe(false);
    // The pending timeout is gone too — advancing time must not throw reaching for a stale element.
    expect(() => act(() => { vi.advanceTimersByTime(2000); })).not.toThrow();
  });
});
