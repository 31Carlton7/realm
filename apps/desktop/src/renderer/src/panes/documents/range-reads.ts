/**
 * The reads a card's PDF preview is drawn from, kept apart from pdf.js so they are tested without it.
 *
 * pdf.js asks for its bytes as ranges, and it joins the chunks it needs next to each other into ONE
 * range — a scanned page whose image stream is several megabytes is asked for whole. Main hands back
 * at most RANGE_PIECE per read (`files:read-range`), so a range is read in pieces and handed on joined,
 * one buffer per range, which is what pdf.js's range reader takes. A read that comes back empty, or a
 * page that would cost more than PAGE_BUDGET, fails the page rather than leaving pdf.js waiting on a
 * range that will never come.
 */

type Read = (start: number, length: number) => Promise<Uint8Array | null>;

/** The most one read returns: main's ceiling for `files:read-range`. */
export const RANGE_PIECE = 1024 * 1024;
/** The most a card reads to draw one PDF's first page. A first page past it is a picture too big to
 *  be worth drawing at the size of a card, and the card keeps its mark. */
export const PAGE_BUDGET = 16 * 1024 * 1024;

/** Bytes `begin` to `end` of a file, read RANGE_PIECE at a time and joined; null when any read
 *  comes back with nothing. */
export async function readPieces(read: Read, begin: number, end: number): Promise<Uint8Array | null> {
  const out = new Uint8Array(end - begin);
  let at = 0;
  while (at < out.length) {
    const piece = await read(begin + at, Math.min(RANGE_PIECE, out.length - at));
    if (!piece || piece.byteLength === 0) return null;
    out.set(piece, at);
    at += piece.byteLength;
  }
  return out;
}

/**
 * What answers pdf.js's `requestDataRange` for one document: each range read in pieces and handed to
 * `deliver` whole. The first range that cannot be read, and the first that takes the document past
 * `budget`, calls `fail` once, and nothing is delivered after it.
 */
export function rangeAnswerer(read: Read, deliver: (begin: number, chunk: Uint8Array) => void, fail: () => void,
  budget = PAGE_BUDGET): (begin: number, end: number) => void {
  let asked = 0;
  let failed = false;
  const stop = () => { if (!failed) { failed = true; fail(); } };
  return (begin, end) => {
    if (failed) return;
    asked += end - begin;
    if (asked > budget) { stop(); return; }
    readPieces(read, begin, end).then((chunk) => {
      if (failed) return;
      if (chunk) deliver(begin, chunk);
      else stop();
    }, stop);
  };
}
