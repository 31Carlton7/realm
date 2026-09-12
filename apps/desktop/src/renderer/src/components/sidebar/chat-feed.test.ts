import { describe, expect, it } from "vitest";
import type { Session } from "@realm/contracts";
import { dayLabel, daysApart, groupSessionsByDay } from "./chat-feed";

/** A fixed `now`: a Wednesday afternoon. Every date assertion below is relative to it. */
const NOW = new Date(2026, 8, 9, 15, 30).getTime(); // 2026-09-09, local
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).getTime();

const session = (id: string, updatedAt: number, over: Partial<Session> = {}): Session =>
  ({
    id, spaceId: "s1", projectId: null, agentKind: "claude", model: null, effort: null,
    permissionMode: "ask", fastMode: false, environmentId: "env1", cwd: "/repo/realm",
    status: "idle", providerSessionId: null, title: `chat ${id}`, lastEventSeq: 0, seenSeq: 0,
    terminalItemId: null, createdAt: updatedAt, updatedAt, ...over,
  } as Session);

describe("dayLabel", () => {
  it("names today and yesterday", () => {
    expect(dayLabel(at(2026, 8, 9, 9), NOW)).toBe("Today");
    expect(dayLabel(at(2026, 8, 8, 23), NOW)).toBe("Yesterday");
  });

  it("uses a weekday name for the rest of the week", () => {
    // 2026-09-06 is 3 days before the 9th.
    expect(dayLabel(at(2026, 8, 6), NOW)).toBe(new Date(at(2026, 8, 6)).toLocaleDateString(undefined, { weekday: "long" }));
  });

  it("falls back to a date once a weekday name would be ambiguous", () => {
    /* THE MUTANT: keep using weekday names past a week. Two different Tuesdays would then carry the
       same heading, and the feed would look like it had duplicated a day. */
    const label = dayLabel(at(2026, 7, 20), NOW);
    expect(label).not.toMatch(/day$/);
    expect(label).toContain("20");
  });

  it("shows the year only when it is not the current one", () => {
    expect(dayLabel(at(2026, 0, 4), NOW)).not.toContain("2026");
    expect(dayLabel(at(2025, 0, 4), NOW)).toContain("2025");
  });

  it("counts whole LOCAL days, not 24-hour blocks", () => {
    /* 23:30 yesterday and 00:30 today are 60 minutes apart and are different days; 09:00 and 15:30
       today are 6 hours apart and are the same one. THE MUTANT: divide the difference in epoch ms,
       which gets both of these backwards and mislabels every row on a clock-change day. */
    expect(daysApart(at(2026, 8, 8, 23), NOW)).toBe(1);
    expect(daysApart(at(2026, 8, 9, 0), NOW)).toBe(0);
    expect(daysApart(at(2026, 8, 9, 9), NOW)).toBe(0);
  });

  it("treats a timestamp in the future as today rather than a negative day", () => {
    // Clock skew between the daemon and the window is real; a "-1 days" heading is not.
    expect(dayLabel(at(2026, 8, 10), NOW)).toBe("Today");
  });
});

describe("groupSessionsByDay", () => {
  it("orders days newest first and sessions newest first within a day", () => {
    const groups = groupSessionsByDay([
      session("old", at(2026, 8, 1)),
      session("today-early", at(2026, 8, 9, 9)),
      session("today-late", at(2026, 8, 9, 14)),
      session("yesterday", at(2026, 8, 8)),
    ], NOW);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", dayLabel(at(2026, 8, 1), NOW)]);
    expect(groups[0]!.sessions.map((s) => s.id)).toEqual(["today-late", "today-early"]);
  });

  it("puts two sessions from the same day in one group", () => {
    /* THE MUTANT: group by timestamp instead of by day — every session would get a heading of its
       own and the feed would be all headings. */
    const groups = groupSessionsByDay([session("a", at(2026, 8, 9, 9)), session("b", at(2026, 8, 9, 14))], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sessions).toHaveLength(2);
  });

  it("groups by updatedAt, so a long-running chat sits under the day it was last worked on", () => {
    const groups = groupSessionsByDay([
      session("stale-start", at(2026, 8, 9, 10), { createdAt: at(2026, 7, 1) }),
    ], NOW);
    expect(groups[0]!.label).toBe("Today");
  });

  it("does not mutate the array it was given", () => {
    const rows = [session("a", at(2026, 8, 1)), session("b", at(2026, 8, 9))];
    groupSessionsByDay(rows, NOW);
    expect(rows.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("answers nothing for no sessions", () => {
    expect(groupSessionsByDay([], NOW)).toEqual([]);
  });
});
