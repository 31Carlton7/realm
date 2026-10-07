import { execFile } from "node:child_process";
import type { SimulatorApp, SimulatorDevice } from "@realm/contracts";
import { simctlBin } from "./simctl";

/**
 * What `xcrun devicectl` can tell us about the iPhones and iPads on this Mac's cable or network, and
 * the few things Realm asks it to do to one.
 *
 * `simctl.ts`'s sibling for hardware, split the same way for the same reason: the JSON's shape is the
 * part that can be wrong, so parsing is pure and tested, and running is a thin shell around it. The
 * JSON is `--json-output -`, never the table, whose columns are for people.
 *
 * MEASURED on devicectl 642.15 (Xcode 26.6): each device carries a `properties` dictionary —
 * `connection`, `hardware`, `software`, `state` — beside `hardwareProperties`, `deviceProperties` and
 * `connectionProperties`, which it says are deprecated. The new one is read first and the old ones
 * are the fallback, so either release reads the same.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** devicectl's JSON, whatever wrapper it came in: the document, or null when the command failed. */
function result(stdout: string): Obj | null {
  try {
    const v = obj(JSON.parse(stdout));
    if (obj(v.info).outcome !== "success") return null;
    return obj(v.result);
  } catch { return null; }
}

/**
 * The real devices in `devicectl list devices` — iPhones and iPads that are paired with this Mac and
 * reachable now.
 *
 * Simulators are in the same list (`reality: simulated`) and are left to simctl, which knows them
 * better. A device devicectl calls `unavailable` — an iPad last seen a week ago — is left out for
 * simctl's reason: a row whose only outcome is an error is not a row to offer. One that is here but
 * has Developer Mode off IS offered, saying so, because that is the thing the user can fix.
 */
export function parsePhysicalDevices(stdout: string): SimulatorDevice[] {
  const r = result(stdout);
  const list = Array.isArray(r?.devices) ? (r!.devices as unknown[]) : [];
  const out: SimulatorDevice[] = [];
  for (const raw of list) {
    const d = obj(raw);
    const p = obj(d.properties);
    const hw = { ...obj(d.hardwareProperties), ...obj(p.hardware) };
    const conn = { ...obj(d.connectionProperties), ...obj(p.connection) };
    const dev = { ...obj(d.deviceProperties), ...obj(p.state) };
    if (hw.reality !== "physical" || hw.platform !== "iOS") continue;
    const udid = text(hw.udid);
    if (!udid) continue;
    if (conn.pairingState !== "paired" || conn.state === "unavailable") continue;
    const version = text(obj(obj(p.software).osVersionNumber).stringValue) ?? text(obj(d.deviceProperties).osVersionNumber) ?? "";
    const developer = dev.developerModeStatus;
    const developerOff = developer === "disabled" || (typeof developer === "object" && developer !== null && "disabled" in (developer as Obj));
    out.push({
      udid, platform: "ios", physical: true,
      name: text(dev.name) ?? text(hw.marketingName) ?? udid,
      runtime: version ? `iOS ${version}` : "iOS",
      state: developerOff ? "Developer Mode off" : "Connected",
      serial: null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
}

/** `device info apps` → the apps it listed. The name is the one on the home screen. */
export function parseDeviceApps(stdout: string): SimulatorApp[] {
  const r = result(stdout);
  const list = Array.isArray(r?.apps) ? (r!.apps as unknown[]) : [];
  const out: SimulatorApp[] = [];
  for (const raw of list) {
    const a = obj(raw);
    const bundleId = text(a.bundleIdentifier);
    if (!bundleId) continue;
    out.push({ bundleId, name: text(a.name) ?? bundleId });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
}

/** `device info lockState` → whether a passcode stands between Realm and the screen right now. */
export function parseLockState(stdout: string): { locked: boolean } | null {
  const r = result(stdout);
  if (!r || typeof r.passcodeRequired !== "boolean") return null;
  return { locked: r.passcodeRequired };
}

export type Devicectl = {
  /** The real iPhones and iPads this Mac can reach now. */
  devices(): Promise<SimulatorDevice[]>;
  /** The apps Xcode installed on the phone — developer builds, which is what a developer came for.
   *  Everything else the owner put there stays unlisted: its names are theirs. */
  apps(udid: string): Promise<SimulatorApp[]>;
  /** One app by bundle id, installed by anyone — Settings included — or null. Asks about that app
   *  alone, so looking one up never lists the rest. */
  app(udid: string, bundleId: string): Promise<SimulatorApp | null>;
  lockState(udid: string): Promise<{ locked: boolean } | null>;
  /** `fresh` terminates a running copy first, so the app opens on its first screen. */
  launch(udid: string, bundleId: string, fresh: boolean): Promise<{ ok: boolean; detail: string }>;
  install(udid: string, path: string): Promise<{ ok: boolean; detail: string }>;
};

type Run = (args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

const execRun = (bin: string): Run => (args, timeout) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: stdout ?? "", stderr: (stderr ?? "") || (err ? String(err.message) : "") });
    });
  });

/** devicectl's own sentence for a failure: the `error` it put in the JSON, else what it printed. */
function failure(r: { code: number; stdout: string; stderr: string }): string {
  try {
    const e = obj(obj(JSON.parse(r.stdout)).error);
    const said = text(obj(e.userInfo).NSLocalizedDescription) ?? text(e.localizedDescription) ?? text(e.description);
    if (said) return said;
  } catch { /* not JSON */ }
  return r.stderr.trim().split("\n").filter((l) => l.trim()).slice(-3).join(" ") || `devicectl exited ${r.code}`;
}

export function devicectl(env: NodeJS.ProcessEnv = process.env, run: Run = execRun(simctlBin(env))): Devicectl {
  /* The JSON flags go straight after the subcommand, ahead of everything else: `process launch` takes
     whatever follows the bundle id as the APP's arguments, so a flag written after it would be handed
     to Settings rather than read by devicectl. */
  const dc = (sub: string[], rest: string[], timeoutMs: number) => run(["devicectl", ...sub, "--json-output", "-", "--quiet", ...rest], timeoutMs);
  const acted = (r: { code: number; stdout: string; stderr: string }) =>
    ({ ok: r.code === 0 && result(r.stdout) !== null, detail: r.code === 0 && result(r.stdout) !== null ? "" : failure(r) });
  return {
    async devices() {
      const r = await dc(["list", "devices"], [], 20_000);
      return r.code === 0 ? parsePhysicalDevices(r.stdout) : [];
    },
    async apps(udid) {
      const r = await dc(["device", "info", "apps"], ["--device", udid], 30_000);
      return r.code === 0 ? parseDeviceApps(r.stdout) : [];
    },
    async app(udid, bundleId) {
      const r = await dc(["device", "info", "apps"], ["--device", udid, "--include-all-apps", "--bundle-id", bundleId], 30_000);
      return r.code === 0 ? parseDeviceApps(r.stdout).find((a) => a.bundleId === bundleId) ?? null : null;
    },
    async lockState(udid) {
      const r = await dc(["device", "info", "lockState"], ["--device", udid], 20_000);
      return r.code === 0 ? parseLockState(r.stdout) : null;
    },
    async launch(udid, bundleId, fresh) {
      return acted(await dc(["device", "process", "launch"], ["--device", udid, ...(fresh ? ["--terminate-existing"] : []), bundleId], 60_000));
    },
    async install(udid, path) {
      return acted(await dc(["device", "install", "app"], ["--device", udid, path], 300_000));
    },
  };
}
