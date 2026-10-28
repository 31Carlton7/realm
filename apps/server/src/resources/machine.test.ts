import { describe, expect, it } from "vitest";
import { classifyPressure, classifyPsi, parseBundleId, parseFootprint, parseFrontAsn, parseMeminfo, parsePs, parseSysctl, parseTop, parseVmStat, realMachineProbe, run, SWAP_OUT_WARN_BYTES_PER_SECOND } from "./machine";

/* Every fixture below is what the real command printed on this Mac (2026-10-28), trimmed. */

describe("reading the process table", () => {
  it("reads pid, parent, terminal, resident size, start and the whole command, spaces and all", () => {
    const rows = parsePs([
      "    1     0 ??        19296 Tue Oct 27 00:29:13 2026     /sbin/launchd",
      "63714 63649 ttys001    3392 Tue Oct 27 02:08:07 2026     /bin/zsh -l",
      "  350     1 ??         6224 Wed Oct  8 00:29:54 2026     /usr/libexec/UserEventAgent (System)",
      "garbage that is not a row",
    ].join("\n"));
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual({ pid: 63714, ppid: 63649, tty: "ttys001", residentBytes: 3392 * 1024, startedAt: new Date(2026, 9, 27, 2, 8, 7).getTime(), command: "/bin/zsh -l" });
    expect(rows[0]!.tty).toBeNull();
    // A single-digit day is padded with a second space, and the command keeps its own spaces.
    expect(rows[2]!.startedAt).toBe(new Date(2026, 9, 8, 0, 29, 54).getTime());
    expect(rows[2]!.command).toBe("/usr/libexec/UserEventAgent (System)");
  });
});

describe("reading footprints", () => {
  it("takes each process's phys_footprint in bytes from footprint(1), names with spaces and brackets included", () => {
    const map = parseFootprint([
      "======================================================================",
      "Python [64135]: 64-bit    Footprint: 2553021832 B (16384 bytes per page)",
      "======================================================================",
      "",
      "Auxiliary data:",
      "    phys_footprint: 2553021832 B",
      "    phys_footprint_peak: 3972467616 B",
      "Google Chrome Helper (Renderer) [57816]: 64-bit    Footprint: 1022000000 B (16384 bytes per page)",
      "Summary Footprint: 3575021832 B",
    ].join("\n"));
    expect([...map]).toEqual([[64135, 2553021832], [57816, 1022000000]]);
  });

  it("takes every process's from one top sample, in top's own units", () => {
    const map = parseTop([
      "Processes: 1388 total, 2 running, 1386 sleeping, 8138 threads",
      "PhysMem: 23G used (4124M wired, 6702M compressor), 566M unused.",
      "",
      "PID    MEM  ",
      "64135  2435M ",
      "99831  4592K",
      "421    1.5G+",
      "7      512B",
    ].join("\n"));
    expect(map.get(64135)).toBe(2435 * 1024 ** 2);
    expect(map.get(99831)).toBe(4592 * 1024);
    expect(map.get(421)).toBe(Math.round(1.5 * 1024 ** 3));
    expect(map.get(7)).toBe(512);
    // The header's "23G used" is not a process.
    expect(map.size).toBe(4);
  });
});

describe("reading the machine's memory", () => {
  it("reads total, macOS's level, what is available and swap from sysctl, by name", () => {
    const s = parseSysctl([
      "hw.memsize: 25769803776",
      "kern.memorystatus_vm_pressure_level: 1",
      "kern.memorystatus_level: 47",
      "vm.swapusage: total = 20480.00M  used = 19019.69M  free = 1460.31M  (encrypted)",
    ].join("\n"));
    expect(s).toEqual({ totalBytes: 25769803776, level: 1, availablePercent: 47, swap: { usedBytes: Math.round(19019.69 * 1024 ** 2), totalBytes: 20480 * 1024 ** 2 } });
    // One name this macOS does not know prints an error and the rest still read.
    expect(parseSysctl("hw.memsize: 8\nsysctl: unknown oid 'kern.memorystatus_level'").availablePercent).toBeNull();
  });

  it("reads the compressor and the swap-out count from vm_stat, in bytes", () => {
    const v = parseVmStat([
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                                    13116.",
      "Pages occupied by compressor:                 421500.",
      "Swapins:                                     4077405.",
      "Swapouts:                                    6497941.",
    ].join("\n"));
    expect(v).toEqual({ compressedBytes: 421500 * 16384, swapouts: 6497941 * 16384 });
  });

  it("reads Linux's meminfo", () => {
    const m = parseMeminfo("MemTotal:       16303456 kB\nMemAvailable:    8000000 kB\nSwapTotal: 0 kB\n");
    expect(m.get("MemTotal")).toBe(16303456 * 1024);
    expect(m.get("SwapTotal")).toBe(0);
  });
});

describe("the app in front", () => {
  it("reads lsappinfo's front app and its bundle id, as this Mac printed them", async () => {
    expect(parseFrontAsn("ASN:0x0-0x73073:\n")).toBe("ASN:0x0-0x73073:");
    expect(parseFrontAsn("[ NULL ]")).toBeNull();
    expect(parseBundleId('[ NULL ]  ASN:0x0-0x73073: (in front) \n    bundleID="co.charmtechnologies.realm"\n    bundle path=[ NULL ] ')).toBe("co.charmtechnologies.realm");
    expect(parseBundleId('"CFBundleIdentifier"="com.apple.iphonesimulator"')).toBe("com.apple.iphonesimulator");
    expect(parseBundleId("    bundleID=[ NULL ] ")).toBeNull();
    const calls: string[][] = [];
    const probe = realMachineProbe({ platform: "darwin", run: async (_f, args) => { calls.push(args); return args[0] === "front" ? "ASN:0x0-0x1a01a:" : 'bundleID="com.apple.iphonesimulator"'; } });
    expect(await probe.frontApp!()).toBe("com.apple.iphonesimulator");
    expect(calls).toEqual([["front"], ["info", "-only", "bundleid", "ASN:0x0-0x1a01a:"]]);
    expect(await realMachineProbe({ platform: "linux", run: async () => { throw new Error("must not run"); } }).frontApp!()).toBeNull();
  });
});

describe("pressure", () => {
  it("is macOS's own level when nothing is swapping", () => {
    expect(classifyPressure({ level: 1, swapOutPerSecond: 0 })).toEqual({ pressure: "normal", why: null });
    expect(classifyPressure({ level: 2, swapOutPerSecond: 0 }).pressure).toBe("warn");
    expect(classifyPressure({ level: 4, swapOutPerSecond: 0 }).pressure).toBe("critical");
    expect(classifyPressure({ level: null, swapOutPerSecond: null }).pressure).toBe("unknown");
  });

  it("lifts a green level to warn while the Mac swaps out, and says how fast", () => {
    // The 02:15 reading: macOS green, 20 GB of swap, load in the hundreds. THE MUTANT: reading the
    // level alone, which calls that Mac relaxed.
    const r = classifyPressure({ level: 1, swapOutPerSecond: 12 * 1024 ** 2 });
    expect(r).toEqual({ pressure: "warn", why: "Swapping out 12 MB a second" });
    expect(classifyPressure({ level: 1, swapOutPerSecond: SWAP_OUT_WARN_BYTES_PER_SECOND - 1 }).pressure).toBe("normal");
    expect(classifyPressure({ level: 2, swapOutPerSecond: 80 * 1024 ** 2 }).pressure).toBe("critical");
  });

  it("reads Linux's pressure stall information", () => {
    expect(classifyPsi("some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0").pressure).toBe("normal");
    expect(classifyPsi("some avg10=22.50 avg60=3.00 avg300=1.00 total=9\nfull avg10=1.00 avg60=0 avg300=0 total=1").pressure).toBe("warn");
    expect(classifyPsi("some avg10=60 avg60=3 avg300=1 total=9\nfull avg10=30 avg60=0 avg300=0 total=1").pressure).toBe("critical");
    expect(classifyPsi("").pressure).toBe("unknown");
  });
});

describe("the real probe", () => {
  it("takes the swap-out rate between two readings, and has none from one", async () => {
    let swapouts = 1000;
    let at = 0;
    const probe = realMachineProbe({
      platform: "darwin", now: () => at,
      run: async (file) => file.endsWith("sysctl")
        ? "hw.memsize: 100\nkern.memorystatus_vm_pressure_level: 1\nkern.memorystatus_level: 60\nvm.swapusage: total = 2048.00M  used = 1024.00M  free = 1024.00M"
        : `Mach Virtual Memory Statistics: (page size of 1024 bytes)\nPages occupied by compressor: 2.\nSwapouts: ${swapouts}.\n`,
    });
    const first = await probe.memory(null);
    expect(first.memory.swapOutPerSecond).toBeNull();
    expect(first.memory.pressure).toBe("normal");
    at = 10_000; swapouts += 20 * 1024; // 20 MB in ten seconds: 2 MB a second
    const second = await probe.memory(first.counters);
    expect(second.memory.swapOutPerSecond).toBe(2 * 1024 * 1024);
    expect(second.memory.pressure).toBe("warn");
    expect(second.memory.swap).toEqual({ usedBytes: 1024 ** 3, totalBytes: 2 * 1024 ** 3 });
  });

  it("leaves its own readings out of the table", async () => {
    const me = process.pid;
    const probe = realMachineProbe({ platform: "darwin", run: async () => [
      `${me} 1 ?? 1000 Tue Oct 27 02:08:07 2026 node main.js`,
      `91 ${me} ?? 10 Tue Oct 27 02:08:07 2026 ps -A -ww -o pid=,ppid=,tty=,rss=,lstart=,command=`,
      `92 ${me} ?? 0 Tue Oct 27 02:08:07 2026 (vm_stat)`,
      `93 ${me} ?? 10 Tue Oct 27 02:08:07 2026 /usr/bin/top -l 1 -stats pid,mem`,
      `94 ${me} ?? 10 Tue Oct 27 02:08:07 2026 /usr/bin/topaz --serve`,
      `95 1 ?? 10 Tue Oct 27 02:08:07 2026 ps aux`,
    ].join("\n") });
    // Somebody else's `ps`, and a binary that merely starts with "top", are not this reading.
    expect((await probe.processes()).map((r) => r.pid)).toEqual([me, 94, 95]);
  });

  it("runs every command in the C locale, so ps's start times parse whatever the Mac's language", async () => {
    // en_GB prints "Tue 27 Oct", de_DE "Di. 27 Okt.": a row parsePs cannot read is a process nobody sees.
    expect(parsePs("63714 63649 ttys001 3392 Di. 27 Okt. 02:08:07 2026 /bin/zsh -l")).toEqual([]);
    const before = process.env.LC_ALL;
    process.env.LC_ALL = "de_DE.UTF-8";
    try {
      expect((await run(process.execPath, ["-e", "console.log(process.env.LC_ALL)"], 5_000)).trim()).toBe("C");
    } finally {
      if (before === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = before;
    }
  });

  it("takes a ps that failed or ran out of time as unreadable, not as the part it printed", async () => {
    // THE MUTANT: the lenient read sysctl needs. A ps killed at its timeout has printed half the table,
    // and a half table says a simulator's launchd has gone and an engine has no work running.
    const slow = [process.execPath, ["-e", "process.stdout.write('1 0 ?? 10 Tue Oct 27 02:08:07 2026 /sbin/launchd\\n'); setTimeout(() => {}, 5000)"]] as const;
    await expect(run(slow[0], [...slow[1]], 300, true)).rejects.toThrow(/could not be read/);
    expect(await run(slow[0], [...slow[1]], 300)).toContain("/sbin/launchd");
    await expect(run(process.execPath, ["-e", "process.stdout.write('x'); process.exit(1)"], 5_000, true)).rejects.toThrow();
    // The probe asks for ps strictly, and passes the refusal on.
    const asked: boolean[] = [];
    const probe = realMachineProbe({ platform: "darwin", run: async (_f, _a, _t, strict) => { asked.push(strict === true); throw new Error("ps timed out"); } });
    await expect(probe.processes()).rejects.toThrow(/timed out/);
    expect(asked).toEqual([true]);
  });

  it("asks footprint(1) in batches, and only on a Mac", async () => {
    const calls: string[][] = [];
    const probe = realMachineProbe({ platform: "darwin", run: async (_f, args) => { calls.push(args); return ""; } });
    await probe.footprints(Array.from({ length: 70 }, (_, i) => i + 1));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.filter((a) => a === "-p")).toHaveLength(64);
    const linux = realMachineProbe({ platform: "linux", run: async () => { throw new Error("must not run"); } });
    expect((await linux.footprints([1, 2])).size).toBe(0);
    expect(await linux.allFootprints()).toBeNull();
  });

  it("reads processes on a Mac and on Linux, and says it does not on Windows", async () => {
    expect(realMachineProbe({ platform: "darwin" }).readsProcesses).toBe(true);
    expect(realMachineProbe({ platform: "linux" }).readsProcesses).toBe(true);
    const windows = realMachineProbe({ platform: "win32", run: async () => { throw new Error("must not run"); } });
    expect(windows.readsProcesses).toBe(false);
    expect(await windows.processes()).toEqual([]);
  });
});
