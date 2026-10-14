import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathDelimiter } from "@realm/contracts";

/**
 * A packaged app launched from Finder inherits launchd's minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`)
 * — no Homebrew, no node, no agent CLIs. The fix everyone ships (VS Code, Sublime, iTerm) is to ask the
 * user's login shell what PATH it would give a terminal, once at startup, and adopt it before anything
 * spawns. This module is that: `loginShellPath()` runs `$SHELL -l -i -c env` behind sentinels with a
 * timeout, and `mergePath()` folds the answer into the current PATH.
 *
 * Failure mode: an exotic shell that rejects `-l -i -c`, hangs at an interactive prompt, or prints no
 * parseable `env` output resolves to null (never throws, never blocks past the timeout), and the merge
 * falls back to the current PATH plus the standard Homebrew/local dirs.
 */

/**
 * Appended only when the login shell could not be asked — the two places macOS CLIs actually live
 * (on Linux, /usr/local/bin and Linuxbrew's), plus `~/.local/bin`, the install dir `uv tool install`
 * and `pipx install` use for Python CLI tools. None on Windows, where a GUI app inherits the PATH the
 * user set rather than a launcher's minimal one. A function, not a constant, so the home directory is
 * the real one at call time.
 */
export function fallbackExtraDirs(platform: string = process.platform): string[] {
  if (platform === "win32") return [];
  const dirs = platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : ["/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"];
  let home = "";
  // homedir() throws on a host with no passwd entry for the uid; a missing ~/.local/bin is not fatal.
  try { home = homedir(); } catch { home = ""; }
  if (home) dirs.push(join(home, ".local", "bin"));
  return dirs;
}

const START = "__REALM_ENV_START__";
const END = "__REALM_ENV_END__";

/**
 * Pull `PATH=` out of `env` output bracketed by the sentinels. The sentinels exist because an
 * interactive login shell talks (rc-file echo, plugin banners) before the command runs; only what sits
 * between the markers is trusted. Exported for tests.
 */
export function extractPathFromEnvOutput(stdout: string, start = START, end = END): string | null {
  const s = stdout.indexOf(start);
  const e = stdout.lastIndexOf(end);
  if (s === -1 || e === -1 || e <= s) return null;
  for (const line of stdout.slice(s + start.length, e).split("\n")) {
    if (line.startsWith("PATH=")) {
      const v = line.slice("PATH=".length).trim();
      if (v) return v;
    }
  }
  return null;
}

/**
 * Union of login PATH (first, so its ordering wins) and the current PATH (nothing the process already
 * had is ever lost). When the login shell gave no answer, the fallback dirs are appended instead.
 */
export function mergePath(current: string | undefined, login: string | null, platform: string = process.platform): string {
  const sep = pathDelimiter(platform);
  const parts: string[] = [];
  const push = (p: string) => { if (p && !parts.includes(p)) parts.push(p); };
  for (const p of (login ?? "").split(sep)) push(p);
  for (const p of (current ?? "").split(sep)) push(p);
  if (login === null) for (const p of fallbackExtraDirs(platform)) push(p);
  return parts.join(sep);
}

/**
 * Ask the user's login shell for its PATH. `-l -i -c` as separate args (grouped `-lic` trips up some
 * shells); `-i` because a non-login-non-interactive zsh skips `/etc/zprofile`'s path_helper AND some
 * setups only extend PATH in `.zshrc`. `/usr/bin/env` (a binary, absolute path) prints the actual
 * environment, immune to each shell's quoting rules — `"$PATH"` notably means something else in fish.
 */
export function loginShellPath(shell = process.env.SHELL || "/bin/zsh", timeoutMs = 5000, platform: string = process.platform): Promise<string | null> {
  // Windows has no login shell to ask and needs none: Explorer hands a GUI app the user's own PATH.
  if (platform === "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-l", "-i", "-c", `echo ${START}; /usr/bin/env; echo ${END}`],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8" },
      // Even on error (timeout kill, nonzero rc-file exit) stdout may already hold the answer.
      (_err, stdout) => resolve(typeof stdout === "string" ? extractPathFromEnvOutput(stdout) : null),
    );
  });
}
