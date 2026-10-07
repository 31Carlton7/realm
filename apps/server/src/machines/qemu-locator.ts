import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { QemuArch } from "./qemu-argv";

const run = promisify(execFile);

/**
 * Is QEMU here, and what can it do (Plan 25 W5)?
 *
 * **QEMU is detected, not shipped.** It is GPL-2.0, and putting it inside a signed, notarized
 * proprietary `.app` takes on a source-offer obligation every release. So Realm runs the user's own
 * install, and where there is none the local-VM source is **absent from the picker entirely** rather
 * than present and disabled — design.md: "Where the owner has said nothing, show nothing, not a
 * disabled control, which invites a user to work out how to enable something nobody has claimed."
 *
 * Everything is asked of the binary rather than assumed from a version number. A Homebrew build, a
 * MacPorts build and a hand-compiled one differ in which accelerators and devices they carry, and a
 * capability table in this repo would be a claim about somebody else's build.
 */
export type QemuCapabilities = {
  /** Absolute path to `qemu-system-<arch>`, or null when that architecture is not installed. */
  binaries: Partial<Record<QemuArch, string>>;
  /** Where the firmware lives — `<prefix>/share/qemu`. Null when it cannot be found, which makes
   *  every guest unbootable and is reported as such rather than failing at spawn. */
  shareDir: string | null;
  /** Hardware acceleration for the HOST's own architecture. `hvf` is Apple's hypervisor and only
   *  ever applies to a guest of the same architecture. */
  hvf: boolean;
  version: string | null;
  /** Why there is nothing usable here, in a sentence the pane can show. Null when there is. */
  unavailable: string | null;
};

/** Where a Mac keeps things. Homebrew on Apple Silicon, Homebrew on Intel, MacPorts, then whatever
 *  is on the PATH — which is the one that covers a hand-built install. */
const PREFIXES = ["/opt/homebrew", "/usr/local", "/opt/local"];

export type LocatorDeps = {
  /** Test seam. Production shells out; a test says what the binary would have answered. */
  exec?: (file: string, args: string[]) => Promise<{ stdout: string }>;
  exists?: (path: string) => boolean;
  /** Overrides everything, from the `machine.qemuPath` setting — for an install somewhere unusual. */
  qemuPath?: string | null;
};

export async function locateQemu(d: LocatorDeps = {}): Promise<QemuCapabilities> {
  const exists = d.exists ?? existsSync;
  const exec = d.exec ?? ((file: string, args: string[]) => run(file, args, { timeout: 5_000 }));
  const binaries: Partial<Record<QemuArch, string>> = {};

  for (const arch of ["aarch64", "x86_64"] as const) {
    const name = `qemu-system-${arch}`;
    // An explicit setting wins, and is taken as the DIRECTORY the binaries live in — a user who
    // points at one binary has said nothing about the other.
    const candidates = d.qemuPath
      ? [join(d.qemuPath, name), d.qemuPath.endsWith(name) ? d.qemuPath : ""]
      : PREFIXES.map((p) => join(p, "bin", name));
    const found = candidates.find((p) => p && exists(p));
    if (found) binaries[arch] = resolve(found);
  }

  if (Object.keys(binaries).length === 0) {
    return {
      binaries, shareDir: null, hvf: false, version: null,
      unavailable: "QEMU is not installed. `brew install qemu` adds it; Realm does not bundle it, because QEMU is GPL-2.0 and shipping it inside a signed app takes on obligations Realm cannot meet.",
    };
  }

  const anyBinary = Object.values(binaries)[0]!;
  const shareDir = findShareDir(anyBinary, exists);
  let version: string | null = null;
  let hvf = false;
  try {
    const v = await exec(anyBinary, ["--version"]);
    version = /QEMU emulator version ([\d.]+)/.exec(v.stdout)?.[1] ?? null;
  } catch { /* a binary that will not run at all is caught by the accel probe below */ }
  try {
    const a = await exec(anyBinary, ["-accel", "help"]);
    hvf = /^\s*hvf\s*$/m.test(a.stdout);
  } catch {
    return {
      binaries, shareDir, hvf: false, version,
      unavailable: `QEMU is at ${anyBinary} but will not run — try \`${anyBinary} --version\` in a terminal to see what it says.`,
    };
  }
  if (!shareDir) {
    return {
      binaries, shareDir, hvf, version,
      unavailable: "QEMU is installed but its firmware files (edk2-*.fd) are missing, so no guest can boot. Reinstalling it usually restores them.",
    };
  }
  return { binaries, shareDir, hvf, version, unavailable: null };
}

/**
 * `<prefix>/share/qemu`, found from the binary rather than guessed.
 *
 * Walking up from the binary is what makes a hand-built or relocated install work: `/opt/x/bin/q` →
 * `/opt/x/share/qemu`. Checked for the file that is actually needed rather than for the directory,
 * because a `share/qemu` with no firmware in it is the same as none.
 */
function findShareDir(binary: string, exists: (p: string) => boolean): string | null {
  const prefix = dirname(dirname(binary));
  for (const dir of [join(prefix, "share", "qemu"), ...PREFIXES.map((p) => join(p, "share", "qemu"))]) {
    if (exists(join(dir, "edk2-aarch64-code.fd")) || exists(join(dir, "edk2-x86_64-code.fd"))) return dir;
  }
  return null;
}

/**
 * Which accelerator a guest of this architecture actually gets.
 *
 * `hvf` is Apple's hypervisor and virtualises rather than emulates — which it can only do for the
 * host's OWN architecture. An x86_64 guest on Apple Silicon is emulated whatever the host supports,
 * and saying so here is what stops the UI promising speed it cannot deliver.
 */
export function accelFor(caps: QemuCapabilities, arch: QemuArch, hostArch = process.arch): "hvf" | "tcg" {
  const hostIsArm = hostArch === "arm64";
  const matches = (arch === "aarch64" && hostIsArm) || (arch === "x86_64" && !hostIsArm);
  return caps.hvf && matches ? "hvf" : "tcg";
}
