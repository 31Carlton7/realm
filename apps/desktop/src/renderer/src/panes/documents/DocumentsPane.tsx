import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "@realm/ui";
import {
  documentExtension, documentKindFor, documentStem, freeFileName, ownerOfTab, refineDocumentKind,
  type DocumentEntry, type DocumentKind, type DocumentWorkspace,
} from "@realm/contracts";
import { rpc } from "../../rpc/client";
import { useApp } from "../../state/store";
import { useDissolve } from "../../components/ScrollFades";
import type { PaneProps } from "../registry";
import { useScrollMemory } from "../scroll-memory";
import {
  canSave, edited, externalChange, keepMine, opened, saved, takeTheirs, writeRejected, type Buffer,
} from "./buffers";
import { DocumentsHome } from "./DocumentsHome";
import { folderName, isOutsideTab, tildePath } from "./home-model";
import { NewMenu, iconFor } from "./NewMenu";
import { PreviewFrame } from "./PreviewFrame";
import { QuickLookView } from "./QuickLookView";

/** How long the editor stays quiet before autosaving. Long enough not to write on every keystroke,
 *  short enough that an agent asked to read the file right after you stop typing sees your text. */
const AUTOSAVE_MS = 700;

/** A PDF is bytes, not text: no buffer is read for it, and its tab can never be dirty. The frame
 *  streams it from the preview server instead (Plan 22). */
/** Files the pane opens WITHOUT reading their bytes: a PDF, and everything Quick Look renders for
 *  us. Both are shown by pointing a frame at the preview server, so pulling a `.docx` through
 *  `readDocument` would only produce mojibake and a failed open. */
const isBinaryKind = (path: string): boolean => {
  const k = documentKindFor(path);
  return k === "pdf" || k === "preview";
};

const baseName = (p: string) => p.split("/").pop() ?? p;

/**
 * Why a file the pane was asked to open cannot be shown, in a sentence, from the read's refusal. Said
 * in the pane, where the file was asked for — an empty editor, or a grey stage, says nothing.
 */
export function unshownReason(path: string, error: unknown): { says: string; gone: boolean } {
  const name = baseName(path);
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "NOT_FOUND" || /ENOENT|no such file/i.test(message)) return { says: `${name} is no longer on disk.`, gone: true };
  if (code === "TOO_LARGE") return { says: `${name} is too large to show here. The pane opens files up to 2 MB.`, gone: false };
  if (code === "BINARY") return { says: `${name} is not text, so the pane cannot show it.`, gone: false };
  if (code === "NOT_UTF8") return { says: `${name} is not UTF-8 text, so the pane cannot show it.`, gone: false };
  return { says: `${name} could not be read: ${message}`, gone: false };
}

/**
 * The rich editor is code-split (Plan 17's bundle-weight mitigation): TipTap and ProseMirror are a
 * substantial payload, and a workspace showing a `.csv` or a `.tex` must never pay for them. The
 * import fires the first time a document is opened in rich mode, not when the pane mounts.
 */
const RichTextEditor = lazy(() => import("./RichTextEditor").then((m) => ({ default: m.RichTextEditor })));
/** Same treatment for the sheet stack: the grid + formula engine load only when a sheet is opened. */
const SheetEditor = lazy(() => import("./SheetEditor").then((m) => ({ default: m.SheetEditor })));
/** Same treatment again: CodeMirror plus a grammar is a payload a workspace of Markdown must never
 *  pay for, and `code-modes.ts` splits the grammars one chunk further. */
const CodeEditor = lazy(() => import("./CodeEditor").then((m) => ({ default: m.CodeEditor })));

/**
 * The document workspace pane (Plan 17 W1): a tab strip over open files, one editor per file type,
 * and the home in front of them (`DocumentsHome`) — the session's files, the Library's, a search over
 * both and the checkout, and New — whenever nothing is open, and one tab-click away when something is.
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
  /** Tabs whose file was asked for and could not be read — too large, not text, gone — with why. The
   *  tab stays, saying so in the pane, rather than an error far from it and nothing where it was. */
  const [unshown, setUnshown] = useState<Record<string, { says: string; gone: boolean }>>({});
  // "rich" for prose, "source" for the markdown behind it. Per-pane, not per-file: switching
  // documents keeps the mode the user chose.
  const [mode, setMode] = useState<"rich" | "source">("rich");
  /** The home is showing while files are open — its tab was picked, or ⌘P asked for its search. With
   *  nothing open there is nothing else to show, so the home needs no flag for that. In the pane and
   *  not on the strip's row: the server keeps an open file active, and the home is a view of the pane,
   *  not a tab that outlives it. */
  const [home, setHome] = useState(false);
  /** Bumped by ⌘P for the home to take the keyboard into its search. */
  const [searchAsk, setSearchAsk] = useState(0);
  /** A line asked for from outside (`openDocumentPath(…, { line })`), for the code editor to go to. */
  const [reveal, setReveal] = useState<{ path: string; line: number } | null>(null);
  /* The session this pane serves: the one whose tab of the side panel it is. A documents pane of its
     own serves nobody — its home lists no session and offers nothing to add a file to. */
  const sessionId = useApp((s) => {
    const owner = s.layout ? ownerOfTab(s.layout, item.id) : null;
    const it = owner ? s.items.find((i) => i.id === owner) : undefined;
    return it?.kind === "session" ? it.refId : null;
  });
  const root = useApp((s) => (ws ? s.environments[ws.environmentId]?.path ?? null : null));
  const ask = useApp((s) => (s.documentsAsk?.documentsId === documentsId ? s.documentsAsk : null));
  const takeDocumentsAsk = useApp((s) => s.takeDocumentsAsk);

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
      /* A file the pane never read has nothing to re-read: its "text" is the empty string and always
         was. Adopting the event's hash directly is what makes the preview LIVE — the frame and the
         image below are keyed on `baseHash`, so an agent rewriting a PDF or a `.docx` in place
         re-renders it. Before this, a binary's hash stayed "" for the life of the tab and the view
         kept showing whatever it first loaded. */
      if (isBinaryKind(path)) { setBuffer(path, (b) => ({ ...b, baseHash: hash })); return; }
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
    setHome(false);
    if (!buffersRef.current[path]) {
      if (isBinaryKind(path)) {
        setBuffers((prev) => ({ ...prev, [path]: opened(path, "", "") }));
      } else {
        try {
          const { text, hash } = await readDocument(documentsId, path);
          setBuffers((prev) => ({ ...prev, [path]: opened(path, text, hash) }));
          setUnshown((prev) => { const { [path]: _was, ...rest } = prev; return rest; });
        } catch (e) {
          setBuffers((prev) => ({ ...prev, [path]: opened(path, "", "") }));
          setUnshown((prev) => ({ ...prev, [path]: unshownReason(path, e) }));
        }
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

  // ---- asks from outside the pane: ⌘P's search, a line to show ---------------------------------
  // Taken once the workspace has loaded, and only then: a line in a file the pane has not read yet is
  // a line in nothing, and the strip it would join is not on screen.
  useEffect(() => {
    if (!ask || !ws) return;
    takeDocumentsAsk(ask.seq);
    if ("search" in ask) { setHome(true); setSearchAsk((n) => n + 1); return; }
    const { path, line } = ask;
    run(async () => { await openPath(path); setReveal({ path, line }); });
  }, [ask, ws, takeDocumentsAsk, openPath, run]);

  const closeTab = useCallback((path: string) => {
    setBuffers((prev) => { const { [path]: _gone, ...rest } = prev; return rest; });
    setUnshown((prev) => { const { [path]: _gone, ...rest } = prev; return rest; });
    const remaining = Object.keys(buffersRef.current).filter((p) => p !== path);
    const nextActive = activeRef.current === path ? (remaining[0] ?? null) : activeRef.current;
    setActive(nextActive);
    persistTabs(remaining, nextActive);
  }, [persistTabs]);

  // ---- autosave ----------------------------------------------------------------------------------
  const save = useCallback(async (path: string) => {
    const b = buffersRef.current[path];
    // A file outside the space is read-only: nothing here writes it, whatever its buffer says.
    if (!b || !canSave(b) || isOutsideTab(path)) return;
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

  /* A file by the whole name someone typed — the code prompt's, or the home's "Create notes.md". Its
     extension already chose the editor, so the kind is read off the name rather than asked again, and
     the name field opens only for a name still called "untitled", which is a name nobody chose. */
  const createNamed = useCallback((name: string) => run(async () => {
    await createDocumentFile(documentsId, name, documentKindFor(name), documentStem(name));
    await openPath(name);
    setRenaming(/^untitled( \d+)?$/i.test(documentStem(name)));
  }), [run, createDocumentFile, documentsId, openPath]);

  /** The names already at the top of the folder, lowercased — what a new file's name is checked against. */
  const takenNames = useCallback(async (): Promise<ReadonlySet<string>> => {
    const entries = await listDocumentEntries(documentsId, "").catch(() => [] as DocumentEntry[]);
    return new Set(entries.map((e) => e.name.toLowerCase()));
  }, [listDocumentEntries, documentsId]);
  const folder = root ? folderName(root) : null;

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

  const showingHome = home || !buf;
  return (
    <div className="documents-pane">
      {/* The picker hangs off the strip rather than off the pane, so "just below the tabs" is a
          layout fact rather than a pixel constant that drifts the moment a tab gets taller. With
          nothing open there is no strip at all: the home's own head carries search and New, and a
          row of one tab would only say "Files" over the page that already is. */}
      <div className="documents-topbar">
        {tabs.length > 0 && (
          <TabStrip
            tabs={tabs} active={showingHome ? null : active} buffers={buffers} home={showingHome}
            onHome={() => { setRenaming(false); setHome(true); }}
            onSelect={(p) => { setRenaming(false); setHome(false); setActive(p); persistTabs(tabs, p); }}
            onClose={closeTab}
            menu={<NewMenu variant="strip" folder={folder} onNewKind={createNew} onNewFile={createNamed}
              onOpenExisting={() => setPicking(true)} taken={takenNames} />}
          />
        )}
        {picking && (
          <FilePicker
            documentsId={documentsId}
            onOpen={(p) => run(() => openPath(p))}
            onDismiss={() => setPicking(false)}
          />
        )}
      </div>

      {error && <div className="documents-error">{error}</div>}

      {showingHome && ws && (
        <DocumentsHome spaceId={item.spaceId} root={root} sessionId={sessionId} searchAsk={searchAsk}
          onOpen={(p) => run(() => openPath(p))} onNewKind={createNew} onNewFile={createNamed}
          onBrowse={() => setPicking(true)} taken={takenNames} />
      )}

      {buf && !showingHome && (
        <>
          <DocumentHead
            buffer={buf} kind={unshown[buf.path] ? "unsupported" : kind} mode={mode} onSetMode={setMode}
            renaming={renaming} onRenaming={setRenaming}
            onRename={(stem) => renameActive(buf.path, stem)}
          />
          {isOutsideTab(buf.path) && !unshown[buf.path] && <OutsideNote path={buf.path} />}
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
              <span>{isOutsideTab(buf.path) ? "This file was deleted on disk." : "This file was deleted on disk. Saving will re-create it."}</span>
            </div>
          )}
          {unshown[buf.path] ? <Unshown path={buf.path} reason={unshown[buf.path]!} /> : (
            <Editor
              buffer={buf} kind={kind} mode={mode} documentsId={documentsId}
              reveal={reveal?.path === buf.path ? reveal : null}
              readOnly={isOutsideTab(buf.path)}
              onChange={(text) => setBuffer(buf.path, (b) => edited(b, text))}
              onSave={() => { void save(buf.path); }}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * The open files, after the home's own tab — the way back to this session's files, the Library and
 * the search once something is open — and before New. The home's tab is a glyph, not a word: it is
 * the pane's own page, always first, and a word there would be read as a file called that.
 */
function TabStrip({ tabs, active, buffers, home, onHome, onSelect, onClose, menu }: {
  tabs: string[]; active: string | null; buffers: Record<string, Buffer>;
  home: boolean; onHome: () => void;
  onSelect: (p: string) => void; onClose: (p: string) => void;
  menu: ReactNode;
}) {
  const strip = useRef<HTMLDivElement>(null);
  useDissolve(strip, "x");
  return (
    <div className="documents-tabs" ref={strip} role="tablist" aria-label="Open documents">
      <div className="documents-tab documents-home-tab" role="tab" aria-selected={home} data-active={home || undefined}>
        <button className="documents-tab-label" onClick={onHome} aria-label="Files" title="This session's files, the Library and search (⌘P)">
          <Icon name="home" size={12} />
        </button>
      </div>
      {tabs.map((path) => {
        const b = buffers[path];
        return (
          <div key={path} className="documents-tab" role="tab" aria-selected={path === active}
            data-active={path === active || undefined}>
            <button className="documents-tab-label" onClick={() => onSelect(path)} title={path}>
              <Icon name={iconFor(path)} size={12} />
              {/* A code file is told apart by its extension — greet.ts and greet.tsx are two files, and
                  the extension is what chose the editor — so its tab keeps it. A document's is its name. */}
              <span>{documentKindFor(path) === "code" ? baseName(path) : documentStem(path)}</span>
              {/* One dot for "not yet on disk", so the tab strip answers "is my work saved?" at a
                  glance. A conflicted tab is marked differently — it needs a decision, not a wait. */}
              {b?.conflict ? <span className="documents-dot conflict" aria-label="Needs attention" />
                : b?.dirty && !isOutsideTab(path) ? <span className="documents-dot" aria-label="Unsaved" /> : null}
            </button>
            <button className="documents-tab-close icon-btn" aria-label={`Close ${baseName(path)}`}
              onClick={() => onClose(path)}><Icon name="close" size={12} /></button>
          </div>
        );
      })}
      {menu}
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
  // Outside the space nothing is saved, so "Saved" would be a claim about a write that never happens.
  const readOnly = isOutsideTab(buffer.path);
  const state = buffer.missing ? "missing" : readOnly ? "read-only" : buffer.conflict ? "conflict" : buffer.dirty ? "dirty" : "clean";
  const stateLabel = { conflict: "Needs a decision", missing: "Deleted on disk", dirty: "Saving…", clean: "Saved", "read-only": "Read-only" }[state];
  return (
    <div className="documents-head">
      <Icon name={iconFor(buffer.path)} size={14} className="documents-head-glyph" />
      {readOnly
        ? <span className="documents-name" title={buffer.path}>
            {documentStem(buffer.path)}
            {kind === "code" && documentExtension(buffer.path) && <span className="documents-name-ext">.{documentExtension(buffer.path)}</span>}
          </span>
        : renaming
        // Keyed by PATH. The field seeds its value once, on mount, and the active document can change
        // underneath an open field — creating a second document does exactly that. Unkeyed, the field
        // kept the previous document's name, and the next blur committed it onto the new one: a
        // spreadsheet created straight after a document was silently renamed to the document's name.
        ? <DocumentNameInput key={buffer.path} stem={documentStem(buffer.path)}
            onCommit={(s) => { onRename(s); onRenaming(false); }}
            onCancel={() => onRenaming(false)} />
        : <button type="button" className="documents-name" title={`${buffer.path} — click to rename`}
            onClick={() => onRenaming(true)}>
            {documentStem(buffer.path)}
            {/* Shown, never edited: the rename field takes the name, and the extension stays the file's. */}
            {kind === "code" && documentExtension(buffer.path) && <span className="documents-name-ext">.{documentExtension(buffer.path)}</span>}
          </button>}
      <span className="documents-state t-xs muted" data-state={state} role="status">{stateLabel}</span>
      {structured && structured !== "pdf" && structured !== "render" && (
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

/** Which kinds have a view other than their source, and what that view is. A PDF is the odd one: it
 *  has no text to show, so it is preview-only and gets no toggle. */
/** `preview` is the GUIDE preview (an html file rendered as itself); `render` is a Quick Look
 *  picture of a file Realm has no editor for. Two different surfaces with one English word between
 *  them, so the names are kept apart here rather than in each reader's head. */
function structuredViewFor(kind: DocumentKind): "rich" | "grid" | "preview" | "pdf" | "render" | null {
  return kind === "doc" || kind === "slides" ? "rich"
    : kind === "sheet" ? "grid" : kind === "html" ? "preview"
    : kind === "pdf" ? "pdf" : kind === "preview" ? "render" : null;
}
const structuredLabel = (v: "rich" | "grid" | "preview" | "pdf" | "render"): string =>
  v === "grid" ? "Grid" : v === "preview" ? "Preview" : v === "pdf" ? "PDF" : v === "render" ? "Preview" : "Rich";

/**
 * The quiet line under a file from outside the space: where it is, that the pane only reads it, and
 * the way to the folder it is in. Read-only because the pane writes only inside the space's folder —
 * the boundary an agent's own documents tools keep too.
 */
function OutsideNote({ path }: { path: string }) {
  const folder = tildePath(path.slice(0, path.lastIndexOf("/")) || "/");
  return (
    <div className="documents-outside" title={path}>
      <Icon name="padlock" size={12} />
      <span className="documents-outside-says">Outside this space · read-only</span>
      <span className="documents-outside-where">{folder}</span>
      <button type="button" className="btn-quiet" onClick={() => { void window.realm?.files?.reveal?.(path); }}>Show in Finder</button>
    </div>
  );
}

/** A file the pane was asked for and cannot show — too large, not text, gone — said where it was
 *  asked for, with the ways out the Finder still has. */
function Unshown({ path, reason }: { path: string; reason: { says: string; gone: boolean } }) {
  return (
    <div className="pane-empty documents-unshown" role="status">
      {/* off-ladder: an empty state's mark, drawn at the 28 the pane's other empty states use. */}
      <div className="pane-empty-tile" aria-hidden="true"><Icon name="documents" size={28} /></div>
      <p className="pane-empty-line">{reason.says}</p>
      {!reason.gone && (
        <div className="docs-home-empty-actions">
          <button type="button" className="btn" onClick={() => { void window.realm?.files?.reveal?.(path); }}>Show in Finder</button>
          <button type="button" className="btn" onClick={() => { void window.realm?.openAttachment?.(path); }}>Open with the default app</button>
        </div>
      )}
    </div>
  );
}

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
function Editor({ buffer, kind, mode, documentsId, reveal, readOnly, onChange, onSave }: {
  buffer: Buffer; kind: DocumentKind; mode: "rich" | "source"; documentsId: string;
  /** A file outside the space: drawn by the same editor, which takes no edits. */
  readOnly: boolean;
  /** A line asked for from outside the pane. The code editor goes to it; the rich views have no lines
   *  to go to, and open where the reader left off. */
  reveal: { line: number } | null;
  onChange: (text: string) => void; onSave: () => void;
}) {
  // The toggle itself lives in the head bar beside the name — the editor only has to know which view
  // it is drawing. A PDF has no text, so it is preview-only regardless of the mode (Plan 22).
  const structured = structuredViewFor(kind);
  /* Where the reader was in this file, kept across the unmount a space switch causes
     (scroll-memory.ts). Per VIEW as well as per file: the rich column and the source text are two
     different heights of the same document, and an offset taken in one is meaningless in the other. */
  const sourceScroll = useScrollMemory(`doc:${documentsId}:source:${buffer.path}`);
  const blinkCaret = useApp((s) => s.caret.animation !== "solid");
  // A PDF and a Quick Look render have no text at all, so neither has a source view to toggle to.
  const showStructured = structured !== null && (mode === "rich" || structured === "pdf" || structured === "render");
  return (
    <div className="documents-editor" data-kind={kind}>
      <div className="documents-surface">
        {showStructured && structured === "render" ? (
          <QuickLookView key={buffer.path} documentsId={documentsId} path={buffer.path} version={buffer.baseHash}
            scrollKey={`doc:${documentsId}:render:${buffer.path}`} />
        ) : showStructured && (structured === "preview" || structured === "pdf") ? (
          // The frame reloads on the DISK hash: while the user edits the source, the preview keeps
          // showing the last saved version, and the autosave tick (or an agent's write) refreshes it.
          <PreviewFrame key={buffer.path} documentsId={documentsId} path={buffer.path}
            kind={structured === "pdf" ? "pdf" : "html"} version={buffer.baseHash}
            scrollKey={`doc:${documentsId}:preview:${buffer.path}`} />
        ) : showStructured ? (
          <Suspense fallback={<div className="pane-placeholder muted">Loading editor…</div>}>
            {/* Keyed by path so switching documents remounts the editor rather than diffing one
                document's editor state onto another's. */}
            {structured === "grid"
              ? <SheetEditor key={buffer.path} path={buffer.path} text={buffer.text} onChange={onChange} />
              : <RichTextEditor key={buffer.path} text={buffer.text} onChange={onChange} readOnly={readOnly}
                  scrollKey={`doc:${documentsId}:rich:${buffer.path}`} />}
          </Suspense>
        ) : kind === "code" ? (
          <Suspense fallback={<div className="pane-placeholder muted">Loading editor…</div>}>
            {/* Keyed by path for the same reason the rich editor is: a new file gets a new editor
                rather than one document's undo history diffed onto another's. */}
            <CodeEditor key={buffer.path} path={buffer.path} text={buffer.text}
              onChange={onChange} onSave={onSave} blinkCaret={blinkCaret} reveal={reveal} readOnly={readOnly}
              scrollKey={`doc:${documentsId}:code:${buffer.path}`} />
          </Suspense>
        ) : (
          <textarea className="documents-source" ref={sourceScroll} value={buffer.text} spellCheck={false} readOnly={readOnly}
            aria-label={`${readOnly ? "Read" : "Edit"} ${baseName(buffer.path)}`} onChange={(e) => onChange(e.target.value)} />
        )}
      </div>
    </div>
  );
}

/** Open an existing file. A flat directory browser, not a tree: the pane opens documents, it is not a
 *  file manager. Creating one is no longer this panel's job — that moved to New, which is why the
 *  disabled-buttons-behind-a-name-field row is gone. */
function FilePicker({ documentsId, onOpen, onDismiss }: {
  documentsId: string;
  onOpen: (path: string) => void;
  onDismiss: () => void;
}) {
  const listDocumentEntries = useApp((s) => s.listDocumentEntries);
  const list = useRef<HTMLUListElement>(null);
  useDissolve(list);
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

      <ul className="documents-picker-list" ref={list}>
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
