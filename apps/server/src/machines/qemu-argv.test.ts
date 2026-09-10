import { describe, expect, it } from "vitest";
import { NVRAM_BYTES, accelNote, buildQemuArgv, firmwareCode, portForDisplay, qemuBinary, type QemuSpec } from "./qemu-argv";

const spec = (over: Partial<QemuSpec> = {}): QemuSpec => ({
  arch: "aarch64", dir: "/home/machines/m1", shareDir: "/opt/homebrew/share/qemu",
  display: 7, memoryMb: 4096, cpus: 4, title: "Debian 13", accel: "hvf", ...over,
});
const argv = (over: Partial<QemuSpec> = {}) => buildQemuArgv(spec(over));
/** The value that followed a flag, so a test asserts on the pair rather than on a substring. */
const after = (a: string[], flag: string): string[] => a.flatMap((v, i) => (a[i - 1] === flag ? [v] : []));

describe("the five flags that will be missed and then needed", () => {
  /**
   * THE security flag in the whole file, and measured rather than reasoned about: `-vnc :7` binds
   * `*:5907` — every interface, the guest's screen on the LAN, reachable by anything that can route
   * to this Mac. The host-qualified form binds `127.0.0.1:5907` only.
   *
   * The mutant is deleting six characters, and nothing about the guest looks different afterwards.
   */
  it("binds VNC to loopback and nowhere else", () => {
    const vnc = after(argv(), "-vnc")[0]!;
    expect(vnc).toMatch(/^127\.0\.0\.1:7,/);
    expect(vnc).not.toMatch(/^:7/);
    expect(portForDisplay(7)).toBe(5907);
  });

  /* The default is `allow-exclusive`, which lets a second client EVICT the first. The agent has its
     own socket, so without this the agent's driver would kick the human's pane off the screen. */
  it("never lets a second viewer evict the first", () => {
    expect(after(argv(), "-vnc")[0]).toContain("share=ignore");
  });

  /* argv is world-readable through `ps`. `data=` puts the VNC password where every process on this
     Mac can read it, and the flag looks almost identical. */
  it("passes the VNC password by file, never inline", () => {
    const secret = argv().find((a) => a.startsWith("secret,"))!;
    expect(secret).toContain("file=/home/machines/m1/vnc.secret");
    expect(secret).not.toContain("data=");
    expect(after(argv(), "-vnc")[0]).toContain("password-secret=vncpw");
  });

  /* The agent's ENTIRE addressing model depends on this device: without an absolute pointing device,
     QMP's absolute coordinates are meaningless and every click lands somewhere else. */
  it("gives every guest an absolute pointing device", () => {
    expect(argv()).toContain("virtio-tablet-pci");
    expect(argv({ arch: "x86_64", accel: "tcg" })).toContain("virtio-tablet-pci");
  });

  /* A unix socket has filesystem permissions. A QMP port on loopback is an unauthenticated
     total-control channel — start, stop, screendump, input, disk — with no token in front of it. */
  it("puts QMP on a unix socket rather than a port", () => {
    const qmp = after(argv(), "-qmp")[0]!;
    expect(qmp).toBe("unix:/home/machines/m1/qmp.sock,server=on,wait=off");
    expect(qmp).not.toContain("tcp:");
  });
});

describe("acceleration", () => {
  it("uses hvf with the host's own CPU when it can", () => {
    expect(after(argv(), "-machine")[0]).toBe("virt,accel=hvf,highmem=on");
    expect(after(argv(), "-cpu")[0]).toBe("host");
  });

  /* `-cpu host` means "the CPU this is running on", which TCG has no way to emulate — a guest
     started that way does not boot. The mutant is a defaults table that always says `host`. */
  it("never asks TCG to emulate the host's own CPU", () => {
    const a = argv({ accel: "tcg" });
    expect(after(a, "-cpu")[0]).toBe("max");
    expect(after(a, "-machine")[0]).toBe("virt,accel=tcg");
    // `highmem` is an hvf-only arrangement here, and goes with it.
    expect(after(a, "-machine")[0]).not.toContain("highmem");
  });

  /* TCG scales badly: past two vCPUs the extra threads are mostly lock contention, so asking for
     eight makes the guest SLOWER. A defaults helper that passed `cpus` straight through would do
     exactly that, and it would look like a generous default. */
  it("caps an emulated guest's vCPUs, because more of them make it slower", () => {
    expect(after(argv({ arch: "x86_64", accel: "tcg", cpus: 8 }), "-smp")[0]).toBe("2");
    expect(after(argv({ cpus: 8 }), "-smp")[0]).toBe("8");
    expect(after(argv({ cpus: 0 }), "-smp")[0]).toBe("1");
  });

  it("says how slow an emulated guest will be, rather than letting it read as a bug", () => {
    expect(accelNote("aarch64", "hvf")).toBeNull();
    expect(accelNote("x86_64", "tcg")).toContain("10–30× slower");
  });
});

describe("the two architectures", () => {
  it("names the right binary and the right firmware", () => {
    expect(qemuBinary("aarch64")).toBe("qemu-system-aarch64");
    expect(firmwareCode("/opt/homebrew/share/qemu", "aarch64")).toContain("edk2-aarch64-code.fd");
    expect(firmwareCode("/opt/homebrew/share/qemu", "x86_64")).toContain("edk2-x86_64-code.fd");
  });

  /* MEASURED: `virtio-vga` is not in the aarch64 binary at all — it is x86_64 only. A shared device
     list would produce a guest that refuses to start, with a message about an unknown device. */
  it("gives each architecture a display device that exists in its own binary", () => {
    expect(argv().join(" ")).toContain("virtio-gpu-pci");
    expect(argv().join(" ")).not.toContain("virtio-vga");
    expect(argv({ arch: "x86_64", accel: "tcg" }).join(" ")).toContain("virtio-vga");
    expect(argv({ arch: "x86_64", accel: "tcg" }).join(" ")).not.toContain("virtio-gpu-pci");
  });

  it("uses q35 for x86_64 and virt for aarch64", () => {
    expect(after(argv({ arch: "x86_64", accel: "tcg" }), "-machine")[0]).toContain("q35");
    expect(after(argv(), "-machine")[0]).toContain("virt");
  });
});

describe("the rest of the machine", () => {
  /**
   * MEASURED, because the obvious answer was unavailable: Homebrew ships no `edk2-aarch64-vars.fd`
   * to copy, and the near-miss `edk2-arm-vars.fd` is the 32-bit one. A 64 MiB zero-filled pflash on
   * unit 1 boots the aarch64 firmware with no complaint and gets WRITTEN, so boot entries persist.
   */
  it("gives the firmware a writable variable store on unit 1", () => {
    const drives = after(argv(), "-drive");
    expect(drives[0]).toContain("unit=0,readonly=on");
    expect(drives[0]).toContain("edk2-aarch64-code.fd");
    expect(drives[1]).toBe("if=pflash,format=raw,unit=1,file=/home/machines/m1/nvram.fd");
    expect(drives[1]).not.toContain("readonly");
    expect(NVRAM_BYTES).toBe(64 * 1024 * 1024);
  });

  /* SLIRP: the guest reaches out and nothing reaches in. A bridge or a tap would put the guest on
     the user's own network, at which point its blast radius stops being a disk image. */
  it("gives the guest outbound network and no way in", () => {
    expect(after(argv(), "-netdev")[0]).toBe("user,id=net0");
    const joined = argv().join(" ");
    expect(joined).not.toContain("hostfwd");
    expect(joined).not.toContain("tap");
    expect(joined).not.toContain("bridge");
  });

  /* `-display none` is what makes this headless. `cocoa` opens a window QEMU owns, outside Realm,
     that the user cannot close from the pane and that Realm's own lifecycle knows nothing about. */
  it("opens no window of its own", () => {
    expect(after(argv(), "-display")[0]).toBe("none");
  });

  it("boots from the installer only while one is attached", () => {
    expect(argv().join(" ")).not.toContain("-cdrom");
    const withIso = argv({ isoPath: "/images/debian.iso" });
    expect(after(withIso, "-cdrom")[0]).toBe("/images/debian.iso");
    expect(after(withIso, "-boot")[0]).toBe("order=d");
  });

  it("puts the machine's name where a process list will show it", () => {
    expect(after(argv({ title: "Debian 13" }), "-name")[0]).toBe("Debian 13");
  });

  it("keeps every file inside the machine's own directory", () => {
    // A path that escaped would be a machine writing over another machine's disk.
    for (const a of argv()) {
      if (a.includes("/home/machines/")) expect(a, a).toContain("/home/machines/m1/");
    }
  });
});
