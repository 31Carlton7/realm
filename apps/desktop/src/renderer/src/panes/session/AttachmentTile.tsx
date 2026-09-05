import { Icon } from "@realm/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { basenameOf, isImageMime, isOpenablePath, isPlayablePath } from "@realm/contracts";
import { MediaLightbox } from "./media/MediaView";
import { useMediaFiles } from "./media/use-media";

/** Thumbnails are minted in main (see the `attachment-thumbnail` handler) and are pure functions of a
 *  path, so one module-level cache serves every tile: the same screenshot appears in the composer and
 *  then again in the transcript, and re-reading it off disk for each would be work nobody asked for.
 *  A path that yields no thumbnail caches `null` too — an unpreviewable file must not send QuickLook
 *  off to fail again on every render. */
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

/**
 * One attachment, as a square: the file itself when macOS can render it — the image, the first page
 * of the PDF — and a glyph with the file's extension when it cannot.
 *
 * The NAME is deliberately not on the tile. A row of chips reading "Screenshot 2026-09-02 at
 * 14.31.07.png" tells the user something they already know (they just picked the file) at the cost of
 * the one thing they cannot check at a glance: whether it is the right file. The picture answers
 * that. The name is one hover away, in the tip, where it is available but not in the way.
 *
 * A thumbnail that never arrives — an unreadable file, a path that has since moved, a type QuickLook
 * has no generator for — lands on the glyph, because `attachmentThumbnail` answers null for every one
 * of them and the tile treats "no picture yet" and "no picture ever" the same.
 *
 * Clicking it opens the file, and what "open" means is decided by what the file IS. An image, a video
 * or an audio file — the ones `realm-media://` will serve — opens in the lightbox the transcript
 * already uses. Everything else goes to the app the user reads that type in, because there is no
 * element that could render a PDF or a CSV and a viewer that showed a broken image for half the
 * attachments would be worse than a tile that did nothing.
 *
 * This lives on the TILE rather than on either of its two callers, which is the point: the composer's
 * pending chip and the sent chip in a user's message bubble look identical, and a tile that behaved
 * one way above the prompter and another way six inches up the transcript would be a bug wearing the
 * same picture.
 */
export function AttachmentTile({ path, mime, name, detail, disposition, onRemove }: {
  path: string; mime: string;
  /** The picker's own name when there is one; otherwise the path's basename. */
  name?: string;
  /** Second line of the tip: size, and this agent's fate for the file. Absent in the transcript,
   *  where the message has been sent and neither is actionable any more. */
  detail?: string;
  /** The composer's per-agent fate for this file; drives the warning tint. */
  disposition?: string;
  onRemove?: () => void;
}) {
  const label = name ?? basenameOf(path);
  const [thumb, setThumb] = useState<string | null>(() => cache.get(path) ?? null);
  const ext = extOf(path);
  const opener = useRef<HTMLButtonElement>(null);
  const [lightbox, setLightbox] = useState(false);
  /* Only a path the scheme could serve is worth asking main about, which is the same cheap filter the
     transcript applies before it stats anything. A PDF never reaches IPC at all. */
  const candidates = useMemo(() => (isPlayablePath(path) ? [path] : []), [path]);
  const file = useMediaFiles(candidates)[0] ?? null;
  // Answered from the path, not from `mime`: the prop carries whatever the picker said, while main
  // gates on the extension. Asking the same question both sides ask keeps the affordance honest.
  const canOpen = isOpenablePath(path);

  useEffect(() => {
    if (cache.has(path)) { setThumb(cache.get(path) ?? null); return; }
    let live = true;
    void loadThumbnail(path).then((url) => { if (live) setThumb(url); });
    return () => { live = false; };
  }, [path]);

  /* Media opens here, everything else opens THERE. The branch is on `file` — main's own answer about
     the file on disk — rather than on the mime the caller passed, so a path that has since moved
     falls to the OS (which reports it) instead of into a lightbox with nothing in it. */
  const open = () => { if (file) setLightbox(true); else void window.realm?.openAttachment?.(path); };
  // Focus goes back to the tile the lightbox came out of. Without it the keyboard lands back at the
  // top of the document, which in a long transcript is nowhere near the file just looked at.
  const close = useCallback(() => { setLightbox(false); opener.current?.focus(); }, []);

  const face = (
    <>
      {/* The picture and its badge sit in their own well, which is the element that clips to the
          rounded corners. The tile around it must NOT clip — the tip hangs outside its box. */}
      <span className="attach-art">
        {thumb
          // alt="" on purpose: the file is named once, by the visually-hidden span below. An alt
          // here would have a screen reader read it twice.
          ? <img className="attach-thumb" src={thumb} alt="" draggable={false} />
          : <Icon name={isImageMime(mime) ? "image" : "artifact"} size={18} className="attach-glyph" />}
        {ext && <span className="attach-ext">{ext}</span>}
      </span>
      {/* Dropping the visible name must not drop it from the accessibility tree: a tile whose only
          content is a picture and a three-letter badge is unreadable to a screen reader, and this is
          the one place the file is still named for one. */}
      <span className="visually-hidden">{label}{detail ? ` — ${detail}` : ""}</span>
    </>
  );

  return (
    <span className="attach-tile" data-disposition={disposition} data-image={thumb ? "" : undefined}
      data-media={file ? "" : undefined}>
      {/* Open and Remove are SIBLINGS, never nested. A button inside a button is invalid, and the
          alternative — one click handler untangling its own target — is the version that eventually
          removes a file the user meant to look at. Being separate elements is the whole guarantee. */}
      {canOpen
        ? <button ref={opener} type="button" className="attach-open" aria-label={`Open ${label}`} onClick={open}>{face}</button>
        : <span className="attach-open">{face}</span>}
      {/* The tip is a real element rather than a `title`: the OS tooltip waits a second, arrives
          under the pointer and cannot show more than one line. `aria-hidden` because the name above
          is already in the tree — a screen reader must not hear the file twice. */}
      <span className="attach-tip" aria-hidden="true">
        <span className="attach-tip-name">{label}</span>
        {detail && <span className="attach-tip-detail">{detail}</span>}
      </span>
      {onRemove && (
        <button type="button" className="attach-remove" aria-label={`Remove ${label}`} onClick={onRemove}>
          <Icon name="close" size={9} />
        </button>
      )}
      {lightbox && file && <MediaLightbox file={file} onClose={close} />}
    </span>
  );
}
