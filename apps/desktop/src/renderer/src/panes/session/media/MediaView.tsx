import { Icon } from "@realm/ui";
import { useContext, useMemo } from "react";
import { basenameOf, formatAttachmentSize, mediaUrl, type MediaFile } from "@realm/contracts";
import { MediaSessionContext, useOpenViewer } from "../../../components/viewer/open";
import { VideoPlayer, type VideoVariant } from "../../../components/video/VideoPlayer";
import { useAppStoreMaybe } from "../../../state/store";
import { useMediaFiles } from "./use-media";

/**
 * Media, drawn where the agent talked about it.
 *
 * Realm's whole transcript argument is that the reader should not have to do the parsing: a diff is
 * drawn, a plan is drawn, a terminal is drawn. A movie the agent just encoded was the one artefact
 * that still arrived as a filename in a table — the reader had to go to Finder to find out whether
 * the thing they asked for is any good. These are the elements that close that.
 *
 * Every path here has already been confirmed by main (`media:stat`). Nothing in this file guesses.
 */

/** One media file at message width: the picture, the player, or an audio row. `onExpand` is what
 *  puts it in the media viewer — a 1080×1920 vertical video is legible in a 680px column only as a
 *  thumbnail, and the full-window view is where it is actually watched. */
export function MediaFrame({ file, autoFocus = false, onExpand, variant = "inline" }: {
  file: MediaFile; autoFocus?: boolean; onExpand?: () => void; variant?: VideoVariant;
}) {
  const name = basenameOf(file.path);
  if (file.kind === "video") return <VideoPlayer file={file} variant={variant} autoFocus={autoFocus} onExpand={onExpand} />;
  if (file.kind === "audio") {
    // Audio is the one kind with nothing to look at, so it keeps the native transport: there is no
    // frame for custom controls to sit on, and a bare row of our own buttons would be a worse
    // version of the same widget.
    return (
      <div className="media-audio">
        <span className="media-audio-name">{name}</span>
        <audio className="media-el" src={mediaUrl(file.path)} controls preload="metadata" />
      </div>
    );
  }
  return (
    <button type="button" className="media-image" onClick={onExpand} disabled={!onExpand} autoFocus={autoFocus}
      aria-label={onExpand ? `Open ${name} larger` : name}>
      {/* `loading="lazy"` matters here in a way it does not on a tile: a long transcript can hold
          dozens of full-size renders, and decoding the ones nobody has scrolled to is work that
          competes with the stream still arriving. */}
      <img className="media-el" src={mediaUrl(file.path)} alt={name} loading="lazy" draggable={false} />
    </button>
  );
}

/** The row under a message: each file, its name, its size, and the two things a reader wants from a
 *  file they can see but not touch. One column when a single file is shown (it gets the width), a
 *  wrapped grid when there are several — three mockups side by side is the comparison the reader
 *  came for, and stacking them full-width would put two of them off-screen. */
export function MediaStrip({ files }: { files: readonly MediaFile[] }) {
  const open = useOpenViewer();
  const openFile = useOpenInRealm();
  if (files.length === 0) return null;
  // The strip's files are each other's siblings in the viewer: three mockups side by side are the
  // three ← and → walk, in the order the message showed them.
  const expand = (i: number) => open?.({ files: files.map((f) => ({ path: f.path, mime: f.mime })), index: i });
  return (
    <>
      <ul className="media-strip" data-count={files.length > 1 ? "many" : "one"} aria-label="Files this message points at">
        {files.map((file, i) => (
          <li key={file.path} className="media-item">
            <MediaFrame file={file} onExpand={open ? () => expand(i) : undefined} />
            <div className="media-meta">
              <span className="media-name" title={file.path}>{basenameOf(file.path)}</span>
              <span className="media-detail">{formatAttachmentSize(file.size)}</span>
              <button type="button" className="media-action" title="Reveal in Finder"
                aria-label={`Reveal ${basenameOf(file.path)} in Finder`}
                onClick={() => void window.realm?.media?.reveal(file.path)}>
                <Icon name="folder" size={12} />
              </button>
              <button type="button" className="media-action" title={file.kind === "video" ? "Open in the documents pane" : "Open"}
                aria-label={`Open ${basenameOf(file.path)}`}
                onClick={() => openFile(file)}>
                <Icon name="focusPane" size={12} />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Open, for a file a message points at. A video opens in Realm's player in the documents pane beside
 * the session, never in QuickTime: the player is the one place a video is watched here. Anything else
 * goes to the app the Mac opens it with, as it always has.
 */
function useOpenInRealm(): (file: MediaFile) => void {
  const store = useAppStoreMaybe();
  const sessionId = useContext(MediaSessionContext);
  return (file) => {
    if (file.kind !== "video" || !store) { void window.realm?.media?.open(file.path); return; }
    const st = store.getState();
    const environmentId = sessionId ? st.sessions[sessionId]?.environmentId ?? null : null;
    st.run(() => st.openDocumentPath(file.path, environmentId, null, sessionId ? { beside: { sessionId } } : {}));
  };
}

/** The longest side a canvas may take. Big enough to read as a placeholder for a picture, small
 *  enough that a run of them does not push the conversation off the screen. */
const GEN_MAX_PX = 320;

/** The width a `w / h` ratio wants, to fit inside a GEN_MAX_PX square.
 *
 *  Computed rather than left to CSS because CSS cannot do it: `aspect-ratio` with BOTH `max-width`
 *  and `max-height` set does not preserve the ratio — it clamps each side independently, so a 9:16
 *  canvas came out square, which is precisely the thing this component exists to avoid. Giving it a
 *  definite width and letting `aspect-ratio` derive the height is unambiguous. Anything unparseable
 *  falls back to the full square. */
export function genWidthPx(aspect: string, max = GEN_MAX_PX): number {
  const [w, h] = aspect.split("/").map((n) => Number(n.trim()));
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) return max;
  return Math.round(w * Math.min(max / w, max / h));
}

/**
 * The frame size to print in the canvas's corner, or null when there is none to print.
 *
 * `aspect` carries two different things and only one of them is a resolution. When `aspectIn` found
 * a `1920x1080` in the command it is the real frame the agent asked for, and saying so is the most
 * useful thing this placeholder can add. When nothing was found the value is a FALLBACK RATIO —
 * `1 / 1`, `16 / 9` — and rendering "1 × 1" in a corner would be Realm inventing a number the agent
 * never wrote. Three digits is the line, and it is the same line `aspectIn` already draws for the
 * same reason: below it, a pair of adjacent numbers is not a frame size.
 */
export function genResolution(aspect: string): string | null {
  const [w, h] = aspect.split("/").map((n) => n.trim());
  return w && h && /^\d{3,5}$/.test(w) && /^\d{3,5}$/.test(h) ? `${w} × ${h}` : null;
}

/**
 * The shimmering canvas an image or a video occupies while it is being made
 * (aicss.dev/components/image-generation).
 *
 * It is a PLACEHOLDER at the size of the thing coming, not a spinner: a spinner says "something is
 * happening", a canvas of the right shape says "your picture is being drawn, and it will land
 * here". That is the entire difference the component exists for, and it is why the aspect ratio and
 * the label are props rather than constants.
 *
 * Shown by the tool call's REAL state — it is on screen exactly as long as the call has no result —
 * never by a timer. A generation that fails leaves a failed tool card, not a canvas shimmering
 * forever.
 */
export function GeneratingCanvas({ label, detail, aspect = "1 / 1" }: {
  label: string;
  /** The prompt, or the command's own description — what is being made, in the agent's words. */
  detail?: string | null;
  aspect?: string;
}) {
  const resolution = genResolution(aspect);
  return (
    <div className="gen-wrap">
      {/* `aspectRatio` stays alongside the width so that a column too narrow for it clamps the width
          and lets the HEIGHT follow, rather than squashing the shape. */}
      <div className="gen-canvas" style={{ aspectRatio: aspect, width: genWidthPx(aspect) }} role="img" aria-label={label}>
        {/* Both decorative: the label below is what a screen reader is given, and a shimmer read
            aloud is noise. */}
        <span className="gen-dots" aria-hidden="true" />
        <span className="gen-glow" aria-hidden="true" />
        {/* No kind glyph. It said the same thing as the label one line below it, and a mark parked
            in the middle of the canvas is the one place the reveal cannot go — the wander is what
            this placeholder now says, so it gets the canvas. `MediaWork.kind` is not passed in at
            all any more: it decides the label and the fallback aspect upstream, which is where the
            image/video distinction actually does work. */}
        {resolution && <span className="gen-res">{resolution}</span>}
      </div>
      <div className="gen-meta">
        <span className="gen-label shimmer-text">{label}</span>
        {detail && <span className="gen-detail" title={detail}>{detail}</span>}
      </div>
    </div>
  );
}

/**
 * A file a tool call named, drawn if it turns out to be media. Used by ToolCard for the `Read` of a
 * screenshot and the `Write` of a render — the two calls whose whole point is a picture, and whose
 * raw well could only ever say what it was called.
 *
 * Renders nothing at all until main confirms the path, and nothing ever for a path it does not: a
 * tool card that grew an empty frame every time an agent read a `.png` that had since been cleaned
 * up would be a worse card than the one that just showed the JSON.
 */
export function ToolMedia({ path }: { path: string }) {
  const open = useOpenViewer();
  const files = useMediaFiles(useMemo(() => [path], [path]));
  const file = files[0];
  if (!file) return null;
  return (
    <div className="tool-media">
      <MediaFrame file={file} onExpand={open ? () => open({ files: [{ path: file.path, mime: file.mime }] }) : undefined} />
    </div>
  );
}
