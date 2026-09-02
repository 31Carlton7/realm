import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@realm/ui";
import { documentKindFor, refineDocumentKind, type DocumentEntry, type DocumentKind, type DocumentWorkspace } from "@realm/contracts";
import { rpc } from "../../rpc/client";
import { useApp } from "../../state/store";
import type { PaneProps } from "../registry";
import {
  canSave, edited, externalChange, keepMine, opened, saved, takeTheirs, writeRejected, type Buffer,
} from "./buffers";
import { PreviewFrame } from "./PreviewFrame";

/** How long the editor stays quiet before autosaving. Long enough not to write on every keystroke,
 *  short enough that an agent asked to read the file right after you stop typing sees your text. */
const AUTOSAVE_MS = 700;

const NEW_KINDS: { kind: DocumentKind; label: string; ext: string }[] = [
  { kind: "doc", label: "Document", ext: "md" },
  { kind: "sheet", label: "Spreadsheet", ext: "csv" },
  { kind: "slides", label: "Presentation", ext: "slides.md" },
  { kind: "latex", label: "LaTeX", ext: "tex" },
  // Plan 22: an interactive study guide — self-contained HTML the preview server renders.
  { kind: "html", label: "Guide", ext: "html" },
];

/** A PDF is bytes, not text: no buffer is read for it, and its tab can never be dirty. The frame
 *  streams it from the preview server instead (Plan 22). */
const isBinaryKind = (path: string): boolean => documentKindFor(path) === "pdf";

const baseName = (p: string) => p.split("/").pop() ?? p;

/**
 * The rich editor is code-split (Plan 17's bundle-weight mitigation): TipTap and ProseMirror are a
 * substantial payload, and a workspace showing a `.csv` or a `.tex` must never pay for them. The
 * import fires the first time a document is opened in rich mode, not when the pane mounts.
 */
const RichTextEditor = lazy(() => import("./RichTextEditor").then((m) => ({ default: m.RichTextEditor })));
/** Same treatment for the sheet stack: the grid + formula engine load only when a sheet is opened. */
const SheetEditor = lazy(() => import("./SheetEditor").then((m) => ({ default: m.SheetEditor })));

/**
 * The document workspace pane (Plan 17 W1): a tab strip over open files, one editor per file type.
 *
 * Tabs live HERE rather than on the layout leaf. Plan 4 removed per-leaf tabs deliberately to make the
 * sidebar the single navigation surface, and layout tabs would stack *sessions* — a different concept
 * that happens to share the word. These stack files within one workspace, and the pane still splits
 * like any other item when two documents need to be read side by side.
 */
export function DocumentsPane({ item }: PaneProps) {
  const documentsId = item.refId;
  const run = useApp((s) => s.run);
  const getDocuments = useApp((s) => s.getDocuments);
  const setDocumentTabs = useApp((s) => s.setDocumentTabs);
  const detachDocuments = useApp((s) => s.detachDocuments);
  const readDocument = useApp((s) => s.readDocument);
  const writeDocument = useApp((s) => s.writeDocument);
  const createDocumentFile = useApp((s) => s.createDocumentFile);

  const [ws, setWs] = useState<DocumentWorkspace | null>(null);
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({});
  const [active, setActive] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "rich" for prose, "source" for the markdown behind it. Per-pane, not per-file: switching
  // documents keeps the mode the user chose.
  const [mode, setMode] = useState<"rich" | "source">("rich");

  // Buffers are read inside callbacks that must not re-subscribe on every keystroke (the file-change
  // listener especially — re-registering it per edit would drop events fired mid-render).
  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;
  const activeRef = useRef(active);
  activeRef.current = active;

  const setBuffer = useCallback((path: string, fn: (b: Buffer) => Buffer) => {
    setBuffers((prev) => {
      const cur = prev[path];
      return cur ? { ...prev, [path]: fn(cur) } : prev;
    });
  }, []);

  // ---- load the workspace and reopen its persisted tabs -----------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const row = await getDocuments(documentsId);
        if (cancelled) return;
        setWs(row);
        setActive(row.activePath);
        for (const path of row.openPaths) {
          try {
            if (isBinaryKind(path)) { setBuffers((prev) => ({ ...prev, [path]: opened(path, "", "") })); continue; }
            const { text, hash } = await readDocument(documentsId, path);
            if (cancelled) return;
            setBuffers((prev) => ({ ...prev, [path]: opened(path, text, hash) }));
          } catch {
            // A tab whose file has since been deleted or grown too large: drop it rather than
            // failing the whole pane. The next setTabs prunes it from the strip for good.
          }
        }
      } catch (e) { if (!cancelled) setError(String(e)); }
    })();
    return () => { cancelled = true; };
  }, [getDocuments, readDocument, documentsId]);

  // ---- release watches when the pane unmounts ---------------------------------------------------
  // Closing a pane is layout-only (Plan 4), so the tab strip must survive it — `detach` drops the
  // server's filesystem watches without touching the persisted tabs.
  useEffect(() => () => { void detachDocuments(documentsId).catch(() => {}); }, [detachDocuments, documentsId]);

  // ---- live reload -------------------------------------------------------------------------------
  useEffect(() => {
    if (!ws) return;
    const off = rpc().on("documents.fileChanged", ({ environmentId, path, hash }) => {
      if (environmentId !== ws.environmentId) return;
      if (!buffersRef.current[path]) return; // a file this pane does not have open
      if (hash === null) { setBuffer(path, (b) => externalChange(b, null, null)); return; }
      // The event carries only a hash; the text is fetched so a clean buffer can adopt it and a
      // dirty one can show a real diff rather than "something changed".
      void readDocument(documentsId, path)
        .then(({ text, hash: h }: { text: string; hash: string }) => setBuffer(path, (b) => externalChange(b, text, h)))
        .catch(() => {});
    });
    return off;
  }, [readDocument, documentsId, ws, setBuffer]);

  // ---- persist the tab strip ---------------------------------------------------------------------
  const persistTabs = useCallback((paths: string[], activePath: string | null) => {
    run(async () => { const row = await setDocumentTabs(documentsId, paths, activePath); setWs(row); });
  }, [setDocumentTabs, documentsId, run]);

  const openPath = useCallback(async (path: string) => {
    setPicking(false);
    if (!buffersRef.current[path]) {
      if (isBinaryKind(path)) {
        setBuffers((prev) => ({ ...prev, [path]: opened(path, "", "") }));
      } else {
        const { text, hash } = await readDocument(documentsId, path);
        setBuffers((prev) => ({ ...prev, [path]: opened(path, text, hash) }));
      }
    }
    setActive(path);
    const paths = [...new Set([...Object.keys(buffersRef.current), path])];
    persistTabs(paths, path);
  }, [readDocument, documentsId, persistTabs]);

  // ---- open requests (Plan 22) -------------------------------------------------------------------
  // `documents.openPath` ran for this workspace — the user's "open this lecture", or an agent's
  // `docs_open`. The server already put the path on the persisted strip; a MOUNTED pane has to
  // open the tab itself, since it only reads the strip at mount.
  useEffect(() => {
    const off = rpc().on("documents.openRequested", ({ documentsId: id, path }) => {
      if (id !== documentsId) return;
      run(() => openPath(path));
    });
    return off;
  }, [documentsId, openPath, run]);

  const closeTab = useCallback((path: string) => {
    setBuffers((prev) => { const { [path]: _gone, ...rest } = prev; return rest; });
    const remaining = Object.keys(buffersRef.current).filter((p) => p !== path);
    const nextActive = activeRef.current === path ? (remaining[0] ?? null) : activeRef.current;
    setActive(nextActive);
    persistTabs(remaining, nextActive);
  }, [persistTabs]);

  // ---- autosave ----------------------------------------------------------------------------------
  const save = useCallback(async (path: string) => {
    const b = buffersRef.current[path];
    if (!b || !canSave(b)) return;
    const res = await writeDocument(documentsId, path, b.text, b.baseHash);
    if (res.ok) setBuffer(path, (cur) => (cur.text === b.text ? saved(cur, res.hash) : cur));
    else setBuffer(path, (cur) => writeRejected(cur, res.currentText, res.currentHash));
  }, [writeDocument, documentsId, setBuffer]);

  const buf = active ? buffers[active] : undefined;
  const dirtyKey = buf && canSave(buf) ? `${buf.path}:${buf.text.length}:${buf.text}` : null;
  useEffect(() => {
    if (!active || dirtyKey === null) return;
    const t = setTimeout(() => { void save(active); }, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [active, dirtyKey, save]);

  const kind = useMemo(() => {
    if (!buf) return "unsupported" as DocumentKind;
    return refineDocumentKind(documentKindFor(buf.path), buf.text);
  }, [buf]);

  const tabs = Object.keys(buffers);

  return (
    <div className="documents-pane">
      <TabStrip
        tabs={tabs} active={active} buffers={buffers}
        onSelect={(p) => { setActive(p); persistTabs(tabs, p); }}
        onClose={closeTab}
        onNew={() => setPicking((v) => !v)}
        picking={picking}
      />

      {picking && (
        <FilePicker
          documentsId={documentsId}
          onOpen={(p) => run(() => openPath(p))}
          onCreate={(path, k, title) => run(async () => {
            await createDocumentFile(documentsId, path, k, title);
            await openPath(path);
          })}
          onDismiss={() => setPicking(false)}
        />
      )}

      {error && <div className="documents-error">{error}</div>}

      {!buf && !picking && (
        <div className="pane-placeholder muted">
          No document open. Use <strong>+</strong> to open or create one.
        </div>
      )}

      {buf && (
        <>
          {buf.conflict && (
            <ConflictBar
              onKeepMine={() => { setBuffer(buf.path, keepMine); void save(buf.path); }}
              onTakeTheirs={() => setBuffer(buf.path, takeTheirs)}
            />
          )}
          {buf.missing && !buf.conflict && (
            <div className="documents-bar warn" role="status">
              This file was deleted on disk. Saving will re-create it.
            </div>
          )}
          <Editor
            buffer={buf} kind={kind} mode={mode} documentsId={documentsId}
            onSetMode={setMode}
            onChange={(text) => setBuffer(buf.path, (b) => edited(b, text))}
          />
          <StatusStrip buffer={buf} kind={kind} />
        </>
      )}
    </div>
  );
}

function TabStrip({ tabs, active, buffers, onSelect, onClose, onNew, picking }: {
  tabs: string[]; active: string | null; buffers: Record<string, Buffer>;
  onSelect: (p: string) => void; onClose: (p: string) => void; onNew: () => void; picking: boolean;
}) {
  return (
    <div className="documents-tabs" role="tablist" aria-label="Open documents">
      {tabs.map((path) => {
        const b = buffers[path];
        return (
          <div key={path} className="documents-tab" role="tab" aria-selected={path === active}
            data-active={path === active || undefined}>
            <button className="documents-tab-label" onClick={() => onSelect(path)} title={path}>
              <Icon name={iconFor(path)} size={12} />
              <span>{baseName(path)}</span>
              {/* One dot for "not yet on disk", so the tab strip answers "is my work saved?" at a
                  glance. A conflicted tab is marked differently — it needs a decision, not a wait. */}
              {b?.conflict ? <span className="documents-dot conflict" aria-label="Needs attention" />
                : b?.dirty ? <span className="documents-dot" aria-label="Unsaved" /> : null}
            </button>
            <button className="documents-tab-close icon-btn" aria-label={`Close ${baseName(path)}`}
              onClick={() => onClose(path)}><Icon name="close" size={11} /></button>
          </div>
        );
      })}
      <button className="icon-btn documents-new" aria-label="Open or create a document"
        aria-expanded={picking} title="Open or create" onClick={onNew}><Icon name="add" size={13} /></button>
    </div>
  );
}

function iconFor(path: string): "artifact" | "documents" | "code" | "browser" {
  const k = documentKindFor(path);
  return k === "sheet" ? "code" : k === "html" ? "browser" : k === "unsupported" || k === "pdf" ? "artifact" : "documents";
}

function ConflictBar({ onKeepMine, onTakeTheirs }: { onKeepMine: () => void; onTakeTheirs: () => void }) {
  return (
    <div className="documents-bar conflict" role="alert">
      <span>This file changed on disk while you were editing.</span>
      <button className="documents-bar-action" onClick={onKeepMine}>Keep mine</button>
      <button className="documents-bar-action" onClick={onTakeTheirs}>Take theirs</button>
    </div>
  );
}

/**
 * The editor host. W2 adds the rich Markdown editor for `doc` and `slides`; the source view remains for
 * every kind and is the only view for `sheet` and `latex` until W3 and W5 replace it.
 */
function Editor({ buffer, kind, mode, documentsId, onChange, onSetMode }: {
  buffer: Buffer; kind: DocumentKind; mode: "rich" | "source"; documentsId: string;
  onChange: (text: string) => void; onSetMode: (m: "rich" | "source") => void;
}) {
  // Which kinds have a structured view, and what it is. "Rich"/"Grid"/"Preview" is the same toggle
  // either way: every kind keeps Source as the always-available other half — except a PDF, which
  // has no text to show and is preview-only (Plan 22).
  const structured = kind === "doc" || kind === "slides" ? "rich" : kind === "sheet" ? "grid" : kind === "html" ? "preview" : kind === "pdf" ? "pdf" : null;
  const showStructured = structured !== null && (mode === "rich" || structured === "pdf");
  const label = structured === "grid" ? "Grid" : structured === "preview" ? "Preview" : "Rich";
  return (
    <div className="documents-editor" data-kind={kind}>
      <div className="documents-toolbar">
        <span className="documents-kind muted">{kind}</span>
        {structured && structured !== "pdf" && (
          <span className="documents-modes" role="group" aria-label="Editor mode">
            <button aria-pressed={mode === "rich"} onClick={() => onSetMode("rich")}>{label}</button>
            <button aria-pressed={mode === "source"} onClick={() => onSetMode("source")}>Source</button>
          </span>
        )}
      </div>
      <div className="documents-surface">
        {showStructured && (structured === "preview" || structured === "pdf") ? (
          // The frame reloads on the DISK hash: while the user edits the source, the preview keeps
          // showing the last saved version, and the autosave tick (or an agent's write) refreshes it.
          <PreviewFrame key={buffer.path} documentsId={documentsId} path={buffer.path}
            kind={structured === "pdf" ? "pdf" : "html"} version={buffer.baseHash} />
        ) : showStructured ? (
          <Suspense fallback={<div className="pane-placeholder muted">Loading editor…</div>}>
            {/* Keyed by path so switching documents remounts the editor rather than diffing one
                document's editor state onto another's. */}
            {structured === "grid"
              ? <SheetEditor key={buffer.path} path={buffer.path} text={buffer.text} onChange={onChange} />
              : <RichTextEditor key={buffer.path} text={buffer.text} onChange={onChange} />}
          </Suspense>
        ) : (
          <textarea className="documents-source" value={buffer.text} spellCheck={false}
            aria-label={`Edit ${baseName(buffer.path)}`} onChange={(e) => onChange(e.target.value)} />
        )}
      </div>
    </div>
  );
}

function StatusStrip({ buffer, kind }: { buffer: Buffer; kind: DocumentKind }) {
  const state = buffer.conflict ? "Needs a decision"
    : buffer.missing ? "Deleted on disk"
    : buffer.dirty ? "Saving…"
    : "Saved";
  return (
    <div className="documents-status">
      <span className="muted">{buffer.path}</span>
      <span className="documents-status-state" data-state={buffer.conflict ? "conflict" : buffer.dirty ? "dirty" : "clean"}>{state}</span>
      <span className="muted">{kind}</span>
    </div>
  );
}

/** Open an existing file or start a new one. A flat directory browser, not a tree: the pane opens
 *  documents, it is not a file manager. */
function FilePicker({ documentsId, onOpen, onCreate, onDismiss }: {
  documentsId: string;
  onOpen: (path: string) => void;
  onCreate: (path: string, kind: DocumentKind, title: string) => void;
  onDismiss: () => void;
}) {
  const listDocumentEntries = useApp((s) => s.listDocumentEntries);
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<DocumentEntry[]>([]);
  const [name, setName] = useState("");

  useEffect(() => {
    let cancelled = false;
    void listDocumentEntries(documentsId, dir)
      .then((e: DocumentEntry[]) => { if (!cancelled) setEntries(e); })
      .catch(() => { if (!cancelled) setEntries([]); });
    return () => { cancelled = true; };
  }, [listDocumentEntries, documentsId, dir]);

  const parent = dir ? dir.split("/").slice(0, -1).join("/") : null;
  return (
    <div className="documents-picker">
      <div className="documents-picker-head">
        <span className="muted">{dir || "/"}</span>
        <button className="icon-btn" aria-label="Close picker" onClick={onDismiss}><Icon name="close" size={12} /></button>
      </div>

      <div className="documents-picker-new">
        <input value={name} placeholder="New document name…" aria-label="New document name"
          onChange={(e) => setName(e.target.value)} />
        {NEW_KINDS.map(({ kind, label, ext }) => (
          <button key={kind} disabled={!name.trim()} onClick={() => {
            const title = name.trim();
            onCreate(dir ? `${dir}/${title}.${ext}` : `${title}.${ext}`, kind, title);
            setName("");
          }}>{label}</button>
        ))}
      </div>

      <ul className="documents-picker-list">
        {parent !== null && (
          <li><button onClick={() => setDir(parent)}>../</button></li>
        )}
        {entries.map((e) => (
          <li key={e.path}>
            <button
              // An unsupported file is listed but not openable — the picker tells the truth about
              // what is there rather than hiding it and leaving the user wondering.
              disabled={!e.isDir && documentKindFor(e.path) === "unsupported"}
              onClick={() => (e.isDir ? setDir(e.path) : onOpen(e.path))}>
              <Icon name={e.isDir ? "folder" : iconFor(e.path)} size={12} />
              {e.name}{e.isDir ? "/" : ""}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
