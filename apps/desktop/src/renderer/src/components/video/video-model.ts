/**
 * What the video player knows without a video element: its keys, its times, its buffered spans.
 *
 * The player's keyboard, as every video player on the web has taught it: Space and K play and pause,
 * J and L jump ten seconds, the arrows five seconds and the volume, M mutes, F fills the screen, and
 * comma and period step a frame while paused. Pure, so the table is tested without a video element.
 */
export type VideoKeyAction =
  | { kind: "toggle" }
  | { kind: "seekBy"; seconds: number }
  | { kind: "seekTo"; fraction: number }
  | { kind: "volumeBy"; delta: number }
  | { kind: "mute" }
  | { kind: "fullscreen" }
  | { kind: "frame"; direction: 1 | -1 };

/** How far a frame step moves when the file does not say its rate: 30 fps, the common case. */
export const FRAME_SECONDS = 1 / 30;
export const VOLUME_STEP = 0.05;

export function videoKeyAction(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }, paused: boolean): VideoKeyAction | null {
  // A chord is the app's (⌘W, ⌘K…), never the player's.
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.key) {
    case " ": case "k": case "K": return { kind: "toggle" };
    case "j": case "J": return { kind: "seekBy", seconds: -10 };
    case "l": case "L": return { kind: "seekBy", seconds: 10 };
    case "ArrowLeft": return { kind: "seekBy", seconds: -5 };
    case "ArrowRight": return { kind: "seekBy", seconds: 5 };
    case "ArrowUp": return { kind: "volumeBy", delta: VOLUME_STEP };
    case "ArrowDown": return { kind: "volumeBy", delta: -VOLUME_STEP };
    case "m": case "M": return { kind: "mute" };
    case "f": case "F": return { kind: "fullscreen" };
    case "Home": return { kind: "seekTo", fraction: 0 };
    case "End": return { kind: "seekTo", fraction: 1 };
    // A frame step on a playing video would be lost in the next frame; paused, it is the only way to
    // find the one frame worth looking at.
    case ",": return paused ? { kind: "frame", direction: -1 } : null;
    case ".": return paused ? { kind: "frame", direction: 1 } : null;
    default: return null;
  }
}

/** A time inside the video, never before its start or past its end. */
export const clampTime = (t: number, duration: number): number =>
  Math.max(0, Number.isFinite(duration) && duration > 0 ? Math.min(t, duration) : t);

/** Seconds as `m:ss` — the same shape a video player has always used, so it needs no label. Over an
 *  hour it grows an `h:mm:ss` field rather than counting to 90 minutes. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const s = total % 60, m = Math.floor(total / 60) % 60, h = Math.floor(total / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** The buffered spans of a media element as fractions of its length, for the scrubber to draw. */
export function bufferedSpans(buffered: { length: number; start(i: number): number; end(i: number): number } | null | undefined, duration: number): { from: number; to: number }[] {
  if (!buffered || !Number.isFinite(duration) || duration <= 0) return [];
  const out: { from: number; to: number }[] = [];
  for (let i = 0; i < buffered.length; i++) {
    out.push({ from: Math.max(0, buffered.start(i) / duration), to: Math.min(1, buffered.end(i) / duration) });
  }
  return out;
}
