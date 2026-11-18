import { spawn } from "node:child_process";
import { killTree } from "./spawn-target";

/** What ends each child a probe has running right now, and everything that child started. */
const running = new Set<() => void>();

/** Keeps `end` until the returned release is called; `endProbes` calls every `end` still kept. */
export function keepProbeChild(end: () => void): () => void {
  running.add(end);
  return () => { running.delete(end); };
}

/**
 * Ends every probe child still running, at once and with what it started. For shutdown: a probe's
 * answer is advisory, and a CLI that ignores its closed stdin (opencode, Hermes) would otherwise
 * outlive the app by its own timeout.
 */
export function endProbes(): void {
  for (const end of [...running]) {
    running.delete(end);
    try { end(); } catch { /* already gone */ }
  }
}

export type ProbeRunOptions = { timeout?: number; killSignal?: NodeJS.Signals; cwd?: string; env?: NodeJS.ProcessEnv; windowsHide?: boolean; windowsVerbatimArguments?: boolean; platform?: string };

/**
 * `execFile` for a probe, failing the same way (`code`, `signal`, `killed`, `stdout`, `stderr` on the
 * error), but with the child leading a process group of its own on POSIX, so `endProbes` ends an npm
 * shim and the binary it started together. Built on `spawn` because `execFile` drops `detached`.
 */
export function execProbe(command: string, args: string[], o: ProbeRunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const { platform = process.platform, timeout = 0, killSignal = "SIGTERM", ...options } = o;
  const group = platform !== "win32";
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"], ...(group ? { detached: true } : {}) });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout.setEncoding("utf8").on("data", (c: string) => { stdout += c; });
    child.stderr.setEncoding("utf8").on("data", (c: string) => { stderr += c; });
    const kill = (signal: NodeJS.Signals) => {
      killed = true;
      if (group && child.pid !== undefined) process.kill(-child.pid, signal);
      else killTree(child, signal, platform);
    };
    const timer = timeout > 0 ? setTimeout(() => { try { kill(killSignal); } catch { /* gone */ } }, timeout) : null;
    const release = keepProbeChild(() => kill("SIGKILL"));
    const settle = (err: Error | null) => {
      if (timer) clearTimeout(timer);
      release();
      if (err) reject(Object.assign(err, { killed, stdout, stderr })); else resolve({ stdout, stderr });
    };
    child.on("error", settle);
    child.on("close", (code, signal) => {
      if (code === 0) settle(null);
      else settle(Object.assign(new Error(`Command failed: ${[command, ...args].join(" ")}`), { code, signal }));
    });
  });
}
