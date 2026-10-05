import { describe, expect, it } from "vitest";
import { AgentKindSchema } from "./entities";
import { SELECTABLE_AGENT_KINDS } from "./presets";
import {
  DEFAULT_USAGE_BUDGET, USAGE_REPORTING, bucketNext, bucketRange, bucketStart, defaultBucketFor,
  estimateCostUsd, formatTokens, formatUsd, nextDayKey, normalizeThresholds, parseUsageBudget, skillUseName,
  sumDeltas, thresholdsCrossed, usageDeltas, usageStreaks, type UsageSample,
} from "./usage";

const sample = (ts: number, costUsd: number, inputTokens: number, outputTokens: number, numTurns: number): UsageSample =>
  ({ ts, costUsd, inputTokens, outputTokens, numTurns });

describe("USAGE_REPORTING", () => {

  it("records the ACP gap honestly: every acp:* kind reports NOTHING", () => {
    // This is the page's central claim, and it is a fact about the protocol (docs/dev/acp-protocol.md
    // §usage: ACP 0.4.5 has no token-usage message), not a gap in Realm's mapping. If someone
    // "fixes" one of these to `cumulative` without an adapter that emits usage, the page starts
    // drawing $0.00 bars for engines whose spend is simply unknown.
    for (const kind of AgentKindSchema.options.filter((k) => k.startsWith("acp:"))) {
      expect(USAGE_REPORTING[kind], kind).toEqual({ series: "none", tokens: false, cost: "none" });
    }
  });

  it("only Claude and Codex report usage, and only Claude reports a price", () => {
    const reporting = SELECTABLE_AGENT_KINDS.filter((k) => USAGE_REPORTING[k].series !== "none");
    expect(reporting).toEqual(["claude", "codex"]);
    expect(USAGE_REPORTING.claude.cost).toBe("reported");
    expect(USAGE_REPORTING.codex.cost).toBe("estimated");
  });
});

describe("usageDeltas", () => {
  it("differences a cumulative series instead of summing it", () => {
    // The named mutant. Claude and Codex both send RUNNING TOTALS, so summing the payloads scales
    // with the square of the turn count: this session spent 6, not 1+3+6=10.
    const out = usageDeltas([sample(1, 1, 10, 5, 1), sample(2, 3, 30, 15, 2), sample(3, 6, 60, 30, 3)], "cumulative");
    expect(out.map((d) => d.costUsd)).toEqual([1, 2, 3]);
    expect(sumDeltas(out)).toEqual({ costUsd: 6, inputTokens: 60, outputTokens: 30, turns: 3 });
  });

  it("treats a drop as a RESTART and takes the new value whole — a resumed session is not a refund", () => {
    // `claude-adapter.ts` passes `resume` when a session is picked back up, and the fresh query's
    // counters begin again at zero. Clamping the negative step to zero instead would silently drop
    // everything the resumed half went on to spend.
    const out = usageDeltas([sample(1, 1, 10, 5, 1), sample(2, 3, 30, 15, 2), sample(3, 1, 8, 4, 1), sample(4, 4, 40, 20, 3)], "cumulative");
    expect(sumDeltas(out).costUsd).toBe(3 + 4);
    expect(sumDeltas(out).inputTokens).toBe(30 + 40);
  });

  it("does not mistake one flat field for a restart", () => {
    // A turn that produced no output tokens leaves that field level while the others climb. Judging
    // the restart field-by-field would re-add the whole running total on that turn.
    const out = usageDeltas([sample(1, 1, 10, 5, 1), sample(2, 2, 20, 5, 2)], "cumulative");
    expect(sumDeltas(out)).toEqual({ costUsd: 2, inputTokens: 20, outputTokens: 5, turns: 2 });
  });

  it("sums a per-turn series, because each event is already its own increment", () => {
    const out = usageDeltas([sample(1, 0.001, 10, 10, 1), sample(2, 0.001, 10, 10, 1)], "per-turn");
    expect(sumDeltas(out)).toEqual({ costUsd: 0.002, inputTokens: 20, outputTokens: 20, turns: 2 });
  });

  it("reads nothing at all for an engine that reports nothing", () => {
    expect(usageDeltas([sample(1, 5, 5, 5, 5)], "none")).toEqual([]);
  });

  it("keeps each delta's own ts, so deltas can be bucketed by time", () => {
    expect(usageDeltas([sample(111, 1, 0, 0, 1), sample(222, 2, 0, 0, 2)], "cumulative").map((d) => d.ts)).toEqual([111, 222]);
  });
});

describe("estimateCostUsd", () => {
  it("prices per MILLION tokens, matching ModelInfo's already-converted unit", () => {
    expect(estimateCostUsd(1_000_000, 1_000_000, { priceIn: 3, priceOut: 15 })).toBe(18);
    expect(estimateCostUsd(500_000, 0, { priceIn: 3, priceOut: 15 })).toBe(1.5);
  });

  it("answers null — not zero — when nothing is known about the price", () => {
    // Free and unknown are different claims and stay different all the way to the screen.
    expect(estimateCostUsd(1000, 1000, null)).toBeNull();
    expect(estimateCostUsd(1000, 1000, { priceIn: null, priceOut: null })).toBeNull();
    expect(estimateCostUsd(1_000_000, 1_000_000, { priceIn: 0, priceOut: 0 })).toBe(0);
  });

  it("prices the half it knows when the catalog quoted only one side", () => {
    expect(estimateCostUsd(1_000_000, 1_000_000, { priceIn: null, priceOut: 10 })).toBe(10);
  });
});

describe("bucketing", () => {
  it("buckets on the LOCAL calendar, so an evening session is not filed under tomorrow", () => {
    const evening = new Date(2026, 8, 3, 20, 30).getTime();
    expect(bucketStart(evening, "day")).toBe(new Date(2026, 8, 3).getTime());
    expect(bucketStart(evening, "month")).toBe(new Date(2026, 8, 1).getTime());
  });

  it("starts weeks on Monday, including from a Sunday", () => {
    // 2026-09-06 is a Sunday; its week began Monday the 31st of August.
    expect(bucketStart(new Date(2026, 8, 6, 12).getTime(), "week")).toBe(new Date(2026, 7, 31).getTime());
    expect(bucketStart(new Date(2026, 7, 31, 0, 1).getTime(), "week")).toBe(new Date(2026, 7, 31).getTime());
  });

  it("advances by the CALENDAR, not by a fixed 86,400,000 — the thing that breaks twice a year", () => {
    expect(bucketNext(new Date(2026, 0, 31).getTime(), "month")).toBe(new Date(2026, 1, 1).getTime());
    expect(bucketNext(new Date(2026, 11, 31).getTime(), "day")).toBe(new Date(2027, 0, 1).getTime());
  });

  it("covers the whole range so an empty period stays a visible gap rather than vanishing", () => {
    const from = new Date(2026, 8, 1).getTime();
    const to = new Date(2026, 8, 5, 23, 59).getTime();
    expect(bucketRange(from, to, "day")).toHaveLength(5);
  });

  it("caps the series, so an all-time range cannot allocate for years of days", () => {
    expect(bucketRange(0, Date.now(), "day", 10)).toHaveLength(10);
  });

  it("picks a bucket that keeps the range readable", () => {
    expect(defaultBucketFor(7)).toBe("day");
    expect(defaultBucketFor(30)).toBe("day");
    expect(defaultBucketFor(90)).toBe("week");
    expect(defaultBucketFor(null)).toBe("month");
  });
});

describe("budget", () => {
  it("falls back to the default rather than throwing on a hand-edited settings row", () => {
    // `settings` is user-editable JSON; a bad row must not take down the page that reads it.
    expect(parseUsageBudget("not a budget")).toEqual(DEFAULT_USAGE_BUDGET);
    expect(parseUsageBudget(null)).toEqual(DEFAULT_USAGE_BUDGET);
    expect(parseUsageBudget({ monthlyUsd: -5 })).toEqual(DEFAULT_USAGE_BUDGET);
  });

  it("normalizes thresholds on the way in, so the crossing check can walk them in order", () => {
    expect(normalizeThresholds([1, 0.5, 0.8, 0.5, 0, 9])).toEqual([0.5, 0.8, 1]);
    expect(parseUsageBudget({ monthlyUsd: 100, thresholds: [1, 0.5] }).thresholds).toEqual([0.5, 1]);
  });

  it("fires a threshold exactly once — the crossing, not the state", () => {
    const budget = parseUsageBudget({ monthlyUsd: 100, thresholds: [0.5, 0.8, 1] });
    expect(thresholdsCrossed(40, 60, budget)).toEqual([0.5]);
    // The named mutant: deriving "are we over 50%?" from the total alone re-fires on every later turn.
    expect(thresholdsCrossed(60, 70, budget)).toEqual([]);
  });

  it("reports every threshold a single expensive turn vaults, in ascending order", () => {
    const budget = parseUsageBudget({ monthlyUsd: 100, thresholds: [0.5, 0.8, 1] });
    expect(thresholdsCrossed(10, 105, budget)).toEqual([0.5, 0.8, 1]);
  });

  it("stays silent with no budget set, and when spend did not move", () => {
    expect(thresholdsCrossed(0, 500, parseUsageBudget({ monthlyUsd: null }))).toEqual([]);
    expect(thresholdsCrossed(90, 90, parseUsageBudget({ monthlyUsd: 100 }))).toEqual([]);
  });
});

describe("formatting", () => {
  it("keeps sub-cent spend visible instead of rendering a page of $0.00", () => {
    // A run that cost a third of a cent is not a run that cost nothing, and 2dp says it did.
    expect(formatUsd(0.0034)).toBe("$0.0034");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(12.5)).toBe("$12.50");
  });

  it("compacts token counts without losing the difference between 1.2K and 1.9K", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1200)).toBe("1.2K");
    expect(formatTokens(45_000)).toBe("45K");
    expect(formatTokens(2_400_000)).toBe("2.4M");
  });
});

describe("nextDayKey", () => {
  it("steps by the calendar across a month, a year and a leap day", () => {
    expect(nextDayKey("2026-09-30")).toBe("2026-10-01");
    expect(nextDayKey("2026-12-31")).toBe("2027-01-01");
    expect(nextDayKey("2028-02-28")).toBe("2028-02-29");
    expect(nextDayKey("2027-02-28")).toBe("2027-03-01");
  });

  it("lands on the next date across both clock changes, wherever the machine is", () => {
    // A fixed 86,400,000 from a local midnight is 23:00 the same day when the clocks go back, and
    // the streak would count that day twice. These are the 2026 transitions in the US and the EU.
    const zone = process.env.TZ;
    try {
      for (const tz of ["America/Los_Angeles", "Europe/London"]) {
        process.env.TZ = tz;
        expect(nextDayKey("2026-03-08"), tz).toBe("2026-03-09");
        expect(nextDayKey("2026-03-29"), tz).toBe("2026-03-30");
        expect(nextDayKey("2026-10-25"), tz).toBe("2026-10-26");
        expect(nextDayKey("2026-11-01"), tz).toBe("2026-11-02");
      }
    } finally {
      if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
    }
  });
});

describe("usageStreaks", () => {
  const today = "2026-09-15";

  it("counts a run of consecutive days that reaches today", () => {
    const s = usageStreaks(["2026-09-13", "2026-09-14", "2026-09-15"], today);
    expect(s.current).toEqual({ days: 3, from: "2026-09-13", to: "2026-09-15" });
    expect(s.longest).toEqual({ days: 3, from: "2026-09-13", to: "2026-09-15" });
  });

  it("is broken by a single day with nothing in it", () => {
    // The 12th is the gap. The run after it is the current one; the run before it is the longest.
    const s = usageStreaks(["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-13", "2026-09-14", "2026-09-15"], today);
    expect(s.current.days).toBe(3);
    expect(s.longest).toEqual({ days: 4, from: "2026-09-08", to: "2026-09-11" });
  });

  it("keeps the streak alive through a today that has nothing in it yet", () => {
    // From midnight until the first message of the morning, a streak that reached yesterday is
    // still a streak. Reading it as broken would be wrong for most of the hours anyone looks.
    const s = usageStreaks(["2026-09-12", "2026-09-13", "2026-09-14"], today);
    expect(s.current).toEqual({ days: 3, from: "2026-09-12", to: "2026-09-14" });
  });

  it("is over once neither today nor yesterday has anything", () => {
    const s = usageStreaks(["2026-09-11", "2026-09-12", "2026-09-13"], today);
    expect(s.current).toEqual({ days: 0, from: null, to: null });
    expect(s.longest.days).toBe(3);
  });

  it("joins days across a month boundary", () => {
    const s = usageStreaks(["2026-08-30", "2026-08-31", "2026-09-01"], "2026-09-01");
    expect(s.current.days).toBe(3);
  });

  it("gives the more recent run when two tie for longest", () => {
    const s = usageStreaks(["2026-09-01", "2026-09-02", "2026-09-05", "2026-09-06"], today);
    expect(s.longest).toEqual({ days: 2, from: "2026-09-05", to: "2026-09-06" });
  });

  it("reads days in any order, once each", () => {
    const s = usageStreaks(["2026-09-15", "2026-09-13", "2026-09-14", "2026-09-14"], today);
    expect(s.current.days).toBe(3);
  });

  it("does not let a day after today count", () => {
    // A clock that was set wrong once must not hand out a streak.
    const s = usageStreaks(["2026-09-15", "2026-09-16", "2026-09-17"], today);
    expect(s.current).toEqual({ days: 1, from: "2026-09-15", to: "2026-09-15" });
    expect(s.longest.days).toBe(1);
  });

  it("answers zero with no days at all", () => {
    expect(usageStreaks([], today)).toEqual({ current: { days: 0, from: null, to: null }, longest: { days: 0, from: null, to: null } });
  });
});

describe("skillUseName", () => {
  it("drops Realm's own namespace so a library skill counts once whichever route loaded it", () => {
    expect(skillUseName("realm:caikins-deslop")).toBe("caikins-deslop");
    expect(skillUseName("caikins-deslop")).toBe("caikins-deslop");
    expect(skillUseName("/realm:browsing")).toBe("browsing");
  });

  it("keeps another plugin's namespace, which is what tells two same-named skills apart", () => {
    expect(skillUseName("superpowers:brainstorming")).toBe("superpowers:brainstorming");
  });
});
