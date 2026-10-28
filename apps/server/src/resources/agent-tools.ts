import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { RESOURCE_CATEGORY_LABEL, type MachineMemory, type ResourceReport } from "@realm/contracts";
import { ok, parseArgs } from "../mcp/tool-result";
import type { WorkspaceToolGroup } from "../workspace/agent-tools";
import type { ProcRow } from "./machine";

/**
 * `machine_status`: how much this Mac has to spare, what of Realm's is heavy, and what to do about it —
 * the question an agent should ask before it starts a build, a full test suite or a simulator, and
 * which it otherwise answers by guessing. On this Mac, four agents each running a full suite at once
 * drove the load average to 157–482 with 20 GB in swap; every one of them would have been told to wait.
 *
 * Read-only and promptless: sizes and names, never a process's arguments, its environment or another
 * app's anything beyond its name and size.
 */

/** Work that takes a machine's memory and cores while it runs, by the name an agent knows it by. */
const HEAVY: readonly (readonly [string, RegExp])[] = [
  ["vitest", /\bvitest\b/],
  ["jest", /\bjest\b/],
  ["xcodebuild", /(^|\/)xcodebuild(\s|$)/],
  ["swift build or test", /\bswift-(build|test)\b/],
  ["tsc", /(^|\/)tsc(\s|$)|typescript\/bin\/tsc\b/],
  ["next build", /\bnext build\b/],
  ["webpack", /\bwebpack\b/],
  ["cargo", /\bcargo (build|test|run)\b/],
  ["pytest", /\bpytest\b/],
  ["gradle", /\bgradle(w)?\b/],
  ["electron-builder", /\belectron-builder\b/],
];

/** Every heavy job on the Mac, by kind and how many processes it has — whoever started it. */
export function heavyWork(table: readonly ProcRow[]): { name: string; processes: number }[] {
  const counts = new Map<string, number>();
  for (const p of table) {
    const hit = HEAVY.find(([, re]) => re.test(p.command));
    if (hit) counts.set(hit[0], (counts.get(hit[0]) ?? 0) + 1);
  }
  return [...counts].map(([name, processes]) => ({ name, processes })).sort((a, b) => b.processes - a.processes);
}

/** How many test workers the Mac can take right now: a quarter of its cores, fewer when memory is short. */
export function testWorkers(m: MachineMemory): number {
  if (m.pressure === "critical") return 1;
  if (m.pressure === "warn") return Math.max(1, Math.min(2, Math.floor(m.cpus / 4)));
  return Math.max(2, Math.floor(m.cpus / 2));
}

const gb = (bytes: number): string => {
  const g = bytes / 1024 ** 3;
  return g >= 1 ? `${g >= 10 ? Math.round(g) : (Math.round(g * 10) / 10).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
};
const size = (s: { footprintBytes: number | null; residentBytes: number }) => s.footprintBytes ?? s.residentBytes;

/** What to do, in the order it matters. Pure, so each sentence is a decision a test can hold. */
export function advice(o: { machine: MachineMemory; heavy: { name: string; processes: number }[]; report: ResourceReport }): string[] {
  const { machine: m, heavy, report } = o;
  const out: string[] = [];
  const workers = testWorkers(m);
  if (m.pressure === "critical") {
    out.push("Memory is critically short. Do not start a build, a full test suite or a simulator now: finish or stop what is running first, then check again.");
  } else if (m.pressure === "warn") {
    out.push(`Memory is short. Run only the tests that cover your change, with at most ${workers} worker${workers === 1 ? "" : "s"} (vitest --maxWorkers=${workers}, jest -w ${workers}; xcodebuild -parallel-testing-enabled NO).`);
  } else if (m.pressure === "normal") {
    out.push(`Memory is fine. Builds and test runs are OK; ${workers} test workers is plenty on ${m.cpus} cores.`);
  }
  if (m.load[0] > m.cpus * 1.5) out.push(`The CPUs are oversubscribed (load ${m.load[0].toFixed(1)} on ${m.cpus} cores): wait for running work to finish, or use fewer workers.`);
  const suites = heavy.filter((h) => h.name === "vitest" || h.name === "jest" || h.name === "xcodebuild" || h.name === "pytest" || h.name === "cargo" || h.name === "gradle");
  if (suites.length > 0) {
    out.push(`Already running on this Mac: ${suites.map((h) => `${h.name} (${h.processes} process${h.processes === 1 ? "" : "es"})`).join(", ")}. Never run two full suites or builds at once on one machine — run targeted tests, or wait.`);
  }
  if (m.swap && m.swap.totalBytes > 0 && m.swap.usedBytes / m.swap.totalBytes > 0.8) out.push(`Swap is ${Math.round((m.swap.usedBytes / m.swap.totalBytes) * 100)}% full: anything new will page.`);
  const sims = report.parts.filter((p) => p.category === "simulators");
  if (sims.length > 0) out.push(`${sims.length} simulator${sims.length === 1 ? " Realm booted is" : "s Realm booted are"} running (${gb(sims.reduce((n, p) => n + size(p), 0))}): reuse a booted one rather than booting another, and shut down any you booted once you are done (\`xcrun simctl shutdown <udid>\`).`);
  out.push("Stop dev servers and watchers you started when you no longer need them, and kill any process you started that outlived its parent (`ps -axo pid,ppid,etime,command` shows them under ppid 1). Never touch a process you did not start.");
  return out;
}

const TOOLS: Tool[] = [{
  name: "machine_status",
  description:
    "How much memory, swap and CPU this Mac has to spare right now, what of Realm's is using it (engines, simulators, browser panes, Laya, terminals), what heavy work is already running, and what to do about it. Call it before a build, a full test suite or booting a simulator, and follow its advice: when memory is short it says how many test workers to use and to run one suite at a time. Read-only.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
}];

export function createMachineStatusTools(d: {
  /** The report, with Realm's parts and the Mac's memory; read fresh. */
  report: () => Promise<ResourceReport>;
  /** The process table, for the heavy work already running. */
  processes: () => Promise<ProcRow[]>;
}): WorkspaceToolGroup {
  return {
    tools: TOOLS,
    handlers: {
      machine_status: async (ctx, raw) => {
        const args = parseArgs(z.object({}).strict(), raw); if ("error" in args) return args.error;
        const [report, table] = await Promise.all([d.report(), d.processes()]);
        const m = report.machine;
        const lines = ["# This Mac right now", ""];
        lines.push(`Memory pressure: ${m.pressure}${m.pressureWhy ? ` — ${m.pressureWhy}` : ""}`);
        lines.push([
          m.totalBytes > 0 ? `RAM ${gb(m.totalBytes)}` : null,
          m.availablePercent !== null ? `${m.availablePercent}% available` : null,
          m.swap ? `swap ${gb(m.swap.usedBytes)} of ${gb(m.swap.totalBytes)} in use` : null,
          m.compressedBytes !== null ? `${gb(m.compressedBytes)} compressed` : null,
        ].filter(Boolean).join(" · "));
        lines.push(`Load: ${m.load.map((l) => l.toFixed(1)).join(" / ")} on ${m.cpus} cores`);
        lines.push("", `## Realm's heaviest (${report.measure}; Realm in all: ${gb(size(report.realm))})`);
        const parts = report.parts.slice(0, 10);
        lines.push(...(parts.length > 0
          ? parts.map((p) => `- ${gb(size(p))} — ${RESOURCE_CATEGORY_LABEL[p.category]}: ${p.label}${p.ownerId === ctx.sessionId ? " (this session)" : ""}${p.detail ? ` — ${p.detail}` : ""}`)
          : ["Nothing measured."]));
        const heavy = heavyWork(table);
        if (heavy.length > 0) lines.push("", "## Heavy work running on this Mac (anyone's)", ...heavy.map((h) => `- ${h.name}: ${h.processes} process${h.processes === 1 ? "" : "es"}`));
        if (report.others.length > 0) lines.push("", "## Other apps (not Realm's; never touch them)", report.others.slice(0, 6).map((o) => `${o.name} ${gb(size(o))}`).join(", "));
        lines.push("", "## Advice", ...advice({ machine: m, heavy, report }).map((a) => `- ${a}`));
        return ok(lines.join("\n"));
      },
    },
  };
}
