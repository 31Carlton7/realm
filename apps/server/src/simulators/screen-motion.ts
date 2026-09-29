import { createHash } from "node:crypto";
import http from "node:http";

/**
 * Whether a device's screen is moving, told from its PICTURE rather than from its tree.
 *
 * Reading the accessibility tree is the slow part of acting on a simulator: MEASURED at 400–900 ms a
 * read of Settings on iOS 27, depending on the Mac's load. Finding out that a tap has finished
 * animating by reading the tree until two reads agree therefore costs a second or more per step, and
 * a read that lands mid-animation reports a screen half-way between two. The stream serve-sim already
 * serves the pane answers the question for nothing. While the screen moves it sends a new picture
 * every display frame, and once the screen is still it sends the SAME bytes again — MEASURED on a
 * Back tap: the first changed frame 120 ms after the tap, 40 different frames at 60 fps over 680 ms,
 * then identical frames, then one about every 220 ms while nothing moves.
 *
 * So a frame that differs from the one before is motion, and rest is the same picture arriving again
 * with no different one for `stillMs`. The tree is then read once, at rest.
 */
export type ScreenMotion = {
  /** A point to measure change from. Take it BEFORE sending the input. */
  mark(): number;
  /**
   * After an input: wait for the picture to change since `mark` and then come to rest.
   *   "still"  — it did.
   *   "none"   — nothing changed within `changeWithinMs`.
   *   "moving" — it changed, but had not come to rest by `maxMs`: a spinner, a video.
   *   "lost"   — the stream went away; the caller falls back to reading the tree.
   */
  settle(mark: number, o: { changeWithinMs: number; stillMs: number; maxMs: number }): Promise<"still" | "none" | "moving" | "lost">;
  /** Wait for the picture to be at rest, whatever it was doing. False when it never was by `maxMs`. */
  rest(o: { stillMs: number; maxMs: number }): Promise<boolean>;
  close(): void;
};

/** How often the waits look at what has arrived: a display frame. */
const TICK_MS = 16;

/**
 * The motion of a screen, from a sequence of frames — the part with no socket in it, so a suite can
 * feed it frames and a clock. `frame` is called with each picture's bytes as it arrives.
 */
export function motionTracker(now: () => number = () => performance.now(), sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
  let last: string | null = null;
  /** Distinct pictures seen so far: the first frame, then every frame unlike the one before it. */
  let distinct = 0;
  let lastDistinctAt = 0;
  /** Whether the latest distinct picture has arrived again since — the renderer saying "still this". */
  let repeated = false;
  let alive = true;

  const atRest = (stillMs: number) => distinct > 0 && repeated && now() - lastDistinctAt >= stillMs;

  const tracker = {
    frame(bytes: Uint8Array): void {
      const h = createHash("sha1").update(bytes).digest("hex");
      if (h === last) { repeated = true; return; }
      last = h;
      distinct++;
      lastDistinctAt = now();
      repeated = false;
    },
    lost(): void { alive = false; },
    motion: {
      mark: () => distinct,
      async settle(mark, o) {
        const start = now();
        for (;;) {
          if (!alive) return "lost";
          const t = now() - start;
          if (distinct > mark) {
            if (atRest(o.stillMs)) return "still";
            if (t >= o.maxMs) return "moving";
          } else if (t >= o.changeWithinMs) {
            return "none";
          }
          await sleep(TICK_MS);
        }
      },
      async rest(o) {
        const start = now();
        for (;;) {
          if (!alive) return false;
          if (atRest(o.stillMs)) return true;
          if (now() - start >= o.maxMs) return false;
          await sleep(TICK_MS);
        }
      },
      close: () => { alive = false; },
    } satisfies ScreenMotion,
  };
  return tracker;
}

/**
 * The motion of the screen behind an MJPEG stream — serve-sim's `stream.mjpeg`, a multipart
 * response of JPEGs each headed by its Content-Length. Frames are cut by that length rather than by
 * scanning for the JPEG end marker, which a thumbnail inside a frame's EXIF also carries.
 */
export function watchMjpeg(url: string): ScreenMotion {
  const t = motionTracker();
  let buf: Buffer = Buffer.alloc(0);
  let need: number | null = null;
  const req = http.get(url, (res) => {
    if (res.statusCode !== 200) { t.lost(); res.resume(); return; }
    res.on("data", (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (need === null) {
          const end = buf.indexOf("\r\n\r\n");
          if (end < 0) break;
          const head = buf.subarray(0, end).toString("latin1");
          const m = /content-length:\s*(\d+)/i.exec(head);
          buf = buf.subarray(end + 4);
          if (!m) continue;
          need = Number(m[1]);
        }
        if (buf.length < need) break;
        t.frame(buf.subarray(0, need));
        buf = buf.subarray(need);
        need = null;
      }
    });
    res.on("end", () => t.lost());
    res.on("error", () => t.lost());
  });
  req.on("error", () => t.lost());
  return {
    ...t.motion,
    close() {
      t.motion.close();
      req.destroy();
    },
  };
}
