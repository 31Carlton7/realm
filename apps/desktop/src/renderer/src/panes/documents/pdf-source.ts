import {
  GlobalWorkerOptions, TextLayer, getDocument,
  type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { PT_TO_PX, type PageSize, type PdfPlace } from "./pdf-layout";

/**
 * The one seam onto pdf.js. Everything the viewer asks of a PDF — its pages' sizes, a page drawn into
 * a canvas, its text, its links — goes through here, so PdfView is tested against a fake of this file
 * and never loads pdf.js into jsdom.
 *
 * The LEGACY build, deliberately: the modern one calls `Math.sumPrecise`, `Map#getOrInsertComputed`
 * and `Uint8Array#toHex`, none of which the Chromium this app ships (138) has. The legacy build carries
 * them; the server reads PDFs through the same build for the same reason.
 *
 * Where pdf.js reads files at run time — CMaps, the standard fonts, the JPX/JBIG2 decoders — it reads
 * them from `pdfjs/` beside index.html (electron.vite.config.ts copies them there), and it reads them
 * IN THE WORKER (`useWorkerFetch`). In the built app the page is a file:// document whose
 * `connect-src` names only the loopback servers, so a fetch of `file://…/cmaps/` from the page is
 * refused; a module worker runs without the page's policy, so it can read its own files and
 * instantiate its WASM decoders without the page ever being given `'wasm-unsafe-eval'`. Measured in
 * this Electron: the same fetch is refused on the page and answered in the worker.
 */
GlobalWorkerOptions.workerSrc = workerUrl;

const assets = (dir: string): string => new URL(`pdfjs/${dir}/`, document.baseURI).href;

export type PdfLink = {
  /** The link's box as fractions of its page, so it needs no redrawing at another zoom. */
  box: { left: number; top: number; width: number; height: number };
  /** Out of the app, through the route a link in prose takes. */
  url?: string;
  /** Somewhere in this document. */
  dest?: unknown;
};

/** One run of text as pdf.js lays it out; a page's runs are what find searches and what the text
 *  layer draws, one span each and in the same order. */
export type PdfTextRun = { str: string; eol: boolean };

export type PdfTextLayer = {
  /** The text layer's spans, aligned one to one with the page's runs. */
  spans: HTMLElement[];
  rescale(scale: number): void;
  cancel(): void;
};

export interface PdfDocument {
  readonly pages: number;
  /** A page's size at 100%, in CSS pixels. */
  size(index: number): Promise<PageSize>;
  /** Draw a page at `scale` into a canvas sized for the screen's pixel density. */
  render(index: number, canvas: HTMLCanvasElement, scale: number, signal: AbortSignal): Promise<void>;
  textLayer(index: number, container: HTMLElement, scale: number): Promise<PdfTextLayer>;
  text(index: number): Promise<PdfTextRun[]>;
  links(index: number): Promise<PdfLink[]>;
  /** Where an internal link goes, as a place in the document. */
  resolve(dest: unknown): Promise<PdfPlace | null>;
  /** Let go of a page's decoded resources once it is out of reach. */
  release(index: number): void;
  destroy(): void;
}

/** Why a PDF did not open, in the three ways a reader is told apart. */
export class PdfOpenError extends Error {
  constructor(readonly kind: "password" | "corrupt" | "missing", reason: string) { super(reason); }
}

/** The most pixels one page's canvas may hold. A Letter page at 800% on a Retina screen is 220 million;
 *  past this cap the bitmap is drawn smaller and stretched, which reads fine while zoomed that far. */
const MAX_CANVAS_PIXELS = 4096 * 4096 * 2;

export function openPdf(url: string): { promise: Promise<PdfDocument>; cancel: () => void } {
  const task: PDFDocumentLoadingTask = getDocument({
    url,
    cMapUrl: assets("cmaps"), cMapPacked: true,
    standardFontDataUrl: assets("standard_fonts"),
    wasmUrl: assets("wasm"), iccUrl: assets("iccs"),
    useWorkerFetch: true,
    // pdf.js 5 compiles nothing with `eval` (the option to forbid it is gone with the code), and a PDF's
    // own JavaScript runs only in a scripting sandbox Realm never creates. XFA forms stay undrawn.
    enableXfa: false,
  });
  const { promise, resolve, reject } = Promise.withResolvers<PdfDocument>();
  // A password-protected file asks; Realm has no field to answer with, so the ask ends the load.
  task.onPassword = () => { reject(new PdfOpenError("password", "password-protected")); void task.destroy(); };
  task.promise.then((doc) => resolve(wrap(doc)), (e: unknown) => reject(openError(e)));
  return { promise, cancel: () => { void task.destroy(); } };
}

function openError(e: unknown): PdfOpenError {
  const err = e as { name?: string; message?: string; status?: number };
  if (err?.name === "PasswordException") return new PdfOpenError("password", "password-protected");
  if (err?.name === "ResponseException" && err.status === 404) return new PdfOpenError("missing", "the file is not on disk");
  return new PdfOpenError("corrupt", err?.message?.replace(/\.$/, "") || String(e));
}

type TextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;

function wrap(doc: PDFDocumentProxy): PdfDocument {
  const pages = new Map<number, Promise<PDFPageProxy>>();
  const page = (i: number) => {
    let p = pages.get(i);
    if (!p) { p = doc.getPage(i + 1); pages.set(i, p); }
    return p;
  };
  const texts = new Map<number, Promise<TextContent>>();
  const textOf = (i: number) => {
    let t = texts.get(i);
    if (!t) { t = page(i).then((p) => p.getTextContent()); texts.set(i, t); }
    return t;
  };
  return {
    pages: doc.numPages,
    async size(i) {
      const vp = (await page(i)).getViewport({ scale: PT_TO_PX });
      return { w: vp.width, h: vp.height };
    },
    async render(i, canvas, scale, signal) {
      const p = await page(i);
      if (signal.aborted) return;
      const css = p.getViewport({ scale: scale * PT_TO_PX });
      let ratio = window.devicePixelRatio || 1;
      ratio = Math.min(ratio, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, css.width * css.height)));
      const vp = p.getViewport({ scale: scale * PT_TO_PX * ratio });
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const job = p.render({ canvas, viewport: vp });
      const stop = () => job.cancel();
      signal.addEventListener("abort", stop);
      try { await job.promise; } finally { signal.removeEventListener("abort", stop); }
    },
    async textLayer(i, container, scale) {
      const p = await page(i);
      const layer = new TextLayer({ textContentSource: await textOf(i), container, viewport: p.getViewport({ scale: scale * PT_TO_PX }) });
      await layer.render();
      return {
        spans: layer.textDivs,
        rescale: (s) => layer.update({ viewport: p.getViewport({ scale: s * PT_TO_PX }) }),
        cancel: () => layer.cancel(),
      };
    },
    async text(i) {
      const content = await textOf(i);
      return content.items.flatMap((it: TextContent["items"][number]) => ("str" in it ? [{ str: it.str, eol: it.hasEOL }] : []));
    },
    async links(i) {
      const p = await page(i);
      const vp = p.getViewport({ scale: 1 });
      const notes = await p.getAnnotations({ intent: "display" });
      return notes.flatMap((a: { subtype?: string; rect?: number[]; url?: string; dest?: unknown }): PdfLink[] => {
        if (a.subtype !== "Link" || !a.rect || (!a.url && a.dest == null)) return [];
        const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
        const box = {
          left: Math.min(x1!, x2!) / vp.width, top: Math.min(y1!, y2!) / vp.height,
          width: Math.abs(x2! - x1!) / vp.width, height: Math.abs(y2! - y1!) / vp.height,
        };
        return [a.url ? { box, url: a.url } : { box, dest: a.dest }];
      });
    },
    async resolve(dest) {
      const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || explicit.length === 0) return null;
      const ref = explicit[0];
      const index = typeof ref === "object" && ref !== null ? await doc.getPageIndex(ref) : Number.isInteger(ref) ? ref as number : null;
      if (index === null || index < 0 || index >= doc.numPages) return null;
      // An XYZ or FitH destination names a line on the page; the rest name the page.
      const kind = (explicit[1] as { name?: string } | undefined)?.name;
      const y = kind === "XYZ" ? explicit[3] : kind === "FitH" || kind === "FitBH" ? explicit[2] : null;
      if (typeof y !== "number") return { page: index, fraction: 0 };
      const vp = (await page(index)).getViewport({ scale: 1 });
      const [, top] = vp.convertToViewportPoint(0, y);
      return { page: index, fraction: Math.max(0, Math.min(1, top! / vp.height)) };
    },
    release(i) {
      void pages.get(i)?.then((p) => p.cleanup());
    },
    destroy() { void doc.destroy(); },
  };
}
