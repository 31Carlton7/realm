import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MachineMemory, ResourceReport } from "@realm/contracts";
import { advice, createMachineStatusTools, heavyWork, testWorkers } from "./agent-tools";
import type { ProcRow } from "./machine";

const GB = 1024 ** 3, MB = 1024 ** 2;
const machine = (o: Partial<MachineMemory> = {}): MachineMemory => ({ totalBytes: 24 * GB, availablePercent: 45, pressure: "normal", pressureWhy: null, swap: { usedBytes: 2 * GB, totalBytes: 8 * GB }, compressedBytes: GB, swapOutPerSecond: 0, load: [3, 3, 3], cpus: 14, ...o });
const proc = (pid: number, command: string): ProcRow => ({ pid, ppid: 1, tty: null, residentBytes: MB, startedAt: 0, command });
const report = (o: Partial<ResourceReport> = {}): ResourceReport => ({
  at: 0, measure: "footprint", machine: machine(), realm: { processes: 3, residentBytes: GB, footprintBytes: 3 * GB }, categories: [], others: [],
  parts: [
    { id: "simulators:U", category: "simulators", ownerId: "U", label: "Persona Onboarding", detail: "Booted by Realm", processes: 177, residentBytes: GB, footprintBytes: 9 * GB },
    { id: "engines:me", category: "engines", ownerId: "me", label: "Fix the sidebar", detail: "Working", processes: 2, residentBytes: 300 * MB, footprintBytes: 400 * MB },
  ],
  ...o,
});
const text = (r: CallToolResult) => r.content.map((c) => (c as { text: string }).text).join("\n");

describe("machine_status", () => {
  it("says how short the Mac is, what of Realm's is heavy — this session's own marked — and what to do", async () => {
    const g = createMachineStatusTools({
      report: async () => report({ machine: machine({ pressure: "warn", pressureWhy: "Swapping out 12 MB a second", load: [30, 20, 10] }), others: [{ name: "Google Chrome", processes: 60, residentBytes: 3 * GB, footprintBytes: 12 * GB }] }),
      processes: async () => [proc(1, "node /repo/node_modules/.bin/vitest run"), proc(2, "node /repo/node_modules/vitest/dist/workers/forks.js"), proc(3, "/bin/zsh -l")],
      inSpace: (p, spaceId) => spaceId === "s",
    });
    const out = text(await g.handlers.machine_status!({ sessionId: "me", spaceId: "s" }, {}));
    expect(out).toContain("Memory pressure: warn — Swapping out 12 MB a second");
    expect(out).toContain("- 9.0 GB — Simulators: Persona Onboarding — Booted by Realm");
    expect(out).toContain("- 400 MB — Engines: Fix the sidebar (this session) — Working");
    expect(out).toContain("- vitest: 2 processes");
    expect(out).toContain("1 app, 12 GB in all");
    expect(out).toContain("at most 2 workers (vitest --maxWorkers=2");
    expect(out).toContain("Never run two full suites or builds at once");
    expect(out).toContain("oversubscribed (load 30.0 on 14 cores)");
  });

  it("names only this space's parts; another space's, and other apps, are counts and sizes", async () => {
    // A no-prompt read: THE MUTANT is the whole report, which puts another space's session title and a
    // title some web page wrote into this agent's context without anyone being asked.
    const g = createMachineStatusTools({
      report: async () => report({
        parts: [
          { id: "engines:me", category: "engines", ownerId: "me", label: "Fix the sidebar", detail: "Working", processes: 2, residentBytes: 300 * MB, footprintBytes: 400 * MB },
          { id: "engines:x", category: "engines", ownerId: "x", label: "Draft the divorce filing", detail: "Idle 3 min", processes: 1, residentBytes: 200 * MB, footprintBytes: 300 * MB },
          { id: "browsers:b", category: "browsers", ownerId: "b", label: "Chase — Account summary", detail: "Hidden 4 min", processes: 1, residentBytes: 100 * MB, footprintBytes: 150 * MB },
          { id: "app:1", category: "app", ownerId: null, label: "Personal", detail: null, processes: 1, residentBytes: 100 * MB, footprintBytes: 200 * MB },
        ],
        others: [{ name: "Signal", processes: 3, residentBytes: GB, footprintBytes: GB }, { name: "Slack", processes: 9, residentBytes: GB, footprintBytes: 2 * GB }],
      }),
      processes: async () => [],
      inSpace: (p, spaceId) => spaceId === "s" && p.ownerId === "me",
    });
    const out = text(await g.handlers.machine_status!({ sessionId: "me", spaceId: "s" }, {}));
    expect(out).toContain("- 400 MB — Engines: Fix the sidebar (this session) — Working");
    for (const secret of ["Draft the divorce filing", "Chase", "Personal", "Signal", "Slack"]) expect(out, secret).not.toContain(secret);
    expect(out).toContain("- 300 MB — Engines: 1");
    expect(out).toContain("- 200 MB — Realm's windows: 1");
    expect(out).toContain("- 150 MB — Browser panes: 1");
    expect(out).toContain("2 apps, 3.0 GB in all");
    // Without a way to tell, nothing is named at all.
    const blind = createMachineStatusTools({ report: async () => report(), processes: async () => [] });
    const none = text(await blind.handlers.machine_status!({ sessionId: "me", spaceId: "s" }, {}));
    expect(none).toContain("Nothing of this space's is running.");
    expect(none).not.toContain("Persona Onboarding");
  });

  it("on a system whose processes Realm does not read, says so rather than that Realm holds nothing", async () => {
    // Windows: no `ps`, and a load average Node reads as zeros.
    const g = createMachineStatusTools({ report: async () => report({ measure: "none", parts: [], machine: machine({ pressure: "unknown", load: [0, 0, 0] }) }), processes: async () => [], machine: "computer" });
    const out = text(await g.handlers.machine_status!({ sessionId: "me", spaceId: "s" }, {}));
    expect(out.startsWith("# This computer right now")).toBe(true);
    expect(out).toContain("Realm does not read this system's processes");
    expect(out).not.toContain("Realm in all");
    expect(out).not.toContain("Load:");
  });

  it("refuses arguments it does not take", async () => {
    const g = createMachineStatusTools({ report: async () => report(), processes: async () => [] });
    expect((await g.handlers.machine_status!({ sessionId: "me", spaceId: "s" }, { verbose: true })).isError).toBe(true);
  });
});

describe("its advice", () => {
  it("tells an agent to wait when memory is critical, and to use fewer workers when it is short", () => {
    expect(advice({ machine: machine({ pressure: "critical" }), heavy: [], report: report() })[0]).toMatch(/^Memory is critically short\. Do not start a build/);
    expect(advice({ machine: machine({ pressure: "warn" }), heavy: [], report: report() })[0]).toMatch(/^Memory is short\. Run only the tests that cover your change, with at most 2 workers/);
    expect(advice({ machine: machine(), heavy: [], report: report() })[0]).toBe("Memory is fine. Builds and test runs are OK; 7 test workers is plenty on 14 cores.");
  });

  it("says nothing about workers it cannot judge, and nothing of swap that has room", () => {
    const a = advice({ machine: machine({ pressure: "unknown" }), heavy: [], report: report({ parts: [] }) });
    expect(a.some((l) => /workers|Memory is/.test(l))).toBe(false);
    expect(a.some((l) => /Swap is/.test(l))).toBe(false);
    expect(advice({ machine: machine({ swap: { usedBytes: 19 * GB, totalBytes: 20 * GB } }), heavy: [], report: report() }).some((l) => l.startsWith("Swap is 95% full"))).toBe(true);
  });

  it("counts a full suite or build already running, whoever started it, and nothing else", () => {
    expect(heavyWork([proc(1, "/usr/bin/xcodebuild test -scheme App"), proc(2, "node vitest run"), proc(3, "/opt/homebrew/bin/tsc -p ."), proc(4, "/bin/zsh -l"), proc(5, "/usr/bin/xcodebuildx")]))
      .toEqual([{ name: "xcodebuild", processes: 1 }, { name: "vitest", processes: 1 }, { name: "tsc", processes: 1 }]);
    // A typecheck is heavy work but not a suite: it is listed, and does not say "never two suites".
    expect(advice({ machine: machine(), heavy: [{ name: "tsc", processes: 1 }], report: report() }).some((l) => l.includes("Never run two"))).toBe(false);
  });

  it("never sends more workers than the Mac's cores can carry", () => {
    expect(testWorkers(machine({ cpus: 2, pressure: "warn" }))).toBe(1);
    expect(testWorkers(machine({ cpus: 4 }))).toBe(2);
    expect(testWorkers(machine({ pressure: "critical" }))).toBe(1);
  });
});
