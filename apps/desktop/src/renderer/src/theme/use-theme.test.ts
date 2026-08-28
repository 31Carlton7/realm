import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { suppressTransitions, useApplyTheme, type ThemePref } from "./useTheme";

afterEach(() => { cleanup(); vi.useRealTimers(); document.documentElement.removeAttribute("data-theme-switching"); });

/** §6's do-NOT-animate list includes theme/mode switching. Rewriting the palette changes every
 *  colour at once; the surfaces carrying a 100ms hover transition would tween to the new theme
 *  while everything else snapped, so the swap is fenced by a no-transition mark on :root. */
describe("theme switching is not animated (§6)", () => {
  const marked = () => document.documentElement.hasAttribute("data-theme-switching");

  it("marks the root immediately and clears it once the new palette has painted", () => {
    vi.useFakeTimers();
    suppressTransitions(document.documentElement, 60);
    expect(marked()).toBe(true);
    act(() => { vi.advanceTimersByTime(59); });
    expect(marked()).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(marked()).toBe(false);
  });

  it("the disposer clears the mark and cancels the pending timer — no stale mark can outlive it", () => {
    vi.useFakeTimers();
    const done = suppressTransitions(document.documentElement, 60);
    done();
    expect(marked()).toBe(false);
    act(() => { vi.advanceTimersByTime(200); });
    expect(marked()).toBe(false); // the timer did not fire against a later, still-live suppression
  });

  it("applying a theme fences the write, and switching mode fences it again", () => {
    vi.useFakeTimers();
    const { rerender } = renderHook(({ pref }) => useApplyTheme("#7c6cff", pref), { initialProps: { pref: "dark" as ThemePref } });
    expect(marked()).toBe(true); // set by the same layout effect that writes the palette
    act(() => { vi.advanceTimersByTime(100); });
    expect(marked()).toBe(false);
    rerender({ pref: "light" });
    expect(marked()).toBe(true);
  });

  it("leaves no mark behind when the app unmounts mid-swap", () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useApplyTheme("#7c6cff", "dark"));
    expect(marked()).toBe(true);
    unmount();
    expect(marked()).toBe(false);
  });
});
