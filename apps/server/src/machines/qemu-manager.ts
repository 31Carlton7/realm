import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { buildQemuArgv, logPath, nvramPath, portForDisplay, qemuBinary, secretPath, qmpPath, NVRAM_BYTES, type QemuSpec } from "./qemu-argv";
import { QmpClient } from "./qmp";

/**
 * One QEMU child, from spawn to reachable (Plan 25 W5). Process only — no DB, no items, no
 * broadcasts, after `terminals/manager.ts`.
 *
 * `spawn` and `probeConnect` are INJECTED, and that is the difference from the terminal manager: it
 * gets away with spawning `/bin/sh` in a unit test, and a virtual machine cannot be a test
 * dependency. Everything below is exercised against a fake child.
 */
export type QemuManagerDeps = {
  spawn?: (cmd: string, args: string[]) => ChildProcess;
  /** "can I REACH it" — the mirror of `probePort`'s "can I bind it". */
  probeConnect?: (port: number) => Promise<boolean>;
  /** How long a guest has to become reachable before Realm gives up and kills it. */
  readyTimeoutMs?: number;
  log?: (line: string) => void;
};

export type QemuHandle = {
  readonly machineId: string;
  readonly port: number;
  readonly qmp: QmpClient;
  /** Kill it. `system_powerdown` first where the guest can take it — see `stop`. */
  stop(graceful: boolean): Promise<void>;
};

/** How many lines of stderr the death message carries. QEMU's stderr is not a terminal and there is
 *  no consumer for a stream of it — but the LAST few lines are almost always the whole reason. */
export const STDERR_TAIL_LINES = 50;

/** How long `system_powerdown` gets before SIGTERM, and SIGTERM before SIGKILL. A Linux guest needs
 *  the first to flush its filesystem; a guest that ignores ACPI needs the rest to ever go away. */
const POWERDOWN_GRACE_MS = 5_000;
const TERM_GRACE_MS = 2_000;

export class QemuManager {
  private readonly running = new Map<string, { child: ChildProcess; handle: QemuHandle; tail: string[]; disposed: boolean }>();

  constructor(private readonly d: QemuManagerDeps = {}) {}

  has(machineId: string): boolean { return this.running.has(machineId); }
  handle(machineId: string): QemuHandle | null { return this.running.get(machineId)?.handle ?? null; }

  /**
   * Boot a guest and wait until it is genuinely usable.
   *
   * **`running` means four things, in order**, and the last is not redundant:
   *
   *   1. the child is alive;
   *   2. the QMP socket produces its greeting and `qmp_capabilities` succeeds;
   *   3. `query-status` reports `running`;
   *   4. **a TCP connect to the port the RENDERER will use succeeds.**
   *
   * Four, because each can be true while the next is false, and a machine reported as running whose
   * VNC port is not accepting is a pane that sits on "Starting…" with nothing to say. The renderer's
   * entire job is to open that socket, so nothing short of opening it is the same claim.
   */
  async start(machineId: string, spec: QemuSpec, onExit: (reason: string, disposed: boolean) => void): Promise<QemuHandle> {
    if (this.running.has(machineId)) throw new Error("that machine is already running");
    await mkdir(spec.dir, { recursive: true });
    // A fresh 32-byte secret per boot, at 0600. Per boot rather than stored: it exists for the
    // length of one run, nothing else ever needs it again, and a file that outlived the process
    // would be a password on disk with no owner.
    await writeFile(secretPath(spec.dir), randomBytes(32).toString("base64"), { mode: 0o600 });
    // The writable UEFI variable store. Created here rather than shipped because Homebrew ships no
    // `edk2-aarch64-vars.fd` — a 64MiB zero-filled pflash boots and gets written, which was measured.
    await writeFile(nvramPath(spec.dir), Buffer.alloc(NVRAM_BYTES), { flag: "wx" }).catch(() => { /* already there, and it holds the boot order */ });
    // A stale socket makes QEMU refuse to bind, with a message about the file rather than the port.
    await rm(qmpPath(spec.dir), { force: true });

    const argv = buildQemuArgv(spec);
    const bin = qemuBinary(spec.arch);
    const spawnFn = this.d.spawn ?? ((c: string, a: string[]) => nodeSpawn(c, a, { stdio: ["ignore", "ignore", "pipe"] }));
    const child = spawnFn(bin, argv);
    const tail: string[] = [];
    const entry = { child, tail, disposed: false, handle: null as unknown as QemuHandle };

    // Streamed to a file AND kept as a ring. Never broadcast line by line: QEMU's stderr is not a
    // terminal, and a log event stream would be a second pipeline with no consumer.
    const logStream = createWriteStream(logPath(spec.dir), { flags: "a" });
    child.stderr?.on("data", (d: Buffer) => {
      logStream.write(d);
      for (const line of d.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > STDERR_TAIL_LINES) tail.shift();
      }
    });

    const port = portForDisplay(spec.display);
    const qmp = new QmpClient(qmpPath(spec.dir));
    const handle: QemuHandle = {
      machineId, port, qmp,
      stop: async (graceful: boolean) => { await this.stop(machineId, graceful); },
    };
    entry.handle = handle;
    this.running.set(machineId, entry);

    child.on("exit", (code, signal) => {
      logStream.end();
      qmp.close();
      const wasDisposed = this.running.get(machineId)?.disposed ?? false;
      this.running.delete(machineId);
      /* Crash vs deliberate kill branches on the `disposed` FLAG, never on parsing the reason —
         that flag is the documented reason the adapters carry one. A SIGTERM Realm sent and a
         SIGTERM the OOM killer sent are the same signal, and only this side knows which. */
      const why = wasDisposed ? "stopped" : tail.length ? tail[tail.length - 1]! : `exited with ${signal ?? code}`;
      onExit(why, wasDisposed);
    });
    child.on("error", (e) => {
      logStream.end();
      qmp.close();
      this.running.delete(machineId);
      // A spawn failure is not a crash: the command never ran, and the useful thing to say is the
      // command itself. `ENOENT` here means QEMU was found at locate time and has gone since.
      onExit(`could not run ${bin}: ${e.message}`, false);
    });

    try {
      await this.waitReady(machineId, qmp, port);
    } catch (e) {
      // Killed with `disposed: true` so the exit handler does not report a crash the user caused by
      // asking for a machine that never came up — and the reason carries the stderr tail, which is
      // where QEMU says what was actually wrong.
      await this.stop(machineId, false);
      const detail = tail.length ? `\n${tail.slice(-8).join("\n")}` : "";
      throw new Error(`${e instanceof Error ? e.message : String(e)}${detail}`);
    }
    return handle;
  }

  /** The four conditions, in order, against a deadline that covers all of them together. */
  private async waitReady(machineId: string, qmp: QmpClient, port: number): Promise<void> {
    const deadline = Date.now() + (this.d.readyTimeoutMs ?? 60_000);
    const probe = this.d.probeConnect ?? (await import("../workspace/ports")).probeConnect;
    const alive = () => this.running.has(machineId);
    // 2: the control socket. QEMU creates it before it is listening on VNC, so this is also the
    // cheapest way to wait for the process to have got somewhere.
    for (;;) {
      if (!alive()) throw new Error("QEMU exited before it finished starting");
      if (Date.now() > deadline) throw new Error("QEMU did not finish starting in time");
      try { await qmp.connect(); break; } catch { await sleep(200); }
    }
    // 3: what QEMU itself says about the guest.
    for (;;) {
      if (!alive()) throw new Error("QEMU exited before it finished starting");
      if (Date.now() > deadline) throw new Error("the guest never reached a running state");
      const status = (await qmp.command("query-status").catch(() => null)) as { status?: string } | null;
      if (status?.status === "running") break;
      await sleep(200);
    }
    // 4: the port the RENDERER will open. Not redundant — that is the pane's entire job, and QEMU
    // reporting `running` says nothing about whether its VNC listener is accepting yet.
    for (;;) {
      if (!alive()) throw new Error("QEMU exited before it finished starting");
      if (Date.now() > deadline) throw new Error(`the guest is running but nothing is accepting on its screen port (${port})`);
      if (await probe(port)) return;
      await sleep(200);
    }
  }

  /**
   * `system_powerdown`, then SIGTERM, then SIGKILL.
   *
   * The first is what lets a Linux guest flush its filesystem — the difference between a clean
   * shutdown and a disk image that fscks on next boot. The rest are for a guest that ignores ACPI,
   * which includes every guest still in its firmware.
   */
  async stop(machineId: string, graceful = true): Promise<void> {
    const entry = this.running.get(machineId);
    if (!entry) return;
    entry.disposed = true;
    const gone = new Promise<void>((resolve) => entry.child.once("exit", () => resolve()));
    if (graceful) {
      await entry.handle.qmp.command("system_powerdown").catch(() => { /* no control socket; the signals below still work */ });
      if (await raced(gone, POWERDOWN_GRACE_MS)) return;
    }
    entry.child.kill("SIGTERM");
    if (await raced(gone, TERM_GRACE_MS)) return;
    entry.child.kill("SIGKILL");
    /* Bounded, even here. SIGKILL always works on a live process — but a child stuck in an
       uninterruptible syscall does not reap until it returns, and this is awaited from `app.ts`'s
       close: an unbounded wait makes quitting Realm hang on a machine rather than leaving one
       orphaned process behind. The map entry is dropped either way, so nothing keeps a handle to it. */
    if (!(await raced(gone, TERM_GRACE_MS))) {
      this.running.delete(machineId);
      this.d.log?.(`[machine ${machineId}] did not reap after SIGKILL; giving up on it`);
    }
  }

  /**
   * Quit. Awaited by the caller, and that matters: un-awaited it orphans QEMU, which then holds the
   * qcow2's own lock — and the next start fails with a message about a locked image that reads like
   * corruption.
   */
  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id, true)));
  }

  /** The last lines QEMU said, for a failure body that can show them. */
  stderrTail(machineId: string): string[] {
    return [...(this.running.get(machineId)?.tail ?? [])];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** True if `p` settled first. */
const raced = (p: Promise<void>, ms: number): Promise<boolean> =>
  Promise.race([p.then(() => true), sleep(ms).then(() => false)]);
