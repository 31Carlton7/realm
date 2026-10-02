import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { activityLevel, dayKey, USAGE_CALENDAR_DAYS } from "@realm/contracts";
import { createAppStore, StoreContext } from "../../../state/store";
import { fakeApi } from "../../../state/store.test-fakes";
import { ActivityCalendar, calendarWeeks, monthLabels } from "./ActivityCalendar";

afterEach(() => cleanup());

const DAY_MS = 86_400_000;
/** A fixed Wednesday, so the grid's Sunday padding is a fact rather than a coincidence of the clock. */
const NOW = new Date(2026, 8, 2, 15, 0, 0).getTime(); // 2026-09-02
const at = (daysAgo: number) => dayKey(NOW - daysAgo * DAY_MS);
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Sep 1, 2026" for "2026-09-01" — how a cell's label names its day. */
const readable = (day: string) => { const [y, m, d] = day.split("-").map(Number); return `${MONTH_NAMES[m! - 1]} ${d}, ${y}`; };

describe("activityLevel", () => {
  it("scales against the reader's OWN busiest day, not a fixed ceiling", () => {
    // Twelve messages is a heavy day for one person and a quiet hour for another. A fixed scale
    // paints one calendar solid and the other blank.
    expect(activityLevel(3, 12)).toBe(1);
    expect(activityLevel(3, 400)).toBe(1);
    expect(activityLevel(300, 400)).toBe(3);
    expect(activityLevel(400, 400)).toBe(4);
  });

  it("separates 'none' from 'a little' — an unused day is a different thing, not a small amount", () => {
    expect(activityLevel(0, 100)).toBe(0);
    expect(activityLevel(1, 100)).toBe(1);
  });

  it("has no level to give when nothing happened all year", () => {
    expect(activityLevel(0, 0)).toBe(0);
  });
});

describe("calendarWeeks", () => {
  it("lays out whole weeks starting on Sunday, ending on today", () => {
    const weeks = calendarWeeks([], NOW);
    // The last column is a partial week — today is a Wednesday, so it holds Sun…Wed.
    expect(weeks[weeks.length - 1]).toHaveLength(4);
    expect(weeks[weeks.length - 1]!.at(-1)!.day).toBe(dayKey(NOW));
    // …and every column before it is a full one. A ragged FIRST stripe is the mutant: padding
    // forward instead of backward would make days that have not happened yet indistinguishable from
    // a week the reader spent away.
    for (const w of weeks.slice(0, -1)) expect(w).toHaveLength(7);
    expect(weeks.length * 7).toBeGreaterThanOrEqual(USAGE_CALENDAR_DAYS);
  });

  it("keeps a day with no rows visible as a gap rather than compressing it away", () => {
    const weeks = calendarWeeks([{ day: at(3), messages: 10, sessions: 1 }], NOW);
    const cells = weeks.flat();
    expect(cells.find((c) => c.day === at(3))!.level).toBe(4); // the only day, so it is the max
    expect(cells.find((c) => c.day === at(4))!.level).toBe(0);
    expect(cells.filter((c) => c.level === 0).length).toBeGreaterThan(300);
  });

  it("reads each day's own counts onto its cell", () => {
    const weeks = calendarWeeks([
      { day: at(1), messages: 4, sessions: 2 },
      { day: at(2), messages: 16, sessions: 5 },
    ], NOW);
    const cells = weeks.flat();
    expect(cells.find((c) => c.day === at(1))).toMatchObject({ messages: 4, sessions: 2, level: 1 });
    expect(cells.find((c) => c.day === at(2))).toMatchObject({ messages: 16, sessions: 5, level: 4 });
  });
});

describe("calendarWeeks — the three readings", () => {
  /** The cell for a day, and the week (column) it sits in. */
  const find = (weeks: ReturnType<typeof calendarWeeks>, day: string) => {
    const week = weeks.find((w) => w.some((c) => c.day === day))!;
    return { cell: week.find((c) => c.day === day)!, week };
  };

  it("paints every day of a week by the week's total when read weekly", () => {
    // Two weeks back: a message on each of seven days. Five weeks back: one message, one day.
    const busy = calendarWeeks([], NOW).at(-3)!.map((c) => ({ day: c.day, messages: 1, sessions: 1 }));
    const quiet = calendarWeeks([], NOW).at(-6)![2]!;
    const weeks = calendarWeeks([...busy, { day: quiet.day, messages: 1, sessions: 1 }], NOW, "weekly");
    const busyWeek = weeks.at(-3)!;
    expect(busyWeek.map((c) => c.value)).toEqual([7, 7, 7, 7, 7, 7, 7]);
    expect(busyWeek.every((c) => c.level === 4)).toBe(true);
    // Scaled by the busiest WEEK, not the busiest day: a one-message week is a light one. Scaled by
    // the day, every week with anything in it would be solid.
    expect(weeks.at(-6)!.map((c) => c.level)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    // …and the day's own count rides along unchanged.
    expect(find(weeks, quiet.day).cell.messages).toBe(1);
  });

  it("climbs through every day from the first shown when read cumulatively", () => {
    const weeks = calendarWeeks([
      { day: at(10), messages: 2, sessions: 1 },
      { day: at(5), messages: 2, sessions: 1 },
    ], NOW, "cumulative");
    expect(find(weeks, at(11)).cell).toMatchObject({ value: 0, level: 0 });
    // A quiet day after the first message still carries everything sent before it.
    expect(find(weeks, at(7)).cell).toMatchObject({ messages: 0, value: 2, level: 2 });
    expect(find(weeks, at(0)).cell).toMatchObject({ value: 4, level: 4 });
  });

  it("is the day's own count when read daily, as it always was", () => {
    const weeks = calendarWeeks([{ day: at(2), messages: 3, sessions: 1 }, { day: at(1), messages: 12, sessions: 1 }], NOW);
    expect(find(weeks, at(2)).cell).toMatchObject({ value: 3, level: 1 });
    expect(find(weeks, at(1)).cell).toMatchObject({ value: 12, level: 4 });
  });
});

describe("monthLabels", () => {
  it("names each month over the week that contains its first day", () => {
    const labels = monthLabels(calendarWeeks([], NOW));
    expect(labels.map((l) => l.label)).toContain("Sep");
    // Twelve or thirteen months of a 53-week window, never a label per week.
    expect(labels.length).toBeLessThanOrEqual(13);
    expect(labels.length).toBeGreaterThanOrEqual(12);
    // Strictly increasing columns: a label placed off a stale index would sit over the wrong weeks.
    expect(labels.map((l) => l.index)).toEqual([...labels.map((l) => l.index)].sort((a, b) => a - b));
  });
});

describe("the calendar card", () => {
  async function mount(days: { day: string; messages: number; sessions: number }[]) {
    const api = fakeApi({ usageActiveDays: days });
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><ActivityCalendar /></StoreContext.Provider>);
    return { api, store };
  }

  it("asks for its OWN window, not the page's filter row", async () => {
    // "Days I used Realm" is not a question about the last 30 days in one space. A calendar that
    // emptied when the reader narrowed the chart beside it would answer a question nobody asked.
    const { api } = await mount([]);
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("usageActiveDays:"))).toBe(true));
    const call = api.calls.find((c) => c.startsWith("usageActiveDays:"))!;
    const [, from, to] = call.split(":").map(Number);
    expect((to! - from!) / DAY_MS).toBeGreaterThan(USAGE_CALENDAR_DAYS);
  });

  it("counts the days it found and says so in words, not only in colour", async () => {
    await mount([
      { day: at(1), messages: 4, sessions: 1 },
      { day: at(30), messages: 12, sessions: 3 },
    ]);
    await waitFor(() => expect(screen.getByText(/2 days · 16 messages sent/)).toBeInTheDocument());
  });

  it("counts in the singular where the count is one", async () => {
    await mount([{ day: at(1), messages: 1, sessions: 1 }]);
    await waitFor(() => expect(screen.getByText("1 day · 1 message sent")).toBeInTheDocument());
  });

  it("says so plainly when there is nothing yet", async () => {
    await mount([]);
    await waitFor(() => expect(screen.getByText("No sent messages in the last year")).toBeInTheDocument());
  });

  it("switches between daily, weekly and cumulative, and the words follow the colour", async () => {
    await mount([{ day: at(1), messages: 4, sessions: 1 }, { day: at(2), messages: 2, sessions: 1 }]);
    const cellFor = (day: string) => [...document.querySelectorAll<HTMLElement>(".cal-grid .cal-cell")]
      .find((c) => c.title.startsWith(`${readable(day)}:`))!;
    await waitFor(() => expect(cellFor(at(1)).title).toMatch(/4 messages$/));

    fireEvent.click(screen.getByRole("radio", { name: "Weekly" }));
    // Both days fall in this week (NOW is a Wednesday): every day of the column now says six.
    await waitFor(() => expect(document.querySelector<HTMLElement>(".cal-grid .cal-cell[data-level='4']")!.title).toMatch(/^Week of .*: 6 messages$/));

    fireEvent.click(screen.getByRole("radio", { name: "Cumulative" }));
    await waitFor(() => expect(cellFor(at(0)).title).toMatch(/: 6 messages since /));
    expect(cellFor(at(1)).title).toMatch(/: 6 messages since /);
    expect(cellFor(at(2)).title).toMatch(/: 2 messages since /);
    expect(screen.getByRole("radio", { name: "Cumulative" })).toBeChecked();
  });

  it("keeps the present end in view when the window narrows under it — until the reader scrolls back", async () => {
    // jsdom lays nothing out, so the geometry is staged by hand and the observer is one we can fire.
    const observers: (() => void)[] = [];
    const Real = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class { constructor(cb: () => void) { observers.push(cb); } observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
    try {
      await mount([{ day: at(1), messages: 4, sessions: 1 }]);
      const el = document.querySelector<HTMLElement>(".cal-scroll")!;
      const stage = (p: Record<string, number>) => { for (const [k, v] of Object.entries(p)) Object.defineProperty(el, k, { value: v, configurable: true, writable: true }); };
      // It opened wide enough to fit: nothing to scroll. Then the window narrows to half that.
      stage({ scrollWidth: 760, clientWidth: 760, scrollLeft: 0 });
      stage({ clientWidth: 380 });
      act(() => observers.forEach((fire) => fire()));
      expect(el.scrollLeft).toBe(760);
      // The reader scrolls back to look at the spring: the next resize leaves them there.
      stage({ scrollLeft: 120 });
      fireEvent.scroll(el);
      stage({ clientWidth: 360 });
      act(() => observers.forEach((fire) => fire()));
      expect(el.scrollLeft).toBe(120);
    } finally {
      globalThis.ResizeObserver = Real;
    }
  });

  it("gives every cell its count as text, so the colour is never the only telling", async () => {
    await mount([{ day: at(1), messages: 4, sessions: 1 }]);
    await waitFor(() => expect(document.querySelectorAll(".cal-cell[data-level='4']").length).toBe(1));
    const filled = document.querySelector<HTMLElement>(".cal-cell[data-level='4']")!;
    expect(filled.title).toMatch(/4 messages$/);
    expect(filled.textContent).toMatch(/4 messages$/);
    // …and a quiet day says it is quiet rather than saying nothing at all.
    expect(document.querySelector<HTMLElement>(".cal-cell[data-level='0']")!.title).toMatch(/no messages$/);
  });
});
