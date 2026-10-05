import { Icon } from "@realm/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { basenameOf, isPlayablePath, mediaUrl } from "@realm/contracts";
import { MediaFrame } from "../../panes/session/media/MediaView";
import { useMediaFile } from "../../panes/session/media/use-media";
import { useApp } from "../../state/store";
import type { Mark, ViewerFile } from "../../state/viewer";
import { MARK_SCREEN_WIDTH, pointsAttr } from "./markup";
import { MAX_ZOOM, MIN_ZOOM, anchoredScroll, clampZoom, scaleOf, stepZoom, zoomLabel, type Size, type Zoom } from "./zoom";

/** A key the viewer may take only when nobody is typing: a field, the scrubber, a menu's list keep it. */
export function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement;
}

/**
 * What the viewer shows of one file, at the size the window gives it.
 *
 * In falling order of how much it says: a picture main confirms is on disk is that picture, which
 * zooms; a video or a sound is the transcript's own player; anything else is macOS's render of it —
 * a PDF's first page, a document, a sheet — which zooms as a picture does; and a file macOS cannot
 * draw either is its name, said plainly, rather than an empty frame. `version` is the file's
 * modification time: an agent rewriting the file in place moves it, and the stage reads the new one.
 */
export function ViewerStage({ file, gone, version, onBackdrop }: {
  file: ViewerFile;
  /** The file's stat answered nothing: it has moved or been deleted since it was listed. */
  gone: boolean;
  version: number | null;
  /** A click on the ground around the file, rather than on it. */
  onBackdrop: () => void;
}) {
  const name = file.name ?? basenameOf(file.path);
  // Only a path the media scheme could serve is put to main as media — a PDF never reaches media:stat.
  const media = useMediaFile(isPlayablePath(file.path) ? file.path : null);
  const v = version === null ? "" : `?v=${version}`;
  if (gone) return <StageNote onBackdrop={onBackdrop}>This file is no longer on disk.</StageNote>;
  if (media === undefined) return <div className="media-viewer-stage" onClick={onBackdrop} />;
  if (media?.kind === "image") return <ZoomPicture key={file.path} src={mediaUrl(media.path) + v} alt={name} onBackdrop={onBackdrop} markPath={file.path} />;
  if (media) {
    return (
      <div className="media-viewer-stage" onClick={(e) => { if (e.target === e.currentTarget) onBackdrop(); }}>
        {/* Keyed on the version: a re-encoded clip is a different file to the element, not a seek. */}
        <div className="media-viewer-player"><MediaFrame key={`${media.path}${v}`} file={media} /></div>
      </div>
    );
  }
  return <DocumentPicture path={file.path} name={name} version={version} onBackdrop={onBackdrop} />;
}

function StageNote({ children, onBackdrop }: { children: React.ReactNode; onBackdrop: () => void }) {
  return (
    <div className="media-viewer-stage" onClick={(e) => { if (e.target === e.currentTarget) onBackdrop(); }}>
      <p className="media-viewer-note">{children}</p>
    </div>
  );
}

/**
 * Anything that is not media, as macOS renders it — the Quick Look picture the Finder's space bar
 * shows, at the size of the window. Fetched for this file and this version only, never from the
 * thumbnail cache: a cached picture of a document the agent has just rewritten is the old document.
 */
function DocumentPicture({ path, name, version, onBackdrop }: { path: string; name: string; version: number | null; onBackdrop: () => void }) {
  const [still, setStill] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setStill(undefined);
    void (window.realm?.files?.preview?.(path, "page") ?? Promise.resolve(null))
      .catch(() => null).then((url) => { if (live) setStill(url); });
    return () => { live = false; };
  }, [path, version]);
  if (still === undefined) return <div className="media-viewer-stage" onClick={onBackdrop} />;
  if (still === null) {
    return (
      <StageNote onBackdrop={onBackdrop}>
        <Icon name="artifact" size={28} className="media-viewer-glyph" aria-hidden="true" />
        <span>macOS has no preview for {name}.</span>
      </StageNote>
    );
  }
  return <ZoomPicture key={`${path}:${version ?? ""}`} src={still} alt={`Preview of ${name}`} onBackdrop={onBackdrop} page markPath={path} />;
}

/**
 * A picture that fits the window, never above its own size, and zooms: the − and + under it, ⌘ or a
 * pinch with the wheel round the pointer, a double-click between fit and actual size, and the keys
 * every image viewer has (+, −, 0). Past the window it pans — by scrolling, or by dragging it.
 *
 * And it takes marks, Codex's Markup: with the pen down a drag draws on the picture, in the picture's
 * own pixels so a mark stays where it was put at any zoom, and the next question carries a copy of
 * the file with the marks on it (`markup.ts`). `markPath` is the file the marks are of.
 */
function ZoomPicture({ src, alt, onBackdrop, page = false, markPath = null }: {
  src: string; alt: string; onBackdrop: () => void; page?: boolean; markPath?: string | null;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Size>({ w: 0, h: 0 });
  const [natural, setNatural] = useState<Size | null>(null);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [failed, setFailed] = useState(false);
  const scale = natural ? scaleOf(zoom, natural, box) : 1;
  /** Where the pointer was when a zoom was asked for, so the next layout can put that point back. */
  const pending = useRef<{ at: { x: number; y: number }; scroll: { left: number; top: number }; from: number } | null>(null);

  useLayoutEffect(() => {
    const el = scroller.current; if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return; // jsdom
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const zoomTo = useCallback((to: Zoom, at?: { x: number; y: number }) => {
    const el = scroller.current;
    if (el && natural) {
      pending.current = { at: at ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 }, scroll: { left: el.scrollLeft, top: el.scrollTop }, from: scale };
    }
    setZoom(to === "fit" ? "fit" : clampZoom(to));
  }, [natural, scale]);

  useLayoutEffect(() => {
    const p = pending.current, el = scroller.current;
    pending.current = null;
    if (!p || !el || !natural) return;
    const next = anchoredScroll({ at: p.at, scroll: p.scroll, natural, box, from: p.from, to: scale });
    el.scrollLeft = next.left; el.scrollTop = next.top;
  }, [scale, natural, box]);

  /* A pinch arrives as a wheel with ctrlKey, and ⌘-scroll is the mouse's way to say the same. Native
     and non-passive: React's wheel listener cannot prevent the page's own zoom. */
  const latest = useRef({ zoomTo, scale });
  latest.current = { zoomTo, scale };
  useEffect(() => {
    const el = scroller.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const { zoomTo: to, scale: s } = latest.current;
      to(s * Math.exp(-e.deltaY * 0.01), { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typingIn(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const { zoomTo: to, scale: s } = latest.current;
      if (e.key === "+" || e.key === "=") { e.preventDefault(); to(stepZoom(s, 1)); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); to(stepZoom(s, -1)); }
      else if (e.key === "0") { e.preventDefault(); to("fit"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const w = natural ? Math.round(natural.w * scale) : 0;
  const h = natural ? Math.round(natural.h * scale) : 0;
  const pans = natural !== null && (w > box.w + 1 || h > box.h + 1);

  const marking = useApp((s) => (markPath && s.viewer?.marking?.path === markPath ? s.viewer.marking : null));
  const setViewerMarks = useApp((s) => s.setViewerMarks);
  const drawing = marking?.drawing ?? false;
  /** The line under the pen, kept here until it is lifted: a store write per pointer move would
   *  re-render the whole viewer, prompter and exchange included, sixty times a second. */
  const [stroke, setStroke] = useState<Mark | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const onImage = (e: ReactPointerEvent): [number, number] => {
    const r = frame.current!.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / scale) * 10) / 10, Math.round(((e.clientY - r.top) / scale) * 10) / 10];
  };
  const pen = drawing ? {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.stopPropagation(); e.preventDefault();
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* jsdom */ }
      setStroke({ points: [onImage(e)], width: Math.round((MARK_SCREEN_WIDTH / scale) * 10) / 10 });
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!stroke) return;
      e.stopPropagation();
      const p = onImage(e), last = stroke.points[stroke.points.length - 1]!;
      // A point per two screen pixels is a smooth line; one per event is thousands of them.
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) * scale < 2) return;
      setStroke({ ...stroke, points: [...stroke.points, p] });
    },
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!stroke || !marking) return;
      e.stopPropagation();
      setViewerMarks({ ...marking, marks: [...marking.marks, stroke] });
      setStroke(null);
    },
    // A click on the picture while drawing is a dot, never a reason to close what was drawn on.
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  } : {};
  const togglePen = () => {
    if (!markPath || !natural) return;
    if (!marking) setViewerMarks({ path: markPath, natural, marks: [], drawing: true });
    else if (!drawing) setViewerMarks({ ...marking, drawing: true });
    // The pen put away with nothing drawn is no marking at all.
    else setViewerMarks(marking.marks.length > 0 ? { ...marking, drawing: false } : null);
  };
  /* Dragging pans a picture bigger than the window. A press that never moved is a click, which on the
     ground around the picture closes the viewer and on the picture does nothing. */
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = scroller.current; if (!el) return;
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false };
    if (pans) try { el.setPointerCapture(e.pointerId); } catch { /* jsdom, or a pointer the element cannot hold */ }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current, el = scroller.current;
    if (!d || !el || !pans) return;
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
    el.scrollLeft = d.left - (e.clientX - d.x);
    el.scrollTop = d.top - (e.clientY - d.y);
  };
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const moved = drag.current?.moved ?? false;
    drag.current = null;
    // Marks on the picture are work, and a stray click on the ground beside it must not take them.
    if (!moved && !(e.target instanceof HTMLImageElement) && !marking?.marks.length) onBackdrop();
  };

  if (failed) return <StageNote onBackdrop={onBackdrop}>This picture could not be read.</StageNote>;
  return (
    <div className="media-viewer-stage media-viewer-picture" data-page={page || undefined}>
      <div ref={scroller} className="media-viewer-canvas" data-pans={pans || undefined} data-drawing={drawing || undefined}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onClick={onClick}
        onDoubleClick={(e) => {
          if (drawing || !(e.target instanceof HTMLImageElement)) return;
          const r = e.currentTarget.getBoundingClientRect();
          zoomTo(zoom === "fit" ? 1 : "fit", { x: e.clientX - r.left, y: e.clientY - r.top });
        }}>
        <div className="media-viewer-canvas-inner" style={natural ? { width: Math.max(box.w, w), height: Math.max(box.h, h) } : undefined}>
          {/* Sized from its own pixels once they are known, and held back until then: before its load a
              picture has no size to fit, and a frame of it at full size would flash past. */}
          <div ref={frame} className="media-viewer-frame" {...pen}>
            <img className="media-viewer-img" src={src} alt={alt} draggable={false}
              style={natural ? { width: w, height: h, maxWidth: "none", maxHeight: "none" } : { visibility: "hidden" }}
              onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              onError={() => setFailed(true)} />
            {/* The marks, in the picture's own pixels, laid over it at whatever size it is shown. */}
            {natural && marking && (
              <svg className="media-viewer-marks" viewBox={`0 0 ${natural.w} ${natural.h}`} style={{ width: w, height: h }} aria-hidden="true">
                {[...marking.marks, ...(stroke ? [stroke] : [])].map((m, i) => (
                  <polyline key={i} points={pointsAttr(m.points.length > 1 ? m : { ...m, points: [m.points[0]!, m.points[0]!] })} strokeWidth={m.width} />
                ))}
              </svg>
            )}
          </div>
        </div>
      </div>
      {/* The readout names the scale and is the way between fit and actual size, which is what a
          click on a number in every image viewer does. */}
      <div className="media-viewer-tools" role="group" aria-label="Zoom">
        <button type="button" className="icon-btn" aria-label="Zoom out" title="Zoom out (−)"
          disabled={!natural || scale <= MIN_ZOOM + 0.001} onClick={() => zoomTo(stepZoom(scale, -1))}>
          <Icon name="minus" size={14} />
        </button>
        <button type="button" className="media-viewer-zoom" disabled={!natural}
          title={zoom === "fit" ? "Show at actual size" : "Fit to the window (0)"} onClick={() => zoomTo(zoom === "fit" ? 1 : "fit")}>
          {zoomLabel(scale)}
        </button>
        <button type="button" className="icon-btn" aria-label="Zoom in" title="Zoom in (+)"
          disabled={!natural || scale >= MAX_ZOOM - 0.001} onClick={() => zoomTo(stepZoom(scale, 1))}>
          <Icon name="add" size={14} />
        </button>
        {markPath && (
          <>
            <span className="media-viewer-tools-sep" aria-hidden="true" />
            <button type="button" className="icon-btn" aria-label="Mark up" aria-pressed={drawing} disabled={!natural}
              title="Draw on the picture — a copy with your marks goes with the next question" onClick={togglePen}>
              <Icon name="pen" size={14} />
            </button>
            {marking && marking.marks.length > 0 && (
              <button type="button" className="icon-btn" aria-label="Undo the last mark" title="Undo the last mark"
                onClick={() => setViewerMarks({ ...marking, marks: marking.marks.slice(0, -1) })}>
                <Icon name="undo" size={14} />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
