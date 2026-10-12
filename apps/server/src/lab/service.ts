import {
  LAB_DEFAULTS, LAB_ENABLED_KEY, LAB_UPDATE_CAP_KEY, LAB_UPDATE_HOUR_KEY, LAB_UPDATE_STATE_KEY, LabUpdateStateSchema,
  type LabAccount, type LabCheck, type LabDevice, type LabDeviceKind, type LabDevices, type LabReadiness, type LabSeenDevice,
  type LabStatus, type LabUpdateState, type SimulatorDevice,
} from "@realm/contracts";
import { RpcError } from "../store/rows";
import type { LabDevicesStore, LabDeviceRow } from "./devices-store";
import { UpdateWindow } from "./update-window";

type SettingsLike = { get(key: string): unknown; set(key: string, value: unknown): void };

/** How often the update window looks at the clock and at what is running. */
const TICK_MS = 15_000;

export type LabServiceDeps = {
  store: LabDevicesStore;
  settings: SettingsLike;
  rpc: { broadcast(event: "lab.changed" | "lab.install", payload: object): void };
  spaceName: (id: string) => string | null;
  /** Every device the simulators module can see: simulators, emulators, and phones on a cable. */
  devices: () => Promise<SimulatorDevice[]>;
  /** The readiness checks this server can make (`readiness.ts`). */
  probe: () => Promise<LabCheck[]>;
  hostName: () => Promise<string | null>;
  /** Work in flight, for the update window. */
  busy: () => { runs: number; sessions: number };
  /** A held team run may start now. */
  pump: () => void;
  now?: () => number;
};

const kindOf = (d: SimulatorDevice): LabDeviceKind => (d.platform === "android" ? "android" : d.physical ? "iphone" : "simulator");

/**
 * The lab (teams plan §12): this Mac's readiness, the devices on its cables, and the update window.
 * One per server, Realm-wide — a Mac and its phones are not any one team's, and each device says
 * which team it serves.
 */
export class LabService {
  private readonly window: UpdateWindow;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The last scan: what was on the cable, by udid. In memory — "connected" is a fact about now. */
  private lastScan: { at: number; seen: SimulatorDevice[] } | null = null;
  private host: Promise<string | null> | null = null;

  constructor(private readonly d: LabServiceDeps) {
    this.window = new UpdateWindow({
      now: () => this.now(),
      load: () => {
        const parsed = LabUpdateStateSchema.safeParse(d.settings.get(LAB_UPDATE_STATE_KEY));
        return parsed.success ? parsed.data : { kind: "idle" };
      },
      save: (s) => d.settings.set(LAB_UPDATE_STATE_KEY, s),
      hour: () => this.hour(),
      capMinutes: () => this.capMinutes(),
      busy: () => d.busy(),
      install: (version) => d.rpc.broadcast("lab.install", { version }),
      release: () => d.pump(),
      changed: () => this.changed(),
    });
  }

  private now(): number { return this.d.now ? this.d.now() : Date.now(); }
  private changed(): void { this.d.rpc.broadcast("lab.changed", {}); }

  start(): void {
    if (this.timer) return;
    this.window.tick();
    this.timer = setInterval(() => this.window.tick(), TICK_MS);
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Whether team runs are held for an update. The team's admit consults it. */
  get holding(): boolean { return this.window.holding; }

  /** The window, as it stands — for tests and the tick. */
  tick(): void { this.window.tick(); }

  /* ── status ── */

  private enabled(): boolean { return this.d.settings.get(LAB_ENABLED_KEY) === true; }
  private hour(): number {
    const v = this.d.settings.get(LAB_UPDATE_HOUR_KEY);
    return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 23 ? v : LAB_DEFAULTS.updateHour;
  }
  private capMinutes(): number {
    const v = this.d.settings.get(LAB_UPDATE_CAP_KEY);
    return typeof v === "number" && Number.isInteger(v) && v >= 5 && v <= 240 ? v : LAB_DEFAULTS.updateCapMinutes;
  }

  async status(): Promise<LabStatus> {
    this.host ??= this.d.hostName().catch(() => null);
    return {
      enabled: this.enabled(), updateHour: this.hour(), updateCapMinutes: this.capMinutes(),
      update: this.window.current, hostName: await this.host,
    };
  }

  async setEnabled(enabled: boolean): Promise<LabStatus> {
    this.d.settings.set(LAB_ENABLED_KEY, enabled);
    if (!enabled) this.window.standDown();
    this.changed();
    return this.status();
  }

  async setUpdateWindow(hour: number, capMinutes: number): Promise<LabStatus> {
    this.d.settings.set(LAB_UPDATE_HOUR_KEY, hour);
    this.d.settings.set(LAB_UPDATE_CAP_KEY, capMinutes);
    this.window.rescheduled();
    this.changed();
    return this.status();
  }

  /* ── the update window ── */

  /** Main: an update is downloaded. Ignored unless this Mac is a lab — main asks the person then. */
  async updateReady(version: string, from: string): Promise<LabStatus> {
    if (this.enabled()) this.window.ready(version, from);
    return this.status();
  }

  async updateNow(): Promise<LabStatus> {
    this.window.openNow();
    return this.status();
  }

  async appVersion(version: string): Promise<LabStatus> {
    this.window.appVersion(version);
    return this.status();
  }

  get update(): LabUpdateState { return this.window.current; }

  /* ── readiness ── */

  async readiness(): Promise<LabReadiness> {
    return { checks: await this.d.probe(), checkedAt: this.now() };
  }

  /* ── devices ── */

  devices(): LabDevices {
    const rows = this.d.store.list();
    const connected = new Set((this.lastScan?.seen ?? []).map((x) => x.udid));
    const registered = new Set(rows.map((r) => r.udid).filter((u): u is string => u !== null));
    // Offered for adding: phones on a cable and simulators that are running — a Mac has dozens of
    // simulators it is not using, and none of those is attached to anything.
    const unregistered: LabSeenDevice[] = (this.lastScan?.seen ?? [])
      .filter((x) => !registered.has(x.udid) && (x.physical || x.platform === "android" || x.state === "Booted"))
      .map((x) => ({ udid: x.udid, kind: kindOf(x), name: x.name, runtime: x.runtime }));
    return { devices: rows.map((r) => this.toDevice(r, connected)), unregistered, scannedAt: this.lastScan?.at ?? null };
  }

  async scan(): Promise<LabDevices> {
    const seen = await this.d.devices();
    const at = this.now();
    this.lastScan = { at, seen };
    const udids = new Set(seen.map((x) => x.udid));
    this.d.store.seen(this.d.store.list().filter((r) => r.udid && udids.has(r.udid)).map((r) => r.id), at);
    this.changed();
    return this.devices();
  }

  addDevice(input: { kind: LabDeviceKind; udid: string | null; name: string; spaceId: string | null; accounts: LabAccount[] }): LabDevices {
    if (input.udid && this.d.store.byUdid(input.udid)) throw new RpcError("LAB_DEVICE_EXISTS", "That device is already in the lab.");
    this.checkSpace(input.spaceId);
    const accounts = this.checkAccounts(input.accounts);
    const onCable = input.udid ? this.lastScan?.seen.some((x) => x.udid === input.udid) ?? false : false;
    this.d.store.add({ ...input, accounts, lastSeenAt: onCable ? this.lastScan!.at : null }, this.now());
    this.changed();
    return this.devices();
  }

  updateDevice(id: string, patch: { name?: string; spaceId?: string | null; accounts?: LabAccount[] }): LabDevices {
    if (patch.spaceId !== undefined) this.checkSpace(patch.spaceId);
    const accounts = patch.accounts === undefined ? undefined : this.checkAccounts(patch.accounts);
    if (!this.d.store.update(id, { ...patch, ...(accounts ? { accounts } : {}) }, this.now())) throw new RpcError("NOT_FOUND", "That device is no longer in the lab.");
    this.changed();
    return this.devices();
  }

  removeDevice(id: string): LabDevices {
    this.d.store.remove(id);
    this.changed();
    return this.devices();
  }

  private checkSpace(spaceId: string | null): void {
    if (spaceId !== null && this.d.spaceName(spaceId) === null) throw new RpcError("NOT_FOUND", "That team's space no longer exists.");
  }

  /** The same account once, and no more than a phone should hold (§12: 2–3 each, each consented). */
  private checkAccounts(accounts: LabAccount[]): LabAccount[] {
    const seen = new Set<string>();
    const out = accounts.filter((a) => {
      const key = `${a.service.toLowerCase()}\u0000${a.handle.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (out.length > LAB_DEFAULTS.accountsPerDevice) {
      throw new RpcError("LAB_ACCOUNTS", `A phone holds at most ${LAB_DEFAULTS.accountsPerDevice} accounts. Put the rest on another phone.`);
    }
    return out;
  }

  private toDevice(r: LabDeviceRow, connected: Set<string>): LabDevice {
    return {
      id: r.id, kind: r.kind, udid: r.udid, name: r.name, spaceId: r.spaceId,
      spaceName: r.spaceId ? this.d.spaceName(r.spaceId) : null, accounts: r.accounts,
      lastSeenAt: r.lastSeenAt, connected: r.udid !== null && connected.has(r.udid), createdAt: r.createdAt,
    };
  }
}
