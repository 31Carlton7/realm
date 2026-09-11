import { describe, expect, it } from "vitest";
import { AGENT_META } from "./presets";
import {
  PLAN_LIMIT_REPORTING, mergeWindows, planLabel, planUnavailableNote, planWindowLabel,
  reportsPlanLimits, tightestWindow, windowLabelForMinutes, windowsByUrgency, type PlanWindow,
} from "./plan-limits";

const w = (id: string, utilization: number | null): PlanWindow =>
  ({ id, label: planWindowLabel(id), utilization, resetsAt: null });

describe("PLAN_LIMIT_REPORTING", () => {
  it("has an entry for every agent kind, so a new engine cannot default to claiming it reports", () => {
    expect(Object.keys(PLAN_LIMIT_REPORTING).sort()).toEqual(Object.keys(AGENT_META).sort());
  });

  it("claims a source only where one was actually captured", () => {
    // Both were measured off a live wire: Claude's SDKRateLimitEvent plus the /usage control request,
    // and Codex's `account/rateLimits/updated` (codex-cli 0.154.0). No ACP kind has the concept at
    // all — claiming one would put confident numbers behind an empty panel.
    expect(PLAN_LIMIT_REPORTING.claude).toEqual({ source: "claude-sdk", plan: true, warns: true });
    expect(PLAN_LIMIT_REPORTING.codex.source).toBe("codex-app-server");
    for (const kind of Object.keys(PLAN_LIMIT_REPORTING)) {
      if (kind.startsWith("acp:")) expect(PLAN_LIMIT_REPORTING[kind as "acp:cursor"].source, kind).toBe("none");
    }
  });

  /* The asymmetry between the two providers that DO report, pinned because it is the one a future
   * edit would smooth over by deriving a warning from a percentage. Codex's only status field
   * (`rateLimitReachedType`) reports a limit already hit; there is no approaching signal on that
   * wire, and inventing one would mean Realm choosing the threshold. */
  it("claims a pre-emptive warning only from the provider that actually raises one", () => {
    expect(PLAN_LIMIT_REPORTING.claude.warns).toBe(true);
    expect(PLAN_LIMIT_REPORTING.codex.warns).toBe(false);
    for (const [kind, row] of Object.entries(PLAN_LIMIT_REPORTING)) {
      if (row.warns) expect(row.source, kind).not.toBe("none");
    }
  });

  it("reportsPlanLimits agrees with the table rather than keeping its own list", () => {
    for (const kind of Object.keys(PLAN_LIMIT_REPORTING) as (keyof typeof PLAN_LIMIT_REPORTING)[]) {
      expect(reportsPlanLimits(kind), kind).toBe(PLAN_LIMIT_REPORTING[kind].source !== "none");
    }
  });
});

describe("planWindowLabel", () => {
  it("says hourly and weekly the way a person asks about them", () => {
    expect(planWindowLabel("five_hour")).toBe("5-hour");
    expect(planWindowLabel("seven_day")).toBe("Weekly");
  });

  it("names the two model buckets that have fixed keys", () => {
    expect(planWindowLabel("seven_day_opus")).toBe("Opus weekly");
    expect(planWindowLabel("seven_day_sonnet")).toBe("Sonnet weekly");
  });

  /* The Fable window has no fixed key: it arrives inside `rate_limits.model_scoped[]` under a
   * server-supplied `display_name`, so the label comes from the server and the id is synthesized. */
  it("labels a server-named model bucket from the server's own word", () => {
    expect(planWindowLabel("model:Fable")).toBe("Fable weekly");
    expect(planWindowLabel("model:Some Future Model")).toBe("Some Future Model weekly");
  });

  it("makes a readable label out of a key it has never seen, rather than dropping the window", () => {
    // The provider adds windows on its own schedule. One Realm cannot name is still one the user is
    // being held to, so it must survive to the panel.
    expect(planWindowLabel("thirty_day_something")).toBe("Thirty day something");
    expect(planWindowLabel("")).toBe("");
  });
});

describe("windowLabelForMinutes", () => {
  /* The two Codex actually sends (measured, codex-cli 0.154.0). They must land on the same words
   * Claude's own keys do, or the same window would be called two things in one panel. */
  it("names Codex's measured windows the way Claude names its equivalents", () => {
    expect(windowLabelForMinutes(300)).toBe("5-hour");
    expect(windowLabelForMinutes(300)).toBe(planWindowLabel("five_hour"));
    expect(windowLabelForMinutes(10080)).toBe("Weekly");
    expect(windowLabelForMinutes(10080)).toBe(planWindowLabel("seven_day"));
  });

  it("names a duration it has never seen rather than giving up", () => {
    expect(windowLabelForMinutes(60)).toBe("1-hour");
    expect(windowLabelForMinutes(1440)).toBe("Daily");
    expect(windowLabelForMinutes(4320)).toBe("3-day");
    expect(windowLabelForMinutes(30)).toBe("30-minute");
  });

  it("falls back to a bare label for a duration that says nothing", () => {
    expect(windowLabelForMinutes(0)).toBe("Plan");
    expect(windowLabelForMinutes(Number.NaN)).toBe("Plan");
  });
});

describe("planLabel", () => {
  it("leads with the provider, because a workspace runs several at once", () => {
    expect(planLabel("claude", "max")).toBe("Claude Max");
  });

  it("passes through a tier this build has never heard of", () => {
    expect(planLabel("claude", "galaxy")).toBe("Claude Galaxy");
  });

  it("answers null when the provider did not say, so the caller can word that itself", () => {
    expect(planLabel("claude", null)).toBeNull();
    expect(planLabel("claude", "   ")).toBeNull();
  });
});

describe("planUnavailableNote", () => {
  it("gives each reason its own sentence, and none of them reads as zero usage", () => {
    for (const reason of ["unsupported", "not-yet-known", "not-on-a-plan", "unreadable"] as const) {
      const note = planUnavailableNote("claude", reason);
      expect(note, reason).toContain("Claude");
      expect(note, reason).not.toMatch(/\b0%|\bzero\b/i);
    }
    // The two that are easiest to conflate must not read alike: one is a refusal, one is a wait.
    expect(planUnavailableNote("claude", "not-on-a-plan")).not.toBe(planUnavailableNote("claude", "not-yet-known"));
  });
});

describe("mergeWindows", () => {
  it("lets a fresher reading win without dropping the windows it did not mention", () => {
    const merged = mergeWindows([w("five_hour", 10), w("seven_day", 40)], [w("seven_day", 91)]);
    expect(merged.map((x) => [x.id, x.utilization])).toEqual([["five_hour", 10], ["seven_day", 91]]);
  });

  it("appends a window the fuller set never had", () => {
    const merged = mergeWindows([w("five_hour", 10)], [w("model:Fable", 55)]);
    expect(merged.map((x) => x.id)).toEqual(["five_hour", "model:Fable"]);
  });

  it("keeps the base untouched when the fresher set is empty", () => {
    expect(mergeWindows([w("five_hour", 10)], [])).toEqual([w("five_hour", 10)]);
  });
});

describe("windowsByUrgency / tightestWindow", () => {
  it("puts the window closest to its ceiling first", () => {
    const sorted = windowsByUrgency([w("five_hour", 10), w("seven_day", 90), w("model:Fable", 50)]);
    expect(sorted.map((x) => x.id)).toEqual(["seven_day", "model:Fable", "five_hour"]);
  });

  /* A window with no number cannot be the answer to "what stops me next", so it sorts last rather
   * than sorting as 0 — which would put it above a window at 5% that genuinely is the tightest. */
  it("sorts a window with no reported utilization last", () => {
    const sorted = windowsByUrgency([w("unknown", null), w("five_hour", 5)]);
    expect(sorted.map((x) => x.id)).toEqual(["five_hour", "unknown"]);
  });

  it("answers null for a set where nothing reported a number", () => {
    expect(tightestWindow([w("unknown", null)])).toBeNull();
    expect(tightestWindow([])).toBeNull();
  });

  it("does not reorder the caller's array", () => {
    const original = [w("five_hour", 10), w("seven_day", 90)];
    windowsByUrgency(original);
    expect(original.map((x) => x.id)).toEqual(["five_hour", "seven_day"]);
  });
});
