import { useEffect, useState } from "react";

/**
 * A picture of a file on disk, cached once per path for the life of the window.
 *
 * Thumbnails are minted in main (the `attachment-thumbnail` and `files:preview` handlers) and are
 * pure functions of a path and a size, so one module-level cache serves every caller: the same
 * screenshot appears in the composer, again in the transcript, and again as a Library tile, and
 * re-reading it off disk for each would be work nobody asked for.
 *
 * A path that yields no picture caches `null` just as hard. Most misses are permanent — a type
 * QuickLook has no generator for, a file that has since moved — and a miss re-asked on every render
 * would send a child process off to fail again on each one.
 *
 * The cache is keyed by path AND size because the two sizes are different pictures: a 96px tile mark
 * and a 512px readable preview of the same PDF must not evict one another, which is exactly what a
 * path-only key did the moment the Library preview was opened over a grid that had already drawn the
 * tile.
 */
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

/** Which producer to ask. `tile` is a mark beside a name; `preview` is meant to be read. */
export type ThumbnailSize = "tile" | "preview";

/** Test seam and cache reset. Nothing in the app calls this; the suite does, between cases that
 *  would otherwise see each other's answers. */
export function resetThumbnailCache(): void {
  cache.clear();
  inflight.clear();
}

function load(path: string, size: ThumbnailSize): Promise<string | null> {
  const key = `${size}:${path}`;
  const hit = inflight.get(key);
  if (hit) return hit;
  // Guarded down to `window.realm` itself: without the preload bridge (tests, and any renderer that
  // loads before it) a missing picture must degrade to the file glyph, never take the caller down.
  const ask = size === "preview"
    ? window.realm?.files?.preview?.(path)
    : window.realm?.attachmentThumbnail?.(path);
  const p = (ask ?? Promise.resolve(null))
    .catch(() => null)
    .then((url) => { cache.set(key, url); inflight.delete(key); return url; });
  inflight.set(key, p);
  return p;
}

/**
 * The picture for `path`, or null while there is none — including forever, for a file that has none.
 *
 * `path` is nullable rather than the hook being conditional, because the decision "is a picture worth
 * asking for at all" belongs to the caller and changes as it re-renders. A Library grid asks only
 * about images and video: everything else would put one `qlmanage` child process behind every tile,
 * and a page of sixty of them is sixty processes for marks nobody is reading.
 */
export function useThumbnail(path: string | null, size: ThumbnailSize = "tile"): string | null {
  const key = path === null ? null : `${size}:${path}`;
  const [url, setUrl] = useState<string | null>(() => (key === null ? null : cache.get(key) ?? null));
  useEffect(() => {
    if (path === null || key === null) { setUrl(null); return; }
    if (cache.has(key)) { setUrl(cache.get(key) ?? null); return; }
    let live = true;
    void load(path, size).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [path, key, size]);
  return url;
}
