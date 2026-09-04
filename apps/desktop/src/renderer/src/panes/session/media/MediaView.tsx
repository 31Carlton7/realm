import { Icon } from "@realm/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { basenameOf, formatAttachmentSize, mediaUrl, type MediaFile } from "@realm/contracts";
import { useMediaFiles, usePoster } from "./use-media";

/**
 * Media, drawn where the agent talked about it.
 *
 * Realm's whole transcript argument is that the reader should not have to do the parsing: a diff is
 * drawn, a plan is drawn, a terminal is drawn. A movie the agent just encoded was the one artefact
 * that still arrived as a filename in a table — the reader had to go to Finder to find out whether
 * the thing they asked for is any good. These are the elements that close that.
 *
 * Every path here has already been confirmed by main (`media:stat`). Nothing in this file guesses.
 */

/** Seconds as `m:ss` — the same shape a video player has always used, so it needs no label. Over an
 *  hour it grows an `h:mm:ss` field rather than counting to 90 minutes. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const s = total % 60, m = Math.floor(total / 60) % 60, h = Math.floor(total / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/**
 * A video with Realm's own controls rather than the platform's.
 *
 * `controls` would put Chromium's chrome — a different type stack, a different accent, its own
 * overflow menu offering "Picture in Picture" and a download the app cannot honour — in the middle
 * of the transcript. These are the four controls that are actually wanted, and the scrubber is a
 * real `input[type=range]`, so the keyboard gets arrow-key seeking for free.
 *
 * Nothing here plays on its own. A transcript that starts making noise as the reader scrolls past is
 * the failure mode this feature has to avoid, so the first frame is a poster and playback is a
 * deliberate act.
 */
function VideoPlayer({ file, autoFocus = false, onExpand }: { file: MediaFile; autoFocus?: boolean; onExpand?: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const poster = usePoster(file.path);

  const toggle = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // The element's own state decides, not React's: a video that reached its end has paused itself
    // and `playing` may not have caught up yet, and toggling off the stale value would do nothing.
    if (el.paused) void el.play().catch(() => setPlaying(false));
    else el.pause();
  }, []);

  const seek = (to: number) => {
    const el = ref.current;
    if (el && Number.isFinite(to)) { el.currentTime = to; setTime(to); }
  };

  return (
    <div className="media-video" data-playing={playing || undefined}>
      <video
        ref={ref}
        className="media-el"
        src={mediaUrl(file.path)}
        poster={poster ?? undefined}
        preload="metadata"
        playsInline
        // No `controls`, no `autoPlay`, no `loop`: see the note above. `muted` is state rather than
        // an attribute so the button and the element can never disagree.
        muted={muted}
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
      />
      {/* The big centre button exists only before the first play. Once the video is running the
          reader clicks the frame itself — a permanent overlay button would sit on top of the one
          thing they came to look at. */}
      {!playing && (
        <button type="button" className="media-play" aria-label={`Play ${basenameOf(file.path)}`} autoFocus={autoFocus} onClick={toggle}>
          <Icon name="play" size={22} />
        </button>
      )}
      <div className="media-controls">
        {/* §6 icon swap: the transport is one control whose glyph turns over, so both stay in the DOM
            and cross-fade. A ternary replaces the element instead, and gets no transition at all. */}
        <button type="button" className="media-btn" aria-label={playing ? "Pause" : "Play"} onClick={toggle}>
          <span className="icon-swap" data-on={playing || undefined}>
            <Icon name="play" size={13} className="swap-off" />
            <Icon name="pause" size={13} className="swap-on" />
          </span>
        </button>
        <span className="media-time">{formatTime(time)}</span>
        <input
          className="media-scrub" type="range" min={0} max={duration || 0} step="any" value={Math.min(time, duration || 0)}
          aria-label="Seek" disabled={!duration}
          onChange={(e) => seek(Number(e.currentTarget.value))}
          // The filled part of the track is painted from this, so the bar reads as progress rather
          // than as an empty slider that happens to have a knob on it.
          style={{ "--media-progress": duration ? `${(time / duration) * 100}%` : "0%" } as React.CSSProperties}
        />
        <span className="media-time media-duration">{formatTime(duration)}</span>
        <button type="button" className="media-btn" aria-label={muted ? "Unmute" : "Mute"} aria-pressed={muted} onClick={() => setMuted((m) => !m)}>
          <span className="icon-swap" data-on={muted || undefined}>
            <Icon name="volumeOn" size={13} className="swap-off" />
            <Icon name="volumeOff" size={13} className="swap-on" />
          </span>
        </button>
        {onExpand && (
          <button type="button" className="media-btn" aria-label="Open larger" onClick={onExpand}>
            <Icon name="focusPane" size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

/** One media file at message width: the picture, the player, or an audio row. `onExpand` is what
 *  puts it in the lightbox — a 1080×1920 vertical video is legible in a 680px column only as a
 *  thumbnail, and the full-pane view is where it is actually watched. */
export function MediaFrame({ file, autoFocus = false, onExpand }: { file: MediaFile; autoFocus?: boolean; onExpand?: () => void }) {
  const name = basenameOf(file.path);
  if (file.kind === "video") return <VideoPlayer file={file} autoFocus={autoFocus} onExpand={onExpand} />;
  if (file.kind === "audio") {
    // Audio is the one kind with nothing to look at, so it keeps the native transport: there is no
    // frame for custom controls to sit on, and a bare row of our own buttons would be a worse
    // version of the same widget.
    return (
      <div className="media-audio">
        <span className="media-audio-name">{name}</span>
        <audio className="media-el" src={mediaUrl(file.path)} controls preload="metadata" />
      </div>
    );
  }
  return (
    <button type="button" className="media-image" onClick={onExpand} disabled={!onExpand} autoFocus={autoFocus}
      aria-label={onExpand ? `Open ${name} larger` : name}>
      {/* `loading="lazy"` matters here in a way it does not on a tile: a long transcript can hold
          dozens of full-size renders, and decoding the ones nobody has scrolled to is work that
          competes with the stream still arriving. */}
      <img className="media-el" src={mediaUrl(file.path)} alt={name} loading="lazy" draggable={false} />
    </button>
  );
}

/** The row under a message: each file, its name, its size, and the two things a reader wants from a
 *  file they can see but not touch. One column when a single file is shown (it gets the width), a
 *  wrapped grid when there are several — three mockups side by side is the comparison the reader
 *  came for, and stacking them full-width would put two of them off-screen. */
export function MediaStrip({ files }: { files: readonly MediaFile[] }) {
  const [open, setOpen] = useState<MediaFile | null>(null);
  if (files.length === 0) return null;
  return (
    <>
      <ul className="media-strip" data-count={files.length > 1 ? "many" : "one"} aria-label="Files this message points at">
        {files.map((file) => (
          <li key={file.path} className="media-item">
            <MediaFrame file={file} onExpand={() => setOpen(file)} />
            <div className="media-meta">
              <span className="media-name" title={file.path}>{basenameOf(file.path)}</span>
              <span className="media-detail">{formatAttachmentSize(file.size)}</span>
              <button type="button" className="media-action" title="Reveal in Finder"
                aria-label={`Reveal ${basenameOf(file.path)} in Finder`}
                onClick={() => void window.realm?.media?.reveal(file.path)}>
                <Icon name="folder" size={12} />
              </button>
              <button type="button" className="media-action" title="Open"
                aria-label={`Open ${basenameOf(file.path)}`}
                onClick={() => void window.realm?.media?.open(file.path)}>
                <Icon name="focusPane" size={12} />
              </button>
            </div>
          </li>
        ))}
      </ul>
      {open && <MediaLightbox file={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/**
 * One file, full window, over everything.
 *
 * A portal to `document.body` rather than a child of the transcript: the transcript is a scroller
 * with its own stacking context and a `backdrop-filter` fade over its bottom edge, and an overlay
 * inside it would be clipped by both.
 *
 * Escape closes, and focus moves into the dialog on open so the key lands somewhere. Nothing else
 * is trapped — this is a viewer, not a form, and a click anywhere outside the media closes it too.
 */
export function MediaLightbox({ file, onClose }: { file: MediaFile; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    // Capture: the pane's own Escape bindings (close pane, dismiss the picker) are listening too,
    // and the topmost surface is the one that should answer the key.
    window.addEventListener("keydown", onKey, true);
    ref.current?.focus();
    /* A playing video keeps playing behind an overlay, and its SOUND does not care that it cannot be
       seen. Pausing is also the half of the fix that the stylesheet cannot do — the other half is
       hiding the frames, which `data-media-lightbox` drives (see the note in styles.css). */
    document.body.dataset["mediaLightbox"] = "";
    for (const v of Array.from(document.querySelectorAll<HTMLVideoElement>(".transcript video"))) v.pause();
    return () => {
      window.removeEventListener("keydown", onKey, true);
      delete document.body.dataset["mediaLightbox"];
    };
  }, [onClose]);
  return createPortal(
    <div className="media-lightbox" role="dialog" aria-modal="true" aria-label={basenameOf(file.path)}
      ref={ref} tabIndex={-1} onClick={onClose}>
      {/* The stage swallows clicks so that using the scrubber does not dismiss the thing being
          scrubbed; the backdrop around it still closes. */}
      <div className="media-stage" onClick={(e) => e.stopPropagation()}>
        <MediaFrame file={file} autoFocus />
      </div>
      <div className="media-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="media-name">{basenameOf(file.path)}</span>
        <span className="media-detail">{formatAttachmentSize(file.size)}</span>
        <button type="button" className="media-action" onClick={() => void window.realm?.media?.reveal(file.path)}>
          <Icon name="folder" size={12} /> Reveal
        </button>
        <button type="button" className="media-action" onClick={() => void window.realm?.media?.open(file.path)}>
          <Icon name="focusPane" size={12} /> Open
        </button>
        <button type="button" className="media-action" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={12} />
        </button>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The shimmering canvas an image or a video occupies while it is being made
 * (aicss.dev/components/image-generation).
 *
 * It is a PLACEHOLDER at the size of the thing coming, not a spinner: a spinner says "something is
 * happening", a canvas of the right shape says "your picture is being drawn, and it will land
 * here". That is the entire difference the component exists for, and it is why the aspect ratio and
 * the label are props rather than constants.
 *
 * Shown by the tool call's REAL state — it is on screen exactly as long as the call has no result —
 * never by a timer. A generation that fails leaves a failed tool card, not a canvas shimmering
 * forever.
 */
/** The longest side a canvas may take. Big enough to read as a placeholder for a picture, small
 *  enough that a run of them does not push the conversation off the screen. */
const GEN_MAX_PX = 320;

/** The width a `w / h` ratio wants, to fit inside a GEN_MAX_PX square.
 *
 *  Computed rather than left to CSS because CSS cannot do it: `aspect-ratio` with BOTH `max-width`
 *  and `max-height` set does not preserve the ratio — it clamps each side independently, so a 9:16
 *  canvas came out square, which is precisely the thing this component exists to avoid. Giving it a
 *  definite width and letting `aspect-ratio` derive the height is unambiguous. Anything unparseable
 *  falls back to the full square. */
export function genWidthPx(aspect: string, max = GEN_MAX_PX): number {
  const [w, h] = aspect.split("/").map((n) => Number(n.trim()));
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) return max;
  return Math.round(w * Math.min(max / w, max / h));
}

export function GeneratingCanvas({ kind, label, detail, aspect = "1 / 1" }: {
  kind: "image" | "video"; label: string;
  /** The prompt, or the command's own description — what is being made, in the agent's words. */
  detail?: string | null;
  aspect?: string;
}) {
  return (
    <div className="gen-wrap">
      {/* `aspectRatio` stays alongside the width so that a column too narrow for it clamps the width
          and lets the HEIGHT follow, rather than squashing the shape. */}
      <div className="gen-canvas" style={{ aspectRatio: aspect, width: genWidthPx(aspect) }} role="img" aria-label={label}>
        {/* Both decorative: the label below is what a screen reader is given, and a shimmer read
            aloud is noise. */}
        <span className="gen-glow" aria-hidden="true" />
        <span className="gen-dots" aria-hidden="true" />
        <Icon name={kind === "video" ? "video" : "image"} size={18} className="gen-glyph" />
      </div>
      <div className="gen-meta">
        <span className="gen-label shimmer-text">{label}</span>
        {detail && <span className="gen-detail" title={detail}>{detail}</span>}
      </div>
    </div>
  );
}

/**
 * A file a tool call named, drawn if it turns out to be media. Used by ToolCard for the `Read` of a
 * screenshot and the `Write` of a render — the two calls whose whole point is a picture, and whose
 * raw well could only ever say what it was called.
 *
 * Renders nothing at all until main confirms the path, and nothing ever for a path it does not: a
 * tool card that grew an empty frame every time an agent read a `.png` that had since been cleaned
 * up would be a worse card than the one that just showed the JSON.
 */
export function ToolMedia({ path }: { path: string }) {
  const [open, setOpen] = useState<MediaFile | null>(null);
  const files = useMediaFiles(useMemo(() => [path], [path]));
  const file = files[0];
  if (!file) return null;
  return (
    <div className="tool-media">
      <MediaFrame file={file} onExpand={() => setOpen(file)} />
      {open && <MediaLightbox file={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
