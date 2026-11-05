import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { compareVersions, parseVersion } from "@realm/contracts";
import { executablesOnPath, spawnTarget } from "./spawn-target";

const exec = promisify(execFile);

type Env = Record<string, string | undefined>;

/**
 * The newest install of a CLI on PATH, or null when there is none.
 *
 * Measured 2026-11-05: brew's `codex` 0.146.0 sat ahead of nvm's 0.166.0 on the server's PATH, so Realm
 * ran the stale cask and its picker lost every model the newer CLI knew.
 *
 * The first match stays unless another copy states a strictly newer `--version` AND the first states
 * one at all — a binary whose version cannot be read is not evidence the other is better. A name with
 * a directory in it (a REALM_*_BIN override) is used as given.
 */
export async function newestExecutable(name: string, env: Env = process.env, platform: string = process.platform): Promise<string | null> {
  const copies = [...distinct(executablesOnPath(name, env, platform))];
  if (copies.length <= 1) return copies[0] ?? null;
  const versions = await Promise.all(copies.map((path) => versionOf(path, env, platform)));
  let pick = 0;
  for (let i = 1; i < copies.length; i += 1) {
    const ours = versions[pick];
    const theirs = versions[i];
    if (ours && theirs && compareVersions(theirs, ours) > 0) pick = i;
  }
  return copies[pick] ?? null;
}

/** One path per real file: brew links and npm shims are often several names for the same binary. */
function* distinct(paths: Iterable<string>): Generator<string> {
  const seen = new Set<string>();
  for (const path of paths) {
    let real = path;
    try { real = realpathSync(path); } catch { /* a dangling link failed access already; keep the name */ }
    if (seen.has(real)) continue;
    seen.add(real);
    yield path;
  }
}

/** `--version` answers per file, keyed on what changes when the file is replaced, so an upgrade in place
 *  is read again and an unchanged copy is never re-run. */
const versionCache = new Map<string, Promise<string | null>>();

function versionOf(path: string, env: Env, platform: string): Promise<string | null> {
  let key: string;
  try {
    const real = realpathSync(path);
    const st = statSync(real);
    key = `${real}\0${st.mtimeMs}\0${st.size}`;
  } catch {
    return Promise.resolve(null);
  }
  let cached = versionCache.get(key);
  if (!cached) {
    const t = spawnTarget(path, ["--version"], { env, platform });
    cached = exec(t.command, t.args, { timeout: 5000, env: env as NodeJS.ProcessEnv, ...t.options }).then(
      ({ stdout }) => parseVersion(stdout),
      () => null,
    );
    versionCache.set(key, cached);
  }
  return cached;
}
