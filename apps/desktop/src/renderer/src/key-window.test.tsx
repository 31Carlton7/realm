import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { KeyWindowBridge } from "./App";

/* The bridge is the whole of "when": the stylesheet greys the accent off one attribute, so THE mutants
   are the attribute never arriving, never leaving, or surviving an unmount into the next window. */
afterEach(() => { cleanup(); delete (window as { realm?: unknown }).realm; });

it("marks the root inactive while main says the window is not key, and clears it when it is again", () => {
  let report: (key: boolean) => void = () => {};
  const off = vi.fn();
  (window as { realm?: unknown }).realm = { onWindowKey: (cb: (key: boolean) => void) => { report = cb; return off; } };
  const root = document.documentElement;
  const { unmount } = render(<KeyWindowBridge />);
  expect(root.hasAttribute("data-window-inactive")).toBe(false);
  act(() => report(false));
  expect(root.hasAttribute("data-window-inactive")).toBe(true);
  act(() => report(true));
  expect(root.hasAttribute("data-window-inactive")).toBe(false);
  act(() => report(false));
  unmount();
  expect(off).toHaveBeenCalledOnce();
  expect(root.hasAttribute("data-window-inactive")).toBe(false);
});

it("stays lit where there is no bridge to ask, as in a browser or jsdom", () => {
  render(<KeyWindowBridge />);
  expect(document.documentElement.hasAttribute("data-window-inactive")).toBe(false);
});

it("asks on mount, so a window that opened behind another app starts grey", async () => {
  (window as { realm?: unknown }).realm = { onWindowKey: () => () => {}, isWindowKey: () => Promise.resolve(false) };
  render(<KeyWindowBridge />);
  await act(async () => {});
  expect(document.documentElement.hasAttribute("data-window-inactive")).toBe(true);
});

it("lets a focus change that arrives before the answer win over the answer", async () => {
  let report: (key: boolean) => void = () => {};
  let answer: (key: boolean) => void = () => {};
  (window as { realm?: unknown }).realm = {
    onWindowKey: (cb: (key: boolean) => void) => { report = cb; return () => {}; },
    isWindowKey: () => new Promise<boolean>((r) => { answer = r; }),
  };
  render(<KeyWindowBridge />);
  act(() => report(true));
  await act(async () => answer(false));
  expect(document.documentElement.hasAttribute("data-window-inactive")).toBe(false);
});
