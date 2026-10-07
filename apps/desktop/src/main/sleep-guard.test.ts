import { describe, expect, it } from "vitest";
import { SleepGuard, type PowerBlocker } from "./sleep-guard";

function blocker() {
  const log: string[] = [];
  let next = 1;
  const b: PowerBlocker = {
    start: (type) => { log.push(`start:${type}`); return next++; },
    stop: (id) => { log.push(`stop:${id}`); },
  };
  return { b, log };
}

describe("keeping the Mac awake while agents work", () => {
  it("holds the app-suspension blocker only while the preference is on AND a session is working", () => {
    const { b, log } = blocker();
    const g = new SleepGuard(b);
    g.setWorking(2);
    // THE always-on mutant: hold it for any working session, whatever the user chose.
    expect(log).toEqual([]);
    g.setPreference(true);
    expect(log).toEqual(["start:prevent-app-suspension"]);
    expect(g.holding).toBe(true);
  });

  it("lets go the moment the last turn ends, and takes it again for the next one", () => {
    const { b, log } = blocker();
    const g = new SleepGuard(b);
    g.setPreference(true);
    g.setWorking(1);
    g.setWorking(0);
    // THE sticky mutant: never release, and a Mac that ran one agent at lunch is awake all night.
    expect(log).toEqual(["start:prevent-app-suspension", "stop:1"]);
    g.setWorking(3);
    expect(log.at(-1)).toBe("start:prevent-app-suspension");
  });

  it("holds once however many updates arrive, so one stop always releases it", () => {
    const { b, log } = blocker();
    const g = new SleepGuard(b);
    g.setPreference(true);
    for (const n of [1, 2, 3, 2, 1]) g.setWorking(n);
    // THE leaking mutant: start on every update, and the stop that follows releases only the last.
    expect(log.filter((l) => l.startsWith("start"))).toHaveLength(1);
    g.setPreference(false);
    expect(log.at(-1)).toBe("stop:1");
    expect(g.holding).toBe(false);
  });

  it("reads a count it cannot trust as nothing working", () => {
    const { b, log } = blocker();
    const g = new SleepGuard(b);
    g.setPreference(true);
    for (const junk of [Number.NaN, -2, Number.POSITIVE_INFINITY]) g.setWorking(junk);
    expect(log).toEqual([]);
  });
});
