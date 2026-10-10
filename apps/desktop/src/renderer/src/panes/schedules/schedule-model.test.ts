import { describe, expect, it } from "vitest";
import { onceExpr, parseOnce, type Schedule } from "@realm/contracts";
import {
  blankDraft, cadenceLabel, cadenceSentence, constraintsOf, draftOf, draftValid, exprOf, filterSchedules, firstRun, runState,
  runUnread, shortWhen, taskLine, timeOptions, upcomingOrder, whenLabel, whenPhrase,
} from "./schedule-model";

const now = new Date(2026, 8, 7, 12).getTime(); // a Monday, noon
const DAY = 86_400_000;
const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  id: "sch1", spaceId: "s1", title: "Morning triage", goal: "read the new issues", cron: "0 9 * * *", enabled: true,
  constraints: null, nextRunAt: now + DAY, lastRunAt: null, lastRunId: null, lastSkippedAt: null,
  newSessionPerRun: true, archiveSucceeded: false, roleId: null, createdAt: 1, updatedAt: 1, ...over,
});

describe("reading a moment", () => {
  it("reads a moment the way someone asks about one", () => {
    expect(whenLabel(new Date(2026, 8, 7, 9).getTime(), now)).toMatch(/^Today at /);
    expect(whenLabel(new Date(2026, 8, 8, 9).getTime(), now)).toMatch(/^Tomorrow at /);
    expect(whenLabel(new Date(2026, 8, 6, 9).getTime(), now)).toMatch(/^Yesterday at /);
    expect(whenLabel(new Date(2026, 8, 10, 9).getTime(), now)).toMatch(/^Thursday at /);
    expect(whenLabel(new Date(2026, 9, 20, 9).getTime(), now)).toMatch(/^Oct 20 at /);
  });

  it("lowers the relative words inside a sentence and leaves the proper nouns alone", () => {
    // THE MUTANT: `whenLabel(...).toLowerCase()`. It reads fine while every next run is within a day
    // — true of any cron schedule — and a one-shot a fortnight out turns into "Next sep 30".
    expect(whenPhrase(new Date(2026, 8, 8, 9).getTime(), now)).toBe("tomorrow at 9:00 am");
    expect(whenPhrase(new Date(2026, 9, 20, 13).getTime(), now)).toBe("Oct 20 at 1:00 pm");
  });

  it("shortens to Codex's row form: a time this week, a date beyond it", () => {
    expect(shortWhen(new Date(2026, 8, 8, 8, 1).getTime(), now)).toBe("Tomorrow 8:01 AM");
    expect(shortWhen(new Date(2026, 8, 11, 16).getTime(), now)).toBe("Friday 4:00 PM");
    expect(shortWhen(new Date(2026, 9, 9, 16).getTime(), now)).toBe("Oct 9");
    expect(shortWhen(new Date(2026, 8, 4, 16, 1).getTime(), now)).toBe("Fri 4:01 PM");
  });
});

describe("cadence", () => {
  it("names a task's repeat in the modal's own words, however the expression was spelled", () => {
    // An agent writing through `schedule_create` spells cron its own way; the row must read the same.
    expect(cadenceLabel("0 16 * * 5")).toBe("Weekly");
    expect(cadenceLabel("@weekly")).toBe("Weekly");
    expect(cadenceLabel("00 09 * * 1-5")).toBe("Weekdays");
    expect(cadenceLabel("15 * * * *")).toBe("Hourly");
    expect(cadenceLabel("0 9 1 * *")).toBe("Monthly");
    expect(cadenceLabel(onceExpr(now + DAY))).toBe("Once");
    // Every fifteen minutes is not "hourly at :15": it stays the expression somebody wrote.
    expect(cadenceLabel("*/15 * * * *")).toBe("Custom");
  });

  it("reads the card's sentence the way Codex does, and shows a shape it cannot name as itself", () => {
    expect(cadenceSentence("0 16 * * 5")).toBe("Fridays at 4:00 PM");
    expect(cadenceSentence("0 9 * * 1-5")).toBe("Weekdays at 9:00 AM");
    expect(cadenceSentence("30 * * * *")).toBe("Every hour at :30");
    expect(cadenceSentence("0 9 2 * *")).toBe("The 2nd of every month at 9:00 AM");
    expect(cadenceSentence("0 9 * * 1,3")).toBe("0 9 * * 1,3");
  });

  it("puts when a task runs next before how often, and says Paused rather than inventing a time", () => {
    expect(taskLine(schedule({ cron: "1 8 * * 2", nextRunAt: new Date(2026, 8, 8, 8, 1).getTime() }), now)).toBe("Tomorrow 8:01 AM · Weekly");
    expect(taskLine(schedule({ enabled: false, nextRunAt: null }), now)).toBe("Paused · Daily");
    expect(taskLine(schedule({ cron: onceExpr(now - DAY), nextRunAt: null, lastRunAt: now - DAY }), now)).toBe("Ran yesterday 12:00 PM · Once");
  });

  it("lists what fires soonest first, and what will not fire after it", () => {
    const soon = schedule({ id: "soon", nextRunAt: now + 1000 });
    const later = schedule({ id: "later", nextRunAt: now + DAY });
    const paused = schedule({ id: "paused", enabled: false, nextRunAt: null, createdAt: 9 });
    const done = schedule({ id: "done", nextRunAt: null, createdAt: 5 });
    expect(upcomingOrder([paused, later, done, soon]).map((s) => s.id)).toEqual(["soon", "later", "paused", "done"]);
  });

  it("searches what a task DOES as well as what it is called", () => {
    const a = schedule({ id: "a", title: "Morning triage", goal: "read the new issues" });
    const b = schedule({ id: "b", title: "Digest", goal: "summarise the week", cron: "0 9 * * 1" });
    expect(filterSchedules([a, b], "issues").map((s) => s.id)).toEqual(["a"]);
    expect(filterSchedules([a, b], "weekly").map((s) => s.id)).toEqual(["b"]);
    expect(filterSchedules([a, b], "").map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("a run's marks", () => {
  it("counts a run never opened as unread — a clock started it while nobody was looking", () => {
    // THE MUTANT: reuse the sidebar's `isUnread`, which reads `seenSeq` 0 as having missed nothing.
    // Every scheduled run is exactly that session, so no run would ever carry the dot.
    expect(runUnread({ seenSeq: 0, lastEventSeq: 12 })).toBe(true);
    expect(runUnread({ seenSeq: 12, lastEventSeq: 12 })).toBe(false);
    expect(runUnread({ seenSeq: 12, lastEventSeq: 15 })).toBe(true);
    // A run whose session has written nothing yet has nothing to read.
    expect(runUnread({ seenSeq: 0, lastEventSeq: 0 })).toBe(false);
    expect(runUnread(undefined)).toBe(false);
  });

  it("says what a run is doing only where its time alone would not", () => {
    expect(runState({ state: "succeeded" })).toBeNull();
    expect(runState({ state: "running" })).toEqual({ label: "Running", mark: "running" });
    expect(runState({ state: "blocked" })).toEqual({ label: "Needs you", mark: "waiting_permission" });
    expect(runState({ state: "failed" })?.mark).toBe("error");
  });
});

describe("the modal's draft", () => {
  it("writes the expression from the menus, and opens a saved task back onto the same menus", () => {
    const d = { ...blankDraft("s1", "claude", now), every: "weekly" as const, weekday: 5, time: "16:00" };
    expect(exprOf(d)).toBe("0 16 * * 5");
    const back = draftOf(schedule({ cron: "0 16 * * 5" }), "claude", now);
    expect(back).toMatchObject({ repeat: true, every: "weekly", weekday: 5, time: "16:00" });
    expect(exprOf(back)).toBe("0 16 * * 5");
  });

  it("opens an agent's spelling as the repeat it means, off-grid time and all", () => {
    // `@weekly` is Monday at nine; 8:01 is not on the half-hour grid and must not be rounded to it.
    expect(draftOf(schedule({ cron: "@weekly" }), "claude", now)).toMatchObject({ every: "weekly", weekday: 1, time: "09:00" });
    const odd = draftOf(schedule({ cron: "1 8 * * 2" }), "claude", now);
    expect(odd.time).toBe("08:01");
    expect(timeOptions(odd.time)).toContain("08:01");
    expect(exprOf(odd)).toBe("1 8 * * 2");
    // A shape the menus cannot hold is kept verbatim as Custom.
    expect(draftOf(schedule({ cron: "*/15 9-17 * * 1-5" }), "claude", now)).toMatchObject({ every: "custom", cron: "*/15 9-17 * * 1-5" });
  });

  it("writes a single run as a one-shot at the date and time picked", () => {
    const d = { ...blankDraft("s1", "claude", now), repeat: false, date: "2026-09-30", time: "13:00" };
    expect(parseOnce(exprOf(d)!)).toBe(new Date(2026, 8, 30, 13).getTime());
    expect(draftOf(schedule({ cron: exprOf(d)! }), "claude", now)).toMatchObject({ repeat: false, date: "2026-09-30", time: "13:00" });
  });

  it("is only valid with a name, instructions, and a first run ahead of now", () => {
    const d = { ...blankDraft("s1", "claude", now), title: "Triage", goal: "Read the new issues." };
    expect(draftValid(d, now)).toBe(true);
    expect(draftValid({ ...d, goal: "   " }, now)).toBe(false);
    expect(draftValid({ ...d, every: "custom", cron: "0 9 30 2 *" }, now)).toBe(false); // February 30th
    expect(draftValid({ ...d, repeat: false, date: "2020-01-02" }, now)).toBe(false);
    expect(firstRun(d, now)).toBe(new Date(2026, 8, 8, 9).getTime());
  });

  it("asks for the agent, the model, its level, fast mode and the permission, and keeps whatever else the task was given", () => {
    const before = { permissionMode: "plan" as const, skills: ["triage"], model: "old", fastMode: true };
    const d = { ...draftOf(schedule({ constraints: before }), "codex", now), model: "gpt-5.6-terra", effort: "medium" };
    expect(constraintsOf(d, before, ["low", "medium", "high"]))
      .toEqual({ permissionMode: "plan", skills: ["triage"], agentKind: "codex", model: "gpt-5.6-terra", effort: "medium", fastMode: true });
    // What the modal turned off is off: no level, no bolt, Ask each time — none of them written down.
    expect(constraintsOf({ ...d, model: null, effort: null, fastMode: false, permissionMode: "default" }, before))
      .toEqual({ skills: ["triage"], agentKind: "codex" });
  });

  it("opens a task's level, bolt and permission back onto the draft", () => {
    expect(draftOf(schedule({ constraints: { agentKind: "claude", effort: "xhigh", fastMode: true, permissionMode: "acceptEdits" } }), "codex", now))
      .toMatchObject({ agentKind: "claude", effort: "xhigh", fastMode: true, permissionMode: "acceptEdits" });
    expect(draftOf(schedule(), "codex", now)).toMatchObject({ agentKind: "codex", effort: null, fastMode: false, permissionMode: null });
  });

  it("saves a level only where the chosen model takes it, and a bolt only where its harness can be asked", () => {
    /* A level set under one model, kept while another was picked: the card showed the new model's
       default in force, so that is what is saved. THE MUTANTS: the stale level written (the run asks
       the harness for a level the model refuses), or dropped where Realm only had not heard yet. */
    const d = { ...blankDraft("s1", "codex", now), model: "gpt-5.6-terra", effort: "max", fastMode: true };
    expect(constraintsOf(d, null, ["low", "medium", "high"])).toEqual({ agentKind: "codex", model: "gpt-5.6-terra", fastMode: true });
    // Codex before its probe has answered: no levels known yet, and the saved one stands.
    expect(constraintsOf(d, null, [])).toEqual({ agentKind: "codex", model: "gpt-5.6-terra", effort: "max", fastMode: true });
    // An ACP agent takes no fast mode from Realm, and the scripted one no level.
    expect(constraintsOf({ ...d, agentKind: "acp:opencode", model: null, effort: "high" }, null, ["low", "medium", "high"]))
      .toEqual({ agentKind: "acp:opencode", effort: "high" });
    expect(constraintsOf({ ...d, agentKind: "fake", model: "fake", effort: "high", fastMode: false }, null)).toEqual({ agentKind: "fake", model: "fake" });
  });
});
