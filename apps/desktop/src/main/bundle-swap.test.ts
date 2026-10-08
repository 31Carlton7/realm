import { copyFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { describe, expect, it } from "vitest";
import { asarReplaced, readAsarStamp, type AsarStamp } from "./bundle-swap";

describe("asarReplaced", () => {
  const launched: AsarStamp = { ino: 42, size: 1000, mtimeMs: 1_700_000_000_123.4 };

  it("holds the archive it launched from", () => {
    expect(asarReplaced(launched, { ...launched })).toBe(false);
    // Sub-millisecond mtime noise is not a new bundle.
    expect(asarReplaced(launched, { ...launched, mtimeMs: 1_700_000_000_123.9 })).toBe(false);
  });

  it("over every way a bundle gets swapped", () => {
    expect(asarReplaced(launched, { ...launched, ino: 43 })).toBe(true); // renamed into place
    expect(asarReplaced(launched, { ...launched, size: 1001 })).toBe(true); // copied over the top
    expect(asarReplaced(launched, { ...launched, mtimeMs: launched.mtimeMs + 1000 })).toBe(true); // same size, rewritten
    expect(asarReplaced(launched, null)).toBe(true); // moved away, or mid-swap
  });
});

describe("readAsarStamp", () => {
  it("sees a rename-swap and a copy over the top, and nothing when the file is gone", () => {
    const dir = tempDir("realm-bundle-swap-");
    const asar = join(dir, "app.asar");
    writeFileSync(asar, "old archive");
    const launched = readAsarStamp(asar)!;
    expect(asarReplaced(launched, readAsarStamp(asar))).toBe(false);

    writeFileSync(join(dir, "next.asar"), "new archive");
    renameSync(join(dir, "next.asar"), asar);
    expect(asarReplaced(launched, readAsarStamp(asar))).toBe(true);

    // Copied over the top: the same inode, holding a bigger archive.
    const second = readAsarStamp(asar)!;
    writeFileSync(join(dir, "bigger.asar"), "a newer, bigger archive");
    copyFileSync(join(dir, "bigger.asar"), asar);
    expect(readAsarStamp(asar)!.ino).toBe(second.ino);
    expect(asarReplaced(second, readAsarStamp(asar))).toBe(true);

    // Rewritten at the same size: only the mtime moves. Set it, since two writes can share a millisecond.
    const third = readAsarStamp(asar)!;
    writeFileSync(asar, "A NEWER, BIGGER ARCHIVE");
    utimesSync(asar, new Date(), new Date(third.mtimeMs + 5_000));
    expect(asarReplaced(third, readAsarStamp(asar))).toBe(true);

    rmSync(asar);
    expect(readAsarStamp(asar)).toBeNull();
  });
});
