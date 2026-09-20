import { Icon, type IconName } from "@realm/ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { artifactTypeOf, documentKindFor, type ArtifactType, type Item } from "@realm/contracts";
import { useApp } from "../../state/store";
import { ScrollFades } from "../../components/ScrollFades";
import { groupByDay } from "../library/LibraryFiles";
import { DOCK_PIN_MIN_PANE, useDockDismiss, useDockPinned, usePaneRect } from "./pane-dock";
import { SummaryLightbox } from "./SessionSummary";

/**
 * The session's files, read off the disk.
 *
 * It exists because the Summary next to it cannot answer the question, and the reason is structural
 * rather than a bug: Outputs is folded out of the TRANSCRIPT, so it lists files that arrived as a
 * write-tool call and nothing else. Ask an agent to build a PDF with a Python script, or zip a
 * folder with a shell line, and the file is on disk and in neither list — which is precisely when
 * someone goes looking for it. A directory listing has no such blind spot.
 *
 * Two roots, because a session has two folders and they are different questions. THE SPACE is where
 * generated things land and is the default; the WORKSPACE is the checkout the agent is editing, and
 * is offered only when the session has one. Switching between them is one control rather than two
 * panels, because "where did that file go" is one question asked twice.
 *
 * Its chrome is the summary's chrome deliberately: same dock, same pin-or-float rule, same slot in
 * the store. Two panels docked to one edge, each measuring it and claiming it, is two panels drawn
 * over each other.
 */

/** One glyph per broad type, the Library's own table — a file reached from here and the same file
 *  reached from the Library must not wear two different marks. */
const TYPE_ICON: Record<ArtifactType, IconName> = {
  document: "documents", image: "image", video: "video", audio: "musicNote",
  data: "table", code: "code", other: "artifact",
};

export type BrowseRow = { path: string; name: string; isDir: boolean; size: number; mtimeMs: number };

/** Bytes as a person says them. Whole numbers under a megabyte: a file browser's size column is read
 *  at a glance and "1.4 KB" is no more useful than "1 KB" at that size. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** The trail of folders from the root to here, as crumbs to click back through. */
export function crumbsOf(rootLabel: string, dir: string): { label: string; dir: string }[] {
  const parts = dir ? dir.split("/").filter(Boolean) : [];
  return [{ label: rootLabel, dir: "" }, ...parts.map((p, i) => ({ label: p, dir: parts.slice(0, i + 1).join("/") }))];
}

/** The last segment of a path, for the root's own crumb. */
const baseName = (p: string): string => p.replace(/\/+$/, "").split("/").pop() || p;

export function SessionFilesHost({ item }: { item: Item }) {
  const id = item.refId;
  const open = useApp((s) => s.sessionDock[id]?.kind === "files");
  const closeSessionDock = useApp((s) => s.closeSessionDock);
  const anchor = useRef<HTMLSpanElement>(null);
  /* The pane's BAR, not the button: on a narrow pane this panel's control is a row in the ⋯ menu
     rather than a button at all, and the bar is the chrome that owns the panel either way. The
     summary resolves its own the same way, and for the same reason. */
  const barRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { barRef.current = anchor.current?.closest(".panel-bar") ?? null; });
  const [lightbox, setLightbox] = useState<string | null>(null);
  return (
    <>
      <span ref={anchor} className="panel-anchor" aria-hidden="true" />
      {open && (
        <FilesPanel item={item} anchorRef={anchor} barRef={barRef}
          onClose={() => closeSessionDock(id)} onLightbox={setLightbox} />
      )}
      {lightbox && <SummaryLightbox path={lightbox} onClose={() => setLightbox(null)} />}
    </>
  );
}

function FilesPanel({ item, anchorRef, barRef, onClose, onLightbox }: {
  item: Item;
  anchorRef: React.RefObject<HTMLElement | null>;
  barRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onLightbox: (path: string) => void;
}) {
  const id = item.refId;
  const ref = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const rect = usePaneRect(anchorRef);
  const pinned = (rect?.width ?? 0) >= DOCK_PIN_MIN_PANE;
  useDockPinned(rect, pinned);
  useDockDismiss({ pinned, onClose, keepOpenIn: [ref, barRef] });

  const spaceFolder = useApp((s) => s.spaces.find((sp) => sp.id === item.spaceId)?.folderPath ?? null);
  const environmentId = useApp((s) => s.sessions[id]?.environmentId ?? null);
  const workspace = useApp((s) => (environmentId ? s.environments[environmentId]?.path ?? null : null));
  /* A session whose checkout IS the space folder has one root, not two: offering the same directory
     under two names is a control that does nothing but ask you to wonder what the difference is. */
  const roots = useMemo(
    () => [
      spaceFolder ? { id: "space" as const, label: "Space", path: spaceFolder } : null,
      workspace && workspace !== spaceFolder ? { id: "workspace" as const, label: "Workspace", path: workspace } : null,
    ].filter((r): r is { id: "space" | "workspace"; label: string; path: string } => r !== null),
    [spaceFolder, workspace],
  );
  const [rootId, setRootId] = useState<"space" | "workspace">("space");
  const root = roots.find((r) => r.id === rootId) ?? roots[0] ?? null;
  const [dir, setDir] = useState("");
  const [rows, setRows] = useState<BrowseRow[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  /* What the session has DONE, as a number. Re-listing on it is what makes a file appear in this
     panel the moment the turn that wrote it finishes, without a watcher: the transcript growing is
     the same event as the agent having run something. */
  const beat = useApp((s) => s.transcripts[id]?.t.blocks.length ?? 0);
  const status = useApp((s) => s.sessionStatus[id]);

  const load = useCallback(async (nextDir: string) => {
    if (!root) { setRows([]); return; }
    const r = await window.realm?.files?.browse?.(root.path, nextDir);
    setRows(r?.entries ?? []);
    setTruncated(r?.truncated ?? false);
  }, [root]);

  useEffect(() => { void load(dir); }, [load, dir, beat, status]);

  const openSheet = useApp((s) => s.openSheet);
  const openDocumentPath = useApp((s) => s.openDocumentPath);
  const run = useApp((s) => s.run);
  /* The same three answers the summary gives, because a file must not open two ways depending on
     which list reached it: a picture opens in the transcript's lightbox, anything the documents pane
     can edit opens there, and everything else — a zip, a binary — opens the sheet that can hand it to
     the Finder. */
  const openRow = (row: BrowseRow) => {
    if (row.isDir) { setDir(row.path); return; }
    const abs = root ? `${root.path}/${row.path}` : row.path;
    const type = artifactTypeOf(row.name);
    if (type === "image" || type === "video") { onLightbox(abs); return; }
    if (documentKindFor(abs) === "unsupported") { openSheet({ kind: "artifact", path: abs }); onClose(); return; }
    onClose();
    run(() => openDocumentPath(abs, environmentId));
  };

  const crumbs = crumbsOf(root ? baseName(root.path) : "Files", dir);
  const days = useMemo(() => groupByDay((rows ?? []).map((r) => ({ ...r, ts: r.mtimeMs }))), [rows]);

  return createPortal(
    <div ref={ref} className="session-files pane-dock" role="dialog" aria-label={`Files for ${item.title}`} data-pinned={pinned || undefined}
      style={{ position: "fixed", right: rect?.right ?? 0, top: rect?.top ?? 0,
        "--dock-pane-h": `${rect?.height ?? window.innerHeight}px` } as React.CSSProperties}>
      <div className="summary-panel-head">
        <h3>Files</h3>
        {/* A list of a directory is a snapshot, and this one re-reads itself when the session does
            something (the transcript growing is the same event as the agent having run a command).
            What that misses is a file that arrives from anywhere else — a build still running, a
            download, another window — so there is a button, which costs one row of chrome and is the
            difference between a stale list and a wrong one. */}
        <button type="button" className="icon-btn" aria-label="Refresh this folder" title="Refresh"
          onClick={() => void load(dir)}>
          <Icon name="reload" size={12} />
        </button>
        {/* Reveal the FOLDER being shown, not a file in it: this is the control for "let me get at
            these myself", and the Finder is where that ends. */}
        {root && (
          <button type="button" className="icon-btn" aria-label="Show this folder in the Finder" title="Show in Finder"
            onClick={() => void window.realm?.files?.reveal?.(dir ? `${root.path}/${dir}` : root.path)}>
            <Icon name="folder" size={12} />
          </button>
        )}
        <button type="button" className="icon-btn" aria-label="Close files" onClick={onClose}>
          <Icon name="close" size={12} />
        </button>
      </div>

      {roots.length > 1 && (
        <div className="files-roots" role="radiogroup" aria-label="Which folder">
          {roots.map((r) => (
            <button key={r.id} type="button" className="btn files-root" role="radio" aria-checked={r.id === root?.id}
              title={r.path} onClick={() => { setRootId(r.id); setDir(""); }}>{r.label}</button>
          ))}
        </div>
      )}

      {/* The trail, and the only way back up. Every crumb but the last is a button; the last is where
          you are, which is a statement rather than a place to go. */}
      <nav className="files-crumbs" aria-label="Folder">
        {crumbs.map((c, i) => (
          i === crumbs.length - 1
            ? <span key={c.dir} className="files-crumb" aria-current="location">{c.label}</span>
            : <button key={c.dir} type="button" className="files-crumb" onClick={() => setDir(c.dir)}>{c.label}</button>
        ))}
      </nav>

      <div className="summary-scroll-wrap">
        <ScrollFades scroller={scroller} />
        <div className="summary-scroll" ref={scroller}>
          {rows === null ? (
            <p className="files-note">Reading the folder…</p>
          ) : rows.length === 0 ? (
            /* Not a bare "nothing here": the folder's own path is the fact that makes the emptiness
               useful, because half the time the answer is that the file went somewhere else. */
            <p className="files-note">Nothing in {dir || (root ? baseName(root.path) : "this folder")} yet.</p>
          ) : (
            days.map((day) => (
              <section key={day.label} className="summary-section">
                <h4 className="summary-head"><span>{day.label}</span><span className="summary-count">{day.entries.length}</span></h4>
                <div className="summary-rows">
                  {day.entries.map((row) => (
                    <button key={row.path} className="summary-row" title={row.path} onClick={() => openRow(row)}>
                      <Icon name={row.isDir ? "folder" : TYPE_ICON[artifactTypeOf(row.name)]} size={12} className="summary-row-glyph" />
                      <span className="summary-row-name">{row.name}</span>
                      <span className="summary-row-meta">{row.isDir ? "Folder" : fileSize(row.size)}</span>
                    </button>
                  ))}
                </div>
              </section>
            ))
          )}
          {truncated && <p className="files-note">Newest {rows?.length} shown — this folder holds more.</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
