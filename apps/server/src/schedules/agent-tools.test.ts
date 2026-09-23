import { beforeEach, describe, expect, it } from "vitest";
import { onceExpr, parseOnce, type CreateScheduleInput, type Schedule } from "@realm/contracts";
import { createScheduleAgentProvider, SCHEDULE_PROVIDER_NAME } from "./agent-tools";
import type { RealmToolProvider } from "../mcp/gateway";

/**
 * The tools that let a session put work on the clock.
 *
 * `ScheduleService` is faked, and it is the only thing faked: what this suite is about is the
 * translation between an ordinary sentence and a row — which moment `at` resolves to, what a refusal
 * says, and whether the answer carries enough for the agent to tell the user the truth. Whether the
 * row then fires is `service.test.ts`'s, and it is tested there.
 *
 * The named mutants:
 *
 *   - `at` read through `new Date()`            → "refuses a date with no time"
 *   - both `at` and `cron` resolved by precedence → "refuses a call carrying both"
 *   - the service's refusal swallowed into a generic failure → "hands the service's own words back"
 *   - a space's tools answered for another space → "reads and writes only its own space"
 */

const SPACE = "space-1";
const ctx = { sessionId: "sess-1", spaceId: SPACE };

let rows: Schedule[];
let provider: RealmToolProvider;
let enabled: boolean;

const row = (input: CreateScheduleInput): Schedule => ({
  id: `sch${rows.length + 1}`, spaceId: input.spaceId, title: input.title, goal: input.goal,
  cron: input.cron, enabled: input.enabled ?? true, constraints: null,
  // The real store derives this; the fake mirrors the one property the tools read back — a one-shot
  // resolves to its own moment, and a cron to something ahead.
  nextRunAt: parseOnce(input.cron) ?? Date.parse("2026-10-01T09:00:00Z"),
  lastRunAt: null, lastRunId: null, lastSkippedAt: null, createdAt: 0, updatedAt: 0,
});

beforeEach(() => {
  rows = [];
  enabled = true;
  provider = createScheduleAgentProvider({
    schedules: {
      create: (input: CreateScheduleInput) => {
        // The one gate the real service applies that these tests depend on.
        const once = parseOnce(input.cron);
        if (once !== null && once <= Date.now()) throw new Error(`${new Date(once).toLocaleString()} has already passed — a one-shot can only be scheduled ahead of now`);
        if (once === null && !/^(@\w+|[\d*,\-/ ]+)$/.test(input.cron)) throw new Error(`\`${input.cron}\` is not a schedule that will ever run — check the expression`);
        const made = row(input);
        rows.push(made);
        return made;
      },
      list: (spaceId: string) => rows.filter((r) => r.spaceId === spaceId),
    } as never,
    mcp: { providerEnabled: () => enabled },
  });
});

const call = (tool: string, args: unknown = {}) => provider.call(ctx, tool, args);
const text = (r: Awaited<ReturnType<typeof call>>) => (r.content[0] as { text: string }).text;

describe("schedule_create", () => {
  it("turns a local moment into a one-shot and says which moment it took", () => {
    // The agent has to be able to repeat the time back to the user. An answer that only said "done"
    // would leave the user with work arriving at a moment nobody confirmed.
    const r = call("schedule_create", { title: "Drop the badge", goal: "Open a PR removing the new badge.", at: "2026-09-30T13:00" });
    return r.then((res) => {
      expect(res.isError).toBe(false);
      expect(rows[0]!.cron).toBe(onceExpr(new Date(2026, 8, 30, 13).getTime()));
      expect(text(res)).toContain("Once, on Sep 30 at 1:00 PM");
      expect(text(res)).toContain("Drop the badge");
    });
  });

  it("refuses a date with no time rather than inventing one", async () => {
    // THE MUTANT: hand `at` to `new Date()`. "2026-09-30" is UTC midnight by the language's spec
    // while "2026-09-30T13:00" is local — the zone changes with the length of the string — and
    // midnight starts unattended work while nobody is awake to answer its permission prompt.
    const res = await call("schedule_create", { title: "T", goal: "G", at: "2026-09-30" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("not a moment I can schedule");
    expect(rows).toEqual([]);
  });

  it("refuses a call carrying both `at` and `cron`, and one carrying neither", async () => {
    // THE MUTANT: prefer one silently. A call with both holds two different intentions and no way to
    // tell which the user said; picking either schedules the other away without a word.
    for (const args of [
      { title: "T", goal: "G", at: "2026-09-30T13:00", cron: "0 9 * * *" },
      { title: "T", goal: "G" },
    ]) {
      const res = await call("schedule_create", args);
      expect(res.isError).toBe(true);
      expect(text(res)).toContain("exactly one");
    }
    expect(rows).toEqual([]);
  });

  it("takes a cron for repeating work, and reads it back as the sentence a person would say", async () => {
    const res = await call("schedule_create", { title: "Triage", goal: "Read the new issues.", cron: "0 9 * * 1-5" });
    expect(res.isError).toBe(false);
    expect(rows[0]!.cron).toBe("0 9 * * 1-5");
    expect(text(res)).toContain("Weekdays at 09:00");
  });

  it("hands the service's own words back when it refuses", async () => {
    // THE MUTANT: catch and report "failed to create schedule". The service already writes its
    // refusals for a person ("has already passed"), and that sentence is what lets the agent correct
    // itself on the next call instead of reporting a failure it cannot explain.
    const res = await call("schedule_create", { title: "T", goal: "G", at: "2020-01-02T09:00" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("already passed");
  });

  it("refuses an argument the schema does not name", async () => {
    // `additionalProperties: false` is advertised, so it has to be a rule. A model sending
    // `spaceId` is reaching for another space, and dropping the field quietly answers that with a
    // success in the space it was actually confined to.
    const res = await call("schedule_create", { title: "T", goal: "G", at: "2026-09-30T13:00", spaceId: "space-2" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("invalid arguments");
  });
});

describe("schedule_list", () => {
  it("reads and writes only its own space", async () => {
    rows.push(row({ spaceId: "space-2", title: "Someone else's", goal: "G", cron: "0 9 * * *", enabled: true, constraints: null }));
    await call("schedule_create", { title: "Mine", goal: "G", cron: "0 9 * * *" });
    // The space is `ctx`'s, never an argument — a session cannot schedule into a space it is not in.
    expect(rows.map((r) => r.spaceId)).toEqual(["space-2", SPACE]);
    const res = await call("schedule_list");
    expect(text(res)).toContain("Mine");
    expect(text(res)).not.toContain("Someone else's");
  });

  it("says a missed firing out loud", async () => {
    // A schedule that quietly did not happen is the one thing an agent asked "did that run?" must
    // not answer with silence.
    const made = row({ spaceId: SPACE, title: "Sweep", goal: "G", cron: "0 9 * * *", enabled: true, constraints: null });
    rows.push({ ...made, lastSkippedAt: Date.parse("2026-09-28T09:00:00Z") });
    expect(text(await call("schedule_list"))).toContain("MISSED");
  });

  it("has an answer for a space with nothing on the clock", async () => {
    expect(text(await call("schedule_list"))).toBe("This space has nothing scheduled.");
  });
});

describe("the provider's switch", () => {
  it("offers no tools and refuses every call when the space has it off", async () => {
    enabled = false;
    expect(await provider.tools(ctx)).toEqual([]);
    const res = await call("schedule_create", { title: "T", goal: "G", at: "2026-09-30T13:00" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain(SCHEDULE_PROVIDER_NAME);
    expect(rows).toEqual([]);
  });

  it("names what it has when asked for a tool it does not", async () => {
    const res = await call("schedule_delete", {});
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("schedule_create, schedule_list");
  });
});
