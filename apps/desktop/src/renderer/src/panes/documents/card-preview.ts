import { useEffect, useState } from "react";
import { documentKindFor, type ArtifactType } from "@realm/contracts";
import { renderMarkdown } from "../session/Markdown";
import { firstPagePicture } from "./pdf-source";

/**
 * What a card on the documents home shows above its name, for the files the home draws itself: the
 * top of a Markdown file rendered, the top of a text file as it is, a PDF's first page. A picture or a
 * video is the Library's own thumbnail (`useThumbnail`), and anything else is its mark.
 *
 * Every preview is drawn from the head of the file and never from the whole of it: TEXT_HEAD bytes of
 * text, and the pieces of a PDF its first page needs (`firstPagePicture`). Each is asked for once per
 * path for the life of the window, as a thumbnail is, and no more than RUNNING at a time, so a fast
 * scroll down three hundred cards queues the reads instead of starting them all at once.
 */
export type CardPreview =
  | { kind: "markdown"; html: string }
  | { kind: "text"; text: string }
  | { kind: "picture"; url: string };

/** What a card draws from: the kinds this module reads, or the thumbnail, or nothing but the mark. */
export type PreviewSource = "markdown" | "text" | "pdf" | "thumbnail" | null;

/** Enough for the dozen lines a card has room for, at most. */
export const TEXT_HEAD = 4096;
/** The PDF's first page is drawn this wide, in CSS pixels: about the widest a card's preview gets. */
const PAGE_WIDTH = 220;
const RUNNING = 2;

export function previewSourceOf(name: string, type: ArtifactType): PreviewSource {
  if (type === "image" || type === "video") return "thumbnail";
  const kind = documentKindFor(name);
  if (kind === "doc" || kind === "slides") return "markdown";
  if (kind === "pdf") return "pdf";
  if (kind === "code" || kind === "latex" || kind === "sheet") return "text";
  return null;
}

/** The text up to its last whole line, so a card never ends on half a word or half a fence. */
export function headLines(bytes: Uint8Array, cut: boolean): string | null {
  if (bytes.subarray(0, 512).includes(0)) return null;
  const text = new TextDecoder("utf-8").decode(bytes);
  if (!cut) return text;
  const end = text.lastIndexOf("\n");
  return end > 0 ? text.slice(0, end) : text;
}

const cache = new Map<string, Promise<CardPreview | null>>();
let running = 0;
const waiting: (() => void)[] = [];

/** Test seam, as `resetThumbnailCache` is. */
export function resetCardPreviews(): void {
  cache.clear();
  waiting.length = 0;
  running = 0;
}

/** Drawing a page or rendering Markdown is main-thread work, so each waits for a frame with time to
 *  spare: a scroll that brings ten cards in keeps its frames, and the previews follow it in. */
const idle = (): Promise<void> => new Promise((go) => (window.requestIdleCallback ? window.requestIdleCallback(() => go(), { timeout: 500 }) : setTimeout(go, 0)));

async function inTurn<T>(job: () => Promise<T>): Promise<T> {
  if (running >= RUNNING) await new Promise<void>((go) => waiting.push(go));
  running++;
  await idle();
  try { return await job(); } finally { running--; waiting.shift()?.(); }
}

async function draw(path: string, source: "markdown" | "text" | "pdf"): Promise<CardPreview | null> {
  const files = window.realm?.files;
  const readRange = files?.readRange;
  if (!files || !readRange) return null;
  const st = await files.stat(path);
  if (!st) return null;
  if (source === "pdf") {
    const url = await firstPagePicture(st.size, (start, length) => readRange(path, start, length), PAGE_WIDTH);
    return url ? { kind: "picture", url } : null;
  }
  const bytes = await readRange(path, 0, TEXT_HEAD);
  const text = bytes ? headLines(bytes, st.size > TEXT_HEAD) : null;
  if (text === null || text.trim() === "") return null;
  return source === "markdown" ? { kind: "markdown", html: renderMarkdown(text) } : { kind: "text", text };
}

/**
 * The preview for `path`, once `ask` has said the card is near the screen. A preview already drawn is
 * shown whatever `ask` says, so a card scrolled back to, or a home opened again, never flashes its mark
 * first.
 */
export function useCardPreview(path: string | null, source: PreviewSource, ask: boolean): CardPreview | null {
  const reads = source === "markdown" || source === "text" || source === "pdf";
  const key = path && reads ? path : null;
  const [preview, setPreview] = useState<CardPreview | null>(null);
  useEffect(() => {
    if (key === null || !reads) { setPreview(null); return; }
    let p = cache.get(key);
    if (!p && !ask) return;
    if (!p) {
      p = inTurn(() => draw(key, source)).catch(() => null);
      cache.set(key, p);
    }
    let live = true;
    void p.then((v) => { if (live) setPreview(v); });
    return () => { live = false; };
  }, [key, source, reads, ask]);
  return preview;
}
