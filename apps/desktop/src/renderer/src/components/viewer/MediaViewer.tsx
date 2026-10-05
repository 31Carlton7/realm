import { Icon } from "@realm/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { basenameOf, formatAttachmentSize, isOpenableArtifact, isOpenablePath } from "@realm/contracts";
import { useApp } from "../../state/store";
import { ownerOf, type FileProvenance, type ViewerState } from "../../state/viewer";
import { Menu, type MenuItem } from "../Menu";
import { canQuickLook, canShare, quickLook, shareFile } from "../file-actions";
import { ViewerChat } from "./ViewerChat";
import { ViewerStage, typingIn } from "./ViewerStage";

/** What main said about the file on show. `null` is "not there"; facts of null are a renderer with no
 *  bridge to ask, which shows the file rather than calling it gone. */
type Facts = { size: number | null; mtimeMs: number | null } | null;

/**
 * The media viewer: one file, over the whole window, with the session's prompter docked under it.
 *
 * The one place a file is looked at. A picture in a message, a chip in the prompter, a tile in the
 * Library, a row of the documents pane's home, a session's summary and its file browser all open
 * here, and the same file reached from any of them is the same view with the same actions — the
 * lightbox and the preview sheet this replaces were two answers to one question.
 *
 * A portal to `document.body`, over everything but the toasts and menus: a pane's stacking context
 * would clip it. While it is up the transcript's own video frames are hidden, because Chromium paints
 * a video layer over any overlay however it is stacked (`data-media-viewer`, styles.css), and every
 * browser pane's native view steps out of the way the way it does for a page (`shouldShowView`).
 */
export function MediaViewer() {
  const viewer = useApp((s) => s.viewer);
  if (!viewer) return null;
  return <ViewerWindow viewer={viewer} />;
}

function ViewerWindow({ viewer }: { viewer: ViewerState }) {
  const file = viewer.files[viewer.index]!;
  const name = file.name ?? basenameOf(file.path);
  const count = viewer.files.length;
  const closeViewer = useApp((s) => s.closeViewer);
  const stepViewer = useApp((s) => s.stepViewer);
  const ref = useRef<HTMLDivElement>(null);

  /* Focus goes into the prompter, so a question can be typed at once — the viewer is a quick chat
     about the file as much as a look at it — and back to the control that opened it on the way out,
     which in a long transcript is nowhere near the top of the document. */
  const opener = useRef(viewer.opener);
  useEffect(() => {
    (ref.current?.querySelector<HTMLElement>("textarea.composer-input") ?? ref.current)?.focus();
    document.body.dataset["mediaViewer"] = "";
    // A playing video goes on playing behind an overlay, and its sound does not care that it cannot be seen.
    for (const v of Array.from(document.querySelectorAll<HTMLVideoElement>(".app video"))) v.pause();
    const back = opener.current;
    return () => {
      delete document.body.dataset["mediaViewer"];
      if (back?.isConnected) back.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = ref.current; if (!root) return;
      if (e.key === "Escape") {
        /* A menu or a picker open from inside answers its own Escape: both listen on the window, and
           this one, registered first, would otherwise close the viewer under it (design.md: Escape
           answers in mount order). Capture, so it is caught before a request card in the exchange
           could take it as Deny — here Escape is the way out and never an answer. */
        if (root.querySelector('[aria-haspopup]:not([aria-haspopup="false"])[aria-expanded="true"]')) return;
        e.preventDefault(); e.stopPropagation(); closeViewer(); return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      /* The arrows walk the files unless something is reading them: a field with text in it moves its
         caret, the scrubber seeks. The prompter starts empty and focused, so from the first frame they
         walk — and stop the moment there is a word to edit. */
      const t = e.target;
      const emptyPrompter = t instanceof HTMLTextAreaElement && t.value === "" && t.closest(".media-viewer-chat") !== null;
      if (typingIn(t) && !emptyPrompter) return;
      e.preventDefault();
      stepViewer(e.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [closeViewer, stepViewer]);

  /* What is on disk, asked again whenever a turn of the exchange ends: an agent rewriting the file in
     place moves its modification time, and that is the version the stage reads. */
  const [beat, setBeat] = useState(0);
  const settled = useCallback(() => setBeat((n) => n + 1), []);
  const facts = useFacts(file.path, beat);

  return createPortal(
    <div ref={ref} className="media-viewer" role="dialog" aria-modal="true" aria-label={name} tabIndex={-1}>
      <ViewerHead viewer={viewer} facts={facts} onClose={closeViewer} />
      <div className="media-viewer-body">
        <div className="media-viewer-stagewrap">
          {facts !== undefined && (
            <ViewerStage key={file.path} file={file} gone={facts === null} version={facts?.mtimeMs ?? null} onBackdrop={closeViewer} />
          )}
          {count > 1 && (
            <>
              <button type="button" className="media-viewer-step" data-dir="prev" aria-label="Previous file" title="Previous (←)"
                disabled={viewer.index === 0} onClick={() => stepViewer(-1)}>
                <Icon name="chevronLeft" size={16} />
              </button>
              <button type="button" className="media-viewer-step" data-dir="next" aria-label="Next file" title="Next (→)"
                disabled={viewer.index === count - 1} onClick={() => stepViewer(1)}>
                <Icon name="chevronRight" size={16} />
              </button>
            </>
          )}
        </div>
        <ViewerChat viewer={viewer} file={file} size={facts ? facts.size ?? 0 : null} onSettled={settled} />
      </div>
    </div>,
    document.body,
  );
}

/** The file's size and modification time, or null when it is not on disk. Undefined while asked:
 *  collapsing that into null would flash "no longer on disk" over every file for one stat. */
function useFacts(path: string, beat: number): Facts | undefined {
  const [facts, setFacts] = useState<{ path: string; facts: Facts } | null>(null);
  useEffect(() => {
    let live = true;
    const stat = window.realm?.files?.stat;
    if (!stat) { setFacts({ path, facts: { size: null, mtimeMs: null } }); return; }
    void stat(path).catch(() => null).then((s) => {
      if (live) setFacts({ path, facts: s ? { size: s.size, mtimeMs: s.mtimeMs } : null });
    });
    return () => { live = false; };
  }, [path, beat]);
  return facts && facts.path === path ? facts.facts : undefined;
}

/**
 * The file's name and what Realm can do with it: open it in the documents pane, reveal it in the
 * Finder, save a copy, and the rest behind ⋯ — each drawn only where it would work. A file that is no
 * longer on disk gets none of them, only the way out: three buttons that fail in turn are a worse way
 * to learn it is gone than the sentence on the stage.
 */
function ViewerHead({ viewer, facts, onClose }: { viewer: ViewerState; facts: Facts | undefined; onClose: () => void }) {
  const file = viewer.files[viewer.index]!;
  const name = file.name ?? basenameOf(file.path);
  const sessions = useApp((s) => s.sessions);
  const sessionSpace = useApp((s) => s.sessionSpace);
  const openDocumentPath = useApp((s) => s.openDocumentPath);
  const run = useApp((s) => s.run);
  const ownerId = ownerOf(viewer, file, (id) => sessions[id] !== undefined || id in sessionSpace);
  const environmentId = ownerId ? sessions[ownerId]?.environmentId ?? null : null;
  const [menuOpen, setMenuOpen] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const finderIcon = useFinderIcon();

  const gone = facts === null;
  // The documents pane's own answer, which is what makes "Open" mean one thing across the app.
  const inPane = file.inPane ?? isOpenableArtifact(file.path);
  // macOS `open` RUNS an `.app` or a `.command`, so handing a file over stays behind the mime table.
  const toOs = isOpenablePath(file.path);
  const openInPane = () => { onClose(); run(() => openDocumentPath(file.path, environmentId)); };
  const toApp = () => { void window.realm?.openAttachment?.(file.path); };

  const items: MenuItem[] = [
    ...(canQuickLook() ? [{ label: "Quick Look", kbd: "Space", onSelect: () => quickLook(file.path) } as MenuItem] : []),
    ...(canShare() ? [{ label: "Share…", onSelect: () => shareFile(file.path, more.current) } as MenuItem] : []),
    ...(canQuickLook() || canShare() ? [{ kind: "separator" } as MenuItem] : []),
    // Beside the pane, not instead of it: "open it in the app I edit pictures in" is its own request.
    ...(toOs && inPane ? [{ label: "Open with the default app", onSelect: toApp } as MenuItem] : []),
    { label: "Copy path", onSelect: () => { void navigator.clipboard?.writeText?.(file.path); } },
  ];

  return (
    <header className="media-viewer-head">
      <div className="media-viewer-title">
        <span className="media-viewer-name" title={file.path}>{name}</span>
        {viewer.files.length > 1 && <span className="media-viewer-count">{viewer.index + 1} of {viewer.files.length}</span>}
        {facts?.size != null && <span className="media-viewer-detail">{formatAttachmentSize(facts.size)}</span>}
        {file.from && <Provenance from={file.from} onLeave={onClose} />}
      </div>
      <div className="media-viewer-actions">
        {!gone && facts !== undefined && (
          <>
            {inPane && (
              <button type="button" className="icon-btn" aria-label="Open in the documents pane" title="Open in the documents pane" onClick={openInPane}>
                <Icon name="documents" size={14} />
              </button>
            )}
            {toOs && !inPane && (
              <button type="button" className="icon-btn" aria-label="Open with the default app" title="Open with the default app" onClick={toApp}>
                <Icon name="focusPane" size={14} />
              </button>
            )}
            {/* Finder's own icon, read off this machine; Realm's folder until it arrives, and for good
                on a machine that cannot read it — the control never waits on a picture. */}
            <button type="button" className="icon-btn" aria-label="Reveal in Finder" title="Reveal in Finder"
              onClick={() => { void window.realm?.files?.reveal?.(file.path); }}>
              {finderIcon ? <img className="media-viewer-finder" src={finderIcon} alt="" draggable={false} /> : <Icon name="folder" size={14} />}
            </button>
            <button type="button" className="icon-btn" aria-label="Save a copy…" title="Save a copy…"
              onClick={() => { void window.realm?.files?.saveCopy?.(file.path); }}>
              <Icon name="download" size={14} />
            </button>
            <button ref={more} type="button" className="icon-btn" aria-label="More actions" title="More actions"
              aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
              <Icon name="more" size={14} />
            </button>
          </>
        )}
        <button type="button" className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      {menuOpen && <Menu items={items} anchorRef={more} align="right" onClose={() => setMenuOpen(false)} label={name} />}
    </header>
  );
}

/** Where a Library file came from, as the one line the Library knows. A session Realm can still reach
 *  is a way to it; a deleted one is named, not offered — a jump that lands on nothing is a worse way
 *  to learn it is gone than the sentence. */
function Provenance({ from, onLeave }: { from: FileProvenance; onLeave: () => void }) {
  const sessionSpace = useApp((s) => s.sessionSpace);
  const revealSession = useApp((s) => s.revealSession);
  const run = useApp((s) => s.run);
  const said = `${from.kind === "upload" ? "Uploaded to " : "Made in "}${from.sessionTitle}`;
  if (!(from.sessionId in sessionSpace)) return <span className="media-viewer-from">{said} — that session is gone.</span>;
  return (
    <button type="button" className="btn-quiet media-viewer-from" onClick={() => { onLeave(); run(() => revealSession(from.sessionId, from.spaceId)); }}>
      {said}
    </button>
  );
}

/** Finder's icon as a data URL, read once per launch in main. Null until it arrives, or for good. */
function useFinderIcon(): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (window.realm?.files?.finderIcon?.() ?? Promise.resolve(null)).catch(() => null).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, []);
  return url;
}
