import { describe, expect, it } from "vitest";
import { EVENT_RETENTION_CHOICES, parseRetentionDays, retentionChoicesFor } from "./storage";

describe("the retention window", () => {
  it("is whole days, floored, and anything that isn't a number of days is off", () => {
    expect(parseRetentionDays(30)).toBe(30);
    expect(parseRetentionDays(30.5)).toBe(30);
    expect(parseRetentionDays(45)).toBe(45);
    for (const v of [null, undefined, "30", -1, Number.NaN, Number.POSITIVE_INFINITY, {}]) expect(parseRetentionDays(v)).toBe(0);
  });

  it("offers the stored window even when it is none of the usual choices", () => {
    expect(retentionChoicesFor(30)).toBe(EVENT_RETENTION_CHOICES);
    expect(retentionChoicesFor(45).map((c) => c.label)).toEqual(["Off", "30 days", "45 days", "90 days"]);
    expect(retentionChoicesFor(1).find((c) => c.days === 1)?.label).toBe("1 day");
  });
});
