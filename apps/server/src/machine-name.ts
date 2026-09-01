import { execFile } from "node:child_process";
import { hostname } from "node:os";

/**
 * The machine's user-facing name, for `system.info.machineName` (Plan 12 W1 — the prompter's
 * under-strip machine label; display-only, since Realm runs agents on this machine and no other).
 *
 * On macOS the name people recognise is the ComputerName System Settings shows ("Carlton's M4
 * MacBook Pro"), which only `scutil --get ComputerName` reports. `os.hostname()` is the fallback —
 * a DNS-shaped rendering of the same name ("Carltons-MacBook-Pro.local"), cleaned of the mDNS
 * suffix — for non-macOS hosts and for the (sandboxed, scutil-less) environments tests run in.
 */
export function machineName(): Promise<string> {
  return new Promise((resolve) => {
    execFile("scutil", ["--get", "ComputerName"], { timeout: 2000 }, (err, stdout) => {
      const name = err ? "" : stdout.trim();
      resolve(name || cleanHostname(hostname()));
    });
  });
}

/** `os.hostname()` minus the mDNS `.local` suffix. Never empty: a hostname that cleans to nothing
 *  (unheard of, but this is a label) falls back to the raw value rather than a blank strip. */
export function cleanHostname(h: string): string {
  const cleaned = h.replace(/\.local$/i, "").trim();
  return cleaned || h;
}
