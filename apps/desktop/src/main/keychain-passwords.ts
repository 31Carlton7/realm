import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { KeychainItem, KeychainSource } from "./secret-store";

/**
 * The login keychain's internet passwords, through the native helper (native/KeychainPasswords.swift).
 *
 * Listing reads attributes only, so it never raises a prompt. A read asks for one item's data, and
 * that is where macOS asks the person — "realmkeychain wants to use your confidential information
 * stored in …" — unless the item already trusts the helper. Realm keeps nothing it reads: the value
 * goes from the helper's stdout into the fill and is gone.
 *
 * Off macOS there is no helper and no keychain (`keychainHelper` answers null), and the store says so
 * in Settings. Passwords saved in Realm and imported ones work everywhere; this is the one source
 * that is a Mac's alone.
 */

/** How long one helper call may take. A list is milliseconds; a read waits for the person to answer
 *  macOS's sheet, so it is given as long as a person reasonably takes. */
const LIST_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 120_000;
/** A keychain with more than this is not one a menu could show; bounds the parse, not a design limit. */
const LIST_MAX_BYTES = 8 * 1024 * 1024;

type Run = (args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>;

export function keychainSource(helper: string, opts: { keychainPath?: string | null; run?: Run } = {}): KeychainSource {
  const scope = opts.keychainPath ? ["--keychain", opts.keychainPath] : [];
  const run: Run = opts.run ?? ((args, timeoutMs) => new Promise((resolve) => {
    execFile(helper, args, { timeout: timeoutMs, maxBuffer: LIST_MAX_BYTES, encoding: "utf8" }, (error, stdout) => {
      // The error is not inspected past its exit code: its message can carry the helper's output,
      // and on a read that output is the password.
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      resolve({ code, stdout: typeof stdout === "string" ? stdout : "" });
    });
  }));
  return {
    async list() {
      const r = await run(["list", ...scope], LIST_TIMEOUT_MS);
      if (r.code !== 0) throw new Error("the keychain could not be listed");
      return r.stdout.split("\n").flatMap((line) => {
        const item = parseItem(line);
        return item ? [item] : [];
      });
    },
    async read(item) {
      const r = await run([
        "read", "--server", item.server, "--account", item.account, "--protocol", item.protocol,
        "--port", String(item.port), "--path", item.path, ...scope,
      ], READ_TIMEOUT_MS);
      return r.code === 0 && r.stdout !== "" ? r.stdout : null;
    },
  };
}

/** One line of `list`, checked field by field: anything malformed is not an item. */
export function parseItem(line: string): KeychainItem | null {
  if (!line.trim()) return null;
  let v: Record<string, unknown>;
  try { v = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  if (typeof v.server !== "string" || !v.server || typeof v.account !== "string") return null;
  if (v.protocol !== "https" && v.protocol !== "http") return null;
  const port = typeof v.port === "number" && Number.isInteger(v.port) && v.port >= 0 && v.port < 65536 ? v.port : 0;
  return {
    server: v.server, account: v.account, protocol: v.protocol, port,
    path: typeof v.path === "string" ? v.path : "",
    label: typeof v.label === "string" ? v.label : "",
    modified: typeof v.modified === "number" && Number.isFinite(v.modified) ? v.modified : 0,
  };
}

/** The helper Realm ships: the dev tree first, then the packaged Resources directory, as for the
 *  other helpers. Null off macOS. */
export function keychainHelper(appPath: string, resourcesPath: string): string | null {
  if (process.platform !== "darwin") return null;
  const dev = join(appPath, "native", "bin", "realmkeychain");
  if (existsSync(dev)) return dev;
  const packaged = join(resourcesPath, "realmkeychain");
  return existsSync(packaged) ? packaged : null;
}

/**
 * The keychain source a run of Realm gets. A build someone uses reads their login keychain. An
 * unpackaged app booted as a harness (`REALM_ENABLE_FAKE_AGENT=1`, as every live check is) reads the
 * one scratch keychain file named by `REALM_LIVE_KEYCHAIN`, or no keychain at all — so a live check
 * can never reach the login keychain, whatever it turns on. A packaged build ignores both variables.
 */
export function keychainSourceFor(d: { helper: string | null; packaged: boolean; env: Record<string, string | undefined> }): KeychainSource | null {
  if (!d.helper) return null;
  if (d.packaged || d.env.REALM_ENABLE_FAKE_AGENT !== "1") return keychainSource(d.helper);
  const scratch = d.env.REALM_LIVE_KEYCHAIN;
  return scratch ? keychainSource(d.helper, { keychainPath: scratch }) : null;
}
