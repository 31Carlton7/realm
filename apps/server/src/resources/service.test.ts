import { afterEach, describe, expect, it, vi } from "vitest";
import type { MachineMemory, MemoryPressure } from "@realm/contracts";
import { APP_METRICS_TIMEOUT_MS, OTHERS_TTL_MS, PRESSURE_EVERY_MS, ResourceService, SNAPSHOT_TTL_MS } from "./service";
import type { MachineProbe, ProcRow } from "./machine";
import type { Owners } from "./attribute";

const MB = 1024 ** 2;
const row = (pid: number, ppid: number, mb: number, command: string): ProcRow => ({ pid, ppid, tty: null, residentBytes: mb * MB, startedAt: 0, command });

/** A machine whose table, footprints and pressure the test sets, and which counts what it was asked. */
function fakeMachine(o: { table?: ProcRow[]; pressure?: () => MemoryPressure } = {}) {
  const asked = { processes: 0, footprints: [] as number[][], all: 0, memory: 0 };
  const probe: MachineProbe = {
    processes: async () => { asked.processes++; return o.table ?? [row(1, 0, 10, "/sbin/launchd"), row(50, 1, 100, "realm-server"), row(51, 50, 30, "/usr/bin/git status"), row(60, 1, 200, "/Applications/Slack.app/Contents/MacOS/Slack")]; },
    footprints: async (pids) => { asked.footprints.push([...pids].sort((a, b) => a - b)); return new Map(pids.map((p) => [p, 1 * MB])); },
    allFootprints: async () => { asked.all++; return new Map([[60, 900 * MB]]); },
    memory: async (prev) => {
      asked.memory++;
      const memory: MachineMemory = { totalBytes: 24 * 1024 * MB, availablePercent: 40, pressure: o.pressure?.() ?? "normal", pressureWhy: null, swap: null, compressedBytes: null, swapOutPerSecond: prev ? 0 : null, load: [1, 1, 1], cpus: 8 };
      return { memory, counters: { at: Date.now(), swapouts: 0 } };
    },
  };
  return { probe, asked };
}

const owners = (): Omit<Owners, "app" | "serverPid"> => ({ engines: [], terminals: [], mcp: [], laya: null, simulators: [] });

afterEach(() => { vi.useRealTimers(); });

describe("the resource report", () => {
  it("reads footprints for Realm's own processes only, and other apps from one sample", async () => {
    const { probe, asked } = fakeMachine();
    const s = new ResourceService({ probe, owners, app: async () => null, serverPid: 50 });
    const r = await s.snapshot();
    // THE MUTANT: footprinting the whole table — a second of system time per report on a Mac with
    // fourteen hundred processes, for numbers the report then only shows by name.
    expect(asked.footprints).toEqual([[50, 51]]);
    expect(r.realm).toEqual({ processes: 2, residentBytes: 130 * MB, footprintBytes: 2 * MB });
    expect(r.measure).toBe("footprint");
    expect(r.others.find((x) => x.name === "Slack")).toMatchObject({ footprintBytes: 900 * MB });
  });

  it("is read at most every few seconds however often it is asked, and once at a time", async () => {
    vi.useFakeTimers();
    const { probe, asked } = fakeMachine();
    const s = new ResourceService({ probe, owners, app: async () => null, serverPid: 50 });
    const [a, b] = await Promise.all([s.snapshot(), s.snapshot()]);
    expect(a).toBe(b);
    expect(asked.processes).toBe(1);
    await s.snapshot();
    expect(asked.processes).toBe(1);
    vi.advanceTimersByTime(SNAPSHOT_TTL_MS + 1);
    await s.snapshot();
    expect(asked.processes).toBe(2);
    // `fresh` is a page that just changed something.
    await s.snapshot({ fresh: true });
    expect(asked.processes).toBe(3);
  });

  it("samples other apps at most once a minute", async () => {
    vi.useFakeTimers();
    const { probe, asked } = fakeMachine();
    const s = new ResourceService({ probe, owners, app: async () => null, serverPid: 50 });
    await s.snapshot();
    vi.advanceTimersByTime(SNAPSHOT_TTL_MS + 1);
    await s.snapshot();
    expect(asked.all).toBe(1);
    vi.advanceTimersByTime(OTHERS_TTL_MS);
    await s.snapshot();
    expect(asked.all).toBe(2);
  });

  it("goes out without the app's processes when the app does not answer in time", async () => {
    vi.useFakeTimers();
    const { probe } = fakeMachine({ table: [row(100, 1, 300, "/Applications/Realm.app/Contents/MacOS/Realm"), row(50, 1, 100, "server")] });
    const s = new ResourceService({ probe, owners, app: () => new Promise(() => {}), serverPid: 50 });
    const pending = s.snapshot();
    await vi.advanceTimersByTimeAsync(APP_METRICS_TIMEOUT_MS + 1);
    const r = await pending;
    expect(r.parts.map((p) => p.category)).toEqual(["server"]);
    expect(r.others.map((o) => o.name)).toContain("Realm");
  });

  it("counts the app's processes as main names them", async () => {
    const { probe } = fakeMachine({ table: [row(100, 1, 300, "/Applications/Realm.app/Contents/MacOS/Realm"), row(101, 100, 900, "Realm Helper (GPU)"), row(50, 100, 100, "server")] });
    const s = new ResourceService({ probe, owners, serverPid: 50, app: async () => [
      { pid: 100, kind: "main", label: "Realm", ownerId: null, detail: null },
      { pid: 101, kind: "gpu", label: "GPU", ownerId: null, detail: null },
    ] });
    const r = await s.snapshot();
    expect(r.categories.find((c) => c.category === "app")).toMatchObject({ processes: 2 });
  });
});

describe("pressure", () => {
  it("is read every half minute once started, and stops when closed", async () => {
    vi.useFakeTimers();
    const { probe, asked } = fakeMachine();
    const s = new ResourceService({ probe, owners, app: async () => null });
    expect(s.pressure()).toBe("unknown");
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(asked.memory).toBe(1);
    expect(s.pressure()).toBe("normal");
    await vi.advanceTimersByTimeAsync(PRESSURE_EVERY_MS);
    expect(asked.memory).toBe(2);
    s.close();
    await vi.advanceTimersByTimeAsync(PRESSURE_EVERY_MS * 3);
    expect(asked.memory).toBe(2);
  });

  it("tells its listeners when the level changes, and only then", async () => {
    let level: MemoryPressure = "normal";
    const { probe } = fakeMachine({ pressure: () => level });
    const s = new ResourceService({ probe, owners, app: async () => null });
    const heard: MemoryPressure[] = [];
    s.onPressure((p) => heard.push(p));
    await s.machine();
    await s.machine();
    level = "warn";
    await s.machine();
    await s.machine();
    level = "normal";
    await s.machine();
    expect(heard).toEqual(["normal", "warn", "normal"]);
  });
});
