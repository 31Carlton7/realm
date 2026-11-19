import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { RANGE_MAX_BYTES, readFileRange, readTextFile } from "./read-text";

let dir: string;
beforeEach(() => { dir = tempDir("realm-read-text-"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("readTextFile", () => {
  it("reads a text file whole", async () => {
    const p = join(dir, "a.ts");
    await writeFile(p, "const x = 1;\n");
    expect(await readTextFile(p)).toEqual({ ok: true, text: "const x = 1;\n" });
  });

  it("refuses a binary — a NUL in its head — so the viewer falls back to the picture", async () => {
    const p = join(dir, "blob");
    await writeFile(p, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x41]));
    expect(await readTextFile(p)).toEqual({ ok: false, reason: "binary" });
  });

  it("refuses past the ceiling without reading it", async () => {
    const p = join(dir, "big.log");
    await writeFile(p, "x".repeat(101));
    expect(await readTextFile(p, 100)).toEqual({ ok: false, reason: "large" });
    expect(await readTextFile(p, 101)).toEqual({ ok: true, text: "x".repeat(101) });
  });

  it("shows bytes that are not UTF-8 rather than refusing them: nothing here writes the file back", async () => {
    const p = join(dir, "latin1.txt");
    await writeFile(p, Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    const r = await readTextFile(p);
    expect(r?.ok && r.text.startsWith("caf")).toBe(true);
  });

  it("answers null for what is not a regular file at an absolute path", async () => {
    await mkdir(join(dir, "folder"));
    expect(await readTextFile(join(dir, "folder"))).toBeNull();
    expect(await readTextFile(join(dir, "missing.txt"))).toBeNull();
    expect(await readTextFile("relative/a.ts")).toBeNull();
    expect(await readTextFile(42)).toBeNull();
  });
});

describe("readFileRange", () => {
  it("reads only the bytes asked for, and fewer where the file ends first", async () => {
    const p = join(dir, "notes.md");
    await writeFile(p, "0123456789");
    expect(new TextDecoder().decode((await readFileRange(p, 2, 4))!)).toBe("2345");
    expect(new TextDecoder().decode((await readFileRange(p, 8, 100))!)).toBe("89");
    expect((await readFileRange(p, 20, 4))!.byteLength).toBe(0);
  });

  it("refuses a length past the ceiling and an offset that is not a whole number", async () => {
    const p = join(dir, "a.txt");
    await writeFile(p, "abc");
    expect(await readFileRange(p, 0, RANGE_MAX_BYTES + 1)).toBeNull();
    expect((await readFileRange(p, 0, RANGE_MAX_BYTES))!.byteLength).toBe(3);
    expect(await readFileRange(p, -1, 2)).toBeNull();
    expect(await readFileRange(p, 0.5, 2)).toBeNull();
    expect(await readFileRange(p, "0", 2)).toBeNull();
  });

  it("answers null for what is not a regular file at an absolute path", async () => {
    await mkdir(join(dir, "folder"));
    expect(await readFileRange(join(dir, "folder"), 0, 4)).toBeNull();
    expect(await readFileRange(join(dir, "missing.txt"), 0, 4)).toBeNull();
    expect(await readFileRange("relative/a.txt", 0, 4)).toBeNull();
  });
});
