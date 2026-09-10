import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer, type Server } from "node:net";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { QemuManager, STDERR_TAIL_LINES } from "./qemu-manager";
import { NVRAM_BYTES, secretPath, type QemuSpec } from "./qemu-argv";

/** A QEMU that never was. Everything the manager does to a child is done to this. */
class FakeChild extends EventEmitter {
  stderr = new PassThrough();
  killed: string[] = [];
  /** A guest that ignores ACPI and SIGTERM but cannot ignore SIGKILL — which is every real one. */
  deaf = false;
  kill(sig: string) {
    this.killed.push(sig);
    if (sig === "SIGKILL" || !this.deaf) queueMicrotask(() => this.exit(null, sig));
    return true;
  }
  exit(code: number | null, signal: string | null = null) { this.emit("exit", code, signal); }
}

const qmpServers: Server[] = [];
afterEach(() => { for (const s of qmpServers.splice(0)) s.close(); });

/** A QMP socket that greets and answers, so the manager's readiness walk can get past step 2. */
function qmpSocketAt(path: string, status = "running") {
  const server = createServer((s) => {
    s.write(`${JSON.stringify({ QMP: { version: {} } })}\n`);
    let buf = "";
    s.on("error", () => {});
    s.on("data", (d) => {
      buf += d.toString();
      for (;;) {
        const i = buf.indexOf("\n"); if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { execute: string };
        if (msg.execute === "query-status") s.write(`${JSON.stringify({ return: { status, running: status === "running" } })}\n`);
        else s.write(`${JSON.stringify({ return: {} })}\n`);
      }
    });
  });
  qmpServers.push(server);
  return new Promise<void>((r) => server.listen(path, () => r()));
}

function harness(over: { reachable?: boolean; status?: string; readyTimeoutMs?: number } = {}) {
  const dir = tempDir("realm-qemu-");
  mkdirSync(dir, { recursive: true });
  const children: FakeChild[] = [];
  const spawned: { cmd: string; args: string[] }[] = [];
  const exits: { reason: string; disposed: boolean }[] = [];
  const probes: number[] = [];
  const manager = new QemuManager({
    spawn: (cmd, args) => {
      spawned.push({ cmd, args });
      const c = new FakeChild();
      children.push(c);
      // QEMU makes its control socket shortly after starting; the fake does the same.
      void qmpSocketAt(join(dir, "qmp.sock"), over.status ?? "running");
      return c as never;
    },
    probeConnect: async (p) => { probes.push(p); return over.reachable ?? true; },
    readyTimeoutMs: over.readyTimeoutMs ?? 4000,
  });
  const spec: QemuSpec = {
    arch: "aarch64", dir, shareDir: "/opt/homebrew/share/qemu", display: 71,
    memoryMb: 2048, cpus: 4, title: "Test guest", accel: "hvf",
  };
  const start = () => manager.start("m1", spec, (reason, disposed) => exits.push({ reason, disposed }));
  /** `start` writes the secret and the nvram before it spawns, so a fixed delay races the setup. */
  const child = async (): Promise<FakeChild> => {
    const t0 = Date.now();
    while (children.length === 0 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 5));
    if (!children[0]) throw new Error("nothing was spawned");
    return children[0];
  };
  return { dir, manager, spec, start, child, children, spawned, exits, probes };
}

describe("bringing a guest up", () => {
  /**
   * `running` means four things, and the fourth is the one that gets dropped.
   *
   * A machine reported as running whose VNC port is not accepting is a pane sitting on "Starting…"
   * with nothing to say — because the renderer's ENTIRE job is to open that socket. "QEMU says it is
   * up" is a different claim from "the socket the pane will open accepts".
   */
  it("waits for the port the renderer will actually open, not just for QEMU to say it is running", async () => {
    const h = harness();
    const handle = await h.start();
    expect(handle.port).toBe(5971);
    expect(h.probes).toContain(5971);
  });

  it("refuses AND kills the child when the guest never becomes reachable", async () => {
    const h = harness({ reachable: false, readyTimeoutMs: 700 });
    await expect(h.start()).rejects.toThrow(/nothing is accepting on its screen port/);
    // Both halves matter. A rejection that left QEMU running would leak a virtual machine per failed
    // start, holding its own disk image's lock against the next attempt.
    expect(h.children[0]!.killed.length).toBeGreaterThan(0);
    expect(h.manager.has("m1")).toBe(false);
  });

  it("gives up on a guest that never reaches a running state", async () => {
    const h = harness({ status: "prelaunch", readyTimeoutMs: 700 });
    await expect(h.start()).rejects.toThrow(/never reached a running state/);
  });

  /* The stderr tail is where QEMU says what was wrong — "Could not access KVM", "image is locked".
     A failure without it is a spinner that stopped. */
  it("carries QEMU's own last words into the failure", async () => {
    const h = harness({ reachable: false, readyTimeoutMs: 700 });
    const pending = h.start();
    (await h.child()).stderr.write("qemu-system-aarch64: Failed to lock byte 100\n");
    await expect(pending).rejects.toThrow(/Failed to lock byte 100/);
  });

  it("refuses to start a machine that is already running", async () => {
    const h = harness();
    await h.start();
    await expect(h.start()).rejects.toThrow(/already running/);
  });
});

describe("what a boot leaves on disk", () => {
  it("writes a fresh VNC secret at 0600, per boot", async () => {
    const h = harness();
    await h.start();
    const path = secretPath(h.dir);
    // 0600 because it is a password; per boot because it exists for the length of one run and a file
    // that outlived the process would be a password on disk with no owner.
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8").length).toBeGreaterThan(20);
  });

  /**
   * MEASURED: Homebrew ships no `edk2-aarch64-vars.fd` to copy, and a 64 MiB zero-filled pflash on
   * unit 1 boots the aarch64 firmware and gets written — so boot entries persist.
   *
   * Written with `wx`, which is the load-bearing part: recreating it on every boot would wipe the
   * boot order the firmware just saved, and a guest that installed an OS would never boot from its
   * own disk again.
   */
  it("creates the UEFI variable store once, and never overwrites it", async () => {
    const h = harness();
    await h.start();
    const path = join(h.dir, "nvram.fd");
    expect(statSync(path).size).toBe(NVRAM_BYTES);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, Buffer.concat([Buffer.from("BOOTORDER"), Buffer.alloc(NVRAM_BYTES - 9)]));
    await h.manager.stop("m1", false);
    h.children[0]!.exit(0);
    await h.start();
    expect(readFileSync(path).subarray(0, 9).toString()).toBe("BOOTORDER");
  });

  it("keeps only the last lines of stderr, rather than a whole boot's worth", async () => {
    const h = harness();
    await h.start();
    for (let i = 0; i < STDERR_TAIL_LINES + 20; i++) h.children[0]!.stderr.write(`line ${i}\n`);
    await new Promise((r) => setTimeout(r, 50));
    const tail = h.manager.stderrTail("m1");
    expect(tail).toHaveLength(STDERR_TAIL_LINES);
    expect(tail[tail.length - 1]).toBe(`line ${STDERR_TAIL_LINES + 19}`);
  });
});

describe("taking a guest down", () => {
  /* `system_powerdown` is what lets a Linux guest flush its filesystem — the difference between a
     clean shutdown and a disk image that fscks on next boot. */
  it("asks the guest to power down before signalling it", async () => {
    const h = harness();
    await h.start();
    const stopping = h.manager.stop("m1", true);
    await new Promise((r) => setTimeout(r, 50));
    // It exits in answer to the ACPI request, so no signal is ever needed.
    h.children[0]!.exit(0);
    await stopping;
    expect(h.children[0]!.killed).toEqual([]);
  });

  it("escalates to SIGTERM and then SIGKILL for a guest that ignores ACPI", async () => {
    const h = harness();
    await h.start();
    h.children[0]!.deaf = true;
    const stopping = h.manager.stop("m1", true);
    await new Promise((r) => setTimeout(r, 8200));
    expect(h.children[0]!.killed).toEqual(["SIGTERM", "SIGKILL"]);
    await stopping;
  }, 15000);

  /**
   * Crash vs deliberate kill branches on the `disposed` FLAG, never on parsing the reason.
   *
   * A SIGTERM Realm sent and a SIGTERM the OOM killer sent are the same signal, and only this side
   * knows which. Reading the exit reason to decide would make an OOM look like a user pressing stop
   * — and the machine would go quietly `off` instead of `failed` with a reason.
   */
  it("tells a stop apart from a crash by the flag, not by the exit code", async () => {
    const crash = harness();
    await crash.start();
    crash.children[0]!.stderr.write("qemu: hardware error\n");
    await new Promise((r) => setTimeout(r, 30));
    crash.children[0]!.exit(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(crash.exits[0]).toEqual({ reason: "qemu: hardware error", disposed: false });

    const stopped = harness();
    await stopped.start();
    await stopped.manager.stop("m1", false);
    await new Promise((r) => setTimeout(r, 30));
    expect(stopped.exits[0]).toEqual({ reason: "stopped", disposed: true });
  });

  it("reports a spawn failure as the command that could not run", async () => {
    const h = harness();
    const pending = h.start();
    (await h.child()).emit("error", new Error("spawn qemu-system-aarch64 ENOENT"));
    await pending.catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    // A spawn failure is not a crash: the command never ran, and naming it is the useful thing.
    expect(h.exits[0]!.reason).toContain("could not run qemu-system-aarch64");
  });

  it("stopping something that is not running is not an error", async () => {
    const h = harness();
    await expect(h.manager.stop("nothing", true)).resolves.toBeUndefined();
  });
});

describe("the command line it actually runs", () => {
  it("spawns the architecture's own binary with the built argv", async () => {
    const h = harness();
    await h.start();
    expect(h.spawned[0]!.cmd).toBe("qemu-system-aarch64");
    const joined = h.spawned[0]!.args.join(" ");
    // The security flag, all the way through the manager rather than only in the builder's tests.
    expect(joined).toContain("-vnc 127.0.0.1:71,password-secret=vncpw,share=ignore");
    expect(joined).toContain("virtio-tablet-pci");
    expect(joined).toContain(`unix:${join(h.dir, "qmp.sock")}`);
  });
});
