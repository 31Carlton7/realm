import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

/**
 * A real iPhone's screen as live video, from Realm's `phonescreen` helper (apps/desktop/native/
 * PhoneScreen.swift): macOS takes it over the cable the way QuickTime does, as a capture device.
 *
 * The pane's picture used to be the runner's screenshots, and on an iPhone 17 Pro each took 773 ms —
 * one frame a second, with every tap queued on the phone behind one. MEASURED on that phone, this is
 * 40 frames a second, 32 ms from the phone's frame to the Mac, and the runner is left free for taps.
 *
 * It is a picture only. A phone on Wi-Fi, a Realm without camera access, or a Mac without the helper
 * has none, and the bridge falls back to the runner's screenshots — which is why every way this can
 * fail is a `VideoStop` that says which it was, rather than an error.
 */

/** Why there is no video: the camera not asked for yet, refused, no such phone on a cable, or anything
 *  else — the helper's exit code, read. */
export type VideoStop = "camera" | "camera-denied" | "no-cable" | "failed";

export type VideoFeed = {
  /** Resolves when the first frame is out. Never rejects: a feed that dies first just ends. */
  ready: Promise<void>;
  /** Why it ended — null when it was stopped on purpose. */
  ended: Promise<VideoStop | null>;
  stop(): void;
};

/** Start the feed; every JPEG it makes goes to `onFrame`, newest only — none are queued. */
export type StartVideo = (onFrame: (jpeg: Buffer) => void) => VideoFeed;

type Spawn = (bin: string, args: string[], o: { stdio: ["ignore", "pipe", "pipe"] }) => ChildProcess;

/** The helper's exit codes. Anything else — a crash, a signal, a spawn that failed — is `failed`. */
const STOPS: Record<number, VideoStop> = { 2: "no-cable", 3: "camera", 4: "camera-denied" };

export function phoneVideo(o: { bin: string; name: string; scale?: number; quality?: number; maxFps?: number; spawn?: Spawn }): StartVideo {
  return (onFrame) => {
    const args = ["stream", "--name", o.name, "--scale", String(o.scale ?? 0.5), "--quality", String(o.quality ?? 0.6), "--max-fps", String(o.maxFps ?? 30)];
    let child: ChildProcess;
    try {
      child = (o.spawn ?? (nodeSpawn as unknown as Spawn))(o.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return { ready: new Promise(() => {}), ended: Promise.resolve("failed"), stop: () => {} };
    }
    let stopped = false;
    let first: () => void = () => {};
    const ready = new Promise<void>((resolve) => { first = resolve; });
    const frames = new FrameReader((jpeg) => { first(); onFrame(jpeg); });
    child.stdout!.on("data", (chunk: Buffer) => frames.push(chunk));
    child.stderr!.resume();
    const ended = new Promise<VideoStop | null>((resolve) => {
      const done = (code: number | null) => resolve(stopped ? null : STOPS[code ?? -1] ?? "failed");
      // A helper that could not even start (gone from disk, not executable) errors and may never exit.
      child.once("error", () => done(-1));
      child.once("exit", (code) => done(code));
    });
    return {
      ready, ended,
      stop: () => { stopped = true; child.kill("SIGTERM"); },
    };
  };
}

/**
 * The helper's stdout, cut back into JPEGs: each frame is a 4-byte big-endian length and then that
 * many bytes. A pipe hands them over in whatever pieces it likes — a frame across three chunks, three
 * frames in one — so the cut is made here and nowhere else.
 */
export class FrameReader {
  private pending: Buffer[] = [];
  private size = 0;

  constructor(private readonly onFrame: (jpeg: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.pending.push(chunk);
    this.size += chunk.length;
    for (;;) {
      if (this.size < 4) return;
      const head = this.take(4, false);
      const length = head.readUInt32BE(0);
      if (this.size < 4 + length) return;
      this.take(4, true);
      this.onFrame(this.take(length, true));
    }
  }

  /** The first `n` bytes, removed from what is pending when `consume`. */
  private take(n: number, consume: boolean): Buffer {
    const all = this.pending.length === 1 ? this.pending[0]! : Buffer.concat(this.pending);
    const out = all.subarray(0, n);
    if (consume) {
      const rest = all.subarray(n);
      this.pending = rest.length ? [rest] : [];
      this.size = rest.length;
    } else {
      this.pending = [all];
    }
    return out;
  }
}
