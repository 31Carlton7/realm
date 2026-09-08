import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { basenameOf, formatAttachmentSize, isOpenablePath, isOpenableArtifact, isPlayablePath, type ArtifactKind } from "@realm/contracts";
import { MediaFrame, MediaLightbox } from "../panes/session/media/MediaView";
import { useMediaFiles } from "../panes/session/media/use-media";
import { useApp } from "../state/store";
import { Menu, type MenuItem } from "./Menu";
import { Sheet } from "./Sheet";
import { useThumbnail } from "./use-thumbnail";

/** Where a file came from, when the surface showing it knows. The Library's index carries all four;
 *  a session summary's sheet knows the path and nothing else, and draws no provenance rather than a
 *  half-filled one. */
export type FileProvenance = {
  sessionId: string;
  /** The space the session was in when the row was indexed. `revealSession` prefers its own live
   *  answer — a session that has since been MOVED would otherwise send the user to the old space. */
  spaceId: string;
  sessionTitle: string;
  kind: ArtifactKind;
};

/**
 * One file, previewed, with everything Realm can honestly do with it.
 *
 * This is the ONE preview. It is what the Library opens when a card is clicked and what a session
 * summary opens for a file the documents pane has no view of, because a file must not open two
 * different ways depending on which list it was reached from — the same `.zip` reached from two
 * places used to get a rich viewer from one and a bare "hand it to the OS" modal from the other.
 *
 * What it shows, in falling order of how much it says:
 *
 *  - Media that `media:stat` confirms is really on disk gets `MediaFrame` — the transcript's own
 *    picture and its own player, unchanged — and "Expand" hands it to the transcript's own lightbox.
 *    A second image viewer here would be a fork of the one thing this file exists to reuse.
 *  - Anything else gets QuickLook's render, which is what Finder's space bar shows: the first page
 *    of a PDF, the first rows of a sheet, a page of source. Null for a type macOS cannot draw, and
 *    the preview then simply has no picture rather than a frame with nothing in it.
 *
 * Every action is drawn only where it would work. `files.stat` answering null means the file is gone,
 * and then NONE of them are drawn — the alternative is three buttons that fail one after another,
 * which is a worse way to learn the same fact than the sentence that replaces them.
 */
export function FilePreview({ path, from = null, onClose }: {
  path: string;
  from?: FileProvenance | null;
  onClose: () => void;
}) {
  const name = basenameOf(path);
  const openDocumentPath = useApp((s) => s.openDocumentPath);
  const revealSession = useApp((s) => s.revealSession);
  const sessionSpace = useApp((s) => s.sessionSpace);
  const run = useApp((s) => s.run);

  /* Only a path the media scheme could serve is worth asking main about — the same cheap filter the
     transcript and the attachment tile apply before they stat anything. A PDF never reaches IPC. */
  const candidates = useMemo(() => (isPlayablePath(path) ? [path] : []), [path]);
  const media = useMediaFiles(candidates)[0] ?? null;
  // Asked only when there is no media frame to draw: QuickLook would happily render a JPEG too, and
  // spending a child process on a second, worse picture of a file already on screen is waste.
  const still = useThumbnail(media ? null : path, "preview");

  const [file, setFile] = useState<{ size: number; mtimeMs: number } | null | undefined>(undefined);
  const [lightbox, setLightbox] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const overflow = useRef<HTMLButtonElement>(null);

  /* `undefined` is "not asked yet" and `null` is "not there", and the two must stay apart: collapsing
     them would flash "this file is no longer on disk" over every file for the length of one stat. */
  useEffect(() => {
    let live = true;
    const ask = window.realm?.files?.stat?.(path) ?? Promise.resolve(null);
    void ask.catch(() => null).then((s) => { if (live) setFile(s ? { size: s.size, mtimeMs: s.mtimeMs } : null); });
    return () => { live = false; };
  }, [path]);

  const gone = file === null;
  // The documents pane's own answer about the same file, which is what makes "Open" mean one thing
  // across the app: `isOpenableArtifact` IS `documentKindFor(path) !== "unsupported"`.
  const inPane = isOpenableArtifact(path);
  // macOS `open` RUNS an `.app` or a `.command`, so handing a file over stays behind the mime table.
  // A `.gitignore` is listable, revealable and copyable, and is not something to hand to `open`.
  const toOs = isOpenablePath(path);
  /* A session Realm can still reach. `sessionSpace` spans every space in the profile and survives a
     space switch, so it answers for a file made in a space that is not the active one — which is
     normal here, since the Library's default scope is every space. A session that has been deleted
     has no entry, and then the row is text rather than a button that would switch space and land on
     nothing. */
  const reachable = from !== null && (from.sessionId in sessionSpace);

  const close = () => { setLightbox(false); onClose(); };
  const open = () => {
    if (media) { setLightbox(true); return; }
    if (inPane) { run(() => openDocumentPath(path)); onClose(); return; }
    void window.realm?.openAttachment?.(path);
    onClose();
  };

  const items: MenuItem[] = [
    { label: "Save a copy…", onSelect: () => { void window.realm?.files?.saveCopy?.(path); } },
    { label: "Reveal in Finder", onSelect: () => { void window.realm?.files?.reveal?.(path); } },
    // Offered alongside the pane for media: an image opens in the lightbox, and "open it in the app I
    // actually edit pictures in" is a different request the lightbox cannot answer.
    ...(toOs && (media || !inPane) ? [{ label: "Open with the default app", onSelect: () => { void window.realm?.openAttachment?.(path); } }] : []),
    ...(media && inPane ? [{ label: "Open in the documents pane", onSelect: () => { run(() => openDocumentPath(path)); onClose(); } }] : []),
    { kind: "separator" } as MenuItem,
    { label: "Copy path", onSelect: () => { void navigator.clipboard?.writeText?.(path); } },
  ];

  const primary = media ? "Expand" : inPane ? "Open in the documents pane" : "Open with the default app";
  const canOpen = media !== null || inPane || toOs;

  /* The lightbox REPLACES the sheet rather than sitting over it, and that is an Escape-ordering fact
     rather than a layout one. Both surfaces listen for Escape on `window` in the capture phase, and
     the sheet — mounted first — gets the key first, so the lightbox's `stopPropagation` cannot stop
     a listener already registered ahead of it: one press closed both, and expanding an image was a
     one-way trip out of the preview. Unmounting the sheet takes its listener with it, so Escape
     lands on the viewer alone and returns here, which is what "expand" should mean. The sheet is
     invisible under a full-window overlay either way, so nothing is lost by not drawing it. */
  if (lightbox && media) return <MediaLightbox file={media} onClose={() => setLightbox(false)} />;

  return (
    <>
      <Sheet title={name} onClose={close} width={520}
        footer={gone ? undefined : (
          <>
            <button ref={overflow} type="button" className="btn file-preview-more" aria-label="More actions"
              aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
              <Icon name="more" size={14} />
            </button>
            {canOpen && <button type="button" className="btn primary" onClick={open}>{primary}</button>}
          </>
        )}>
        {/* The picture, when there is one. No frame is drawn for a file that has none: an empty well
            the size of a preview is a claim on room it had nothing to put in. */}
        {media
          ? <div className="file-preview-art"><MediaFrame file={media} onExpand={() => setLightbox(true)} /></div>
          : still && <div className="file-preview-art"><img className="file-preview-still" src={still} alt="" draggable={false} /></div>}

        <p className="file-preview-path" title={path}>{path}</p>

        {/* The facts the row itself could not carry. `file === undefined` is the stat still in flight,
            and prints nothing rather than a zero that would later change. */}
        {file && <p className="file-preview-detail">{formatAttachmentSize(file.size)}</p>}
        {gone && <p className="file-preview-note">This file is no longer on disk.</p>}

        {from && (
          <div className="file-preview-from">
            <Icon name={from.kind === "upload" ? "attach" : "artifact"} size={12} aria-hidden="true" />
            {reachable
              ? (
                <button type="button" className="btn btn-quiet" onClick={() => { onClose(); run(() => revealSession(from.sessionId, from.spaceId)); }}>
                  {from.kind === "upload" ? "Uploaded to " : "Made in "}{from.sessionTitle}
                </button>
              )
              /* Named, not offered. The session is gone; a button that switched space and landed on
                 nothing would be a worse answer than the sentence. */
              : <span className="file-preview-from-gone">{from.kind === "upload" ? "Uploaded to " : "Made in "}{from.sessionTitle} — that session is gone.</span>}
          </div>
        )}
      </Sheet>
      {menuOpen && <Menu items={items} anchorRef={overflow} onClose={() => setMenuOpen(false)} placement="up" label={name} />}
    </>
  );
}
