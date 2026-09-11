import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The command line for a guest, as a pure function (Plan 25 W5).
 *
 * No I/O, no `fs`, no `spawn` — the split `browser-host.ts` makes against Electron, for the same
 * reason: every flag below is a decision, several of them are security decisions, and a decision
 * that can only be exercised by booting a virtual machine is a decision nobody will test.
 *
 * Verified against QEMU 10.2.0 on this Mac, September 2026. Where a comment says a flag was measured,
 * it was: the boot, the binding and the QMP conversation were all run.
 */

export type QemuArch = "aarch64" | "x86_64";

export type QemuSpec = {
  arch: QemuArch;
  /** The machine's own directory: disk, nvram, secret, QMP socket, log. */
  dir: string;
  /** Where Homebrew's firmware lives — `qemu-locator.ts` finds it. */
  shareDir: string;
  /** The VNC display number, so the port is 5900 + this. */
  display: number;
  memoryMb: number;
  cpus: number;
  /** The disk's ceiling in GB. qcow2 is sparse, so this is not an allocation — a guest that is
   *  never installed costs a few hundred kilobytes whatever this says. */
  diskGb?: number;
  /** Shown in QEMU's own window title and in `ps`. The machine's name, so a process list is legible. */
  title: string;
  /** Where QMP listens. Passed in rather than derived from `dir`, because it deliberately is NOT in
   *  `dir` — see `qmpSocketPath`. Keeping it a parameter is also what keeps this function pure. */
  qmpPath: string;
  /** An installer to boot from, if this guest has not been installed yet. */
  isoPath?: string | null;
  /** Hardware acceleration, when the host can give it. `qemu-locator.ts` decides. */
  accel: "hvf" | "tcg";
};

/** 5900 is display 0, which is what every VNC client assumes when given none. */
export const VNC_BASE_PORT = 5900;
export const portForDisplay = (display: number): number => VNC_BASE_PORT + display;

/**
 * The five flags that will be missed and then needed.
 *
 * Named as a constant so the tests can assert against the same list the comment describes, rather
 * than against strings copied out of it by hand.
 */
export const LOAD_BEARING = {
  /** MEASURED: `-vnc :72` binds `*:5972` — the guest's screen on every interface, on the LAN. The
   *  host-qualified form binds `127.0.0.1:5971` only. This is the security flag in the whole file. */
  loopbackVnc: "127.0.0.1:",
  /** The default is `allow-exclusive`, which lets a second client EVICT the first. The human's view
   *  must never be interruptible by the agent's, and the agent has its own socket. */
  shareIgnore: "share=ignore",
  /** `file=`, never `data=`: argv is world-readable through `ps`, so a password passed inline is a
   *  password every process on this Mac can read. */
  secretFile: "-object",
  /** Without an absolute pointing device, QMP's absolute coordinates are meaningless and every agent
   *  click lands somewhere else. The agent's entire addressing model depends on this one device, so
   *  it is asserted here rather than left to a defaults helper somewhere. */
  tablet: "virtio-tablet-pci",
  /** A unix socket has filesystem permissions. A QMP port on loopback is an unauthenticated
   *  total-control channel with no token in front of it. */
  qmpUnix: "-qmp",
} as const;

export const diskPath = (dir: string): string => join(dir, "disk.qcow2");
export const nvramPath = (dir: string): string => join(dir, "nvram.fd");
export const secretPath = (dir: string): string => join(dir, "vnc.secret");
/**
 * Where a guest's QMP socket lives, and why it is not beside its disk.
 *
 * **A unix socket path may not exceed 104 bytes on macOS** — `sun_path` in `sockaddr_un` — and QEMU
 * refuses to start with "UNIX socket path is too long" when it does. A machine directory is
 * `<realmHome>/machines/<26-char ULID>/`, which fits under a short home and does not under a long
 * one: a deeper `REALM_HOME`, a synced folder, or simply a longer user name. Found by a demo, where
 * the scratch home pushed it over.
 *
 * So the socket goes in the per-user temp directory under a 10-character digest of the machine id —
 * deterministic, so a restart finds the same name, and short enough that the whole path is well
 * under the limit whatever the home is. The DISK, the nvram and the log stay in the machine's own
 * directory, where they belong and where no such limit applies.
 *
 * The directory is created at 0700 by the manager: a unix socket's access control is its path's, and
 * a QMP socket anyone could connect to is an unauthenticated total-control channel.
 */
export const QMP_DIR = join(tmpdir(), "realm-qmp");
export const qmpSocketPath = (machineId: string): string =>
  join(QMP_DIR, `${createHash("sha256").update(machineId).digest("hex").slice(0, 10)}.sock`);

/** The platform's own limit, so the manager can refuse with a sentence rather than letting QEMU
 *  fail with one nobody expects. */
export const UNIX_PATH_MAX = 104;
export const logPath = (dir: string): string => join(dir, "qemu.log");

/** The firmware for an architecture. MEASURED: Homebrew ships `edk2-aarch64-code.fd` and
 *  `edk2-x86_64-code.fd`, and NEITHER of the matching `-vars` files — see `nvramBytes`. */
export const firmwareCode = (shareDir: string, arch: QemuArch): string =>
  join(shareDir, arch === "aarch64" ? "edk2-aarch64-code.fd" : "edk2-x86_64-code.fd");

/**
 * How large the writable UEFI variable store is.
 *
 * MEASURED, because the obvious answer was unavailable: Homebrew ships no `edk2-aarch64-vars.fd` to
 * copy, and the near-miss `edk2-arm-vars.fd` is the 32-bit one. A 64 MiB zero-filled pflash on unit
 * 1 boots `edk2-aarch64-code.fd` with no complaint and the firmware WRITES to it, so boot entries
 * persist — which is what the vars file would have been for.
 */
export const NVRAM_BYTES = 64 * 1024 * 1024;

export function qemuBinary(arch: QemuArch): string {
  return `qemu-system-${arch}`;
}

/**
 * Build the argv.
 *
 * The x86_64 branch is not a variation on the aarch64 one and is not written as one: a different
 * machine type, a different accelerator, a different display device, and half the vCPUs. TCG scales
 * badly — more vCPUs mostly add lock contention — so asking for eight makes a guest slower, not
 * faster, and a defaults table that "just used `cpus`" would do exactly that.
 */
export function buildQemuArgv(spec: QemuSpec): string[] {
  const argv: string[] = [];
  const push = (...a: string[]) => argv.push(...a);

  if (spec.arch === "aarch64") {
    push("-machine", `virt,accel=${spec.accel}${spec.accel === "hvf" ? ",highmem=on" : ""}`);
    // `-cpu host` only under hvf: it means "the CPU this is running on", which TCG has no way to
    // emulate. An aarch64 guest under TCG needs a named model, and `max` is the one that works.
    push("-cpu", spec.accel === "hvf" ? "host" : "max");
    push("-smp", String(Math.max(1, spec.cpus)));
  } else {
    push("-machine", `q35,accel=${spec.accel}`);
    push("-cpu", "qemu64");
    if (spec.accel === "tcg") push("-accel", "tcg,thread=multi");
    // TCG scales badly. Two is the point past which more vCPUs are mostly lock contention.
    push("-smp", String(Math.min(2, Math.max(1, spec.cpus))));
  }
  push("-m", String(spec.memoryMb));

  // Firmware: read-only code, writable vars. Unit 1 is a 64MiB zero-filled file this repo creates
  // rather than a `-vars.fd` Homebrew does not ship — see NVRAM_BYTES.
  push("-drive", `if=pflash,format=raw,unit=0,readonly=on,file=${firmwareCode(spec.shareDir, spec.arch)}`);
  push("-drive", `if=pflash,format=raw,unit=1,file=${nvramPath(spec.dir)}`);
  push("-drive", `if=virtio,format=qcow2,file=${diskPath(spec.dir)},cache=writeback,discard=unmap`);

  // `virtio-vga` does not exist in the aarch64 binary — MEASURED; it is x86_64 only.
  if (spec.arch === "aarch64") push("-device", "virtio-gpu-pci,xres=1280,yres=800");
  else push("-device", "virtio-vga,xres=1280,yres=800");

  // The tablet is the agent's whole addressing model: without an ABSOLUTE pointing device, QMP's
  // absolute coordinates mean nothing and every click lands somewhere else.
  push("-device", "qemu-xhci", "-device", "usb-kbd", "-device", LOAD_BEARING.tablet);

  // SLIRP: the guest reaches out, nothing reaches in. No bridge, no tap, no port forwarding — a
  // guest that could be connected to from the LAN is a guest whose blast radius stopped being a
  // disk image.
  push("-netdev", "user,id=net0", "-device", "virtio-net-pci,netdev=net0");

  // `file=`, never `data=`: argv is world-readable through `ps`.
  push("-object", `secret,id=vncpw,format=raw,file=${secretPath(spec.dir)}`);
  // The security flag. MEASURED: the bare `:N` form binds every interface.
  push("-vnc", `${LOAD_BEARING.loopbackVnc}${spec.display},password-secret=vncpw,${LOAD_BEARING.shareIgnore}`);
  push("-display", "none");
  // A unix socket has filesystem permissions; a QMP port on loopback is an unauthenticated
  // total-control channel with no token in front of it.
  push("-qmp", `unix:${spec.qmpPath},server=on,wait=off`);
  push("-name", spec.title);
  push("-rtc", "base=utc");

  if (spec.isoPath) push("-cdrom", spec.isoPath, "-boot", "order=d");
  return argv;
}

/**
 * What the UI says about how fast this guest will be.
 *
 * Said out loud rather than left to be discovered: an x86_64 guest on Apple Silicon runs under TCG
 * at roughly a tenth of native, and a user who was not told reads that as Realm being broken.
 */
export function accelNote(arch: QemuArch, accel: "hvf" | "tcg"): string | null {
  if (accel === "hvf") return null;
  return arch === "x86_64"
    ? "This is an Intel guest on an Apple Silicon Mac, so every instruction is emulated — expect it to run roughly 10–30× slower than native."
    : "Running without hardware acceleration, so expect it to be slow.";
}
