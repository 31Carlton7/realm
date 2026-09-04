import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ThemeName } from "@realm/ui";
import { hasWindowMaterial, suppressTransitions, useApplyTheme, type ThemePref } from "./useTheme";

afterEach(() => { cleanup(); vi.useRealTimers(); document.documentElement.removeAttribute("data-theme-switching"); document.documentElement.removeAttribute("style"); });

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

/** The palette is a second axis over light/dark, so the interesting cases are the ones where the two
 *  disagree: a theme with no light face, and the trip back out of it. */
describe("theme and mode compose", () => {
  const root = () => document.documentElement;

  it("a one-faced palette pins the effective mode, and the preference survives it", () => {
    const { result, rerender } = renderHook(
      ({ theme }) => useApplyTheme("#7c6cff", "light" as ThemePref, theme),
      { initialProps: { theme: "monokai" as ThemeName } },
    );
    expect(result.current).toBe("dark");
    expect(root().dataset.mode).toBe("dark");
    expect(root().dataset.theme).toBe("monokai");
    // THE pinning-by-preference mutant: implement this by writing "dark" into themePref. The window
    // looks identical and the user's "light" is gone — this rerender would then still say dark.
    rerender({ theme: "one" });
    expect(result.current).toBe("light");
    expect(root().dataset.mode).toBe("light");
  });

  it("a custom palette paints inline and the default palette scrubs it off again", () => {
    const { rerender } = renderHook(
      ({ theme }) => useApplyTheme("#7c6cff", "dark" as ThemePref, theme),
      { initialProps: { theme: "one" as ThemeName } },
    );
    expect(root().style.getPropertyValue("--page")).toMatch(/^oklch\(/);
    rerender({ theme: "realm" });
    expect(root().style.getPropertyValue("--page")).toBe("");
    expect(root().dataset.theme).toBe("realm");
  });

  it("switching palette is fenced by the no-transition mark, exactly like switching mode", () => {
    vi.useFakeTimers();
    const { rerender } = renderHook(
      ({ theme }) => useApplyTheme("#7c6cff", "dark" as ThemePref, theme),
      { initialProps: { theme: "realm" as ThemeName } },
    );
    act(() => { vi.advanceTimersByTime(100); });
    expect(root().hasAttribute("data-theme-switching")).toBe(false);
    // Repainting 34 custom properties at once is the same smear §6 fenced mode switching for; a
    // theme change that skipped the fence would tween the hovered row and snap everything else.
    rerender({ theme: "one" });
    expect(root().hasAttribute("data-theme-switching")).toBe(true);
  });
});

describe("the adjustable ground reaches :root", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("carries the user's value, and a change to it repaints without a mode or theme change", () => {
    const { rerender } = renderHook(
      ({ alpha }) => useApplyTheme("#7c6cff", "dark" as ThemePref, "realm", alpha),
      { initialProps: { alpha: 82 } },
    );
    expect(document.documentElement.style.getPropertyValue("--ground-alpha")).toBe("82%");
    // THE missing-dependency mutant: leave groundAlpha out of the layout effect's deps. The slider
    // moves, the store updates, and the window does not change until something else forces a
    // re-apply — which for most users is never.
    rerender({ alpha: 60 });
    expect(document.documentElement.style.getPropertyValue("--ground-alpha")).toBe("60%");
  });

  it("an unknown platform is not macOS — a bridgeless renderer must not guess a material it may not have", () => {
    expect(hasWindowMaterial()).toBe(false);
    vi.stubGlobal("realm", { platform: "linux" });
    expect(hasWindowMaterial()).toBe(false);
    vi.stubGlobal("realm", { platform: "darwin" });
    expect(hasWindowMaterial()).toBe(true);
  });
});
