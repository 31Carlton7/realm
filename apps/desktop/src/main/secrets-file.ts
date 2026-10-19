/**
 * `secrets.json` on disk — the filesystem half of never losing a saved sign-in to the file itself.
 * `SecretStore` decides what it cannot read; this writes the file whole or not at all, reads it past
 * a momentary refusal, and moves an unreadable one aside instead of letting anything write over it.
 */
import * as nodeFs from "node:fs";
import { dirname, join } from "node:path";

/** The calls made here, so a test can stop one partway — the crash between writing and renaming. */
export type SecretsFs = Pick<typeof nodeFs, "openSync" | "writeFileSync" | "fsyncSync" | "closeSync" | "renameSync" | "rmSync" | "readFileSync" | "existsSync">;

/**
 * Replace the file with `text` so that a crash at any moment leaves the old file or the new one,
 * never half of either: written to a temporary file beside it, flushed to the disk, then renamed over
 * it, which the filesystem does in one step. 0600, as the file has always been.
 */
export function writeSecretsFile(path: string, text: string, fs: SecretsFs = nodeFs): void {
  const temp = `${path}.tmp`;
  try {
    const fd = fs.openSync(temp, "w", 0o600);
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, path);
  } catch (e) {
    fs.rmSync(temp, { force: true });
    throw e;
  }
}

/** Errors a read can fail with for a moment and then not — another process holding the file, a
 *  scanner, a permission that is being changed. */
const MOMENTARY = new Set(["EBUSY", "EACCES", "EPERM", "EAGAIN"]);
/** The waits between tries, a third of a second in all: long enough to outlast a scanner's hold, and
 *  short, because main is waiting on it. */
export const READ_RETRY_MS = [50, 100, 200];

const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * The file's text, or null when there is none. A read that fails with an error that may be momentary
 * is tried again before it is believed, and one that still fails throws, so the store writes nothing
 * and asks again next time. Failing to read the file never means its contents are bad.
 */
export function readSecretsFile(path: string, d: { fs?: SecretsFs; sleep?: (ms: number) => void } = {}): string | null {
  const fs = d.fs ?? nodeFs;
  const sleep = d.sleep ?? sleepSync;
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.readFileSync(path, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (code === "ENOENT") return null;
      if (!MOMENTARY.has(code) || attempt >= READ_RETRY_MS.length) throw e;
      sleep(READ_RETRY_MS[attempt]!);
    }
  }
}

/**
 * Move an unreadable store aside, unopened and unchanged, as `secrets.unreadable-<when>.json` beside
 * it, and return where it went. Never over another one: each holds somebody's sign-ins. The time is
 * ISO 8601 with its colons and dot turned to dashes, which Windows refuses in a name and Finder
 * shows as slashes.
 */
export function setAsideSecretsFile(path: string, at: Date, fs: SecretsFs = nodeFs): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  for (let n = 1; ; n++) {
    const aside = join(dirname(path), `secrets.unreadable-${stamp}${n === 1 ? "" : `-${n}`}.json`);
    if (fs.existsSync(aside)) continue;
    fs.renameSync(path, aside);
    return aside;
  }
}
