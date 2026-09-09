/**
 * The accessibility tree of a device streamed into a browser pane, and the point→element lookup a
 * pick needs.
 *
 * `serve-sim` mirrors an Apple Simulator into an ordinary web page: the framebuffer is a `<canvas>`
 * or `<img>`, so every control on the device is pixels and `document.elementFromPoint` can only ever
 * return the surface. The device's own accessibility tree is published beside the stream at `/ax`,
 * as Server-Sent Events whose every `data:` line is a complete snapshot — which is what makes a pick
 * inside the screen resolvable at all.
 *
 * Nothing here talks to a simulator. It talks to one HTTP endpoint and does arithmetic, so the
 * geometry — the half that is actually easy to get wrong — is testable without a Mac, an Xcode, or
 * a booted device.
 */

/** One element of a device's accessibility tree, as `/ax` publishes it. Frames are in device POINTS
 *  relative to `AxSnapshot.screen`, never in pane pixels. */
export type AxElement = {
  id: string;
  path: string;
  label: string;
  value: string;
  role: string;
  type: string;
  enabled: boolean;
  frame: { x: number; y: number; width: number; height: number };
};

export type AxSnapshot = {
  screen: { width: number; height: number };
  elements: AxElement[];
};

/** How long to wait for the first snapshot. A pick is a gesture the user is waiting on, so this is
 *  short on purpose: a device that has not answered in a second is one whose element the pick will
 *  report as the surface instead, which is honest and instant. */
const AX_TIMEOUT_MS = 1000;

/**
 * Read ONE snapshot from a serve-sim `/ax` stream, or null if this origin does not serve one.
 *
 * The endpoint is SSE and stays open forever; this takes the first complete `data:` line and hangs
 * up. A truncated final line is discarded rather than repaired — a half-parsed tree would resolve a
 * pick to whichever element happened to survive the cut, which is worse than not resolving it.
 *
 * Every failure is null: not a simulator page, a 404, a 503 while the device's AX framework warms up
 * after boot, a timeout. The caller falls back to the DOM element the user actually clicked, so the
 * cost of guessing wrong here is a less specific chip, never a broken one.
 */
export async function readAxSnapshot(origin: string, fetchImpl: typeof fetch = fetch): Promise<AxSnapshot | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AX_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${origin.replace(/\/+$/, "")}/ax`, {
      signal: controller.signal,
      headers: { accept: "text/event-stream" },
    });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        // Only a line terminated by a newline is complete. Parsing the tail of the buffer would be
        // parsing whatever arrived in the last TCP segment.
        const nl = buffered.indexOf("\n", buffered.indexOf("data: "));
        if (buffered.includes("data: ") && nl !== -1) {
          const line = buffered.slice(buffered.indexOf("data: ") + 6, nl).trim();
          const snap = parseSnapshot(line);
          if (snap) return snap;
          buffered = buffered.slice(nl + 1);
        }
        if (buffered.length > 4_000_000) return null; // a stream that never yields a snapshot
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseSnapshot(line: string): AxSnapshot | null {
  if (!line) return null;
  try {
    const raw = JSON.parse(line) as Partial<AxSnapshot>;
    const w = raw.screen?.width, h = raw.screen?.height;
    if (typeof w !== "number" || typeof h !== "number" || w <= 0 || h <= 0) return null;
    if (!Array.isArray(raw.elements)) return null;
    return { screen: { width: w, height: h }, elements: raw.elements.filter(isAxElement) };
  } catch {
    return null;
  }
}

function isAxElement(v: unknown): v is AxElement {
  const e = v as Partial<AxElement> | null;
  if (!e || typeof e !== "object" || !e.frame) return false;
  const f = e.frame;
  return typeof f.x === "number" && typeof f.y === "number"
    && typeof f.width === "number" && typeof f.height === "number";
}

/**
 * The device element under a normalized point, or null.
 *
 * `nx`/`ny` are 0..1 across the streamed SURFACE, which is the device screen and nothing else — the
 * bezel and the page's chrome are outside it, so the mapping to points is a plain multiply.
 *
 * **Smallest containing frame wins**, which is what makes the answer the one the user meant. A tap
 * on a row in Settings is inside the row, inside the group, inside the table, inside the window; the
 * DOM picker resolves that ambiguity by returning the innermost node, and area is this tree's stand-in
 * for depth. Ties go to the earlier element, so the result is stable rather than dependent on sort.
 *
 * Zero-area frames are skipped: a device reports them for elements that exist but are not laid out,
 * and one of those containing a point would win every comparison by being the smallest.
 */
export function axElementAt(snap: AxSnapshot, nx: number, ny: number): AxElement | null {
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
  const px = nx * snap.screen.width, py = ny * snap.screen.height;
  let best: AxElement | null = null;
  let bestArea = Infinity;
  for (const e of snap.elements) {
    const { x, y, width, height } = e.frame;
    if (width <= 0 || height <= 0) continue;
    if (px < x || px > x + width || py < y || py > y + height) continue;
    const area = width * height;
    if (area < bestArea) { best = e; bestArea = area; }
  }
  return best;
}
