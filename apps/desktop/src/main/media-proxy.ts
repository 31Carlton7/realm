import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fallbackExtraDirs } from "./login-shell-path";

/**
 * A playable copy of a video Chromium cannot decode.
 *
 * The player takes every movie, and some of them it cannot play: ProRes, an `.avi`, a `.mkv` with a
 * codec Chromium was not built with, an HEVC `.mov` on a build without the decoder. The OS would play
 * most of those, which is exactly the hand-off the player exists to avoid, so where this Mac has
 * ffmpeg the player offers a copy it can play — H.264 and AAC in an mp4, the one pairing every Chromium
 * decodes — made once per version of the file and kept under Realm's own tmp. Where there is no
 * ffmpeg the player says so and offers the default app and the Finder instead; nothing is installed.
 */

/** Where the copies live, under the Realm home. Swept of anything older than a week on each make. */
export const playableDir = (home: string): string => join(home, "tmp", "playable");
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** A long screen recording at `veryfast` takes minutes, not hours; past this it is stuck. */
const MAKE_TIMEOUT_MS = 20 * 60 * 1000;

/** The ffmpeg on this Mac, by the PATH main runs with (already the login shell's) and the two places
 *  Homebrew puts it; null when there is none. */
export function findFfmpeg(path = process.env["PATH"] ?? "", extra = fallbackExtraDirs()): string | null {
  for (const dir of [...path.split(delimiter), ...extra]) {
    if (!dir) continue;
    const bin = join(dir, "ffmpeg");
    if (existsSync(bin)) return bin;
  }
  return null;
}

/** The copy's name: the source's path, size and modification time, so an edited file gets a new
 *  copy and the same file asked for twice gets the one already made. */
export function playableName(source: string, size: number, mtimeMs: number): string {
  return `${createHash("sha1").update(`${source}\n${size}\n${Math.round(mtimeMs)}`).digest("hex").slice(0, 20)}.mp4`;
}

/** The encoders tried in order: x264 where ffmpeg was built with it, Apple's hardware encoder where it
 *  was not (an LGPL build has no x264). */
export function ffmpegArgs(source: string, out: string, encoder: "libx264" | "h264_videotoolbox"): string[] {
  const video = encoder === "libx264" ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"] : ["-c:v", "h264_videotoolbox", "-b:v", "8M"];
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", source,
    "-map", "0:v:0", "-map", "0:a:0?", ...video, "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out,
  ];
}

type Run = (bin: string, args: string[]) => Promise<void>;
const runFfmpeg: Run = (bin, args) => new Promise((resolve, reject) => {
  // execFile, never a shell: the source path is user data.
  execFile(bin, args, { timeout: MAKE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err) => (err ? reject(err) : resolve()));
});

const making = new Map<string, Promise<string>>();

/**
 * The path of a playable copy of `source`, made if it is not already there. Throws when there is no
 * ffmpeg or the encode fails; the player turns that into its fallback. One encode per copy however
 * many players ask at once.
 */
export async function playableCopy(home: string, source: string, deps: { ffmpeg?: string | null; run?: Run } = {}): Promise<string> {
  const ffmpeg = deps.ffmpeg === undefined ? findFfmpeg() : deps.ffmpeg;
  if (!ffmpeg) throw new Error("ffmpeg is not installed");
  const st = await stat(source);
  if (!st.isFile()) throw new Error(`${source} is not a file`);
  const dir = playableDir(home);
  const out = join(dir, playableName(source, st.size, st.mtimeMs));
  if (existsSync(out)) return out;
  const pending = making.get(out);
  if (pending) return pending;
  const run = deps.run ?? runFfmpeg;
  const job = (async () => {
    await mkdir(dir, { recursive: true });
    void sweep(dir).catch(() => {});
    // Written beside its final name and renamed into it, so a half-made copy is never served.
    const part = `${out}.part.mp4`;
    try {
      try { await run(ffmpeg, ffmpegArgs(source, part, "libx264")); }
      catch { await run(ffmpeg, ffmpegArgs(source, part, "h264_videotoolbox")); }
      await rename(part, out);
      return out;
    } catch (e) {
      await rm(part, { force: true }).catch(() => {});
      throw e;
    }
  })().finally(() => making.delete(out));
  making.set(out, job);
  return job;
}

async function sweep(dir: string, now = Date.now()): Promise<void> {
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const st = await stat(path).catch(() => null);
    if (st && now - st.mtimeMs > KEEP_MS) await rm(path, { force: true }).catch(() => {});
  }
}
