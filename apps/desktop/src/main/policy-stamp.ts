import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The unlock-policy stamp (native/PolicyStamp.swift): one number per profile in the login Keychain
 * that a sealed unlock policy must carry to be honoured (`SecretStoreDeps.policyStamp`).
 *
 * Why it exists: `secrets.json` is a file, and anything with a shell can save a copy of it while a
 * profile is on "Without asking" and put that copy back after the user has tightened the policy — at
 * the next launch the older file would have opened as the looser policy again. The seal stops a
 * policy being forged or moved; it cannot stop one being REPLAYED. The stamp is the state outside the
 * file that a replay cannot bring back with it: every change moves it on, and the helper has no way
 * to set it to a chosen value, so an older file carries an older number and reads as Touch ID.
 *
 * What it does not stop, said plainly: a process that can run as Realm itself (inject into the
 * signed app) can do anything Realm can. And an unsigned dev build's helper shares the Keychain's
 * "unsigned" partition with every other unsigned program, so there another unsigned program can read
 * or remove the item; a signed build's item is the team's, and the same program gets a refusal.
 * Removing the item only ever tightens: no stamp, no looser policy.
 */
export type PolicyStamp = {
  /** The scope's number; null when it has none; "unreadable" when the item is there but is not one
   *  the helper may read without asking (made by another program). */
  read(scope: string): number | null | "unreadable";
  /** Move the scope's number on and return it — null when it could not be moved. Never prompts. */
  bump(scope: string): number | null;
};

/** The Keychain service the real stamps live under. Tests use their own, starting "Realm Test ". */
export const POLICY_STAMP_SERVICE = "Realm unlock policy";

/** How long one helper call may take: a Keychain read is milliseconds; this only bounds a hang. */
const HELPER_TIMEOUT_MS = 5_000;

/**
 * The stamp, through the helper at `helper`. Null when there is no helper (not a Mac, or swiftc was
 * unavailable at build time) — and with no stamp, no looser policy can be kept (secret-store.ts).
 */
export function keychainPolicyStamp(helper: string | null, service = POLICY_STAMP_SERVICE): PolicyStamp | null {
  if (!helper || !existsSync(helper)) return null;
  const run = (command: "read" | "bump", scope: string) =>
    spawnSync(helper, [command, service, scope], { timeout: HELPER_TIMEOUT_MS, encoding: "utf8" });
  const number = (text: string): number | null => {
    const n = Number(text.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  return {
    read(scope) {
      const r = run("read", scope);
      if (r.status === 3) return null;
      if (r.status !== 0) return "unreadable";
      return number(r.stdout) ?? "unreadable";
    },
    bump(scope) {
      const r = run("bump", scope);
      return r.status === 0 ? number(r.stdout) : null;
    },
  };
}

/** The helper Realm ships: the dev tree first, then the packaged Resources directory, as for the
 *  other helpers — and, like `deviceowner`, no environment override, which would be a way to point
 *  Realm at a stamp that says whatever it is told. */
export function policyStampHelper(appPath: string, resourcesPath: string): string | null {
  if (process.platform !== "darwin") return null;
  const dev = join(appPath, "native", "bin", "policystamp");
  if (existsSync(dev)) return dev;
  const packaged = join(resourcesPath, "policystamp");
  return existsSync(packaged) ? packaged : null;
}
