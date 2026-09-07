import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { activityLevel, dayKey, USAGE_CALENDAR_DAYS } from "@realm/contracts";
import { createAppStore, StoreContext } from "../../../state/store";
import { fakeApi } from "../../../state/store.test-fakes";
import { ActivityCalendar, calendarWeeks, monthLabels } from "./ActivityCalendar";

afterEach(() => cleanup());

const DAY_MS = 86_400_000;
/** A fixed Wednesday, so the grid's Sunday padding is a fact rather than a coincidence of the clock. */
const NOW = new Date(2026, 8, 2, 15, 0, 0).getTime(); // 2026-09-02
const at = (daysAgo: number) => dayKey(NOW - daysAgo * DAY_MS);

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
