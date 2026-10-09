import { describe, expect, it } from "vitest";
import { backoffUntil } from "./team-handoffs";

describe("backoffUntil — how long every team waits after an engine's limit", () => {
  const now = 1_000_000_000_000;
  it("takes the reset of the window the provider named", () => {
    expect(backoffUntil({ alertWindow: "five_hour", windows: [
      { id: "seven_day", utilization: 40, resetsAt: now + 9e8 },
      { id: "five_hour", utilization: 100, resetsAt: now + 3_600_000 },
    ] }, now)).toEqual({ until: now + 3_600_000, named: true });
  });
  it("with no window named, waits for the latest full window to reset", () => {
    expect(backoffUntil({ alertWindow: null, windows: [
      { id: "a", utilization: 100, resetsAt: now + 60_000 }, { id: "b", utilization: 100, resetsAt: now + 120_000 }, { id: "c", utilization: 50, resetsAt: now + 9e9 },
    ] }, now).until).toBe(now + 120_000);
  });
  it("reads Claude's usage-limit message for its reset, in seconds", () => {
    expect(backoffUntil({ message: `Claude AI usage limit reached|${(now + 7_200_000) / 1000}` }, now)).toEqual({ until: now + 7_200_000, named: true });
  });
  it("waits an hour, and says it guessed, when nothing names a reset — never a retry a moment later", () => {
    expect(backoffUntil({ message: "rate limit exceeded" }, now)).toEqual({ until: now + 3_600_000, named: false });
    expect(backoffUntil({ message: `usage limit reached|${(now - 1000) / 1000}` }, now).named).toBe(false);
  });
});
