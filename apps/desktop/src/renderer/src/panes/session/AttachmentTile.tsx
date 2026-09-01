import { Icon } from "@realm/ui";
import { useEffect, useState } from "react";
import { basenameOf, isImageMime } from "@realm/contracts";

/** Thumbnails are minted in main (see the `attachment-thumbnail` handler) and are pure functions of a
 *  path, so one module-level cache serves every tile: the same screenshot appears in the composer and
 *  then again in the transcript, and re-reading it off disk for each would be work nobody asked for.
 *  A path that yields no thumbnail caches `null` too — a PDF must not be re-probed on every render. */
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

function loadThumbnail(path: string): Promise<string | null> {
  const hit = inflight.get(path);
  if (hit) return hit;
  // Guarded down to `window.realm` itself: without the preload bridge (tests, and any renderer that
  // loads before it) a missing thumbnail must degrade to the file glyph, never take the tile down.
  const p = (window.realm?.attachmentThumbnail?.(path) ?? Promise.resolve(null))
    .catch(() => null)
    .then((url) => { cache.set(path, url); inflight.delete(path); return url; });
  inflight.set(path, p);
  return p;
}

/** The extension, as the badge shows it: "pdf", "png". Empty for a file that has none. */
const extOf = (path: string): string => {
  const base = basenameOf(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase().slice(0, 4) : "";
};

/** One attachment, shown rather than merely named: the image itself when it is an image, a file glyph
 *  otherwise, with the type as a badge and the full path on hover.
 *
 *  A non-image, an unreadable file, or a path that has since moved all land in the same place — the
 *  glyph — because `attachmentThumbnail` answers null for every one of them. */
export function AttachmentTile({ path, mime, name, title, disposition, onRemove }: {
  path: string; mime: string;
  /** The picker's own name when there is one; otherwise the path's basename. */
  name?: string;
  /** Hover text; defaults to the full path, which is what makes a bare basename unambiguous. */
  title?: string;
  /** The composer's per-agent fate for this file; drives the warning tint. Absent in the transcript,
   *  where the message has already been sent and the fate is no longer actionable. */
  disposition?: string;
  onRemove?: () => void;
}) {
  const label = name ?? basenameOf(path);
  const [thumb, setThumb] = useState<string | null>(() => cache.get(path) ?? null);
  const isImage = isImageMime(mime);

  useEffect(() => {
    if (!isImage || cache.has(path)) { setThumb(cache.get(path) ?? null); return; }
    let live = true;
    void loadThumbnail(path).then((url) => { if (live) setThumb(url); });
    return () => { live = false; };
  }, [path, isImage]);

  return (
    <span className="attach-chip" title={title ?? path} data-disposition={disposition} data-image={thumb ? "" : undefined}>
      <span className="attach-art">
        {thumb
          ? <img className="attach-thumb" src={thumb} alt={label} draggable={false} />
          : <Icon name={isImage ? "image" : "artifact"} size={15} className="attach-glyph" />}
        {extOf(path) && <span className="attach-ext">{extOf(path)}</span>}
      </span>
      <span className="chip-label">{label}</span>
      {onRemove && (
        <button type="button" className="attach-remove" aria-label={`Remove ${label}`} onClick={onRemove}>
          <Icon name="close" size={10} />
        </button>
      )}
    </span>
  );
}
