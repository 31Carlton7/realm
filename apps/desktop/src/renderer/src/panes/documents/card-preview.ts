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
 * text, and the pieces of a PDF its first page needs (`firstPagePicture`). A preview is kept for the
 * file as it was when it was drawn, by its modified time, so a file an agent rewrites is read again
 * and one nobody touched is not. No more than RUNNING are drawn at a time, so a fast scroll down three
 * hundred cards queues the reads instead of starting them all at once, and none holds its turn past
 * JOB_LIMIT_MS, so a file that never answers cannot stop the cards after it.
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
/** Longer than any first page or head a card has drawn (a few hundred ms), short enough that a stuck
 *  one gives its turn back while the person is still looking at the grid. */
export const JOB_LIMIT_MS = 10_000;

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

/** Per path: the modified time the preview was drawn at, and the preview. */
const cache = new Map<string, { mtime: number; preview: Promise<CardPreview | null> }>();
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

/** A job's turn, given back when it settles or at JOB_LIMIT_MS, whichever is first; a job past its
 *  limit answers null. */
async function inTurn<T>(job: () => Promise<T | null>): Promise<T | null> {
  if (running >= RUNNING) await new Promise<void>((go) => waiting.push(go));
  running++;
  let limit: ReturnType<typeof setTimeout> | undefined;
  try {
    await idle();
    return await Promise.race([job(), new Promise<null>((done) => { limit = setTimeout(() => done(null), JOB_LIMIT_MS); })]);
  } finally {
    clearTimeout(limit);
    running--;
    waiting.shift()?.();
  }
}

async function draw(path: string, source: "markdown" | "text" | "pdf", size: number): Promise<CardPreview | null> {
  const readRange = window.realm?.files?.readRange;
  if (!readRange) return null;
  if (source === "pdf") {
    const url = await firstPagePicture(size, (start, length) => readRange(path, start, length), PAGE_WIDTH);
    return url ? { kind: "picture", url } : null;
  }
  const bytes = await readRange(path, 0, TEXT_HEAD);
  const text = bytes ? headLines(bytes, size > TEXT_HEAD) : null;
  if (text === null || text.trim() === "") return null;
  return source === "markdown" ? { kind: "markdown", html: renderMarkdown(text) } : { kind: "text", text };
}

/** The preview of the file at `path` as it is now: the one already drawn when its modified time has
 *  not moved, else a new one. */
export async function loadCardPreview(path: string, source: "markdown" | "text" | "pdf"): Promise<CardPreview | null> {
  const st = await window.realm?.files?.stat(path);
  if (!st) return null;
  const held = cache.get(path);
  if (held && held.mtime === st.mtimeMs) return held.preview;
  const preview = inTurn(() => draw(path, source, st.size)).catch(() => null);
  cache.set(path, { mtime: st.mtimeMs, preview });
  return preview;
}

/**
 * The preview for `path`, once `ask` has said the card is near the screen. A preview already drawn is
 * shown at once whatever `ask` says, so a card scrolled back to, or a home opened again, never flashes
 * its mark first; on screen it is checked against the file, and drawn again if the file has changed.
 * `version` is when the list last saw the file touched: it moving is what has a card on screen look
 * again, since the row stays mounted while an agent rewrites its file.
 */
export function useCardPreview(path: string | null, source: PreviewSource, ask: boolean, version: number | null): CardPreview | null {
  const reads = source === "markdown" || source === "text" || source === "pdf";
  const key = path && reads ? path : null;
  const [preview, setPreview] = useState<CardPreview | null>(null);
  useEffect(() => {
    if (key === null || !reads) { setPreview(null); return; }
    let live = true;
    const show = (v: CardPreview | null) => { if (live) setPreview(v); };
    void cache.get(key)?.preview.then(show);
    if (ask) void loadCardPreview(key, source as "markdown" | "text" | "pdf").then(show);
    return () => { live = false; };
  }, [key, source, reads, ask, version]);
  return preview;
}
