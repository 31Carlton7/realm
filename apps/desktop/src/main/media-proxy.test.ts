import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { ffmpegArgs, findFfmpeg, playableCopy, playableDir } from "./media-proxy";

let home: string;
beforeEach(() => { home = tempDir("realm-proxy-test-"); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("a playable copy of a video Chromium cannot decode", () => {
  it("makes it once, as H.264 in an mp4 under Realm's tmp, and hands back the same copy after", async () => {
    const source = join(home, "take.mov");
    await writeFile(source, "prores");
    const run = vi.fn(async (_bin: string, args: string[]) => { await writeFile(args[args.length - 1]!, "h264"); });
    const out = await playableCopy(home, source, { ffmpeg: "/opt/ffmpeg", run });
    expect(out.startsWith(playableDir(home))).toBe(true);
    expect(out.endsWith(".mp4")).toBe(true);
    expect(existsSync(out)).toBe(true);
    expect(run.mock.calls[0]![1]).toContain("libx264");
    // THE MUTANT: no cache — every click re-encodes a long recording.
    expect(await playableCopy(home, source, { ffmpeg: "/opt/ffmpeg", run })).toBe(out);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("falls back to Apple's encoder when ffmpeg has no x264, and leaves no half-made copy on failure", async () => {
    const source = join(home, "take.avi");
    await writeFile(source, "x");
    const run = vi.fn(async (_bin: string, args: string[]) => {
      if (args.includes("libx264")) throw new Error("Unknown encoder 'libx264'");
      await writeFile(args[args.length - 1]!, "h264");
    });
    await playableCopy(home, source, { ffmpeg: "/opt/ffmpeg", run });
    expect(run.mock.calls[1]![1]).toContain("h264_videotoolbox");

    const broken = join(home, "broken.mkv");
    await writeFile(broken, "y");
    const fail = vi.fn(async (_bin: string, args: string[]) => { await writeFile(args[args.length - 1]!, "half"); throw new Error("decode error"); });
    await expect(playableCopy(home, broken, { ffmpeg: "/opt/ffmpeg", run: fail })).rejects.toThrow("decode error");
    expect((await readdir(playableDir(home))).filter((x) => x.includes(".part"))).toEqual([]);
  });

  it("refuses without ffmpeg rather than reaching for the OS", async () => {
    const source = join(home, "take.mov");
    await writeFile(source, "x");
    await expect(playableCopy(home, source, { ffmpeg: null })).rejects.toThrow("ffmpeg is not installed");
  });

  it("finds ffmpeg on the PATH or where Homebrew puts it", async () => {
    const bin = join(home, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "ffmpeg"), "");
    expect(findFfmpeg(`/nowhere:${bin}`, [])).toBe(join(bin, "ffmpeg"));
    expect(findFfmpeg("/nowhere", [bin])).toBe(join(bin, "ffmpeg"));
    expect(findFfmpeg("/nowhere", [])).toBeNull();
  });

  it("never passes the source through a shell, and writes a file that streams from its start", () => {
    const args = ffmpegArgs("/tmp/a; rm -rf ~.mov", "/out.mp4", "libx264");
    expect(args[args.indexOf("-i") + 1]).toBe("/tmp/a; rm -rf ~.mov");
    expect(args).toContain("+faststart");
  });
});
