import { describe, expect, it } from "vitest";
import type { Schedule } from "@realm/contracts";
import { createAppStore } from "./store";
import { fakeApi, runRow, type FakeData } from "./store.test-fakes";

const boot = async (overrides: FakeData = {}) => {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  return { api, store };
};

const task: Pick<Schedule, "id" | "spaceId"> = { id: "sch1", spaceId: "s1" };
const ran = (id: string, createdAt: number) => runRow(id, "s1", { scheduleId: "sch1", createdAt, state: "succeeded" });

describe("store — a scheduled task's runs", () => {
  it("holds a task's first page of runs, newest first, and pages the rest in behind it", async () => {
    const runs = Array.from({ length: 12 }, (_, i) => ran(`r${String(i).padStart(2, "0")}`, 100 + i));
    const { store } = await boot({ runs: { s1: [...runs, runRow("manual", "s1", { createdAt: 500 })] } });
    await store.getState().refreshScheduleRuns(task);
    const first = store.getState().scheduleRuns.sch1!;
    expect(first.runs.map((r) => r.id).slice(0, 2)).toEqual(["r11", "r10"]);
    expect(first.runs).toHaveLength(10);
    // A run started by hand is not this task's history, however recent it is.
    expect(first.runs.some((r) => r.id === "manual")).toBe(false);
    await store.getState().loadOlderScheduleRuns(task);
    expect(store.getState().scheduleRuns.sch1!.runs.map((r) => r.id).slice(-2)).toEqual(["r01", "r00"]);
    expect(store.getState().scheduleRuns.sch1!.nextCursor).toBeNull();
  });

  it("folds a run the scheduler fires into its task's held history, without a refetch", async () => {
    // THE MUTANT: leave `applyRunsChanged` to the Tasks lens alone. A run fired on the clock while the
    // page is open would then not appear under its task until the page was opened again.
    const { api, store } = await boot({ runs: { s1: [ran("r1", 100)] } });
    await store.getState().refreshScheduleRuns(task);
    const listed = api.calls.filter((c) => c.startsWith("listScheduleRuns")).length;
    store.getState().applyRunsChanged({ spaceId: "s1", run: ran("r2", 200) });
    expect(store.getState().scheduleRuns.sch1!.runs.map((r) => r.id)).toEqual(["r2", "r1"]);
    // …and a later change to the same run replaces it in place.
    store.getState().applyRunsChanged({ spaceId: "s1", run: { ...ran("r2", 200), state: "failed" } });
    expect(store.getState().scheduleRuns.sch1!.runs.map((r) => [r.id, r.state])).toEqual([["r2", "failed"], ["r1", "succeeded"]]);
    expect(api.calls.filter((c) => c.startsWith("listScheduleRuns")).length).toBe(listed);
  });

  it("leaves a task nobody has asked about alone", async () => {
    const { store } = await boot();
    store.getState().applyRunsChanged({ spaceId: "s1", run: ran("r1", 100) });
    expect(store.getState().scheduleRuns.sch1).toBeUndefined();
  });
});
