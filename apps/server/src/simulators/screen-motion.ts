import { createHash } from "node:crypto";
import http from "node:http";

/**
 * Whether a device's screen is moving, told from its PICTURE rather than from its tree.
 *
 * Reading the accessibility tree is the slow part of acting on a simulator: MEASURED at 400–900 ms a
 * read of Settings on iOS 27, depending on the Mac's load. Finding out that a tap has finished
 * animating by reading the tree until two reads agree therefore costs a second or more per step, and
 * a read that lands mid-animation reports a screen half-way between two. The stream serve-sim already
 * serves the pane answers the question for nothing. While the screen moves it sends a new picture
 * every display frame, and once the screen is still it sends the SAME bytes again — MEASURED on a
 * Back tap: the first changed frame 120 ms after the tap, 40 different frames at 60 fps over 680 ms,
 * then identical frames, then one about every 220 ms while nothing moves.
 *
 * So a frame that differs from the one before is motion, and rest is no motion for `stillMs` with the
 * picture shown again since. The tree is then read once, at rest.
 *
 * One kind of change is not motion: a list's scroll indicator fading at the right-hand edge. iOS
 * flashes it whenever a list appears or stops, and it fades for a second and a half after the list
 * itself has stopped — MEASURED after pushing Settings ▸ Accessibility: the screen still at 1.45 s,
 * frames still differing until 2.93 s, every one of them in a 16-px strip at x 1296–1312 of 1320.
 * Waiting that out cost a second and a half a step. So each frame's change is located (see
 * `frameChange`), and a change confined to the right-hand edge does not hold rest back.
 */
export type ScreenMotion = {
  /** A point to measure change from. Take it BEFORE sending the input. */
  mark(): MotionMark;
  /**
   * After an input: wait for the picture to change since `mark` and then come to rest.
   *   "still"  — it did.
   *   "none"   — nothing changed within `changeWithinMs`.
   *   "moving" — it changed, but had not come to rest by `maxMs`: a spinner, a video.
   *   "lost"   — the stream went away; the caller falls back to reading the tree.
   */
  settle(mark: MotionMark, o: { changeWithinMs: number; stillMs: number; maxMs: number }): Promise<"still" | "none" | "moving" | "lost">;
  /** Wait for the picture to be at rest, whatever it was doing. False when it never was by `maxMs`. */
  rest(o: { stillMs: number; maxMs: number }): Promise<boolean>;
  close(): void;
};

/**
 * Where the picture stood when an input was sent: how many times it had moved, how many times only its
 * edge had changed, and whether the edge was changing right then. An edge change after an input counts
 * as the input's effect — a switch at the edge of a row, flipping — unless the edge was already
 * changing when it was sent, which is a scroll indicator still fading from the step before.
 */
export type MotionMark = { readonly moved: number; readonly edges: number; readonly edgeBusy: boolean };

/** How often the waits look at what has arrived: a display frame. */
const TICK_MS = 16;
/** An edge change this recent means the edge is still changing: the fade sends one about every 64 ms. */
const EDGE_BUSY_MS = 250;

/**
 * The motion of a screen, from a sequence of frames — the part with no socket in it, so a suite can
 * feed it frames and a clock. `frame` is called with each picture's bytes as it arrives.
 */
export function motionTracker(now: () => number = () => performance.now(), sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
  let lastHash: string | null = null;
  let prev: Frame = null;
  let moved = 0;
  let edges = 0;
  let lastMovedAt = 0;
  let lastEdgeAt = Number.NEGATIVE_INFINITY;
  /** Whether a frame has arrived since the last one that moved — the renderer showing it again. */
  let shown = false;
  let alive = true;

  const atRest = (stillMs: number, since: number) => shown && now() - Math.max(lastMovedAt, since) >= stillMs;

  const tracker = {
    frame(bytes: Uint8Array): void {
      const h = createHash("sha1").update(bytes).digest("hex");
      if (h === lastHash) { shown = true; return; }
      const first = lastHash === null;
      lastHash = h;
      const parsed = parseFrame(bytes);
      const kind = first ? "moved" : frameChange(prev, parsed);
      prev = parsed;
      if (kind === "moved") {
        moved++;
        lastMovedAt = now();
        shown = false;
      } else {
        if (kind === "edge") { edges++; lastEdgeAt = now(); }
        shown = true;
      }
    },
    lost(): void { alive = false; },
    motion: {
      mark: () => ({ moved, edges, edgeBusy: now() - lastEdgeAt < EDGE_BUSY_MS }),
      async settle(mark, o) {
        const start = now();
        let changedAt: number | null = null;
        for (;;) {
          if (!alive) return "lost";
          const t = now() - start;
          if (moved > mark.moved || (!mark.edgeBusy && edges > mark.edges)) {
            changedAt ??= now();
            if (atRest(o.stillMs, changedAt)) return "still";
            if (t >= o.maxMs) return "moving";
          } else if (t >= o.changeWithinMs) {
            return "none";
          }
          await sleep(TICK_MS);
        }
      },
      async rest(o) {
        const start = now();
        for (;;) {
          if (!alive) return false;
          if (atRest(o.stillMs, 0)) return true;
          if (now() - start >= o.maxMs) return false;
          await sleep(TICK_MS);
        }
      },
      close: () => { alive = false; },
    } satisfies ScreenMotion,
  };
  return tracker;
}

/**
 * The motion of the screen behind an MJPEG stream — serve-sim's `stream.mjpeg`, a multipart
 * response of JPEGs each headed by its Content-Length. Frames are cut by that length rather than by
 * scanning for the JPEG end marker, which a thumbnail inside a frame's EXIF also carries.
 */
export function watchMjpeg(url: string): ScreenMotion {
  const t = motionTracker();
  let buf: Buffer = Buffer.alloc(0);
  let need: number | null = null;
  const req = http.get(url, (res) => {
    if (res.statusCode !== 200) { t.lost(); res.resume(); return; }
    res.on("data", (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (need === null) {
          const end = buf.indexOf("\r\n\r\n");
          if (end < 0) break;
          const head = buf.subarray(0, end).toString("latin1");
          const m = /content-length:\s*(\d+)/i.exec(head);
          buf = buf.subarray(end + 4);
          if (!m) continue;
          need = Number(m[1]);
        }
        if (buf.length < need) break;
        t.frame(buf.subarray(0, need));
        buf = buf.subarray(need);
        need = null;
      }
    });
    res.on("end", () => t.lost());
    res.on("error", () => t.lost());
  });
  req.on("error", () => t.lost());
  return {
    ...t.motion,
    close() {
      t.motion.close();
      req.destroy();
    },
  };
}

/* ---------------------------------- where a frame changed ---------------------------------- */

/**
 * The columns of 16-px blocks at the right-hand edge where iOS draws a list's scroll indicator. A
 * change that starts in them, in every band it touches, is the indicator — MEASURED at x 1296–1312 on
 * a 1320-px-wide screen, the last two columns of 83.
 */
const EDGE_COLUMNS = 2;
/** A band whose first difference comes this early is a change well inside the screen, whatever its
 *  column; only later ones are worth the decode that finds the column. */
const SURELY_INSIDE = 0.5;
/** Bands decoded to find a column, the likeliest-inside first. */
const DECODED_BANDS = 4;

type Huffman = { maxcode: Int32Array; valptr: Int32Array; mincode: Int32Array; values: Uint8Array };
type Layout = { mcuCols: number; blocks: { dc: Huffman; ac: Huffman }[] };
/** A frame read by band: its entropy-coded data cut at the restart markers, and what it takes to walk one. */
export type Frame = { bands: Uint8Array[]; layout: Layout } | null;

/**
 * A JPEG, read by band — without decoding its pixels.
 *
 * serve-sim's frames are baseline JPEGs with a restart marker after every row of MCUs (MEASURED:
 * 1320×2868, 4:2:0, restart interval 83 = one row of 16-px blocks), so each band of the picture is
 * coded on its own, byte-aligned between two markers. Null for any other kind of JPEG — progressive,
 * restarted some other way, or not a JPEG at all — whose changes are then all taken for motion.
 */
export function parseFrame(jpeg: Uint8Array): Frame {
  try {
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
    const dc = new Map<number, Huffman>(), ac = new Map<number, Huffman>();
    let comps: { id: number; h: number; v: number }[] = [];
    let width = 0, restart = 0, i = 2;
    while (i + 4 <= jpeg.length && jpeg[i] === 0xff) {
      const marker = jpeg[i + 1]!;
      const len = (jpeg[i + 2]! << 8) | jpeg[i + 3]!;
      const seg = jpeg.subarray(i + 4, i + 2 + len);
      if (marker === 0xc0 || marker === 0xc1) {
        width = (seg[3]! << 8) | seg[4]!;
        comps = Array.from({ length: seg[5]! }, (_, k) => ({ id: seg[6 + 3 * k]!, h: seg[7 + 3 * k]! >> 4, v: seg[7 + 3 * k]! & 15 }));
      } else if (marker >= 0xc2 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return null; // progressive, lossless or arithmetic-coded: not what serve-sim sends
      } else if (marker === 0xc4) {
        for (let p = 0; p < seg.length;) {
          const counts = seg.subarray(p + 1, p + 17);
          const total = counts.reduce((a, b) => a + b, 0);
          (seg[p]! >> 4 === 0 ? dc : ac).set(seg[p]! & 15, huffman(counts, seg.subarray(p + 17, p + 17 + total)));
          p += 17 + total;
        }
      } else if (marker === 0xdd) {
        restart = (seg[0]! << 8) | seg[1]!;
      } else if (marker === 0xda) {
        const selected = Array.from({ length: seg[0]! }, (_, k) => ({ id: seg[1 + 2 * k]!, dc: seg[2 + 2 * k]! >> 4, ac: seg[2 + 2 * k]! & 15 }));
        if (!width || comps.length === 0 || selected.length !== comps.length) return null;
        const mcuCols = Math.ceil(width / (8 * Math.max(...comps.map((c) => c.h))));
        if (restart !== mcuCols) return null;
        const blocks: Layout["blocks"] = [];
        for (const s of selected) {
          const c = comps.find((x) => x.id === s.id), d = dc.get(s.dc), a = ac.get(s.ac);
          if (!c || !d || !a) return null;
          for (let b = 0; b < c.h * c.v; b++) blocks.push({ dc: d, ac: a });
        }
        return { bands: bandsFrom(jpeg, i + 2 + len), layout: { mcuCols, blocks } };
      }
      i += 2 + len;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * How a frame differs from the one before it, which differs somewhere: only in bytes outside its
 * picture ("same"), only at the right-hand edge ("edge"), or anywhere else ("moved"). A frame that
 * cannot be read by band — or whose bands do not line up with the last one's — is "moved".
 */
export function frameChange(before: Frame, after: Frame): "same" | "edge" | "moved" {
  if (!before || !after || before.bands.length !== after.bands.length || before.layout.mcuCols !== after.layout.mcuCols) return "moved";
  const late: { band: Uint8Array; bit: number; share: number }[] = [];
  for (let b = 0; b < after.bands.length; b++) {
    const x = before.bands[b]!, y = after.bands[b]!;
    if (x.length === y.length && Buffer.compare(x, y) === 0) continue;
    const n = Math.min(x.length, y.length);
    let at = 0;
    while (at < n && x[at] === y[at]) at++;
    const share = at / Math.max(1, y.length);
    if (share < SURELY_INSIDE) return "moved";
    // The first differing BIT: a byte can end one column's code and start the next one's.
    const bit = at * 8 + (at < n ? Math.clz32(x[at]! ^ y[at]!) - 24 : 0);
    late.push({ band: y, bit, share });
  }
  if (late.length === 0) return "same";
  late.sort((p, q) => p.share - q.share);
  for (const l of late.slice(0, DECODED_BANDS)) {
    if (columnOf(l.band, l.bit, after.layout) < after.layout.mcuCols - EDGE_COLUMNS) return "moved";
  }
  return "edge";
}

/** A scan's bands: the bytes between its restart markers, up to the end of the image. */
function bandsFrom(jpeg: Uint8Array, start: number): Uint8Array[] {
  const bands: Uint8Array[] = [];
  let from = start, at = start;
  for (;;) {
    const ff = jpeg.indexOf(0xff, at);
    if (ff < 0 || ff + 1 >= jpeg.length) { bands.push(jpeg.subarray(from)); return bands; }
    const next = jpeg[ff + 1]!;
    // A stuffed zero is a literal 0xFF byte of data, and a run of 0xFF is fill before a marker.
    if (next === 0x00 || next === 0xff) { at = ff + 1; continue; }
    if (next >= 0xd0 && next <= 0xd7) { bands.push(jpeg.subarray(from, ff)); from = at = ff + 2; continue; }
    bands.push(jpeg.subarray(from, ff));
    return bands;
  }
}

/** The column of blocks whose code holds bit `bit` of a band — counted in the band's raw bytes, stuffing
 *  and all: the first column that differs. */
function columnOf(band: Uint8Array, bit: number, layout: Layout): number {
  try {
    const bits = new Bits(band);
    for (let col = 0; col < layout.mcuCols; col++) {
      for (const block of layout.blocks) {
        bits.skip(decode(bits, block.dc));
        for (let k = 1; k < 64;) {
          const rs = decode(bits, block.ac);
          const run = rs >> 4, size = rs & 15;
          if (size === 0) {
            if (run !== 15) break; // end of block
            k += 16;
            continue;
          }
          bits.skip(size);
          k += run + 1;
        }
      }
      if (bits.position > bit) return col;
    }
    return layout.mcuCols - 1;
  } catch {
    return 0; // a band that will not decode is not proof of an edge: call it moved
  }
}

/** A band's bits, most significant first, with the stuffed zero after every 0xFF skipped. */
class Bits {
  /** Where the next byte starts in the band, counting stuffing. */
  private next = 0;
  /** Where the byte being read started. */
  private at = 0;
  private cur = 0;
  private left = 0;
  constructor(private readonly b: Uint8Array) {}
  /** The bits consumed so far, as a bit offset into the band's raw bytes. */
  get position(): number { return this.left > 0 ? this.at * 8 + (8 - this.left) : this.next * 8; }
  read(): number {
    if (this.left === 0) {
      if (this.next >= this.b.length) throw new Error("the band ended mid-block");
      this.at = this.next;
      this.cur = this.b[this.next]!;
      this.next += this.cur === 0xff ? 2 : 1;
      this.left = 8;
    }
    this.left--;
    return (this.cur >> this.left) & 1;
  }
  skip(n: number): void { for (let i = 0; i < n; i++) this.read(); }
}

/** A JPEG Huffman table as the standard's decoding procedure wants it (ITU T.81, F.2.2.3). */
function huffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const maxcode = new Int32Array(17).fill(-1), valptr = new Int32Array(17), mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    const n = counts[len - 1]!;
    if (n > 0) { valptr[len] = k; mincode[len] = code; code += n; k += n; maxcode[len] = code - 1; }
    code <<= 1;
  }
  return { maxcode, valptr, mincode, values };
}

function decode(bits: Bits, h: Huffman): number {
  let code = 0;
  for (let len = 1; len <= 16; len++) {
    code = (code << 1) | bits.read();
    if (code <= h.maxcode[len]!) return h.values[h.valptr[len]! + code - h.mincode[len]!]!;
  }
  throw new Error("not a code in this table");
}
