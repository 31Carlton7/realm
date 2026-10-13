import { app } from "electron";
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The `deviceowner` helper (native/DeviceOwner.swift): LocalAuthentication's device-owner check,
 * Touch ID or the login password. Dev tree first, then the packaged Resources directory, as for the
 * other helpers — and, unlike them, NO environment override: a variable that could point Realm at
 * another binary would be a way to answer "yes" without anybody there.
 */
function helperPath(): string | null {
  if (process.platform !== "darwin") return null;
  const dev = join(app.getAppPath(), "native", "bin", "deviceowner");
  if (existsSync(dev)) return dev;
  const packaged = join(process.resourcesPath, "deviceowner");
  return existsSync(packaged) ? packaged : null;
}

/** How long a device-owner prompt may stay up before Realm takes it as a no. Long enough to walk
 *  over and type a password; short enough that a fill nobody answers does not wait forever. */
const ASK_TIMEOUT_MS = 120_000;

let canCache: { at: number; can: boolean } | null = null;

/** Whether the check can run here: the helper exists and macOS will evaluate the policy (a login
 *  password is set). Asked again at most every 30 seconds. */
export function canPromptDeviceOwner(): boolean {
  if (canCache && Date.now() - canCache.at < 30_000) return canCache.can;
  const bin = helperPath();
  let can = false;
  if (bin) {
    const r = spawnSync(bin, ["can"], { timeout: 5_000, encoding: "utf8" });
    can = r.status === 0 && r.stdout.trim() === "yes";
  }
  canCache = { at: Date.now(), can };
  return can;
}

/** Ask macOS to confirm the Mac's owner. Resolves false — never throws — on cancel, failure, timeout
 *  or a missing helper, which is `SecretStoreDeps.promptDeviceOwner`'s contract. */
export function promptDeviceOwner(reason: string): Promise<boolean> {
  const bin = helperPath();
  if (!bin) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(bin, ["ask", `Realm wants to ${reason}.`], { timeout: ASK_TIMEOUT_MS }, (error) => resolve(error === null));
  });
}

let machineCache: string | null | undefined;

/** This Mac's hardware UUID (IOPlatformUUID). It survives reinstalls and differs on every Mac,
 *  including one a home directory and login Keychain were migrated to. Null when it cannot be read. */
export function machineId(): string | null {
  if (machineCache !== undefined) return machineCache;
  machineCache = null;
  if (process.platform === "darwin") {
    const r = spawnSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: 5_000, encoding: "utf8" });
    const m = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/.exec(r.stdout ?? "");
    if (m) machineCache = m[1]!.toUpperCase();
  }
  return machineCache;
}
