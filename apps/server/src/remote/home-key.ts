import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { SECRET_KEY_BYTES } from "@realm/contracts/src/secret-box";

/**
 * The `remote` key of a server with no Realm window: a Linux box, or a Mac running `realm serve` with
 * the app closed. On a Mac the app hands its key over from the Keychain; with no app there is nobody
 * to ask, and Realm Mobile could never pair. So a headless server keeps a key of its own, beside the
 * home it serves — 32 random bytes, base64, in a 0600 file in a 0700 folder — or reads one from
 * `REALM_REMOTE_KEY_FILE` (a systemd credential, `LoadCredential=`), which it never writes.
 *
 * Honest about what that buys: the identity in `realm.db` is sealed, so a copy of the database alone
 * opens nothing, but anyone who can read this home as its user can read the key too — the same reach
 * that already reads `daemon.json` and drives the server. A Keychain item is the better place, and a
 * Mac with the app open uses it.
 */
export type HomeKey = {
  file: string;
  /** Whether this server may make the file when it is missing: only one started by `realm serve`, and
   *  only at `REALM_HOME`'s own path. A server the app started never makes one. */
  create: boolean;
};

export const homeKeyFile = (home: string): string => join(home, "keys", "remote.key");

export class HomeKeyError extends Error {}

/** The key in `file`, or null when there is no file. A file that is not a key, or that other users
 *  can read, is refused — as ssh refuses such a key — rather than trusted. */
export function readHomeKey(file: string): Buffer | null {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new HomeKeyError(`can't read ${file}: ${(e as Error).message}`);
  }
  if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) {
    throw new HomeKeyError(`${file} can be read by other users; run chmod 600 ${file}`);
  }
  const key = Buffer.from(text.trim(), "base64");
  if (key.length !== SECRET_KEY_BYTES || key.toString("base64") !== text.trim()) {
    throw new HomeKeyError(`${file} is not a Realm key (32 bytes, base64)`);
  }
  return key;
}

/** A new key, written where none is. `wx` makes the write the check: two servers racing cannot both
 *  make one and each seal under its own. */
export function makeHomeKey(file: string): Buffer {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const key = randomBytes(SECRET_KEY_BYTES);
  const fd = openSync(file, "wx", 0o600);
  try { writeSync(fd, `${key.toString("base64")}\n`); } finally { closeSync(fd); }
  return key;
}
