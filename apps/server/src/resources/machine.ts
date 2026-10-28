import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cpus, loadavg, totalmem } from "node:os";
import type { MachineMemory, MemoryPressure } from "@realm/contracts";

/**
 * Reading this Mac's processes and memory, and nothing more: no attribution here, and nothing that
 * acts. `attribute.ts` decides what each process is for; `service.ts` decides when to look.
 *
 * **The method, because the obvious one is wrong.** `ps`'s RSS is resident memory — the pages in RAM
 * this instant. A process macOS has compressed or swapped out reads SMALL exactly when it is costing
 * the most: measured here, a Claude engine with 360 MB resident had a 375 MB footprint, but Chrome
 * renderers showed 60 MB resident against 500 MB footprints, the rest sitting in the compressor and
 * a 20 GB swap file. So every size Realm reports is the process's `phys_footprint` — its dirty memory
 * wherever it lives, which is what Activity Monitor's Memory column shows — read with `footprint(1)`
 * for Realm's own processes (about 10 ms each, no privileges needed for your own) and with one
 * `top -l 1` sample for everyone else (about a second, so it is kept for a minute). RSS is kept beside
 * it, and stands in for it where a platform has no footprint to read.
 *
 * Pressure is macOS's own level (`kern.memorystatus_vm_pressure_level`), lifted to `warn` when the Mac
 * is swapping out between two readings: macOS stayed green on this Mac with 19 of 20 GB of swap in use
 * and load averages in the hundreds, which is not a Mac with memory to spare.
 */

/** One row of the process table. */
export type ProcRow = {
  pid: number;
  ppid: number;
  /** The terminal it is attached to, as `ps` names it (`ttys012`, `pts/3`); null for none. */
  tty: string | null;
  residentBytes: number;
  /** When it started, to the second; null when `ps` said something this could not read. */
  startedAt: number | null;
  command: string;
};

/** `ps -A -ww -o pid=,ppid=,tty=,rss=,lstart=,command=`. `lstart` is five words (`Tue Oct 27 02:08:07 2026`). */
export function parsePs(stdout: string): ProcRow[] {
  const out: ProcRow[] = [];
  const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;
  for (const line of stdout.split("\n")) {
    const m = row.exec(line);
    if (!m) continue;
    const started = Date.parse(m[5]!.replace(/\s+/g, " "));
    out.push({
      pid: Number(m[1]), ppid: Number(m[2]),
      tty: m[3] === "??" || m[3] === "?" || m[3] === "-" ? null : m[3]!,
      residentBytes: Number(m[4]) * 1024,
      startedAt: Number.isFinite(started) ? started : null,
      command: m[6]!.trim(),
    });
  }
  return out;
}

/** `footprint --noCategories -f bytes -p … -p …`: one `name [pid]: … Footprint: N B` line per process. */
export function parseFootprint(stdout: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const m of stdout.matchAll(/\[(\d+)\]:[^\n]*?Footprint:\s*(\d+)\s*B/g)) out.set(Number(m[1]), Number(m[2]));
  return out;
}

const UNIT: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** `top -l 1 -stats pid,mem`: the MEM column is the footprint, in top's own short units (`101M`, `4592K`). */
export function parseTop(stdout: string): Map<number, number> {
  const out = new Map<number, number>();
  let table = false;
  for (const line of stdout.split("\n")) {
    if (/^\s*PID\s+MEM\b/.test(line)) { table = true; continue; }
    if (!table) continue;
    const m = /^\s*(\d+)\s+([\d.]+)([BKMGT])[+-]?\s*$/.exec(line);
    if (m) out.set(Number(m[1]), Math.round(Number(m[2]) * UNIT[m[3]!]!));
  }
  return out;
}

/** `sysctl hw.memsize kern.memorystatus_vm_pressure_level kern.memorystatus_level vm.swapusage`, by name. */
export function parseSysctl(stdout: string): { totalBytes: number | null; level: number | null; availablePercent: number | null; swap: { usedBytes: number; totalBytes: number } | null } {
  const val = (name: string): string | null => new RegExp(`^${name.replace(/\./g, "\\.")}:\\s*(.+)$`, "m").exec(stdout)?.[1]?.trim() ?? null;
  const num = (name: string): number | null => { const v = val(name); return v !== null && /^\d+$/.test(v) ? Number(v) : null; };
  const swapLine = val("vm.swapusage");
  const mb = (key: string): number | null => {
    const m = swapLine ? new RegExp(`${key}\\s*=\\s*([\\d.]+)([KMGT])`).exec(swapLine) : null;
    return m ? Math.round(Number(m[1]) * UNIT[m[2]!]!) : null;
  };
  const used = mb("used"), total = mb("total");
  const available = num("kern.memorystatus_level");
  return {
    totalBytes: num("hw.memsize"),
    level: num("kern.memorystatus_vm_pressure_level"),
    availablePercent: available !== null && available <= 100 ? available : null,
    swap: used !== null && total !== null ? { usedBytes: used, totalBytes: total } : null,
  };
}

/** `vm_stat`: the page size, the compressor's pages and the running count of swap-outs. */
export function parseVmStat(stdout: string): { compressedBytes: number | null; swapouts: number | null } {
  const page = Number(/page size of (\d+) bytes/.exec(stdout)?.[1] ?? NaN);
  const pages = (label: string): number | null => {
    const m = new RegExp(`^"?${label}"?:\\s+(\\d+)\\.?\\s*$`, "m").exec(stdout);
    return m ? Number(m[1]) : null;
  };
  const compressor = pages("Pages occupied by compressor");
  const swapouts = pages("Swapouts");
  return {
    compressedBytes: compressor !== null && Number.isFinite(page) ? compressor * page : null,
    swapouts: swapouts !== null && Number.isFinite(page) ? swapouts * page : null,
  };
}

/** Swapping out this fast, sustained between two readings, is a Mac short of memory whatever its level says. */
export const SWAP_OUT_WARN_BYTES_PER_SECOND = 1024 ** 2;
export const SWAP_OUT_CRITICAL_BYTES_PER_SECOND = 50 * 1024 ** 2;

/** macOS's level (1 normal, 2 warn, 4 critical), lifted by swapping out, as one level and its reason. */
export function classifyPressure(o: { level: number | null; swapOutPerSecond: number | null }): { pressure: MemoryPressure; why: string | null } {
  const rate = o.swapOutPerSecond ?? 0;
  const paging = `Swapping out ${Math.max(1, Math.round(rate / 1024 ** 2))} MB a second`;
  if (o.level === 4) return { pressure: "critical", why: "macOS reports critical memory pressure" };
  if (rate >= SWAP_OUT_CRITICAL_BYTES_PER_SECOND) return { pressure: "critical", why: paging };
  if (o.level === 2) return { pressure: "warn", why: "macOS reports memory pressure" };
  if (rate >= SWAP_OUT_WARN_BYTES_PER_SECOND) return { pressure: "warn", why: paging };
  if (o.level === 1) return { pressure: "normal", why: null };
  return { pressure: "unknown", why: null };
}

/** Linux's own pressure (`/proc/pressure/memory`): the share of the last ten seconds some or all tasks stalled on memory. */
export function classifyPsi(text: string): { pressure: MemoryPressure; why: string | null } {
  const some = Number(/^some\s+avg10=([\d.]+)/m.exec(text)?.[1] ?? NaN);
  const full = Number(/^full\s+avg10=([\d.]+)/m.exec(text)?.[1] ?? NaN);
  if (!Number.isFinite(some)) return { pressure: "unknown", why: null };
  if (Number.isFinite(full) && full >= 10) return { pressure: "critical", why: `Every task stalled on memory ${Math.round(full)}% of the last ten seconds` };
  if (some >= 10) return { pressure: "warn", why: `Tasks stalled on memory ${Math.round(some)}% of the last ten seconds` };
  return { pressure: "normal", why: null };
}

/** `/proc/meminfo`'s kB values, by name. */
export function parseMeminfo(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of text.matchAll(/^(\w+):\s+(\d+)\s*kB$/gm)) out.set(m[1]!, Number(m[2]) * 1024);
  return out;
}

/** The counters a rate is taken between two readings of. */
export type MachineCounters = { at: number; swapouts: number | null };

/** Everything the resource service asks of the machine — the seam a test hands a fake table to. */
export type MachineProbe = {
  /** False where this platform's processes are not read at all (Windows has no `ps`): a report then
   *  says it measured nothing. Absent is true. */
  readonly readsProcesses?: boolean;
  /** Every process on the machine. */
  processes(): Promise<ProcRow[]>;
  /** The footprint of each of these processes, where it can be read; a process missing from the answer has none. */
  footprints(pids: readonly number[]): Promise<Map<number, number>>;
  /** The footprint of every process, or null where that costs more than this platform allows. */
  allFootprints(): Promise<Map<number, number> | null>;
  /** Memory, pressure, swap and load, given the counters of the reading before (null for none). */
  memory(previous: MachineCounters | null): Promise<{ memory: MachineMemory; counters: MachineCounters }>;
  /** The bundle id of the app in front (`lsappinfo`, no permission needed), or null — always null off a
   *  Mac. Absent, nothing is read. */
  frontApp?(): Promise<string | null>;
};

/** `lsappinfo front`: `ASN:0x0-0x73073:`. */
export function parseFrontAsn(out: string): string | null {
  const m = /ASN:0x[0-9a-f]+-0x[0-9a-f]+/i.exec(out);
  return m ? `${m[0]}:` : null;
}

/** `lsappinfo info -only bundleid <asn>`: `bundleID="com.apple.iphonesimulator"` (older macOS quotes
 *  the key as `"CFBundleIdentifier"`); `[ NULL ]` for an app without one. */
export function parseBundleId(out: string): string | null {
  return /(?:bundleID|"CFBundleIdentifier")\s*=\s*"([^"]+)"/i.exec(out)?.[1] ?? null;
}

type Run = (file: string, args: string[], timeoutMs: number) => Promise<string>;

/** The command's output, whatever its exit: `sysctl` exits 1 for one unknown name and still prints the rest. */
const run: Run = (file, args, timeoutMs) => new Promise((resolve) => {
  execFile(file, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" }, (_err, stdout) => resolve(stdout ?? ""));
});

/** The commands a reading runs, as `ps` lists them — `(name)` while one is exiting. */
const MEASURING = /^\(?(?:\/usr\/s?bin\/|\/bin\/)?(?:ps|top|footprint|sysctl|vm_stat|lsappinfo)(?:\)|\s|$)/;

/** At most this many pids per `footprint` call: its argv stays far under ARG_MAX, and one slow process costs one batch. */
const FOOTPRINT_BATCH = 64;

/** The real machine. macOS reads everything; Linux reads `/proc`; anything else answers what Node knows. */
export function realMachineProbe(o: { platform?: string; run?: Run; readText?: (path: string) => Promise<string>; now?: () => number } = {}): MachineProbe {
  const platform = o.platform ?? process.platform;
  const exec = o.run ?? run;
  const readText = o.readText ?? ((path: string) => readFile(path, "utf8"));
  const now = o.now ?? Date.now;
  const base = (): Pick<MachineMemory, "load" | "cpus"> => {
    const [one = 0, five = 0, fifteen = 0] = loadavg();
    return { load: [one, five, fifteen], cpus: Math.max(1, cpus().length) };
  };
  return {
    readsProcesses: platform !== "win32",
    async processes() {
      if (platform === "win32") return [];
      // The reading's own commands are this process's children while it reads: not Realm's work.
      return parsePs(await exec("ps", ["-A", "-ww", "-o", "pid=,ppid=,tty=,rss=,lstart=,command="], 10_000))
        .filter((r) => !(r.ppid === process.pid && MEASURING.test(r.command)));
    },
    async footprints(pids) {
      const out = new Map<number, number>();
      if (platform !== "darwin" || pids.length === 0) return out;
      for (let i = 0; i < pids.length; i += FOOTPRINT_BATCH) {
        const args = ["--noCategories", "-f", "bytes", ...pids.slice(i, i + FOOTPRINT_BATCH).flatMap((p) => ["-p", String(p)])];
        for (const [pid, bytes] of parseFootprint(await exec("/usr/bin/footprint", args, 20_000))) out.set(pid, bytes);
      }
      return out;
    },
    async allFootprints() {
      if (platform !== "darwin") return null;
      const map = parseTop(await exec("/usr/bin/top", ["-l", "1", "-stats", "pid,mem"], 15_000));
      return map.size > 0 ? map : null;
    },
    async frontApp() {
      if (platform !== "darwin") return null;
      const asn = parseFrontAsn(await exec("/usr/bin/lsappinfo", ["front"], 2_000));
      return asn ? parseBundleId(await exec("/usr/bin/lsappinfo", ["info", "-only", "bundleid", asn], 2_000)) : null;
    },
    async memory(previous) {
      const at = now();
      if (platform === "darwin") {
        const [sys, vm] = await Promise.all([
          exec("/usr/sbin/sysctl", ["hw.memsize", "kern.memorystatus_vm_pressure_level", "kern.memorystatus_level", "vm.swapusage"], 5_000),
          exec("/usr/bin/vm_stat", [], 5_000),
        ]);
        const s = parseSysctl(sys), v = parseVmStat(vm);
        const rate = previous?.swapouts != null && v.swapouts !== null && at > previous.at
          ? Math.max(0, (v.swapouts - previous.swapouts) / ((at - previous.at) / 1000)) : null;
        const { pressure, why } = classifyPressure({ level: s.level, swapOutPerSecond: rate });
        return {
          memory: { ...base(), totalBytes: s.totalBytes ?? totalmem(), availablePercent: s.availablePercent, pressure, pressureWhy: why, swap: s.swap, compressedBytes: v.compressedBytes, swapOutPerSecond: rate },
          counters: { at, swapouts: v.swapouts },
        };
      }
      if (platform === "linux") {
        const [meminfo, psi] = await Promise.all([readText("/proc/meminfo").catch(() => ""), readText("/proc/pressure/memory").catch(() => "")]);
        const m = parseMeminfo(meminfo);
        const total = m.get("MemTotal") ?? totalmem();
        const available = m.get("MemAvailable");
        const swapTotal = m.get("SwapTotal"), swapFree = m.get("SwapFree");
        const { pressure, why } = classifyPsi(psi);
        return {
          memory: {
            ...base(), totalBytes: total, availablePercent: available !== undefined && total > 0 ? Math.round((available / total) * 100) : null,
            pressure, pressureWhy: why,
            swap: swapTotal !== undefined && swapFree !== undefined ? { usedBytes: swapTotal - swapFree, totalBytes: swapTotal } : null,
            compressedBytes: null, swapOutPerSecond: null,
          },
          counters: { at, swapouts: null },
        };
      }
      return {
        memory: { ...base(), totalBytes: totalmem(), availablePercent: null, pressure: "unknown", pressureWhy: null, swap: null, compressedBytes: null, swapOutPerSecond: null },
        counters: { at, swapouts: null },
      };
    },
  };
}

/**
 * A machine with nothing on it and nothing to say: what every `createApp` but `main.ts`'s gets, so a
 * suite never reads the Mac it runs on and two runs of it answer the same.
 */
export function quietMachineProbe(): MachineProbe {
  return {
    processes: async () => [],
    footprints: async () => new Map(),
    allFootprints: async () => null,
    frontApp: async () => null,
    memory: async () => ({
      memory: { totalBytes: 0, availablePercent: null, pressure: "unknown", pressureWhy: null, swap: null, compressedBytes: null, swapOutPerSecond: null, load: [0, 0, 0], cpus: 1 },
      counters: { at: 0, swapouts: null },
    }),
  };
}
