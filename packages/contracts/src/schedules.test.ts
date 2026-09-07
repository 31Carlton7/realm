import { describe, expect, it } from "vitest";
import { CRON_PRESETS, describeCron, matchesCron, nextCronFire, nextFireOf, parseCron } from "./schedules";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const show = (ts: number | null) => (ts === null ? null : new Date(ts).toString().slice(0, 24));

describe("parseCron", () => {
  it("expands every supported field form", () => {
    expect([...parseCron("0 9 * * *")!.minute]).toEqual([0]);
    expect([...parseCron("*/15 * * * *")!.minute]).toEqual([0, 15, 30, 45]);
    expect([...parseCron("0 9-11 * * *")!.hour]).toEqual([9, 10, 11]);
    expect([...parseCron("0 8,12,18 * * *")!.hour]).toEqual([8, 12, 18]);
    expect([...parseCron("0 0-23/6 * * *")!.hour]).toEqual([0, 6, 12, 18]);
    expect(parseCron("0 9 * * *")!.hour.size).toBe(1);
    expect(parseCron("* * * * *")!.minute.size).toBe(60);
  });

  it("folds 7 into 0, because half the world's crontabs spell Sunday that way", () => {
    expect([...parseCron("0 9 * * 7")!.dayOfWeek]).toEqual([0]);
    expect([...parseCron("0 9 * * 0,7")!.dayOfWeek]).toEqual([0]);
  });

  it("refuses anything malformed rather than guessing at it", () => {
    // A schedule that silently fires at a different time than its author wrote is worse than one
    // that will not save. Every one of these has a "helpful" reading, and none of them is taken.
    for (const bad of ["", "0 9 * *", "0 9 * * * *", "60 9 * * *", "0 24 * * *", "0 9 0 * *",
                       "0 9 32 * *", "0 9 * 13 *", "0 9 * * 8", "0 9 * * mon", "a 9 * * *",
                       "0 9-5 * * *", "*/0 * * * *", "5/2 * * * *", "0 9 * * 1/", "0,, 9 * * *"]) {
      expect(parseCron(bad), bad).toBeNull();
    }
  });

  it("reads the four aliases, and points @daily somewhere a person is awake", () => {
    // These start an AGENT. A midnight default would run unattended work while nobody could answer
    // a permission prompt, which is exactly the state a run's `blocked` exists to avoid getting into.
    expect(show(nextFireOf("@daily", at(2026, 3, 4, 12)))).toBe(show(at(2026, 3, 5, 9)));
    expect(show(nextFireOf("@hourly", at(2026, 3, 4, 12, 30)))).toBe(show(at(2026, 3, 4, 13)));
    expect(parseCron("@weekly")!.dayOfWeek.has(1)).toBe(true);
    expect(parseCron("@nope")).toBeNull();
  });

  it("every shipped preset parses and has a next fire", () => {
    // A preset the picker offers that the parser refuses would be a button that cannot be saved.
    for (const p of CRON_PRESETS) {
      expect(parseCron(p.expr), p.label).not.toBeNull();
      expect(nextFireOf(p.expr, Date.now()), p.label).toBeTypeOf("number");
    }
  });
});

describe("matchesCron — the day-of-month / day-of-week rule", () => {
  const cron = parseCron("0 9 1 * 1")!; // both restricted: the 1st OR any Monday

  it("ORs the two when BOTH are restricted", () => {
    // The common bug is to AND them, which makes this fire only on Mondays that fall on the 1st —
    // roughly seven times a decade instead of five times a month.
    expect(matchesCron(cron, at(2026, 4, 1, 9))).toBe(true);   // a Wednesday, but the 1st
    expect(matchesCron(cron, at(2026, 4, 6, 9))).toBe(true);   // a Monday, but the 6th
    expect(matchesCron(cron, at(2026, 4, 7, 9))).toBe(false);  // neither
  });

  it("consults only the restricted one when the other is a star", () => {
    expect(matchesCron(parseCron("0 9 1 * *")!, at(2026, 4, 6, 9))).toBe(false); // dom only
    expect(matchesCron(parseCron("0 9 * * 1")!, at(2026, 4, 1, 9))).toBe(false); // dow only
    expect(matchesCron(parseCron("0 9 * * 1")!, at(2026, 4, 6, 9))).toBe(true);
  });

  it("is a minute-level match, not an hour-level one", () => {
    expect(matchesCron(parseCron("30 9 * * *")!, at(2026, 4, 6, 9, 30))).toBe(true);
    expect(matchesCron(parseCron("30 9 * * *")!, at(2026, 4, 6, 9, 31))).toBe(false);
  });
});

describe("nextCronFire", () => {
  it("is strictly after its argument — a schedule cannot re-fire the minute it just fired", () => {
    // The mutant: `>=`. The runner writes `nextRunAt = nextFire(now)` immediately after firing, so
    // an inclusive search would hand back the same minute and fire the schedule again on the next
    // tick, forever.
    const nine = at(2026, 4, 6, 9);
    expect(show(nextFireOf("0 9 * * *", nine))).toBe(show(at(2026, 4, 7, 9)));
    expect(show(nextFireOf("0 9 * * *", nine - 1))).toBe(show(nine));
  });

  it("ignores seconds on the way in, so a tick at 09:00:37 still finds tomorrow", () => {
    expect(show(nextFireOf("0 9 * * *", at(2026, 4, 6, 9) + 37_000))).toBe(show(at(2026, 4, 7, 9)));
  });

  it("crosses days, months and years", () => {
    expect(show(nextFireOf("0 9 * * *", at(2026, 4, 6, 22)))).toBe(show(at(2026, 4, 7, 9)));
    expect(show(nextFireOf("0 9 1 * *", at(2026, 4, 6, 22)))).toBe(show(at(2026, 5, 1, 9)));
    expect(show(nextFireOf("0 9 1 1 *", at(2026, 4, 6)))).toBe(show(at(2027, 1, 1, 9)));
  });

  it("finds the next weekday occurrence, skipping the weekend", () => {
    // 2026-04-03 is a Friday.
    expect(show(nextFireOf("0 9 * * 1-5", at(2026, 4, 3, 10)))).toBe(show(at(2026, 4, 6, 9)));
  });

  it("reaches a leap day rather than looping forever", () => {
    expect(show(nextFireOf("0 9 29 2 *", at(2026, 4, 1)))).toBe(show(at(2028, 2, 29, 9)));
  });

  it("answers null for an expression no calendar can satisfy", () => {
    // February 30th. Four years of searching and then an honest "never", rather than a hang.
    expect(nextFireOf("0 9 30 2 *", at(2026, 4, 1))).toBeNull();
  });

  it("walks the calendar rather than adding 86,400,000 — the day the clocks change is still one day", () => {
    // US DST forward, 2026-03-08: 02:00 does not exist. A daily 09:00 must still be 09:00 on the
    // 8th, which fixed-length arithmetic gets wrong by an hour. Asserted on the local wall clock,
    // so the test says the same thing in every zone that observes a change here and passes trivially
    // in one that does not.
    const next = nextFireOf("0 9 * * *", at(2026, 3, 7, 12))!;
    const d = new Date(next);
    expect([d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2, 8, 9, 0]);
  });

  it("every fire it reports actually matches", () => {
    // The two functions are separate implementations of the same predicate; this is what keeps the
    // fast-skip in `nextCronFire` honest against the plain check in `matchesCron`.
    for (const expr of ["0 9 * * *", "*/15 * * * *", "0 9 1 * 1", "0 0-23/6 * * 1-5", "30 2 29 2 *"]) {
      const cron = parseCron(expr)!;
      let t = at(2026, 1, 1);
      for (let i = 0; i < 5; i++) {
        const next = nextCronFire(cron, t);
        if (next === null) break;
        expect(matchesCron(cron, next), `${expr} @ ${new Date(next)}`).toBe(true);
        t = next;
      }
    }
  });
});

describe("describeCron", () => {
  it("reads back the shapes the picker itself writes", () => {
    expect(describeCron("0 9 * * *")).toBe("Every day at 09:00");
    expect(describeCron("0 9 * * 1-5")).toBe("Weekdays at 09:00");
    expect(describeCron("30 17 * * 1")).toBe("Monday at 17:30");
    expect(describeCron("0 9 1 * *")).toBe("Day 1 of each month at 09:00");
    expect(describeCron("15 * * * *")).toBe("Every hour at :15");
  });

  it("shows the expression itself rather than a subtly wrong sentence", () => {
    // A general cron-to-prose translator gets the gnarly cases wrong, and a wrong description of
    // when unattended work runs is worse than the expression the user typed.
    expect(describeCron("0 9,17 * 3-5 2")).toBe("0 9,17 * 3-5 2");
    expect(describeCron("not a cron")).toBe("not a cron");
  });
});
