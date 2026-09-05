import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@realm/ui";
import {
  documentExtension, documentKindFor, documentStem, freeFileName, refineDocumentKind,
  type DocumentEntry, type DocumentKind, type DocumentWorkspace,
} from "@realm/contracts";
import { rpc } from "../../rpc/client";
import { useApp } from "../../state/store";
import { Menu, type MenuItem } from "../../components/Menu";
import type { PaneProps } from "../registry";
import {
  canSave, edited, externalChange, keepMine, opened, saved, takeTheirs, writeRejected, type Buffer,
} from "./buffers";
import { PreviewFrame } from "./PreviewFrame";

/** How long the editor stays quiet before autosaving. Long enough not to write on every keystroke,
 *  short enough that an agent asked to read the file right after you stop typing sees your text. */
const AUTOSAVE_MS = 700;

/**
 * What "+" offers. `menu` and `stem` are written out rather than derived from one another, because
 * the one case where a rule would have been tidy — lowercasing the menu word to build the stem — is
 * the case that gets it wrong: "LaTeX" is not "latex".
 */
const NEW_KINDS: { kind: DocumentKind; menu: string; stem: string; ext: string }[] = [
  { kind: "doc", menu: "New document", stem: "Untitled document", ext: "md" },
  { kind: "sheet", menu: "New spreadsheet", stem: "Untitled spreadsheet", ext: "csv" },
  { kind: "slides", menu: "New presentation", stem: "Untitled presentation", ext: "slides.md" },
  { kind: "latex", menu: "New LaTeX", stem: "Untitled LaTeX", ext: "tex" },
  // Plan 22: an interactive study guide — self-contained HTML the preview server renders.
  { kind: "html", menu: "New guide", stem: "Untitled guide", ext: "html" },
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
  const renameDocumentFile = useApp((s) => s.renameDocumentFile);
  const listDocumentEntries = useApp((s) => s.listDocumentEntries);

  const [ws, setWs] = useState<DocumentWorkspace | null>(null);
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({});
  const [active, setActive] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  /** The head bar's name field is open. Set by a click on the name, and by creating a document —
   *  which is the whole point: the file exists first, and naming it is the next optional keystroke. */
  const [renaming, setRenaming] = useState(false);
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

  // ---- create ------------------------------------------------------------------------------------
  // Named AFTERWARDS, not before. The old flow made the first thing you did in a new document a form
  // field for a file that did not exist yet — and the name is the one thing you rarely know at that
  // moment. So the file is created under "Untitled <kind>", opened, and its title left focused and
  // selected in the head bar: type over it, or ignore it and start writing.
  const createNew = useCallback((kind: DocumentKind, ext: string, stem: string) => run(async () => {
    const entries = await listDocumentEntries(documentsId, "").catch(() => [] as DocumentEntry[]);
    const path = freeFileName(stem, ext, entries.filter((e) => !e.isDir).map((e) => e.name));
    await createDocumentFile(documentsId, path, kind, documentStem(path));
    await openPath(path);
    setRenaming(true);
  }), [run, listDocumentEntries, createDocumentFile, documentsId, openPath]);

  // ---- rename ------------------------------------------------------------------------------------
  // The extension is never the user's to type: they edit a NAME, and the kind is already decided.
  // Keeping it out of the field is also what stops a rename from silently changing a document into a
  // spreadsheet by way of a typo.
  const renameActive = useCallback((from: string, stem: string) => run(async () => {
    const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
    const ext = documentExtension(from);
    const to = `${dir}${stem.trim()}${ext ? `.${ext}` : ""}`;
    if (!stem.trim() || to === from) return;
    const { path } = await renameDocumentFile(documentsId, from, to);
    // The server has already moved the persisted tab; this moves the pane's live buffer to match, so
    // the open editor keeps its text and its baseHash rather than reloading from disk.
    setBuffers((prev) => {
      const b = prev[from];
      if (!b) return prev;
      const { [from]: _gone, ...rest } = prev;
      return { ...rest, [path]: { ...b, path } };
    });
    setActive((cur) => (cur === from ? path : cur));
  }), [run, renameDocumentFile, documentsId]);

  return (
    <div className="documents-pane">
      {/* The picker hangs off the strip rather than off the pane, so "just below the tabs" is a
          layout fact rather than a pixel constant that drifts the moment a tab gets taller. */}
      <div className="documents-topbar">
        <TabStrip
          tabs={tabs} active={active} buffers={buffers}
          onSelect={(p) => { setRenaming(false); setActive(p); persistTabs(tabs, p); }}
          onClose={closeTab}
          onNew={createNew}
          onOpenExisting={() => setPicking(true)}
        />
        {picking && (
          <FilePicker
            documentsId={documentsId}
            onOpen={(p) => run(() => openPath(p))}
            onDismiss={() => setPicking(false)}
          />
        )}
      </div>

      {error && <div className="documents-error">{error}</div>}

      {!buf && !picking && (
        <div className="pane-placeholder muted">
          <p>Nothing open yet.</p>
          <NewMenuButton onNew={createNew} onOpenExisting={() => setPicking(true)} variant="btn" />
        </div>
      )}

      {buf && (
        <>
          <DocumentHead
            buffer={buf} kind={kind} mode={mode} onSetMode={setMode}
            renaming={renaming} onRenaming={setRenaming}
            onRename={(stem) => renameActive(buf.path, stem)}
          />
          {buf.conflict && (
            <ConflictBar
              onKeepMine={() => { setBuffer(buf.path, keepMine); void save(buf.path); }}
              onTakeTheirs={() => setBuffer(buf.path, takeTheirs)}
            />
          )}
          {buf.missing && !buf.conflict && (
            // `alert`, not `status`: the head bar already carries the save state as this pane's one
            // polite status, and a file vanishing under an open editor is not a polite update.
            <div className="documents-bar warn" role="alert">
              <Icon name="alert" size={12} />
              <span>This file was deleted on disk. Saving will re-create it.</span>
            </div>
          )}
          <Editor
            buffer={buf} kind={kind} mode={mode} documentsId={documentsId}
            onChange={(text) => setBuffer(buf.path, (b) => edited(b, text))}
          />
        </>
      )}
    </div>
  );
}

type NewHandler = (kind: DocumentKind, ext: string, stem: string) => void;

/**
 * "+" — one menu, five kinds, and "Open a file…".
 *
 * The old row was an input the buttons were disabled behind: five greyed-out kinds until you typed a
 * name, in a panel that was also a directory browser. Picking a kind is the only decision that has to
 * be made up front (it decides the template and the editor), so it is the only one this asks.
 */
function NewMenuButton({ onNew, onOpenExisting, variant = "icon" }: {
  onNew: NewHandler; onOpenExisting: () => void; variant?: "icon" | "btn";
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const items: MenuItem[] = [
    ...NEW_KINDS.map(({ kind, menu, stem, ext }) => ({
      label: <><Icon name={iconForKind(kind)} size={14} />{menu}</>,
      onSelect: () => onNew(kind, ext, stem),
    })),
    { kind: "separator" as const },
    { label: <><Icon name="folder" size={14} />Open a file…</>, onSelect: onOpenExisting },
  ];
  return (
    <>
      <button ref={ref} type="button" aria-haspopup="menu" aria-expanded={open}
        className={variant === "btn" ? "btn primary" : "icon-btn documents-new"}
        // Two openers for one menu, so they must not share a name: the strip's "+" is always there,
        // the empty state's is the page's one call to action.
        aria-label={variant === "btn" ? undefined : "Add a document"}
        title={variant === "btn" ? undefined : "Add a document"}
        onClick={() => setOpen((v) => !v)}>
        <Icon name="add" size={variant === "btn" ? 14 : 13} />
        {variant === "btn" && "New document"}
      </button>
      {open && <Menu items={items} anchorRef={ref} onClose={() => setOpen(false)} label="Add a document" />}
    </>
  );
}

function TabStrip({ tabs, active, buffers, onSelect, onClose, onNew, onOpenExisting }: {
  tabs: string[]; active: string | null; buffers: Record<string, Buffer>;
  onSelect: (p: string) => void; onClose: (p: string) => void;
  onNew: NewHandler; onOpenExisting: () => void;
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
              <span>{documentStem(path)}</span>
              {/* One dot for "not yet on disk", so the tab strip answers "is my work saved?" at a
                  glance. A conflicted tab is marked differently — it needs a decision, not a wait. */}
              {b?.conflict ? <span className="documents-dot conflict" aria-label="Needs attention" />
                : b?.dirty ? <span className="documents-dot" aria-label="Unsaved" /> : null}
            </button>
            <button className="documents-tab-close icon-btn" aria-label={`Close ${baseName(path)}`}
              onClick={() => onClose(path)}><Icon name="close" size={12} /></button>
          </div>
        );
      })}
      <NewMenuButton onNew={onNew} onOpenExisting={onOpenExisting} />
    </div>
  );
}

/**
 * The document's own bar: its NAME, editable in place, plus the view toggle and whether it is saved.
 *
 * This replaces a toolbar that said "doc" and a status strip that repeated the full path and the kind
 * a third time. What a person actually wants from a document's chrome is the name (and the ability to
 * change it) and the answer to "is my work safe" — so that is what is here, and nothing else.
 */
function DocumentHead({ buffer, kind, mode, onSetMode, renaming, onRenaming, onRename }: {
  buffer: Buffer; kind: DocumentKind; mode: "rich" | "source"; onSetMode: (m: "rich" | "source") => void;
  renaming: boolean; onRenaming: (v: boolean) => void; onRename: (stem: string) => void;
}) {
  const structured = structuredViewFor(kind);
  const state = buffer.conflict ? "conflict" : buffer.missing ? "missing" : buffer.dirty ? "dirty" : "clean";
  const stateLabel = { conflict: "Needs a decision", missing: "Deleted on disk", dirty: "Saving…", clean: "Saved" }[state];
  return (
    <div className="documents-head">
      <Icon name={iconFor(buffer.path)} size={14} className="documents-head-glyph" />
      {renaming
        // Keyed by PATH. The field seeds its value once, on mount, and the active document can change
        // underneath an open field — creating a second document does exactly that. Unkeyed, the field
        // kept the previous document's name, and the next blur committed it onto the new one: a
        // spreadsheet created straight after a document was silently renamed to the document's name.
        ? <DocumentNameInput key={buffer.path} stem={documentStem(buffer.path)}
            onCommit={(s) => { onRename(s); onRenaming(false); }}
            onCancel={() => onRenaming(false)} />
        : <button type="button" className="documents-name" title={`${buffer.path} — click to rename`}
            onClick={() => onRenaming(true)}>{documentStem(buffer.path)}</button>}
      <span className="documents-state t-xs muted" data-state={state} role="status">{stateLabel}</span>
      {structured && structured !== "pdf" && (
        <span className="documents-modes" role="group" aria-label="Editor mode">
          <button type="button" aria-pressed={mode === "rich"} onClick={() => onSetMode("rich")}>{structuredLabel(structured)}</button>
          <button type="button" aria-pressed={mode === "source"} onClick={() => onSetMode("source")}>Source</button>
        </span>
      )}
    </div>
  );
}

/** Commits on Enter or blur, abandons on Escape — the same contract as the sidebar's RenameInput,
 *  which this cannot reuse because a document is a FILE, not an Item with a title column. */
function DocumentNameInput({ stem, onCommit, onCancel }: { stem: string; onCommit: (s: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(stem);
  return (
    <input className="documents-name-input" aria-label="Document name" autoFocus value={value}
      // Selected on focus, because a new document arrives here already called "Untitled document":
      // the useful first keystroke replaces that, it does not append to it.
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      // preventDefault marks Escape consumed so the global binding (interrupt) never sees it.
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); onCommit(value); }
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      }} />
  );
}

type DocIcon = "artifact" | "documents" | "table" | "browser" | "layout";

function iconForKind(k: DocumentKind): DocIcon {
  return k === "sheet" ? "table" : k === "html" ? "browser" : k === "slides" ? "layout"
    : k === "unsupported" || k === "pdf" ? "artifact" : "documents";
}
const iconFor = (path: string): DocIcon => iconForKind(documentKindFor(path));

/** Which kinds have a view other than their source, and what that view is. A PDF is the odd one: it
 *  has no text to show, so it is preview-only and gets no toggle. */
function structuredViewFor(kind: DocumentKind): "rich" | "grid" | "preview" | "pdf" | null {
  return kind === "doc" || kind === "slides" ? "rich"
    : kind === "sheet" ? "grid" : kind === "html" ? "preview" : kind === "pdf" ? "pdf" : null;
}
const structuredLabel = (v: "rich" | "grid" | "preview" | "pdf"): string =>
  v === "grid" ? "Grid" : v === "preview" ? "Preview" : v === "pdf" ? "PDF" : "Rich";

function ConflictBar({ onKeepMine, onTakeTheirs }: { onKeepMine: () => void; onTakeTheirs: () => void }) {
  return (
    <div className="documents-bar conflict" role="alert">
      <Icon name="alert" size={12} />
      <span>This file changed on disk while you were editing.</span>
      <button type="button" className="btn-quiet" onClick={onKeepMine}>Keep mine</button>
      <button type="button" className="btn-quiet" onClick={onTakeTheirs}>Take theirs</button>
    </div>
  );
}

/**
 * The editor host. W2 adds the rich Markdown editor for `doc` and `slides`; the source view remains for
 * every kind and is the only view for `sheet` and `latex` until W3 and W5 replace it.
 */
function Editor({ buffer, kind, mode, documentsId, onChange }: {
  buffer: Buffer; kind: DocumentKind; mode: "rich" | "source"; documentsId: string;
  onChange: (text: string) => void;
}) {
  // The toggle itself lives in the head bar beside the name — the editor only has to know which view
  // it is drawing. A PDF has no text, so it is preview-only regardless of the mode (Plan 22).
  const structured = structuredViewFor(kind);
  const showStructured = structured !== null && (mode === "rich" || structured === "pdf");
  return (
    <div className="documents-editor" data-kind={kind}>
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

/** Open an existing file. A flat directory browser, not a tree: the pane opens documents, it is not a
 *  file manager. Creating one is no longer this panel's job — that moved to the "+" menu, which is
 *  why the disabled-buttons-behind-a-name-field row is gone. */
function FilePicker({ documentsId, onOpen, onDismiss }: {
  documentsId: string;
  onOpen: (path: string) => void;
  onDismiss: () => void;
}) {
  const listDocumentEntries = useApp((s) => s.listDocumentEntries);
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<DocumentEntry[]>([]);

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
        <span className="t-xs muted">{dir || "/"}</span>
        <button type="button" className="icon-btn" aria-label="Close picker" onClick={onDismiss}><Icon name="close" size={12} /></button>
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
