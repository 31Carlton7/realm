import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@realm/ui";
import { basenameOf } from "@realm/contracts";
import { useApp } from "../../state/store";
import { useDissolve } from "../../components/ScrollFades";
import { Menu, type MenuItem } from "../../components/Menu";
import { MAX_ZOOM, MIN_ZOOM, clampZoom, stepZoom, zoomLabel } from "../../components/viewer/zoom";
import { typingIn } from "../../components/viewer/ViewerStage";
import {
  PAD_Y, PT_TO_PX, anchorZoom, currentPage, layoutPages, pagesInReach, placeOf, recallPdfPlace, rememberPdfPlace,
  scaleFor, scrollTopFor, type PageSize, type PdfLayout, type PdfPlace, type PdfZoom,
} from "./pdf-layout";
import { findInPage, findLabel, type PdfHit } from "./pdf-find";
import { canOpenInPreview, openInPreview } from "./shown-file";
import { PdfOpenError, openPdf, type PdfDocument, type PdfLink, type PdfTextLayer } from "./pdf-source";

/** How long a zoom has to hold still before the pages are drawn again at the new scale. Until then
 *  the bitmaps already drawn are stretched, so a pinch never waits on paint. */
const REPAINT_MS = 120;

const reducedMotion = (): boolean => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;


/**
 * A PDF, drawn by Realm rather than by Chromium's viewer (pdf.js through `pdf-source.ts`).
 *
 * Chromium's viewer brought its own grey toolbar, its own slate ground and its own type into the
 * pane, and lost the reader's page every time an agent rewrote the file. Here the pages are white
 * paper on the pane's own ground — the object shadow and the picture outline every file in the app
 * wears — and the controls live in the document's head row beside the name, which `head` is the slot
 * for. Nothing is drawn over the pages.
 *
 * The reader's place is a page and a fraction of it, not pixels: it survives every zoom, a space
 * switch (kept under `scrollKey`), and a rewrite of the file (`version` changes, the file is read
 * again, and the reader lands on the same page — the last one, if the new file is shorter).
 */
export function PdfView({ documentsId, path, version, scrollKey, head, filePath }: {
  documentsId: string; path: string; version: string | null; scrollKey: string;
  /** The head row's slot for the viewer's controls; null until the head has mounted. */
  head: HTMLElement | null;
  /** The file on disk, for Open in Preview; null where the pane does not know its folder. */
  filePath: string | null;
}) {
  const previewInfo = useApp((s) => s.previewInfo);
  const name = basenameOf(path);
  const [info, setInfo] = useState<{ port: number; token: string } | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    previewInfo().then((i) => { if (live) setInfo(i); }).catch((e) => { if (live) setInfoError(String(e)); });
    return () => { live = false; };
  }, [previewInfo]);
  const url = useMemo(() => {
    if (!info) return null;
    const rel = path.split("/").map(encodeURIComponent).join("/");
    return `http://127.0.0.1:${info.port}/p/${info.token}/${documentsId}/${rel}?v=${encodeURIComponent(version ?? "")}`;
  }, [info, documentsId, path, version]);

  /* The document, and the sizes of its pages at 100%. A rewrite keeps the old document on screen
     until the new one has opened, so the reader never sees the column empty out and refill. */
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [error, setError] = useState<PdfOpenError | null>(null);
  useEffect(() => {
    if (!url) return;
    const job = openPdf(url);
    let live = true;
    let opened: PdfDocument | null = null;
    job.promise.then(async (d) => {
      if (!live) { d.destroy(); return; }
      opened = d;
      const first = await d.size(0).catch(() => ({ w: 816, h: 1056 }));
      if (!live) return;
      // Every page assumed the first one's size until it is measured: the column is laid out at once,
      // and the measuring below corrects any page that differs.
      setDoc((prev) => { prev?.destroy(); return d; });
      setSizes(Array.from({ length: d.pages }, () => first));
      setError(null);
      const all: PageSize[] = [first];
      for (let i = 1; i < d.pages && live; i++) all.push(await d.size(i).catch(() => first));
      if (live && all.some((s) => s.w !== first.w || s.h !== first.h)) setSizes(all);
    }, (e: unknown) => {
      if (!live) return;
      setError(e instanceof PdfOpenError ? e : new PdfOpenError("corrupt", String(e)));
      setDoc((prev) => { prev?.destroy(); return null; });
    });
    return () => { live = false; if (!opened) job.cancel(); };
  }, [url]);
  // The last document goes with the pane.
  const docRef = useRef(doc);
  docRef.current = doc;
  useEffect(() => () => docRef.current?.destroy(), []);

  // ---- zoom and layout ---------------------------------------------------------------------------
  const recalled = useMemo(() => recallPdfPlace(scrollKey), [scrollKey]);
  const [zoom, setZoom] = useState<PdfZoom>(recalled?.zoom ?? "width");
  const scroller = useRef<HTMLDivElement>(null);
  useDissolve(scroller);
  const [box, setBox] = useState<PageSize>({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = scroller.current; if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc]);
  const scale = sizes.length > 0 ? scaleFor(zoom, sizes, box) : 1;
  const layout = useMemo(() => layoutPages(sizes, scale), [sizes, scale]);

  /* The place, kept as the reader scrolls and put back whenever the layout under it changes — a
     zoom, a page measured, the pane resized, a rewrite. `pending` is a zoom round a point. */
  /** Null until the reader moves: a file opened fresh starts at the top of the column, ground and all. */
  const place = useRef<PdfPlace | null>(recalled?.place ?? null);
  const pending = useRef<{ from: PdfLayout; at: { x: number; y: number }; scroll: { left: number; top: number } } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  /** The offset a restore just wrote: the scroll event it causes is not the reader moving. */
  const restored = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || layout.tops.length === 0) return;
    const p = pending.current;
    pending.current = null;
    if (p) {
      const next = anchorZoom({ from: p.from, to: layout, at: p.at, scroll: p.scroll, box });
      el.scrollTop = next.top; el.scrollLeft = next.left;
    } else {
      el.scrollTop = place.current ? scrollTopFor(layout, place.current) : 0;
    }
    restored.current = el.scrollTop;
    setScrollTop(el.scrollTop);
    // A zoom round a point moved the place; a restore put it back where it was, and keeps it exact.
    if (p) place.current = placeOf(layout, el.scrollTop);
  }, [layout, box]);
  useEffect(() => { if (place.current) rememberPdfPlace(scrollKey, place.current, zoom); }, [scrollKey, zoom]);

  const onScroll = () => {
    const el = scroller.current; if (!el) return;
    setScrollTop(el.scrollTop);
    const own = restored.current !== null && Math.abs(el.scrollTop - restored.current) < 1;
    restored.current = null;
    if (own) return;
    place.current = placeOf(layout, el.scrollTop);
    rememberPdfPlace(scrollKey, place.current, zoom);
  };

  const zoomTo = useCallback((to: PdfZoom, at?: { x: number; y: number }) => {
    const el = scroller.current;
    if (el && layout.tops.length > 0) {
      pending.current = { from: layout, at: at ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 }, scroll: { left: el.scrollLeft, top: el.scrollTop } };
    }
    setZoom(typeof to === "number" ? clampZoom(to) : to);
  }, [layout]);

  /* The bitmaps are drawn at the scale the zoom SETTLES on. */
  const [paintScale, setPaintScale] = useState(scale);
  useEffect(() => {
    const t = setTimeout(() => setPaintScale(scale), REPAINT_MS);
    return () => clearTimeout(t);
  }, [scale]);

  // A pinch arrives as a wheel with ctrlKey, and ⌘-scroll is a mouse's way to say the same. Native and
  // non-passive, as the media viewer's is: React's wheel listener cannot prevent the window's zoom.
  const latest = useRef({ zoomTo, scale });
  latest.current = { zoomTo, scale };
  useEffect(() => {
    const el = scroller.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      latest.current.zoomTo(latest.current.scale * Math.exp(-e.deltaY * 0.01), { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [doc]);

  // ---- pages -------------------------------------------------------------------------------------
  const page = currentPage(layout, scrollTop, box.h);
  const reach = pagesInReach(layout, scrollTop, box.h);
  const goTo = useCallback((to: PdfPlace, smooth = true) => {
    const el = scroller.current; if (!el || layout.tops.length === 0) return;
    // A page jump lands with a little of the ground above the page, as the column starts.
    const top = Math.max(0, scrollTopFor(layout, to) - (to.fraction === 0 ? PAD_Y : 0));
    el.scrollTo({ top, behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
  }, [layout]);
  const follow = useCallback(async (link: PdfLink) => {
    if (!doc || link.dest == null) return;
    const to = await doc.resolve(link.dest).catch(() => null);
    if (to) goTo(to);
  }, [doc, goTo]);

  // ---- find --------------------------------------------------------------------------------------
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PdfHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [hit, setHit] = useState(0);
  const reveal = useRef(false);
  const findField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setHits([]); setHit(0);
    if (!finding || !doc || !query.trim()) { setSearching(false); return; }
    let live = true;
    setSearching(true);
    const from = page;
    const t = setTimeout(async () => {
      const found: PdfHit[] = [];
      let first = -1;
      for (let i = 0; i < doc.pages && live; i++) {
        const runs = await doc.text(i).catch(() => []);
        if (!live) return;
        const onPage = findInPage(i, runs, query);
        // The first hit at or after the page being read is where find starts, as it does in Preview.
        if (first < 0 && i >= from && onPage.length > 0) first = found.length;
        found.push(...onPage);
        // Every few pages, so a long document shows its count climbing rather than nothing.
        if (i % 8 === 7 || i === doc.pages - 1) setHits([...found]);
      }
      if (!live) return;
      setSearching(false);
      if (found.length > 0) { reveal.current = true; setHit(first < 0 ? 0 : first); }
    }, 150);
    return () => { live = false; clearTimeout(t); };
    // `page` is read once, at the start of a search, on purpose: scrolling to a hit must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finding, doc, query]);
  const step = useCallback((dir: 1 | -1) => {
    if (hits.length === 0) return;
    reveal.current = true;
    setHit((h) => (h + dir + hits.length) % hits.length);
  }, [hits.length]);
  // The page the current hit is on is brought into reach first; once its text is laid out, the hit
  // itself is centred (`onRevealed`).
  const current = hits[hit] ?? null;
  useEffect(() => {
    if (!current || !reveal.current) return;
    const el = scroller.current; if (!el) return;
    const top = layout.tops[current.page];
    if (top === undefined) return;
    if (top + (layout.sizes[current.page]?.h ?? 0) < el.scrollTop || top > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - PAD_Y);
  }, [current, layout]);
  const onRevealed = useCallback((span: HTMLElement) => {
    if (!reveal.current) return;
    reveal.current = false;
    const el = scroller.current; if (!el) return;
    const s = span.getBoundingClientRect(), r = el.getBoundingClientRect();
    const y = s.top - r.top;
    if (y < el.clientHeight * 0.15 || y > el.clientHeight * 0.75) el.scrollTop += y - el.clientHeight / 3;
    const x = s.left - r.left;
    if (x < 0 || x > el.clientWidth - s.width) el.scrollLeft += x - el.clientWidth / 3;
  }, []);
  const closeFind = useCallback(() => { setFinding(false); setQuery(""); scroller.current?.focus({ preventScroll: true }); }, []);

  // ---- keys: only while the keyboard is in this pane ----------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = scroller.current;
      const pane = el?.closest(".documents-pane");
      if (!el || !pane || !pane.contains(document.activeElement)) return;
      const k = e.key.toLowerCase();
      if (k === "f" && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey) {
        e.preventDefault();
        setFinding(true);
        requestAnimationFrame(() => { findField.current?.focus(); findField.current?.select(); });
        return;
      }
      if (k === "g" && e.metaKey && !e.altKey && !e.ctrlKey) { e.preventDefault(); step(e.shiftKey ? -1 : 1); return; }
      if (typingIn(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const { zoomTo: to, scale: s } = latest.current;
      if (e.key === "+" || e.key === "=") { e.preventDefault(); to(stepZoom(s, 1)); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); to(stepZoom(s, -1)); }
      else if (e.key === "0") { e.preventDefault(); to("width"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  // ---- render ------------------------------------------------------------------------------------
  /* Each page's own hits, as arrays that keep their identity while the search holds still: a page's
     marks are cut into its text again only when ITS hits change, not on every scroll. */
  const hitsByPage = useMemo(() => {
    const m = new Map<number, PdfHit[]>();
    if (finding) for (const h of hits) { const l = m.get(h.page); if (l) l.push(h); else m.set(h.page, [h]); }
    return m;
  }, [finding, hits]);
  const controls = head && doc && !error ? createPortal(
    <PdfControls pages={doc.pages} page={page} onPage={(i) => goTo({ page: i, fraction: 0 })}
      zoom={zoom} scale={scale} onZoom={zoomTo} head={head}
      find={finding ? { query, setQuery, label: findLabel(hit, hits.length, searching), step, close: closeFind, field: findField } : null} />,
    head) : null;

  if (infoError) return <div className="documents-error">Preview unavailable: {infoError}</div>;
  if (error) {
    return (
      <div className="pdf-message" role="status">
        {error.kind === "password"
          ? <p>{name} is password-protected. Realm can't open it.</p>
          : <p>Realm couldn't read this PDF: {error.message}.</p>}
        {error.kind === "password" && filePath && canOpenInPreview() && (
          <button type="button" className="btn-quiet" onClick={() => openInPreview(filePath)}>Open in Preview</button>
        )}
      </div>
    );
  }
  return (
    <>
      {controls}
      {/* The scroller is focusable so a click on a page puts the keyboard in it — which is what ⌘F,
          the zoom keys and the arrow keys ask about. */}
      <div ref={scroller} className="pdf-view" role="region" aria-label={`PDF ${name}`} tabIndex={0} onScroll={onScroll}>
        {!doc ? <div className="pane-placeholder muted">Loading preview…</div> : (
          <div className="pdf-pages" style={{ height: layout.height, width: Math.max(layout.width, box.w) }}>
            {layout.sizes.map((size, i) => (
              // Centred by a whole-pixel offset rather than a transform, which would put the bitmap
              // between device pixels and soften every glyph on the page.
              <PdfPage key={i} doc={doc} index={i} top={layout.tops[i]!} left={Math.round((Math.max(layout.width, box.w) - size.w) / 2)}
                size={size} scale={paintScale}
                live={i >= reach.first && i <= reach.last}
                hits={hitsByPage.get(i) ?? NO_HITS} current={current?.page === i ? current : null}
                onLink={follow} onRevealed={onRevealed} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

const NO_HITS: PdfHit[] = [];

/**
 * One sheet of the column. Out of reach it is a sized placeholder holding nothing; in reach it draws
 * its bitmap, its text (selectable, and what find marks) and its links. The bitmap is redrawn when the
 * settled scale changes, and until then the one already drawn is stretched to the page's new box.
 */
const PdfPage = memo(function PdfPage({ doc, index, top, left, size, scale, live, hits, current, onLink, onRevealed }: {
  doc: PdfDocument; index: number; top: number; left: number; size: PageSize; scale: number; live: boolean;
  hits: PdfHit[]; current: PdfHit | null;
  onLink: (l: PdfLink) => void; onRevealed: (span: HTMLElement) => void;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const textBox = useRef<HTMLDivElement>(null);
  const [painted, setPainted] = useState(false);
  const [text, setText] = useState<PdfTextLayer | null>(null);
  const [links, setLinks] = useState<PdfLink[]>([]);

  // The bitmap: drawn into a fresh canvas and swapped in once complete, so a redraw never blanks the page.
  useEffect(() => {
    const host = sheet.current;
    if (!live || !host) return;
    const ctl = new AbortController();
    const canvas = document.createElement("canvas");
    canvas.className = "pdf-canvas";
    doc.render(index, canvas, scale, ctl.signal).then(() => {
      if (ctl.signal.aborted) return;
      host.querySelector(".pdf-canvas")?.remove();
      host.prepend(canvas);
      setPainted(true);
    }, () => {});
    return () => ctl.abort();
  }, [doc, index, scale, live]);
  // Out of reach, the bitmap goes and pdf.js lets go of what it decoded for the page.
  useEffect(() => {
    if (live) return;
    sheet.current?.querySelector(".pdf-canvas")?.remove();
    setPainted(false);
    doc.release(index);
  }, [doc, index, live]);

  // The text, laid out once while in reach; a zoom re-measures it rather than laying it out again.
  useEffect(() => {
    const box = textBox.current;
    if (!live || !box) return;
    let layer: PdfTextLayer | null = null;
    let gone = false;
    void doc.textLayer(index, box, scale).then((l) => { if (gone) l.cancel(); else { layer = l; setText(l); } }, () => {});
    void doc.links(index).then((l) => { if (!gone) setLinks(l); }, () => {});
    return () => { gone = true; layer?.cancel(); box.replaceChildren(); setText(null); setLinks([]); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- laid out at the scale it arrived at; `rescale` follows
  }, [doc, index, live]);
  useEffect(() => { text?.rescale(scale); }, [text, scale]);

  // Find's marks, cut into the text's own spans; the original text goes back when they change.
  useEffect(() => {
    if (!text || hits.length === 0) return;
    const touched = new Map<number, string>();
    let currentSpan: HTMLElement | null = null;
    // Pieces of one span are applied from its end backwards, so earlier offsets stay true.
    const byRun = new Map<number, { start: number; end: number; current: boolean }[]>();
    for (const h of hits) for (const p of h.pieces) {
      const list = byRun.get(p.run) ?? [];
      list.push({ start: p.start, end: p.end, current: h === current });
      byRun.set(p.run, list);
    }
    for (const [run, pieces] of byRun) {
      const span = text.spans[run];
      if (!span) continue;
      const str = span.textContent ?? "";
      touched.set(run, str);
      span.replaceChildren();
      let at = 0;
      for (const p of pieces.sort((a, b) => a.start - b.start)) {
        if (p.start > at) span.append(str.slice(at, p.start));
        const mark = document.createElement("span");
        mark.className = "pdf-hit";
        if (p.current) { mark.dataset.current = ""; currentSpan ??= mark; }
        mark.textContent = str.slice(p.start, p.end);
        span.append(mark);
        at = p.end;
      }
      if (at < str.length) span.append(str.slice(at));
    }
    if (currentSpan) onRevealed(currentSpan);
    return () => { for (const [run, str] of touched) { const s = text.spans[run]; if (s) s.textContent = str; } };
  }, [text, hits, current, onRevealed]);

  return (
    <div ref={sheet} className="pdf-page" data-painted={painted || undefined}
      style={{ top, left, width: size.w, height: size.h, ["--total-scale-factor" as string]: scale * PT_TO_PX } as React.CSSProperties}>
      <div ref={textBox} className="textLayer pdf-text" />
      {links.length > 0 && (
        <div className="pdf-links">
          {links.map((l, i) => {
            const style = { left: `${l.box.left * 100}%`, top: `${l.box.top * 100}%`, width: `${l.box.width * 100}%`, height: `${l.box.height * 100}%` };
            return l.url
              ? <a key={i} className="pdf-link" href={l.url} target="_blank" rel="noopener noreferrer" title={l.url} style={style} />
              : <a key={i} className="pdf-link" href="#" aria-label="Go to the linked page" style={style}
                  onClick={(e) => { e.preventDefault(); onLink(l); }} />;
          })}
        </div>
      )}
    </div>
  );
});

type FindProps = {
  query: string; setQuery: (q: string) => void; label: string;
  step: (dir: 1 | -1) => void; close: () => void; field: React.RefObject<HTMLInputElement | null>;
};

/** How much of the head the controls may take, measured, in the order they give it up. The name is
 *  the head's unbounded item and keeps the slack: the fit menu goes first (its choices move into the
 *  readout's menu), then ‹ ›, then "of 42". The page field and the zoom readout always stay. */
type Room = "full" | "noFit" | "noSteps" | "least";
const roomFor = (w: number): Room => (w >= 640 ? "full" : w >= 540 ? "noFit" : w >= 440 ? "noSteps" : "least");

/**
 * The viewer's controls, in the document's head row: the page ("3 of 42", the number a field you can
 * type in), the zoom (−, the readout, +), and the fit menu. ⌘F swaps the page for a find field.
 */
function PdfControls({ pages, page, onPage, zoom, scale, onZoom, head, find }: {
  pages: number; page: number; onPage: (i: number) => void;
  zoom: PdfZoom; scale: number; onZoom: (z: PdfZoom) => void;
  head: HTMLElement; find: FindProps | null;
}) {
  const [room, setRoom] = useState<Room>("full");
  useLayoutEffect(() => {
    const row = head.parentElement; if (!row) return;
    const measure = () => setRoom(roomFor(row.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    return () => ro.disconnect();
  }, [head]);

  const fitBtn = useRef<HTMLButtonElement>(null);
  const readout = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<"fit" | "readout" | null>(null);
  const fitItems: MenuItem[] = [
    { label: "Fit width", checked: zoom === "width", onSelect: () => onZoom("width") },
    { label: "Fit page", checked: zoom === "page", onSelect: () => onZoom("page") },
    { label: "Actual size", checked: zoom === 1, onSelect: () => onZoom(1) },
  ];
  const fitName = zoom === "width" ? "Fit width" : zoom === "page" ? "Fit page" : zoom === 1 ? "Actual size" : "Fit";

  return (
    <span className="pdf-tools">
      {find ? <FindField {...find} /> : (
        <span className="pdf-tools-page">
          {room !== "least" && room !== "noSteps" && (
            <button type="button" className="icon-btn" aria-label="Previous page" title="Previous page"
              disabled={page <= 0} onClick={() => onPage(page - 1)}><Icon name="chevronLeft" size={14} /></button>
          )}
          <PageField page={page} pages={pages} onPage={onPage} />
          {room !== "least" && <span className="pdf-tools-of" aria-hidden="true">of {pages}</span>}
          {room !== "least" && room !== "noSteps" && (
            <button type="button" className="icon-btn" aria-label="Next page" title="Next page"
              disabled={page >= pages - 1} onClick={() => onPage(page + 1)}><Icon name="chevronRight" size={14} /></button>
          )}
        </span>
      )}
      <span className="pdf-tools-zoom" role="group" aria-label="Zoom">
        <button type="button" className="icon-btn" aria-label="Zoom out" title="Zoom out (−)"
          disabled={scale <= MIN_ZOOM + 0.001} onClick={() => onZoom(stepZoom(scale, -1))}><Icon name="minus" size={14} /></button>
        <button ref={readout} type="button" className="media-viewer-zoom"
          title={room === "full" ? (zoom === "width" ? "Show at actual size" : "Fit to the pane's width (0)") : "Fit and size"}
          aria-haspopup={room === "full" ? undefined : "menu"}
          onClick={() => (room === "full" ? onZoom(zoom === "width" ? 1 : "width") : setMenu("readout"))}>
          {zoomLabel(scale)}
        </button>
        <button type="button" className="icon-btn" aria-label="Zoom in" title="Zoom in (+)"
          disabled={scale >= MAX_ZOOM - 0.001} onClick={() => onZoom(stepZoom(scale, 1))}><Icon name="add" size={14} /></button>
      </span>
      {room === "full" && (
        <button ref={fitBtn} type="button" className="pdf-tools-fit" aria-haspopup="menu" aria-expanded={menu === "fit"}
          title="How the pages fit the pane" onClick={() => setMenu("fit")}>
          <span>{fitName}</span><Icon name="chevronDown" size={12} />
        </button>
      )}
      {menu && <Menu anchorRef={menu === "fit" ? fitBtn : readout} align="right" label="Fit" items={fitItems} onClose={() => setMenu(null)} />}
    </span>
  );
}

/** The page being read, as a number you can type over: Return goes there, Escape puts it back. */
function PageField({ page, pages, onPage }: { page: number; pages: number; onPage: (i: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const n = Number.parseInt(draft ?? "", 10);
    setDraft(null);
    if (Number.isFinite(n)) onPage(Math.min(pages, Math.max(1, n)) - 1);
  };
  return (
    <input className="pdf-page-field" aria-label={`Page, of ${pages}`} inputMode="numeric" size={3}
      value={draft ?? String(page + 1)}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value.replace(/\D/g, "").slice(0, 5))}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); e.currentTarget.blur(); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDraft(null); e.currentTarget.blur(); }
      }} />
  );
}

function FindField({ query, setQuery, label, step, close, field }: FindProps): ReactNode {
  return (
    <span className="pdf-find" role="search">
      <Icon name="search" size={14} className="pdf-find-glyph" />
      <input ref={field} className="pdf-find-field" aria-label="Find in PDF" placeholder="Find" value={query} spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
          // Escape is this field's own: it closes find, and nothing behind it hears the key.
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
        }} />
      {query.trim() && <span className="pdf-find-count" role="status">{label}</span>}
      <button type="button" className="icon-btn" aria-label="Previous match" title="Previous match (⇧⌘G)" onClick={() => step(-1)}><Icon name="chevronUp" size={14} /></button>
      <button type="button" className="icon-btn" aria-label="Next match" title="Next match (⌘G)" onClick={() => step(1)}><Icon name="chevronDown" size={14} /></button>
      <button type="button" className="icon-btn" aria-label="Close find" title="Close find (Escape)" onClick={close}><Icon name="close" size={14} /></button>
    </span>
  );
}
