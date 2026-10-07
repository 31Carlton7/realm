import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { AGENT_FRAME } from "@realm/contracts";
import { DriveFrame } from "./DriveFrame";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const frame = (c: HTMLElement) => c.querySelector(".drive-frame");

describe("DriveFrame", () => {
  it("draws nothing at all when nothing is driving", () => {
    const { container } = render(<DriveFrame active={false} subject="this terminal" />);
    expect(frame(container)).toBeNull();
  });

  it("names what is being controlled", () => {
    const { container } = render(<DriveFrame active subject="this terminal" />);
    expect(frame(container)?.textContent).toBe("An agent is controlling this terminal");
  });

  /**
   * THE MUTANT: drop the linger and hide on the first `active: false`. Agents act in bursts — a
   * login is a write, a read, a write — so the frame would flash once per keystroke rather than
   * stating a condition, which is the failure `computer-driving.ts` documents for the menu-bar item
   * ("tearing the item down between each would flash the menu bar rather than inform it").
   */
  it("stays up after the act settles, for as long as the shared table says", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<DriveFrame active subject="this terminal" />);
    rerender(<DriveFrame active={false} subject="this terminal" />);
    act(() => { vi.advanceTimersByTime(AGENT_FRAME.lingerMs - 1); });
    expect(frame(container)).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(frame(container)).toBeNull();
  });

  it("restarts the clock on the next act, so a burst is one showing", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<DriveFrame active subject="this terminal" />);
    rerender(<DriveFrame active={false} subject="this terminal" />);
    act(() => { vi.advanceTimersByTime(AGENT_FRAME.lingerMs - 100); });
    rerender(<DriveFrame active subject="this terminal" />);
    rerender(<DriveFrame active={false} subject="this terminal" />);
    // Had the first timer survived, the frame would vanish 100ms from here.
    act(() => { vi.advanceTimersByTime(AGENT_FRAME.lingerMs - 100); });
    expect(frame(container)).not.toBeNull();
    act(() => { vi.advanceTimersByTime(100); });
    expect(frame(container)).toBeNull();
  });

  it("is invisible to a screen reader, which is told the same thing in words elsewhere", () => {
    const { container } = render(<DriveFrame active subject="this terminal" />);
    expect(frame(container)).toHaveAttribute("aria-hidden", "true");
  });
});
