/**
 * The app's RPC token: the one that opens every method realm-server has, permission cards and the
 * sandbox included.
 *
 * Main mints it, keeps it in memory, and hands it to the server on the spawn pipe. It is never on a
 * command line, in an environment, or in `daemon.json`, all of which an agent running as this user
 * can read. That file carries the `realm` CLI's token instead, which opens only the CLI's methods.
 *
 * A daemon outlives the app that started it, so the next launch needs the token back. It gets it from
 * a copy sealed by Electron's `safeStorage`, beside `daemon.json`. An agent can read the file, but not
 * open it: the key is a Keychain item only this app can read without a prompt.
 *
 * The lock-screen case: an update relaunches Realm at night, with the screen locked, and a
 * data-protection Keychain item cannot be read then (that is why notarytool's profile seemed to
 * vanish). safeStorage's key is not one. Chromium 156 (Electron 45) looks it up through
 * `crypto::apple::KeychainV2::FindGenericPassword`, a `SecItemCopyMatching` query for a generic
 * password that never sets `kSecUseDataProtectionKeychain`, which on macOS means the file-based login
 * Keychain. So this module must only ever seal through the safeStorage it is given, never with a
 * Keychain call of its own.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_SEALED_TOKEN_FILE, type DaemonState } from "@realm/contracts";
import type { SafeStorageLike } from "./secret-store";

export const mintAppToken = (): string => randomBytes(32).toString("base64url");

/** As realm-server records it in `daemon.json` (`appTokenSha256`). */
export const appTokenSha256 = (token: string): string => createHash("sha256").update(token).digest("hex");

export const sealedTokenPath = (home: string): string => join(home, DAEMON_SEALED_TOKEN_FILE);

/** Seal `token` for the next launch. False when there is no Keychain to seal with: the next launch
 *  then replaces the server rather than reattaching to it. */
export function sealAppToken(home: string, token: string, safe: SafeStorageLike): boolean {
  if (!safe.isEncryptionAvailable()) return false;
  const target = sealedTokenPath(home);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, safe.encryptString(token).toString("base64"), { mode: 0o600 });
  renameSync(tmp, target);
  return true;
}

/** The sealed token, if it is the one the running server was handed; null for every other case. */
export function unsealAppToken(home: string, state: Pick<DaemonState, "appTokenSha256">, safe: SafeStorageLike): string | null {
  if (!state.appTokenSha256 || !safe.isEncryptionAvailable()) return null;
  try {
    const token = safe.decryptString(Buffer.from(readFileSync(sealedTokenPath(home), "utf8"), "base64"));
    return appTokenSha256(token) === state.appTokenSha256 ? token : null;
  } catch { return null; }
}

/**
 * Where an unpackaged build writes the token in the clear for a live check, which drives the server
 * it boots with methods the CLI's token cannot call. Only when the check asks (`REALM_LIVE_APP_TOKEN=1`,
 * set by `scripts/lib/live-app.mjs`), and never in a packaged build.
 */
export function liveAppTokenFile(d: { packaged: boolean; env: string | undefined; home: string }): string | null {
  return !d.packaged && d.env === "1" ? join(d.home, "live-app-token") : null;
}
