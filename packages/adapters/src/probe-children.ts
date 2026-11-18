import { execFile, type ExecFileOptions } from "node:child_process";
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

/**
 * `execFile` for a probe: the child leads a process group of its own (POSIX), so an npm shim and the
 * binary it starts end together, and `endProbes` ends it.
 */
export function execProbe(command: string, args: string[], o: ExecFileOptions & { platform?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  const { platform = process.platform, ...options } = o;
  const group = platform !== "win32";
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { ...options, encoding: "utf8", ...(group ? { detached: true } : {}) }, (err, stdout, stderr) => {
      release();
      if (err) reject(Object.assign(err, { stdout, stderr })); else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    const release = keepProbeChild(() => {
      if (group && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      else killTree(child, "SIGKILL", platform);
    });
  });
}
