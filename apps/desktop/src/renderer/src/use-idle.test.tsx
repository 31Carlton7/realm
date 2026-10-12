import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { IDLE_AFTER_MS, useIdle } from "./use-idle";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("goes idle half a minute after the last input, and wakes on the next one", () => {
  const { result } = renderHook(() => useIdle(true));
  expect(result.current).toBe(false);
  act(() => { vi.advanceTimersByTime(IDLE_AFTER_MS - 1000); });
  window.dispatchEvent(new Event("pointermove"));
  // The move re-armed nothing visible: still awake a full window after the first deadline.
  act(() => { vi.advanceTimersByTime(IDLE_AFTER_MS - 1); });
  expect(result.current).toBe(false);
  act(() => { vi.advanceTimersByTime(1); });
  expect(result.current).toBe(true);
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" })); });
  expect(result.current).toBe(false);
  act(() => { vi.advanceTimersByTime(IDLE_AFTER_MS); });
  expect(result.current).toBe(true);
});

it("is never idle while nobody is watching, so it never claims a reason the window already has", () => {
  const { result, rerender } = renderHook(({ on }) => useIdle(on), { initialProps: { on: false } });
  act(() => { vi.advanceTimersByTime(IDLE_AFTER_MS * 2); });
  expect(result.current).toBe(false);
  rerender({ on: true });
  act(() => { vi.advanceTimersByTime(IDLE_AFTER_MS); });
  expect(result.current).toBe(true);
  // Focus leaving and coming back starts the count again rather than arriving idle.
  rerender({ on: false });
  rerender({ on: true });
  expect(result.current).toBe(false);
});
