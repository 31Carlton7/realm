import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HELPERS } from "./build-native.mjs";
import { minimumMacos, plistMinimumMacos, versionNumber } from "./lib/macos-minimum.mjs";
import { helperProblems } from "./native-helpers.mjs";

const LC_SEGMENT_64 = 0x19;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;

/** "27.2" packed as a Mach-O version: xxxx.yy.zz in nibbles. */
const packed = (version: string) => {
  const [major, minor = 0, patch = 0] = version.split(".").map(Number);
  return (major << 16) | (minor << 8) | patch;
};

/** A thin arm64 executable's header and load commands: a segment first, then the version command. */
function machO(version: { build?: string; legacy?: string } = {}) {
  const commands: Buffer[] = [Buffer.alloc(72)];
  commands[0].writeUInt32LE(LC_SEGMENT_64, 0);
  commands[0].writeUInt32LE(72, 4);
  if (version.build) {
    const c = Buffer.alloc(24);
    c.writeUInt32LE(LC_BUILD_VERSION, 0);
    c.writeUInt32LE(24, 4);
    c.writeUInt32LE(1, 8);
    c.writeUInt32LE(packed(version.build), 12);
    c.writeUInt32LE(packed("27.0"), 16);
    commands.push(c);
  }
  if (version.legacy) {
    const c = Buffer.alloc(16);
    c.writeUInt32LE(LC_VERSION_MIN_MACOSX, 0);
    c.writeUInt32LE(16, 4);
    c.writeUInt32LE(packed(version.legacy), 8);
    commands.push(c);
  }
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(2, 12);
  header.writeUInt32LE(commands.length, 16);
  header.writeUInt32LE(commands.reduce((n, c) => n + c.length, 0), 20);
  return Buffer.concat([header, ...commands]);
}

describe("minimumMacos", () => {
  it("reads LC_BUILD_VERSION's minos past the commands before it", () => {
    expect(minimumMacos(machO({ build: "27.2" }))).toBe("27.2");
    expect(minimumMacos(machO({ build: "13.0" }))).toBe("13.0");
    expect(minimumMacos(machO({ build: "13.5.1" }))).toBe("13.5.1");
  });

  it("reads the older LC_VERSION_MIN_MACOSX", () => {
    expect(minimumMacos(machO({ legacy: "10.15" }))).toBe("10.15");
  });

  it("is null for a binary that names no macOS, and refuses what is not a thin Mach-O", () => {
    expect(minimumMacos(machO())).toBeNull();
    expect(() => minimumMacos(Buffer.from("#!/bin/sh\n"))).toThrow(/Mach-O/);
  });
});

describe("helperProblems", () => {
  const helpers = [
    ["A.swift", "a", "13.0"],
    ["B.swift", "b", "26.0"],
  ];

  function withHelpers(built: Record<string, string>, check: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "native-helpers-"));
    try {
      for (const [binary, version] of Object.entries(built)) writeFileSync(join(dir, binary), machO({ build: version }));
      check(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("names each helper built for a newer macOS than its entry, as 2.11.1's were", () => {
    withHelpers({ a: "27.2", b: "27.2" }, (dir) => {
      expect(helperProblems(dir, null, helpers)).toEqual([
        "a is built for macOS 27.2, above its 13.0",
        "b is built for macOS 27.2, above its 26.0",
      ]);
    });
  });

  it("passes helpers built for their entry or older, and skips one that was not built", () => {
    withHelpers({ a: "13.0" }, (dir) => expect(helperProblems(dir, "13.0", helpers)).toEqual([]));
    withHelpers({ a: "12.0", b: "26.0" }, (dir) => expect(helperProblems(dir, null, helpers)).toEqual([]));
  });

  it("refuses an entry with no minimum, which swiftc would build for the Mac it runs on", () => {
    withHelpers({}, (dir) => expect(helperProblems(dir, null, [["C.swift", "c"]])).toEqual(["c has no minimum macOS in build-native.mjs"]));
  });

  it("refuses a table whose lowest entry is above the app's own minimum", () => {
    withHelpers({}, (dir) => {
      expect(helperProblems(dir, "12.0", helpers)).toEqual(["every helper needs macOS 13.0 or later, above the app's 12.0"]);
    });
  });
});

describe("the helper table", () => {
  it("names a source that exists for every helper", () => {
    for (const [source] of HELPERS) expect(() => readFileSync(join(__dirname, "..", "native", source))).not.toThrow();
  });

  it("has its lowest entry at or below the macOS the packaged app says it runs on", () => {
    // electron-builder copies Electron's LSMinimumSystemVersion into Realm's Info.plist.
    const electron = dirname(createRequire(import.meta.url).resolve("electron/package.json"));
    const appMinimum = plistMinimumMacos(readFileSync(join(electron, "dist", "Electron.app", "Contents", "Info.plist"), "utf8"));
    expect(appMinimum).not.toBeNull();
    const lowest = Math.min(...HELPERS.map(([, , macos]) => versionNumber(macos)));
    expect(lowest).toBeLessThanOrEqual(versionNumber(appMinimum!));
  });
});
