import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stampLabel, stampTitle, useNow } from "./timestamps";

afterEach(() => { cleanup(); vi.useRealTimers(); });

/** Local wall-clock moments, so the assertions read the way the labels do. */
const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

describe("how a timestamp is said", () => {
  const now = at(2026, 10, 4, 19, 40);

  it("is a bare clock time for something that happened today", () => {
    expect(stampLabel(at(2026, 10, 4, 19, 38), now)).toMatch(/^7:38\sPM$/);
    expect(stampLabel(at(2026, 10, 4, 0, 1), now)).toMatch(/^12:01\sAM$/);
  });

  it("says Yesterday for the day before, by the calendar and not by 24 hours", () => {
    expect(stampLabel(at(2026, 10, 3, 19, 38), now)).toMatch(/^Yesterday 7:38\sPM$/);
    // Fifteen minutes apart, across midnight: the message is yesterday's even though it is recent.
    expect(stampLabel(at(2026, 10, 3, 23, 50), at(2026, 10, 4, 0, 5))).toMatch(/^Yesterday 11:50\sPM$/);
    // And 23 hours apart inside one day is still today.
    expect(stampLabel(at(2026, 10, 4, 0, 30), at(2026, 10, 4, 23, 30))).toMatch(/^12:30\sAM$/);
  });

  it("names the date for anything older, and the year only once it is not this one", () => {
    expect(stampLabel(at(2026, 10, 2, 19, 38), now)).toMatch(/^Oct 2, 7:38\sPM$/);
    expect(stampLabel(at(2025, 12, 30, 9, 5), now)).toMatch(/^Dec 30, 2025, 9:05\sAM$/);
  });

  it("puts the full date and time, to the second, in the tooltip", () => {
    const full = stampTitle(at(2026, 10, 2, 19, 38, 12));
    expect(full).toMatch(/Friday/);
    expect(full).toMatch(/October 2, 2026/);
    expect(full).toMatch(/7:38:12\sPM/);
  });
});

describe("the reader's now", () => {
  it("moves on at local midnight, so an open transcript relabels today as yesterday", () => {
    vi.useFakeTimers({ now: at(2026, 10, 4, 23, 59, 30) });
    const sent = at(2026, 10, 4, 21, 0);
    const Stamp = () => createElement("span", { "data-testid": "s" }, stampLabel(sent, useNow()));
    const view = render(createElement(Stamp));
    expect(view.getByTestId("s").textContent).toMatch(/^9:00\sPM$/);
    act(() => { vi.advanceTimersByTime(32_000); });
    expect(view.getByTestId("s").textContent).toMatch(/^Yesterday 9:00\sPM$/);
  });
});
