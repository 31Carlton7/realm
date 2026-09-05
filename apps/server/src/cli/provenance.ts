import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, resolve, sep } from "node:path";
import type { InstallProvenance } from "@realm/contracts";

/**
 * Where an agent CLI on this machine came from, so Realm never runs an update command that would not
 * update the copy the user is actually running.
 *
 * The whole method rests on one observation: **every package manager here installs the real file
 * somewhere characteristic and puts a symlink on PATH.** `/opt/homebrew/bin` holds both the brew
 * symlinks and the npm-global shims when node itself came from brew, so the directory on PATH proves
 * nothing — only the resolved target does.
 *
 *   brew   /opt/homebrew/bin/goose  → ../Cellar/block-goose-cli/1.9.0/bin/goose
 *   npm    /opt/homebrew/bin/codex  → ../lib/node_modules/@openai/codex/bin/codex.js
 *   pnpm   ~/Library/pnpm/codex     → ../pnpm/global/5/.pnpm/@openai+codex@0.1.0/node_modules/...
 *   script ~/.local/bin/cursor-agent → a real file, no marker at all
 */

/** Every marker is matched as a whole path SEGMENT (`/Cellar/`, not the substring "Cellar"), so a
 *  user directory called `~/Cellar-backups` or `~/node_modules-notes` cannot pass for a prefix. */
const hasSegment = (path: string, name: string): boolean => path.split(sep).includes(name);

/**
 * Classify a *resolved* (symlink-free) binary path.
 *
 * Order matters. A Homebrew formula may vendor a `node_modules` tree inside its Cellar keg
 * (`.../Cellar/opencode/1.2.3/libexec/node_modules/...`), and that install is brew's — `npm install -g`
 * would not touch it. So Cellar wins over node_modules, and `.pnpm` wins over the plain node_modules
 * that always encloses it.
 */
export function classifyPath(realPath: string): InstallProvenance {
  if (hasSegment(realPath, "Cellar")) return "brew";
  if (hasSegment(realPath, ".pnpm")) return "pnpm";
  if (hasSegment(realPath, "node_modules")) return "npm";
  return "unknown";
}

/**
 * Find `bin` the way a spawn would, then follow it to the real file.
 *
 * PATH is read from the passed environment rather than resolved through a shell: the server child was
 * started by the desktop main *after* `mergePath(loginShellPath())`, so `process.env.PATH` here is
 * already the PATH a terminal would have. Asking a login shell again from inside the server would be
 * a second, slower answer to a question already answered — and `login-shell-path.ts` exists precisely
 * because getting it wrong is subtle.
 *
 * Returns null when the binary is not on PATH, is not executable, or its symlink chain is broken.
 */
export async function resolveInstall(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ path: string; realPath: string; provenance: InstallProvenance } | null> {
  const candidates = bin.includes(sep)
    // An explicit path (a REALM_*_BIN override pointing at a stub) is used as given, not searched for.
    ? [isAbsolute(bin) ? bin : resolve(bin)]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => resolve(dir, bin));
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);
      const real = await realpath(path);
      return { path, realPath: real, provenance: classifyPath(real) };
    } catch {
      // Not here, not executable, or a dangling link — the next PATH entry is the next candidate,
      // exactly as a spawn would carry on.
    }
  }
  return null;
}
