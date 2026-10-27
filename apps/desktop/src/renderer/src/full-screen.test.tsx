import { afterEach, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { FullScreenBridge } from "./App";

/* The bridge is the whole of "when": the stylesheet drops every drag region off one attribute, so THE
   mutants are the attribute never arriving, never leaving (a window back out of full screen that no
   longer drags), or surviving an unmount. */
afterEach(() => { cleanup(); delete (window as { realm?: unknown }).realm; });

it("marks the root while main says the window is in full screen, and clears it when it leaves", () => {
  let report: (fullScreen: boolean) => void = () => {};
  let unsubscribed = false;
  (window as { realm?: unknown }).realm = { onWindowFullScreen: (cb: (fullScreen: boolean) => void) => { report = cb; return () => { unsubscribed = true; }; } };
  const root = document.documentElement;
  const { unmount } = render(<FullScreenBridge />);
  expect(root.hasAttribute("data-fullscreen")).toBe(false);
  act(() => report(true));
  expect(root.hasAttribute("data-fullscreen")).toBe(true);
  act(() => report(false));
  expect(root.hasAttribute("data-fullscreen")).toBe(false);
  act(() => report(true));
  unmount();
  expect(unsubscribed).toBe(true);
  expect(root.hasAttribute("data-fullscreen")).toBe(false);
});

it("asks on mount, so a window restored into full screen starts without its regions", async () => {
  (window as { realm?: unknown }).realm = { onWindowFullScreen: () => () => {}, isWindowFullScreen: () => Promise.resolve(true) };
  render(<FullScreenBridge />);
  await act(async () => {});
  expect(document.documentElement.hasAttribute("data-fullscreen")).toBe(true);
});

it("lets a transition that arrives before the answer win over the answer", async () => {
  let report: (fullScreen: boolean) => void = () => {};
  let answer: (fullScreen: boolean) => void = () => {};
  (window as { realm?: unknown }).realm = {
    onWindowFullScreen: (cb: (fullScreen: boolean) => void) => { report = cb; return () => {}; },
    isWindowFullScreen: () => new Promise<boolean>((r) => { answer = r; }),
  };
  render(<FullScreenBridge />);
  act(() => report(false));
  await act(async () => answer(true));
  expect(document.documentElement.hasAttribute("data-fullscreen")).toBe(false);
});

it("keeps its regions where there is no bridge to ask, as in a browser or jsdom", () => {
  render(<FullScreenBridge />);
  expect(document.documentElement.hasAttribute("data-fullscreen")).toBe(false);
});
