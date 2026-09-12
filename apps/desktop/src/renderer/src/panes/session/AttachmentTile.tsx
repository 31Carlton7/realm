import { Icon } from "@realm/ui";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { basenameOf, isDirectoryMime, isImageMime, isOpenablePath, isPlayablePath } from "@realm/contracts";
import { useThumbnail } from "../../components/use-thumbnail";
import { squirclePath } from "../machine/squircle-path";
import { MediaLightbox } from "./media/MediaView";
import { useMediaFiles } from "./media/use-media";

/** The extension, as the badge shows it: "pdf", "png". Empty for a file that has none. */
const extOf = (path: string): string => {
  const base = basenameOf(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase().slice(0, 4) : "";
};

/**
 * The well's superellipse, as a clip path.
 *
 * The fill and the ring are the paint worklet's, like every other signature corner in the app. What
 * the worklet cannot do is clip the tile's CONTENTS — the thumbnail and the type badge — and under
 * it `border-radius` has to be 0, so `overflow: hidden` clips them to a square. A picture with square
 * corners sitting on a painted superellipse is the one arrangement that looks worse than either
 * shape alone.
 *
 * So the well takes a clip path, for the reason `squircle-path.ts` exists at all. It costs a read of
 * the tile's own box: the size lives in the stylesheet (`--attach-tile`, 44px in the prompter and
 * 56px in a message) and the path needs it in pixels. Read once, on mount — a tile is one of two
 * sizes and never changes between them, so there is nothing here to keep watching.
 */
function useSquircleWell(): { ref: React.RefObject<HTMLSpanElement | null>; clip: string | undefined } {
  const ref = useRef<HTMLSpanElement>(null);
  const [clip, setClip] = useState<string | undefined>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return; // not laid out yet; the fallback corner still reads
    /* The ratio comes from the stylesheet too, so the clip and the painted fill are derived from one
       number rather than from two that have to be kept equal. */
    const ratio = parseFloat(getComputedStyle(el).getPropertyValue("--sq-ratio-media")) || 0.4;
    /* `path("…")`, not the bare `d`: `squirclePath` returns the path DATA, and `clip-path` takes a
       shape. The machine pane wraps it at its own call site for the same reason. */
    const d = squirclePath(box.width, box.height, Math.round(box.width * ratio));
    setClip(d ? `path("${d}")` : undefined);
  }, []);
  return { ref, clip };
}

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
 * Opening lives on the TILE rather than on either of its two callers. The composer's pending chip
 * and the sent chip in a message bubble are the same picture of the same file, so a tile that
 * behaved one way in the prompter and another way in the transcript would be a bug — and two
 * callers each holding their own copy of the behaviour is how that bug gets written.
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
  // The shared cache, not a private one: this same file is a tile in the composer, a tile in the
  // message it was sent with, and a tile in the Library, and three copies of the cache would send
  // main after the same picture three times.
  // A folder is a folder before it is anything else. Asked of the MIME rather than the path because
  // only main can tell (it stats; the renderer would be guessing from a name), and because a folder
  // named `photos.png` must not be drawn as the picture it is not.
  const directory = isDirectoryMime(mime);
  // Nothing to preview, and nothing to badge: a folder's extension is either absent or a lie, and
  // asking main for a thumbnail of a directory is a round trip whose only answer is null.
  const thumb = useThumbnail(directory ? null : path);
  const ext = directory ? "" : extOf(path);
  const opener = useRef<HTMLButtonElement>(null);
  const [lightbox, setLightbox] = useState(false);
  /* Only a path the scheme could serve is worth asking main about, which is the same cheap filter the
     transcript applies before it stats anything. A PDF never reaches IPC at all. */
  const candidates = useMemo(() => (!directory && isPlayablePath(path) ? [path] : []), [path, directory]);
  const file = useMediaFiles(candidates)[0] ?? null;
  // Answered from the path, not from `mime`: the prop carries whatever the picker said, while main
  // gates on the extension. Asking the same question both sides ask keeps the affordance honest.
  // Deliberately NOT extended to folders. `openAttachment` would hand a directory to the OS, and on
  // macOS an `.app` is a directory — so a tile that opened folders would run a dragged-in
  // `Calculator.app` on a click. The mime table is the gate precisely to stop that, and a folder
  // tile that shows what it is without offering to launch it is the honest trade.
  const canOpen = isOpenablePath(path);
  const well = useSquircleWell();

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
      <span className="attach-art" ref={well.ref} style={well.clip ? { ["--attach-clip" as string]: well.clip } : undefined}>
        {thumb
          // alt="" on purpose: the file is named once, by the visually-hidden span below. An alt
          // here would have a screen reader read it twice.
          ? <img className="attach-thumb" src={thumb} alt="" draggable={false} />
          : <Icon name={directory ? "folder" : isImageMime(mime) ? "image" : "artifact"} size={18} className="attach-glyph" />}
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
          <Icon name="close" size={12} />
        </button>
      )}
      {lightbox && file && <MediaLightbox file={file} onClose={close} />}
    </span>
  );
}
