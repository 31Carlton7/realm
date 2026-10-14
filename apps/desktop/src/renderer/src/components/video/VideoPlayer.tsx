import { Icon } from "@realm/ui";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { basenameOf, mediaUrl, type MediaFile } from "@realm/contracts";
import { Menu, type MenuItem } from "../Menu";
import { usePoster } from "../../panes/session/media/use-media";
import { rememberPosition, rememberVolume, savedPosition, savedVolume } from "./video-memory";
import { FRAME_SECONDS, bufferedSpans, clampTime, formatTime, videoKeyAction, type VideoKeyAction } from "./video-model";

/**
 * Realm's video player — the one every video in the app plays in: a message's clip, a tool's render,
 * the viewer's stage, the documents pane.
 *
 * Realm's own transport rather than `controls`, which would put Chromium's chrome — a different type
 * stack, a different accent, an overflow menu offering a download the app cannot honour — on the one
 * thing being looked at. What a player is expected to have, it has: a scrubber that shows what has
 * loaded and the time under the pointer, volume, speed, loop, picture in picture, full screen, the
 * keyboard every web player taught (`video-model.ts`), and the place each file was left
 * (`video-memory.ts`).
 *
 * Nothing plays on its own: a transcript that starts making noise as the reader scrolls past is the
 * failure this has to avoid, so the first frame is a poster and playback is a deliberate act.
 *
 * And it says when it cannot play. Chromium decodes H.264, VP8/9 and AV1; a ProRes `.mov`, most
 * `.avi`s and some `.mkv`s it cannot, and the element answers with an error or a picture with no
 * width. The player turns either into a sentence and the ways out — a playable copy where this Mac
 * has ffmpeg (main/media-proxy.ts), the default app, the Finder — rather than a black box.
 */
export type VideoVariant = "inline" | "stage" | "pane";

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
/** How long the transport stays up after the pointer or a key last moved, while playing. */
const IDLE_MS = 2500;
/** How often a playing video's place is written down; a pause, an end and an unmount write at once. */
const REMEMBER_MS = 2000;

type Failure = "format" | "unreadable";
type Copy = { state: "idle" } | { state: "making" } | { state: "failed"; message: string };

export function VideoPlayer({ file, variant = "inline", autoFocus = false, onExpand, version = null }: {
  file: MediaFile;
  variant?: VideoVariant;
  autoFocus?: boolean;
  /** Puts the video somewhere larger — the viewer, from a message. Absent where it already is. */
  onExpand?: () => void;
  /** The file's version on disk. A video that failed while still being written is tried again when
   *  it moves. */
  version?: string | number | null;
}) {
  const name = basenameOf(file.path);
  const root = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLVideoElement>(null);
  /** What the element is playing: the file, or the playable copy made of it. */
  const [src, setSrc] = useState(file.path);
  const [attempt, setAttempt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [sound, setSound] = useState(savedVolume);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [spans, setSpans] = useState<{ from: number; to: number }[]>([]);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  const [pip, setPip] = useState(false);
  const [full, setFull] = useState(false);
  const [active, setActive] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [canCopy, setCanCopy] = useState<boolean | undefined>(undefined);
  const [copy, setCopy] = useState<Copy>({ state: "idle" });
  const [rateMenu, setRateMenu] = useState(false);
  const rateButton = useRef<HTMLButtonElement>(null);
  const poster = usePoster(file.path);
  const width = useWidth(root);
  // A narrow frame (a clip at its own 320px, a grid of three in a message) keeps the transport that
  // is used every second and folds the rest away; the keys still do all of it.
  const size = width === null ? undefined : width < 300 ? "tiny" : width < 460 ? "narrow" : undefined;

  useEffect(() => { setSrc(file.path); setFailure(null); setCopy({ state: "idle" }); }, [file.path]);

  // The element's volume is a property, not an attribute; the state is the one source of both.
  useEffect(() => {
    const el = ref.current; if (!el) return;
    el.volume = sound.volume; el.muted = sound.muted;
    rememberVolume(sound.volume, sound.muted);
  }, [sound, attempt, src]);
  useEffect(() => { const el = ref.current; if (el) el.playbackRate = rate; }, [rate, attempt, src]);

  /* Where the file was left, written down as it plays and whenever it stops. Keyed by the FILE's path
     even while a copy plays: it is the file the reader is watching. */
  const lastWrite = useRef(0);
  const remember = useCallback((force = false) => {
    const el = ref.current; if (!el) return;
    const now = Date.now();
    if (!force && now - lastWrite.current < REMEMBER_MS) return;
    lastWrite.current = now;
    rememberPosition(file.path, el.currentTime, el.duration);
  }, [file.path]);
  useEffect(() => () => remember(true), [remember]);

  useEffect(() => {
    const onFull = () => setFull(document.fullscreenElement !== null && document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", onFull);
    return () => document.removeEventListener("fullscreenchange", onFull);
  }, []);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const on = () => setPip(true), off = () => setPip(false);
    el.addEventListener("enterpictureinpicture", on);
    el.addEventListener("leavepictureinpicture", off);
    return () => { el.removeEventListener("enterpictureinpicture", on); el.removeEventListener("leavepictureinpicture", off); };
  }, [attempt, src]);

  // A failure that a copy could fix asks once whether this Mac can make one.
  useEffect(() => {
    if (failure !== "format" || canCopy !== undefined) return;
    let live = true;
    void (window.realm?.media?.canTranscode?.() ?? Promise.resolve(false)).catch(() => false)
      .then((yes) => { if (live) setCanCopy(yes); });
    return () => { live = false; };
  }, [failure, canCopy]);

  // A file still being written fails until it is whole; when it changes on disk, try again.
  const seenVersion = useRef(version);
  useEffect(() => {
    if (seenVersion.current === version) return;
    seenVersion.current = version;
    if (failure) { setFailure(null); setAttempt((n) => n + 1); }
  }, [version, failure]);

  /* The transport shows while paused, and while playing for a moment after the pointer or a key last
     moved — so a full-screen film is not watched through its controls. */
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wake = useCallback(() => {
    setActive(true);
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(() => setActive(false), IDLE_MS);
  }, []);
  useEffect(() => () => { if (idle.current) clearTimeout(idle.current); }, []);

  const toggle = useCallback(() => {
    const el = ref.current; if (!el) return;
    // The element's own state decides, not React's: a video that reached its end has paused itself
    // and `playing` may not have caught up yet.
    if (el.paused) void el.play()?.catch(() => setPlaying(false));
    else el.pause();
  }, []);

  const seek = useCallback((to: number) => {
    const el = ref.current; if (!el || !Number.isFinite(to)) return;
    const at = clampTime(to, el.duration);
    el.currentTime = at; setTime(at);
  }, []);

  const toggleFull = useCallback(() => {
    const box = root.current; if (!box) return;
    if (document.fullscreenElement === box) void document.exitFullscreen?.().catch(() => {});
    else void box.requestFullscreen?.().catch(() => {});
  }, []);

  const togglePip = useCallback(() => {
    const el = ref.current; if (!el) return;
    if (document.pictureInPictureElement === el) void document.exitPictureInPicture?.().catch(() => {});
    else void el.requestPictureInPicture?.().catch(() => {});
  }, []);

  const act = useCallback((a: VideoKeyAction) => {
    const el = ref.current; if (!el) return;
    switch (a.kind) {
      case "toggle": toggle(); break;
      case "seekBy": seek(el.currentTime + a.seconds); break;
      case "seekTo": seek(a.fraction * (el.duration || 0)); break;
      case "volumeBy": setSound((s) => ({ volume: Math.round(Math.min(1, Math.max(0, s.volume + a.delta)) * 100) / 100, muted: a.delta > 0 ? false : s.muted })); break;
      case "mute": setSound((s) => ({ ...s, muted: !s.muted })); break;
      case "fullscreen": toggleFull(); break;
      case "frame": seek(el.currentTime + a.direction * FRAME_SECONDS); break;
    }
  }, [toggle, seek, toggleFull]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const t = e.target;
    // The volume slider keeps its own arrows, and a focused button its own Space and Return.
    if (t instanceof HTMLInputElement) return;
    if ((e.key === " " || e.key === "Enter") && t instanceof HTMLButtonElement) return;
    const a = videoKeyAction(e, ref.current?.paused ?? true);
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    wake();
    act(a);
  };

  const openInApp = () => { void window.realm?.media?.open(file.path); };
  const reveal = () => { void window.realm?.media?.reveal(file.path); };
  const makeCopy = () => {
    setCopy({ state: "making" });
    void (window.realm?.media?.transcode?.(file.path) ?? Promise.reject(new Error("Making a copy needs the desktop app.")))
      .then((path) => { setSrc(path); setFailure(null); setCopy({ state: "idle" }); setAttempt((n) => n + 1); })
      .catch((e: unknown) => setCopy({ state: "failed", message: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e) }));
  };

  const rateItems: MenuItem[] = RATES.map((r) => ({ label: r === 1 ? "Normal" : `${r}×`, checked: r === rate, onSelect: () => setRate(r) }));
  const pipOffered = typeof document !== "undefined" && document.pictureInPictureEnabled === true;
  const copied = src !== file.path;

  if (failure) {
    return (
      <div className="media-video video-player video-failed" data-variant={variant} role="group" aria-label={`Video ${name}`}>
        <Icon name="alert" size={16} className="video-failed-mark" aria-hidden="true" />
        <p className="video-failed-says">
          {failure === "unreadable"
            ? `Realm could not read ${name}. It may still be being written, or it has moved.`
            : copied
              ? `The copy of ${name} would not play either.`
              : `Realm cannot play the video format in ${name}.`}
        </p>
        {failure === "format" && !copied && (
          <p className="video-failed-detail">
            {copy.state === "failed" ? `ffmpeg could not make a playable copy: ${copy.message}`
              : canCopy === false ? "This Mac has no ffmpeg, which Realm would use to make a copy it can play."
              : canCopy ? "ffmpeg on this Mac can make a copy Realm can play. The original is not changed." : null}
          </p>
        )}
        <div className="video-failed-actions">
          {failure === "format" && !copied && canCopy && (
            <button type="button" className="btn btn-primary" disabled={copy.state === "making"} onClick={makeCopy}>
              {copy.state === "making" ? "Making a playable copy…" : "Make a playable copy"}
            </button>
          )}
          {failure === "unreadable" && (
            <button type="button" className="btn" onClick={() => { setFailure(null); setAttempt((n) => n + 1); }}>Try again</button>
          )}
          <button type="button" className="btn" onClick={openInApp}>Open in default app</button>
          <button type="button" className="btn" onClick={reveal}>Reveal in Finder</button>
        </div>
      </div>
    );
  }

  return (
    <div ref={root} className="media-video video-player" data-variant={variant} data-playing={playing || undefined}
      data-active={active || undefined} data-full={full || undefined} data-size={size} role="group" aria-label={`Video ${name}`}
      tabIndex={0} autoFocus={autoFocus} onKeyDown={onKeyDown} onPointerMove={wake}>
      <video
        key={`${src}#${attempt}`}
        ref={ref}
        className="media-el"
        src={mediaUrl(src)}
        poster={poster ?? undefined}
        preload="metadata"
        playsInline
        loop={loop}
        onClick={toggle}
        onDoubleClick={toggleFull}
        onPlay={() => { setPlaying(true); setStarted(true); wake(); }}
        onPause={() => { setPlaying(false); remember(true); }}
        onEnded={() => { setPlaying(false); remember(true); }}
        onTimeUpdate={(e) => { setTime(e.currentTarget.currentTime); remember(); }}
        onProgress={(e) => setSpans(bufferedSpans(e.currentTarget.buffered, e.currentTarget.duration))}
        onVolumeChange={(e) => {
          const { volume, muted } = e.currentTarget;
          setSound((s) => (s.volume === volume && s.muted === muted ? s : { volume, muted }));
        }}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          // A movie whose picture Chromium cannot decode loads its sound and reports no width.
          if (el.videoWidth === 0 && el.videoHeight === 0) { setFailure("format"); return; }
          setDuration(el.duration);
          const at = savedPosition(file.path, el.duration);
          if (at !== null) { el.currentTime = at; setTime(at); }
          setSpans(bufferedSpans(el.buffered, el.duration));
        }}
        onError={(e) => {
          const code = e.currentTarget.error?.code;
          // 3 is a decode failure, 4 a source no decoder takes; anything else is the file not arriving.
          setFailure(code === 3 || code === 4 ? "format" : "unreadable");
        }}
      />
      {/* The big centre button exists only before the first play. Once the video is running the
          reader clicks the frame itself — a permanent overlay would sit on the one thing they came for. */}
      {!started && (
        <button type="button" className="media-play" aria-label={`Play ${name}`} onClick={toggle}>
          {/* off-ladder: a 52px poster button has no rung. */}
          <Icon name="play" size={22} />
        </button>
      )}
      <div className="video-controls">
        <Scrubber time={time} duration={duration} spans={spans} onSeek={seek} />
        <div className="video-bar">
          {/* §6 icon swap: one control whose glyph turns over, so both stay in the DOM and cross-fade. */}
          <button type="button" className="video-btn" aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (k)" : "Play (k)"} onClick={toggle}>
            <span className="icon-swap" data-on={playing || undefined}>
              <Icon name="play" size={14} className="swap-off" />
              <Icon name="pause" size={14} className="swap-on" />
            </span>
          </button>
          <button type="button" className="video-btn" aria-label={sound.muted ? "Unmute" : "Mute"} aria-pressed={sound.muted}
            title={sound.muted ? "Unmute (m)" : "Mute (m)"} onClick={() => setSound((s) => ({ ...s, muted: !s.muted }))}>
            <span className="icon-swap" data-on={sound.muted || undefined}>
              <Icon name="volumeOn" size={14} className="swap-off" />
              <Icon name="volumeOff" size={14} className="swap-on" />
            </span>
          </button>
          <input className="video-volume" type="range" min={0} max={1} step={0.05} aria-label="Volume"
            value={sound.muted ? 0 : sound.volume}
            style={{ "--video-volume": `${(sound.muted ? 0 : sound.volume) * 100}%` } as React.CSSProperties}
            onChange={(e) => { const v = Number(e.currentTarget.value); setSound({ volume: v, muted: v === 0 }); }} />
          <span className="video-time" aria-live="off">
            {formatTime(time)}<span className="video-time-total"> / {formatTime(duration)}</span>
          </span>
          {copied && <span className="video-copy-note" title="Chromium cannot decode the original, so this is a copy ffmpeg made.">Playable copy</span>}
          <span className="video-bar-gap" />
          <button ref={rateButton} type="button" className="video-btn video-rate" aria-label={`Speed, ${rate === 1 ? "normal" : `${rate}×`}`}
            title="Playback speed" aria-haspopup="menu" aria-expanded={rateMenu} onClick={() => setRateMenu(true)}>
            {rate}×
          </button>
          <button type="button" className="video-btn video-loop" aria-label="Loop" aria-pressed={loop} title="Loop" onClick={() => setLoop((l) => !l)}>
            <Icon name="loop" size={14} />
          </button>
          {pipOffered && (
            <button type="button" className="video-btn video-pip" aria-label="Picture in picture" aria-pressed={pip} title="Picture in picture" onClick={togglePip}>
              <Icon name={pip ? "pipExit" : "pip"} size={14} />
            </button>
          )}
          {onExpand && (
            <button type="button" className="video-btn" aria-label="Open larger" title="Open larger" onClick={onExpand}>
              <Icon name="expand" size={14} />
            </button>
          )}
          <button type="button" className="video-btn" aria-label={full ? "Exit full screen" : "Full screen"} title={full ? "Exit full screen (f)" : "Full screen (f)"} onClick={toggleFull}>
            <Icon name={full ? "exitFullscreen" : "fullscreen"} size={14} />
          </button>
        </div>
      </div>
      {rateMenu && <Menu items={rateItems} anchorRef={rateButton} align="right" placement="up" onClose={() => setRateMenu(false)} label="Playback speed" />}
    </div>
  );
}

/** The element's laid-out width, kept current; null until it has been measured (and in jsdom). */
function useWidth(ref: React.RefObject<HTMLElement | null>): number | null {
  const [w, setW] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/**
 * The seek bar: a slider the keyboard moves like the rest of the player, what has loaded drawn under
 * what has played, and the time under the pointer said above it before the click.
 */
function Scrubber({ time, duration, spans, onSeek }: {
  time: number; duration: number; spans: readonly { from: number; to: number }[]; onSeek: (t: number) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const dragging = useRef(false);
  const at = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = bar.current!.getBoundingClientRect();
    const f = r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0;
    return { x: f * r.width, t: f * duration };
  };
  const played = duration > 0 ? Math.min(1, time / duration) : 0;
  return (
    <div ref={bar} className="video-scrub" role="slider" tabIndex={duration > 0 ? 0 : -1} aria-label="Seek"
      aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(time)}
      aria-valuetext={`${formatTime(time)} of ${formatTime(duration)}`} aria-disabled={duration > 0 ? undefined : true}
      onPointerDown={(e) => {
        if (e.button !== 0 || duration <= 0) return;
        dragging.current = true;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* jsdom */ }
        onSeek(at(e).t);
      }}
      onPointerMove={(e) => {
        if (duration <= 0) return;
        const p = at(e);
        setHover(p);
        if (dragging.current) onSeek(p.t);
      }}
      onPointerUp={() => { dragging.current = false; }}
      onPointerLeave={() => { if (!dragging.current) setHover(null); }}>
      <div className="video-scrub-track">
        {spans.map((s, i) => <span key={i} className="video-scrub-buffered" style={{ left: `${s.from * 100}%`, width: `${(s.to - s.from) * 100}%` }} />)}
        <span className="video-scrub-played" style={{ width: `${played * 100}%` }} />
        <span className="video-scrub-thumb" style={{ left: `${played * 100}%` }} />
      </div>
      {hover && <span className="video-scrub-hover" style={{ left: hover.x }} aria-hidden="true">{formatTime(hover.t)}</span>}
    </div>
  );
}
