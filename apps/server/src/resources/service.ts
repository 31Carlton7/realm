import type { MachineMemory, MemoryPressure, ResourceReport } from "@realm/contracts";
import { attribute, type Owners } from "./attribute";
import type { MachineCounters, MachineProbe } from "./machine";

/** A report is read at most this often, however many windows ask: one costs a `ps`, a `footprint`
 *  per hundred processes and the owners' own answers. */
export const SNAPSHOT_TTL_MS = 5_000;
/** Other apps' footprints come from one `top -l 1` sample, about a second of the kernel's time, so
 *  they are kept for a minute: they are context for Realm's own numbers, not something acted on. */
export const OTHERS_TTL_MS = 60_000;
/** How often pressure is read while Realm runs — one `sysctl` and one `vm_stat`, a few milliseconds. */
export const PRESSURE_EVERY_MS = 30_000;
/** How long the app may take to list its processes before a report goes out without them. */
export const APP_METRICS_TIMEOUT_MS = 3_000;

/**
 * What Realm costs this Mac in memory, and how short the Mac is of it (`machine.ts` for the method,
 * `attribute.ts` for who owns what).
 *
 * Two clocks, deliberately different. **Pressure** is read every half minute for as long as Realm
 * runs, because the policies that let idle things go sooner when memory is short read it
 * (`pressure()`), and it costs next to nothing. **The report** — every process, its footprint, its
 * owner — is read only when somebody asks for one (the Memory page, `machine_status`), and kept a few
 * seconds.
 */
export class ResourceService {
  private cached: { at: number; report: ResourceReport } | null = null;
  private inflight: Promise<ResourceReport> | null = null;
  private othersCache: { at: number; map: Map<number, number> | null } | null = null;
  private reading: { memory: MachineMemory; counters: MachineCounters } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<(pressure: MemoryPressure) => void>();
  private closed = false;

  constructor(private readonly d: {
    probe: MachineProbe;
    /** What each service owns right now: live engines, terminals, MCP servers, Laya, simulators. */
    owners: () => Omit<Owners, "app" | "serverPid">;
    /** The app's own processes, labelled by main; null when no app is attached. */
    app: () => Promise<Owners["app"]>;
    serverPid?: number;
    now?: () => number;
  }) {}

  /** Start reading pressure. Unref'd: a daemon with nothing else to do must not stay up for this. */
  start(): void {
    if (this.timer || this.closed) return;
    void this.machine().catch(() => {});
    this.timer = setInterval(() => { void this.machine().catch(() => {}); }, PRESSURE_EVERY_MS);
    this.timer.unref?.();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  /** The level last read — `unknown` before the first reading. Synchronous, for a policy's sweep. */
  pressure(): MemoryPressure {
    return this.reading?.memory.pressure ?? "unknown";
  }

  /** Told whenever the level changes, so a policy can act at once rather than on its next tick. */
  onPressure(fn: (pressure: MemoryPressure) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Read the machine now: memory, pressure, swap, load. */
  async machine(): Promise<MachineMemory> {
    const before = this.reading?.memory.pressure ?? "unknown";
    const next = await this.d.probe.memory(this.reading?.counters ?? null);
    // A rate needs two readings; until there are, the level is macOS's alone.
    this.reading = next;
    if (next.memory.pressure !== before) for (const fn of this.listeners) { try { fn(next.memory.pressure); } catch { /* a listener's problem */ } }
    return next.memory;
  }

  /** The whole report. One read at a time: a second caller while one is running gets the same answer. */
  async snapshot(o: { fresh?: boolean } = {}): Promise<ResourceReport> {
    const now = this.now();
    if (!o.fresh && this.cached && now - this.cached.at < SNAPSHOT_TTL_MS) return this.cached.report;
    if (this.inflight) return this.inflight;
    this.inflight = this.read().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async read(): Promise<ResourceReport> {
    const serverPid = this.d.serverPid ?? process.pid;
    const [table, app, memory, allFootprint] = await Promise.all([
      this.d.probe.processes(),
      withTimeout(this.d.app(), APP_METRICS_TIMEOUT_MS).catch(() => null),
      this.machine(),
      this.others(),
    ]);
    const owners: Owners = { ...this.d.owners(), serverPid, app };
    // Twice: once to learn which processes are Realm's, then with their footprints read.
    const first = attribute({ table, owners, footprint: new Map(), allFootprint: null, footprintMeasured: false });
    const footprint = await this.d.probe.footprints(first.claimed);
    const measured = footprint.size > 0;
    const { claimed: _claimed, ...attribution } = attribute({ table, owners, footprint, allFootprint, footprintMeasured: measured });
    const report: ResourceReport = { at: this.now(), machine: memory, ...attribution };
    this.cached = { at: report.at, report };
    return report;
  }

  private async others(): Promise<Map<number, number> | null> {
    const now = this.now();
    if (this.othersCache && now - this.othersCache.at < OTHERS_TTL_MS) return this.othersCache.map;
    const map = await this.d.probe.allFootprints().catch(() => null);
    this.othersCache = { at: now, map };
    return map;
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
