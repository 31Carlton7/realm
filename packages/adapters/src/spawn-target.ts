import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { resolve } from "node:path";
import { executableNames, needsShell, pathDelimiter } from "@realm/contracts";

type Env = Record<string, string | undefined>;

/**
 * The file a bare command name runs, found the way a spawn would find it, or null.
 *
 * On a Mac and Linux that is the first executable `name` on PATH. On Windows it is the first PATHEXT
 * match — `claude.cmd` from npm, `codex.exe` from a native install — which libuv's own lookup does not
 * do for anything but `.com` and `.exe`, so `spawn("codex")` fails there for every npm-installed CLI.
 * A name that already has a directory in it is checked where it is.
 */
export function findExecutable(name: string, env: Env = process.env, platform: string = process.platform): string | null {
  const names = executableNames(name, platform, env);
  const hasDir = /[\\/]/.test(name);
  const dirs = hasDir ? [""] : (env.PATH ?? env.Path ?? "").split(pathDelimiter(platform));
  for (const dir of dirs) {
    if (!hasDir && !dir) continue;
    for (const n of names) {
      const candidate = hasDir ? n : resolve(dir, n);
      try {
        // On Windows the extension is what makes a file runnable (Node's X_OK is F_OK there); a
        // directory named like the command is not one.
        accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        if (platform === "win32" && statSync(candidate).isDirectory()) continue;
        return candidate;
      } catch {
        // Not here, or not executable: the next entry is the next candidate, as for a spawn.
      }
    }
  }
  return null;
}

/** cmd.exe's metacharacters, which a caret escapes. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument quoted for `cmd.exe /d /s /c "…"` and then for the program's own argv parser — the
 *  same two layers cross-spawn escapes for. An npm shim re-parses `%*`, so its arguments take the
 *  carets twice. */
function cmdArg(arg: string, shim: boolean): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  a = `"${a}"`.replace(CMD_META, "^$1");
  return shim ? a.replace(CMD_META, "^$1") : a;
}

export type SpawnTarget = { command: string; args: string[]; options: { windowsVerbatimArguments?: boolean } };

/**
 * What to hand `spawn`/`execFile` to run `command args` on this OS.
 *
 * Unchanged on a Mac and Linux. On Windows a bare name is resolved through PATHEXT first, and a batch
 * file — every npm-installed CLI — goes through `cmd.exe` with its arguments escaped, because Node
 * refuses to spawn a `.cmd` directly (CVE-2024-27980) and `shell: true` would hand cmd the arguments
 * unescaped.
 */
export function spawnTarget(command: string, args: string[], o: { env?: Env; platform?: string } = {}): SpawnTarget {
  const platform = o.platform ?? process.platform;
  if (platform !== "win32") return { command, args, options: {} };
  const env = o.env ?? process.env;
  const bin = findExecutable(command, env, platform) ?? command;
  if (!needsShell(bin, platform)) return { command: bin, args, options: {} };
  const shim = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(bin);
  const line = [bin.replace(CMD_META, "^$1"), ...args.map((a) => cmdArg(a, shim))].join(" ");
  return { command: env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], options: { windowsVerbatimArguments: true } };
}

/**
 * Ends a child and everything it started. On Windows a signal reaches only the process it names, and
 * a CLI started through `cmd.exe` is that shell's child, so `taskkill /T` takes the tree; elsewhere
 * it is the signal it always was.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL", platform: string = process.platform, spawnFn: typeof spawn = spawn): void {
  if (platform === "win32" && child.pid !== undefined) {
    spawnFn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill(signal));
    return;
  }
  child.kill(signal);
}
