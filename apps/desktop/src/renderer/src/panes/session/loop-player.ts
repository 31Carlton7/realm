/**
 * The one loop a window plays. Every moving backdrop on screen (the empty session's, the chat's, a
 * second pane's) is a viewer of it: they ask for a loop by its URL, and the window decodes ONE, the
 * one asked for by the pane the keyboard is in, or else by the first pane on screen. Every viewer of
 * that loop draws each of its frames into its own canvas; a viewer of any other shows its still.
 *
 * A frame source is outside every mechanism the app stops its motion with (design.md, Motion), so
 * this re-reads each of them and STOPS the decoder, never throttles it: the Motion switch, Reduce
 * motion, Realm's Low power, macOS Low Power Mode, a document that is hidden, and a window that is
 * covered, on displays all asleep, or behind a locked screen. Those three are asked of macOS
 * (main/backdrop-state.ts, stamped on the root by App.tsx): main keeps occluded windows compositing
 * for the browser agent (index.ts), so to the page such a window is visible and goes on drawing frames.
 */
/** What a viewer plays: a video by URL, or a GIF of the person's own by its id. */
export type LoopSource = { kind: "video"; url: string } | { kind: "gif"; id: string };
export const sourceKey = (s: LoopSource) => (s.kind === "video" ? s.url : `gif:${s.id}`);

export type Viewer = {
  source: LoopSource;
  /** The pane the viewer draws in, which says whether the keyboard is in it. */
  pane: Element;
  canvas: HTMLCanvasElement;
  /** The Motion switch, as the viewer's window has it. */
  motion(): boolean;
  /** A new frame, `w`×`h`. */
  frame(src: TexImageSource, w: number, h: number): void;
  /** Whether this viewer is showing the loop rather than its still. */
  showing(on: boolean): void;
};

/** Everything that may stop a loop, read fresh each time it is asked. */
export type Gate = {
  motion: boolean; reduce: boolean; quiet: string | null; lowPowerMode: boolean;
  hidden: boolean; covered: boolean; displayAsleep: boolean; screenLocked: boolean;
};

/** Whether a loop may play at all: Motion on, and none of Reduce motion, Realm's Low power (the
 *  root's `data-quiet="always"`), macOS Low Power Mode, a hidden document, a covered window, a window
 *  whose displays are all asleep, or a locked screen. */
export function loopMayPlay(g: Gate): boolean {
  return g.motion && !g.reduce && g.quiet !== "always" && !g.lowPowerMode && !g.hidden && !g.covered && !g.displayAsleep && !g.screenLocked;
}

/** Which loop the window decodes: the one asked for by a viewer on screen in the pane the keyboard is
 *  in, else by the first viewer on screen; none when no viewer is on screen. */
export function pickSource(viewers: readonly { key: string; onScreen: boolean; focused: boolean }[]): string | null {
  const seen = viewers.filter((v) => v.onScreen);
  return (seen.find((v) => v.focused) ?? seen[0])?.key ?? null;
}

type Decoder = { key: string; play(): void; release(): void };

/** Decoders made and not yet released, across the window: the "one per window" a live check reads. */
let live = 0;

/** A video, muted and looping, decoded once and drawn on each frame it presents. */
function videoDecoder(url: string, onFrame: (src: TexImageSource, w: number, h: number) => void): Decoder {
  const el = document.createElement("video");
  el.muted = true;
  el.loop = true;
  el.playsInline = true;
  el.crossOrigin = "anonymous";
  el.preload = "auto";
  el.src = url;
  let cb = 0, gone = false;
  live++;
  const next = () => { cb = el.requestVideoFrameCallback(() => { if (gone) return; onFrame(el, el.videoWidth, el.videoHeight); next(); }); };
  next();
  return {
    key: url,
    play: () => { if (el.paused) void el.play().catch(() => {}); },
    release: () => {
      live--;
      gone = true;
      el.cancelVideoFrameCallback(cb);
      el.pause();
      el.removeAttribute("src");
      el.load();
    },
  };
}

type DecodedImage = { image: VideoFrame & { duration: number | null } };
type GifDecoder = {
  tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null };
  decode(o: { frameIndex: number }): Promise<DecodedImage>;
  close(): void;
};
declare const ImageDecoder: { new (init: { data: Uint8Array; type: string }): GifDecoder } | undefined;

/** A GIF of the person's own, decoded a frame at a time when that frame is due. Driven by the
 *  window's frames, so a covered window decodes nothing. */
function gifDecoder(id: string, onFrame: (src: TexImageSource, w: number, h: number) => void): Decoder {
  let dec: GifDecoder | null = null;
  let playing = false, gone = false, raf = 0, index = 0, due = 0, shown: VideoFrame | null = null;
  live++;
  const ready = (async () => {
    const bytes = await window.realm?.backgrounds?.gif(id);
    if (!bytes || typeof ImageDecoder === "undefined" || gone) return;
    dec = new ImageDecoder({ data: bytes, type: "image/gif" });
    await dec.tracks.ready;
  })().catch(() => { dec = null; });
  const tick = async (now: number) => {
    raf = 0;
    if (!playing || !dec) return;
    if (now >= due) {
      const count = dec.tracks.selectedTrack?.frameCount ?? 1;
      const { image } = await dec.decode({ frameIndex: index }).catch(() => ({ image: null }));
      if (!image || gone) return;
      shown?.close();
      shown = image;
      onFrame(image, image.displayWidth, image.displayHeight);
      index = (index + 1) % count;
      due = now + Math.max(20, (image.duration ?? 100000) / 1000);
    }
    if (playing && !raf) raf = requestAnimationFrame((t) => void tick(t));
  };
  return {
    key: `gif:${id}`,
    play: () => { playing = true; void ready.then(() => { if (playing && !raf) raf = requestAnimationFrame((t) => void tick(t)); }); },
    release: () => { live--; gone = true; playing = false; cancelAnimationFrame(raf); shown?.close(); dec?.close(); },
  };
}

let viewers: Viewer[] = [];
const onScreen = new WeakMap<Viewer, boolean>();
const shown = new WeakSet<Viewer>();
let active: Decoder | null = null;
let wired = false;
let watching = false;
let observer: IntersectionObserver | null = null;
const reduce = () => window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;

function gate(): Gate {
  return {
    motion: viewers.some((v) => v.motion()),
    reduce: reduce()?.matches ?? false,
    quiet: document.documentElement.getAttribute("data-quiet"),
    lowPowerMode: document.documentElement.hasAttribute("data-low-power-mode"),
    hidden: document.hidden,
    covered: document.documentElement.hasAttribute("data-window-covered"),
    displayAsleep: document.documentElement.hasAttribute("data-display-asleep"),
    screenLocked: document.documentElement.hasAttribute("data-screen-locked"),
  };
}

function show(v: Viewer, on: boolean) {
  if (on === shown.has(v)) return;
  if (on) shown.add(v); else shown.delete(v);
  v.showing(on);
}

function frame(src: TexImageSource, w: number, h: number) {
  if (!w || !h || !active) return;
  for (const v of viewers) {
    if (sourceKey(v.source) !== active.key || !onScreen.get(v)) continue;
    v.frame(src, w, h);
    show(v, true);
  }
}

/** Settles which loop plays, if any, after anything that could change it. */
function update() {
  // Main looks at the screen only while this window has a loop to stop.
  if (watching !== viewers.length > 0) { watching = viewers.length > 0; window.realm?.watchBackdrop?.(watching); }
  const focus = document.activeElement;
  const key = loopMayPlay(gate())
    ? pickSource(viewers.map((v) => ({ key: sourceKey(v.source), onScreen: onScreen.get(v) === true, focused: !!focus && v.pane.contains(focus) })))
    : null;
  if (active && active.key !== key) {
    active.release();
    active = null;
  }
  for (const v of viewers) if (!active || sourceKey(v.source) !== key || !onScreen.get(v)) show(v, false);
  if (!key) return;
  if (!active) {
    const v = viewers.find((x) => sourceKey(x.source) === key)!;
    active = v.source.kind === "video" ? videoDecoder(v.source.url, frame) : gifDecoder(v.source.id, frame);
  }
  active.play();
}

function wire() {
  if (wired) return;
  wired = true;
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const v = viewers.find((x) => x.canvas === e.target);
      if (v) onScreen.set(v, e.isIntersecting);
    }
    update();
  });
  document.addEventListener("visibilitychange", update);
  document.addEventListener("focusin", update);
  reduce()?.addEventListener?.("change", update);
  new MutationObserver(update).observe(document.documentElement, { attributes: true, attributeFilter: ["data-quiet", "data-low-power-mode", "data-window-covered", "data-display-asleep", "data-screen-locked"] });
}

/** Starts showing `v` the window's loop when it is the one playing; the returned function stops. */
export function watchLoop(v: Viewer): () => void {
  wire();
  viewers.push(v);
  observer!.observe(v.canvas);
  update();
  return () => {
    viewers = viewers.filter((x) => x !== v);
    observer?.unobserve(v.canvas);
    shown.delete(v);
    update();
  };
}

/** Settles the loop again after something a viewer reads has changed (the Motion switch). */
export const refreshLoops = () => { if (wired) update(); };

/** For a live check: how many loops this window is decoding, and which. */
export function loopStats() {
  return { decoders: live, key: active?.key ?? null, viewers: viewers.length, showing: viewers.filter((v) => shown.has(v)).length };
}

/** For tests: forget every viewer and the loop, as a fresh window would. */
export function resetLoops() {
  active?.release();
  active = null;
  viewers = [];
  watching = false;
}
