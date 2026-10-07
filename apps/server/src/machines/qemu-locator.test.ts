import { describe, expect, it } from "vitest";
import { accelFor, locateQemu, type QemuCapabilities } from "./qemu-locator";

const BREW = "/opt/homebrew/bin/qemu-system-aarch64";
const fakeExec = (over: Record<string, string> = {}) => async (_f: string, args: string[]) => ({
  stdout: args[0] === "--version" ? (over.version ?? "QEMU emulator version 10.2.0\nCopyright (c) 2003-2025")
    : args[0] === "-accel" ? (over.accel ?? "Accelerators supported in QEMU binary:\nhvf\ntcg\n")
    : "",
});

const present = (...paths: string[]) => (p: string) => paths.includes(p);
const FULL = [BREW, "/opt/homebrew/bin/qemu-system-x86_64", "/opt/homebrew/share/qemu/edk2-aarch64-code.fd"];

describe("finding QEMU", () => {
  it("finds a Homebrew install and asks the binary what it can do", async () => {
    const caps = await locateQemu({ exists: present(...FULL), exec: fakeExec() });
    expect(caps.unavailable).toBeNull();
    expect(caps.binaries.aarch64).toBe(BREW);
    expect(caps.binaries.x86_64).toBe("/opt/homebrew/bin/qemu-system-x86_64");
    expect(caps.shareDir).toBe("/opt/homebrew/share/qemu");
    expect(caps.hvf).toBe(true);
    expect(caps.version).toBe("10.2.0");
  });

  /**
   * The absence has to be a SENTENCE, not a false. design.md: "Where the owner has said nothing,
   * show nothing — not a disabled control, which invites a user to work out how to enable something
   * nobody has claimed." The picker hides the source; this string is what the pane says if it is
   * reached another way, and it has to explain why Realm does not simply ship it.
   */
  it("says QEMU is absent, and why Realm does not bundle it", async () => {
    const caps = await locateQemu({ exists: () => false, exec: fakeExec() });
    expect(caps.binaries).toEqual({});
    expect(caps.unavailable).toContain("brew install qemu");
    expect(caps.unavailable).toContain("GPL-2.0");
  });

  /* A `share/qemu` with no firmware in it is the same as none: every guest fails at boot with a
     message about a missing file, which reads as Realm's bug. */
  it("treats missing firmware as unusable rather than finding out at spawn", async () => {
    const caps = await locateQemu({ exists: present(BREW), exec: fakeExec() });
    expect(caps.shareDir).toBeNull();
    expect(caps.unavailable).toContain("firmware");
  });

  it("reports a binary that will not run, rather than reporting no acceleration", async () => {
    const caps = await locateQemu({
      exists: present(...FULL),
      exec: async (_f, args) => { if (args[0] === "-accel") throw new Error("Bad CPU type"); return { stdout: "" }; },
    });
    // The difference matters: "no hvf" sends someone to their BIOS settings, and "will not run"
    // sends them to the terminal where the real message is.
    expect(caps.unavailable).toContain("will not run");
    expect(caps.hvf).toBe(false);
  });

  /* Asked of the binary, not assumed from a version. A Homebrew build, a MacPorts build and a
     hand-compiled one differ in which accelerators they carry, and a table in this repo would be a
     claim about somebody else's build. */
  it("reports no acceleration when the binary does not list it", async () => {
    const caps = await locateQemu({ exists: present(...FULL), exec: fakeExec({ accel: "Accelerators supported in QEMU binary:\ntcg\n" }) });
    expect(caps.hvf).toBe(false);
    expect(caps.unavailable).toBeNull();   // still usable, just slow
  });

  it("walks up from the binary, so a relocated install finds its own firmware", async () => {
    const caps = await locateQemu({
      exists: present("/opt/custom/bin/qemu-system-aarch64", "/opt/custom/share/qemu/edk2-aarch64-code.fd"),
      exec: fakeExec(), qemuPath: "/opt/custom/bin",
    });
    expect(caps.shareDir).toBe("/opt/custom/share/qemu");
  });

  it("takes an explicit path as a directory, not as one binary", async () => {
    // A user who points at one binary has said nothing about the other.
    const caps = await locateQemu({
      exists: present("/custom/qemu-system-x86_64", "/opt/homebrew/share/qemu/edk2-x86_64-code.fd"),
      exec: fakeExec(), qemuPath: "/custom",
    });
    expect(caps.binaries.x86_64).toBe("/custom/qemu-system-x86_64");
    expect(caps.binaries.aarch64).toBeUndefined();
  });
});

describe("which accelerator a guest gets", () => {
  const caps = (hvf: boolean): QemuCapabilities => ({ binaries: {}, shareDir: "/s", hvf, version: "10.2.0", unavailable: null });

  /**
   * `hvf` virtualises rather than emulates, which it can only do for the HOST's own architecture.
   * An x86_64 guest on Apple Silicon is emulated whatever the host supports — and the mutant is a
   * one-line `caps.hvf ? "hvf" : "tcg"`, which produces a command line QEMU refuses outright and a
   * UI that promised speed it never had.
   */
  it("gives hvf only to a guest of the host's own architecture", () => {
    expect(accelFor(caps(true), "aarch64", "arm64")).toBe("hvf");
    expect(accelFor(caps(true), "x86_64", "arm64")).toBe("tcg");
    expect(accelFor(caps(true), "x86_64", "x64")).toBe("hvf");
    expect(accelFor(caps(true), "aarch64", "x64")).toBe("tcg");
  });

  it("falls back to emulation when the host has no hypervisor at all", () => {
    expect(accelFor(caps(false), "aarch64", "arm64")).toBe("tcg");
  });
});
