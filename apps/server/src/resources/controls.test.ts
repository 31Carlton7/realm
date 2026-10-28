import { describe, expect, it } from "vitest";
import type { ResourceReport } from "@realm/contracts";
import { ResourceControls } from "./controls";

const MB = 1024 ** 2;
const part = (category: ResourceReport["parts"][number]["category"], ownerId: string | null, mb: number, detail: string | null = null): ResourceReport["parts"][number] =>
  ({ id: `${category}:${ownerId}`, category, ownerId, label: ownerId ?? "", detail, processes: 1, residentBytes: mb * MB, footprintBytes: mb * MB });

const REPORT: ResourceReport = {
  at: 0, measure: "footprint", others: [], categories: [],
  machine: { totalBytes: 0, availablePercent: null, pressure: "normal", pressureWhy: null, swap: null, compressedBytes: null, swapOutPerSecond: null, load: [0, 0, 0], cpus: 1 },
  realm: { processes: 0, residentBytes: 0, footprintBytes: 0 },
  parts: [
    part("engines", "s-idle", 300), part("engines", "s-working", 500, "Working"),
    part("simulators", "SIM-A", 9000), part("simulators", "SIM-SHOWN", 8000),
    part("browsers", "b-hidden", 400, "Hidden 30 min"), part("browsers", "b-on", 350, "On screen"),
    part("laya", "laya", 2400),
  ],
};

function setup(o: { stoppable?: boolean; attached?: boolean } = {}) {
  const settings = new Map<string, unknown>();
  const calls: string[] = [];
  const c = new ResourceControls({
    settings: { get: (k) => settings.get(k), set: (k, v) => { settings.set(k, v); } },
    snapshot: async () => REPORT,
    adapt: (m) => Math.min(m, 10),
    engines: { idleEngines: () => ["s-idle"], stopIdleNow: async () => { calls.push("engines"); return ["s-idle"]; } },
    simulators: { idleCandidates: () => ["SIM-A"], sweepIdle: async (x) => { calls.push(`simulators:${x.minutes}`); return ["SIM-A"]; } },
    laya: { stoppable: () => o.stoppable ?? true, stopIdle: async () => { calls.push("laya"); return true; }, idleChanged: () => calls.push("laya-window") },
    browsers: () => (o.attached === false ? null : { call: async (_op, p) => { calls.push(`browsers:${p.hiddenMs}:${p.keepHidden}`); return { discarded: ["b-hidden"], kept: [] }; } }),
  });
  return { c, calls, settings };
}

describe("the Memory page's controls", () => {
  it("say what each button would let go of, counting only what is idle", async () => {
    const { c } = setup();
    expect((await c.snapshot()).freeable).toEqual({
      engines: { count: 1, bytes: 300 * MB },
      simulators: { count: 1, bytes: 9000 * MB },
      browsers: { count: 1, bytes: 400 * MB },
      laya: { count: 1, bytes: 2400 * MB },
    });
    // Laya mid-question, or in Assist: not something the button may stop.
    expect((await setup({ stoppable: false }).c.snapshot()).freeable!.laya).toEqual({ count: 0, bytes: 0 });
  });

  it("show the windows as set and as memory pressure leaves them, defaults first", () => {
    const { c } = setup();
    expect(c.policies()).toEqual({
      engineIdleMinutes: 30, mcpIdleMinutes: 30, layaIdleMinutes: 10, simulatorIdleMinutes: 30, browserHiddenMinutes: 20, browserKeepHidden: 3, adaptive: true,
      effective: { engines: 10, mcp: 10, laya: 10, simulators: 10, browsers: 10 },
    });
  });

  it("write a window or the switch, refuse anything else, and re-arm Laya's own timer", () => {
    const { c, calls, settings } = setup();
    expect(c.setPolicy("sessions.engineIdleMinutes", 60).engineIdleMinutes).toBe(60);
    expect(settings.get("sessions.engineIdleMinutes")).toBe(60);
    expect(c.setPolicy("resources.adaptive", false).adaptive).toBe(false);
    expect(() => c.setPolicy("mcp.idleStopMinutes", true)).toThrow(/whole number/);
    expect(() => c.setPolicy("resources.adaptive", 5)).toThrow(/on or off/);
    c.setPolicy("laya.idleStopMinutes", 0);
    expect(calls.filter((x) => x === "laya-window")).toHaveLength(2);
  });

  it("free memory with each button through the policy's own rules, skipping only the wait", async () => {
    const { c, calls } = setup();
    expect(await c.free("engines")).toEqual({ freed: 1 });
    expect(await c.free("simulators")).toEqual({ freed: 1 });
    expect(await c.free("browsers")).toEqual({ freed: 1 });
    expect(await c.free("laya")).toEqual({ freed: 1 });
    expect(calls).toEqual(["engines", "simulators:0", "browsers:0:0", "laya"]);
    expect(await setup({ attached: false }).c.free("browsers")).toEqual({ freed: 0 });
  });
});
