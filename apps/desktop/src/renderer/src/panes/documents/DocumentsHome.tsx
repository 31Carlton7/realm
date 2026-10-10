import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { chordsForCommand, displayKeyChord, type DocumentKind, type LibraryEntry } from "@realm/contracts";
import { useApp } from "../../state/store";
import { TYPE_ICON } from "../../components/FileCard";
import { fileDragProps, quickLookOnSpace } from "../../components/file-actions";
import { fileMenuItems, isMenuKey, removeOnDelete } from "../../components/file-menu";
import { Menu } from "../../components/Menu";
import { useDissolve } from "../../components/ScrollFades";
import { SEARCH_DEBOUNCE_MS, relTime } from "../../components/CommandPalette";
import { CodeFilePrompt, NEW_KINDS, NewMenu } from "./NewMenu";
import {
  checkoutFileOf, folderName, homeFilesOf, identityOf, libraryDetail, matchRun, paneTabOf, planNewFile, sessionDetail, tildePath, withoutShown, type HomeFile,
} from "./home-model";

/** Rows a section shows before folding the rest: enough to read the shape of a session's work in a
 *  side pane at a glance, few enough that the Library under it is still on the first screen. */
const SECTION_ROWS = 8;
/** One page of the index for each list. The session's own is every file it has touched, near enough;
 *  the Library's is the newest of the profile's, and its page is where the rest are browsed. */
const SESSION_LIMIT = 100;
const LIBRARY_LIMIT = 60;

type Lists = { forQuery: string; session: LibraryEntry[] | null; library: LibraryEntry[]; checkout: string[] | null };

/**
 * The documents pane before a file is open, and whenever its Files tab is: what this session has
 * made and been given, what the Library holds, and a search over both and the checkout — the one
 * place a file is found, opened, made, or added to the next message.
 *
 * It replaces "Nothing open yet" over a void, and a ⌘P palette that found a file in one place and
 * then opened a pane somewhere else. Every list here is a real record: the session's files and the
 * Library's are the artifacts index (a file the agent wrote or edited, a file attached to a message),
 * and the checkout's are `project.files`, which is git's own list. Nothing is folded, guessed or kept
 * on the side.
 */
export function DocumentsHome({ spaceId, root, sessionId, searchAsk, onOpen, onNewKind, onNewFile, onBrowse, taken }: {
  spaceId: string;
  /** The checkout the pane is rooted at; null until its environment has loaded. */
  root: string | null;
  /** The session the pane serves — the owner of the side pane it is a tab of — or null for a pane of
   *  its own, which has no session to list or to add a file to. */
  sessionId: string | null;
  /** Bumped to put the keyboard in the search: ⌘P, from anywhere. */
  searchAsk: number;
  /** Open a file in the pane, by its tab path. */
  onOpen: (rel: string) => void;
  onNewKind: (kind: DocumentKind, ext: string, stem: string) => void;
  onNewFile: (name: string) => void;
  onBrowse: () => void;
  taken: () => Promise<ReadonlySet<string>>;
}) {
  const libraryArtifacts = useApp((s) => s.libraryArtifacts);
  const searchProjectFiles = useApp((s) => s.searchProjectFiles);
  const profileId = useApp((s) => s.spaces.find((x) => x.id === spaceId)?.profileId ?? null);
  /* What the session has DONE, as two numbers: re-reading on them is what makes a file the agent just
     wrote appear without a watcher, because the transcript growing is the same event as the agent
     having run something. The session's file browser listens the same way. */
  const beat = useApp((s) => (sessionId ? s.transcripts[sessionId]?.t.blocks.length ?? 0 : 0));
  const status = useApp((s) => (sessionId ? s.sessionStatus[sessionId] ?? null : null));
  const pending = useApp((s) => (sessionId ? s.pendingAttachments[sessionId] : undefined));
  // Files added to the Library from this window — the page over this pane, say — are asked for again.
  const libraryRevision = useApp((s) => s.libraryRevision);
  const attachPaths = useApp((s) => s.attachPaths);
  const removeAttachment = useApp((s) => s.removeAttachment);
  const removeLibraryFiles = useApp((s) => s.removeLibraryFiles);
  const openDestinationPage = useApp((s) => s.openDestinationPage);
  const openViewer = useApp((s) => s.openViewer);
  const keybindings = useApp((s) => s.keybindings);
  const run = useApp((s) => s.run);

  const [query, setQuery] = useState("");
  const [lists, setLists] = useState<Lists | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [codePrompt, setCodePrompt] = useState<ReadonlySet<string> | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const codeButton = useRef<HTMLButtonElement>(null);
  useDissolve(scroller);
  /* Every fetch carries the generation it was started under, so an answer for a query already retyped
     can never land on top of the answer for the one on screen. */
  const generation = useRef(0);
  const q = query.trim();

  useEffect(() => {
    const gen = ++generation.current;
    // Rested, so a word typed or a burst of tool calls in one turn is one round of asking.
    const t = setTimeout(() => {
      void Promise.all([
        sessionId ? libraryArtifacts({ sessionId, perFile: true, query: q, limit: SESSION_LIMIT }) : null,
        libraryArtifacts({ profileId, perFile: true, query: q, limit: LIBRARY_LIMIT }),
        q && root ? searchProjectFiles(q, root).catch(() => null) : null,
      ]).then(([session, library, checkout]) => {
        if (generation.current !== gen) return;
        setLists({ forQuery: q, session: session?.entries ?? null, library: library.entries, checkout: checkout?.hits.map((h) => h.path) ?? null });
      }).catch(() => { /* the lists keep what they last showed; the next beat asks again */ });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [sessionId, profileId, root, q, beat, status, libraryRevision, libraryArtifacts, searchProjectFiles]);

  // ⌘P: the keyboard in the search, with what was typed last selected so the next word replaces it.
  useEffect(() => {
    if (searchAsk === 0) return;
    search.current?.focus();
    search.current?.select();
  }, [searchAsk]);

  /* The three lists, each one minus what a list above it already shows: a file is one file on this
     page, listed where it says the most — the session's own before the Library's, the Library's
     before the checkout's. */
  const sections = useMemo(() => {
    if (!lists) return null;
    const session = lists.session ? homeFilesOf(lists.session, root, (e, place) => sessionDetail(e, place, e.path)) : null;
    const shown = new Set((session ?? []).map(identityOf));
    const library = withoutShown(homeFilesOf(lists.library, root, libraryDetail), shown);
    for (const f of library) shown.add(identityOf(f));
    const checkout = lists.checkout && root ? withoutShown(lists.checkout.map((rel) => checkoutFileOf(rel, root)), shown) : null;
    return { session, library, checkout };
  }, [lists, root]);

  const attached = useMemo(() => new Set((pending ?? []).map((a) => a.path)), [pending]);
  const attach = (f: HomeFile) => (sessionId && f.abs ? {
    on: attached.has(f.abs),
    toggle: () => {
      if (attached.has(f.abs!)) removeAttachment(sessionId, f.abs!);
      else run(() => attachPaths(sessionId, [f.abs!]));
    },
  } : null);
  /* A file the pane has an editor or a page for opens HERE, as a tab — inside the checkout, or outside
     it read-only when the pane draws it from text (`paneTabOf`): a REPORT.md in another worktree is
     markdown, never Quick Look's grey picture of its source. A picture, a video or a sound opens in
     the media viewer, which is where media is looked at — with this session's prompter under it — and
     so does anything else, a PDF elsewhere, a download the user attached, an archive: the viewer every
     other list of files opens, which says what Realm can do with it. Beside it, the home's other files the viewer would show, so ← and →
     walk the list as it reads. */
  const inPane = (f: HomeFile) => paneTabOf(f) !== null;
  const opensHere = (f: HomeFile) => inPane(f) && f.type !== "image" && f.type !== "video" && f.type !== "audio";
  const open = (f: HomeFile) => {
    if (opensHere(f)) { onOpen(paneTabOf(f)!); return; }
    if (!f.abs) return;
    const shown = [...(sections?.session ?? []), ...(sections?.library ?? []), ...(sections?.checkout ?? [])]
      .filter((x) => x.abs && !opensHere(x));
    openViewer({
      files: shown.map((x) => ({ path: x.abs!, name: x.name, from: x.from, inPane: inPane(x) })),
      index: Math.max(0, shown.findIndex((x) => x.key === f.key)), sessionId, spaceId,
    });
  };

  const searching = lists !== null && lists.forQuery !== "";
  const names = new Set([...(sections?.session ?? []), ...(sections?.library ?? []), ...(sections?.checkout ?? [])].map((f) => f.name.toLowerCase()));
  /* A query that is a file name nothing here has is an offer to make it: ⌘P, "notes.md", Return.
     Only a name this pane would make — `planNewFile` refuses a path, a kind it cannot write, a name
     the folder already has. */
  const creatable = searching && !names.has(lists.forQuery.toLowerCase()) ? planNewFile(lists.forQuery) : null;
  const chord = chordsForCommand(keybindings, "palette.files")[0];
  const nothing = sections !== null && !searching && (sections.session ?? []).length === 0 && sections.library.length === 0;

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const rows = [...(scroller.current?.querySelectorAll<HTMLButtonElement>(".docs-home-open") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const inSearch = e.target === search.current;
    if (inSearch && e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); rows[0]?.click(); return; }
    if (inSearch && e.key === "Escape" && query) { e.preventDefault(); setQuery(""); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (inSearch) { if (e.key === "ArrowDown" && rows[0]) { e.preventDefault(); rows[0].focus(); } return; }
    if (at < 0) return;
    e.preventDefault();
    if (e.key === "ArrowDown") rows[Math.min(at + 1, rows.length - 1)]!.focus();
    else if (at === 0) search.current?.focus();
    else rows[at - 1]!.focus();
  };

  /* A file the person added goes back out of the Library from here too — its menu, or Delete on the
     row — and the keyboard moves on to the row after it once the lists without it are back. */
  const focusNext = useRef<string | null>(null);
  useEffect(() => {
    const key = focusNext.current;
    if (key === null || !scroller.current) return;
    const row = scroller.current.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"] > .docs-home-open`);
    if (!row) return;
    focusNext.current = null;
    row.focus();
  }, [sections]);
  const remove = (f: HomeFile) => (f.from?.kind === "added" && f.abs && profileId ? () => run(async () => {
    const rows = [...(scroller.current?.querySelectorAll<HTMLElement>(".docs-home-row[data-key]") ?? [])];
    const at = rows.findIndex((r) => r.dataset["key"] === f.key);
    const held = at >= 0 && rows[at]!.contains(document.activeElement);
    const next = rows[at + 1] ?? rows[at - 1];
    const r = await removeLibraryFiles(profileId, [f.abs!]);
    if (held && next && r?.removal) focusNext.current = next.dataset["key"] ?? null;
  }) : null);

  const toggle = (id: string) => setExpanded((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const rowsOf = (id: string, files: HomeFile[]) => (
    <ul className="docs-home-rows">
      {(expanded.has(id) ? files : files.slice(0, SECTION_ROWS)).map((f) => (
        <HomeRow key={f.key} file={f} query={lists?.forQuery ?? ""} onOpen={() => open(f)} attach={attach(f)} onRemove={remove(f)} />
      ))}
      {files.length > SECTION_ROWS && (
        <li><button type="button" className="btn-quiet docs-home-more" onClick={() => toggle(id)}>
          {expanded.has(id) ? "Show fewer" : `Show all ${files.length}`}
        </button></li>
      )}
    </ul>
  );

  return (
    <div className="docs-home" onKeyDown={onKeyDown}>
      <div className="docs-home-head">
        <label className="docs-home-search">
          <Icon name="search" size={14} />
          <input ref={search} className="search-field" type="search" placeholder="Search files" aria-label="Search files"
            value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
          {chord && !query && <kbd className="menu-kbd docs-home-kbd">{displayKeyChord(chord)}</kbd>}
        </label>
        <NewMenu variant="home" folder={root ? folderName(root) : null}
          onNewKind={onNewKind} onNewFile={onNewFile} onOpenExisting={onBrowse} taken={taken} />
      </div>

      <div className="docs-home-scroll" ref={scroller}>
        {nothing ? (
          <div className="pane-empty docs-home-empty">
            {/* off-ladder: the empty state's mark is a 64px tile's illustration, not a UI glyph — the
                same 28 the Changes pane's empty state draws its folder at. */}
            <div className="pane-empty-tile" aria-hidden="true"><Icon name="documents" size={28} /></div>
            <h2 className="pane-empty-title">No files yet</h2>
            <p className="pane-empty-line">
              {sessionId
                ? "Files the agent writes or edits in this session, and files you attach to a message, appear here — with everything in your Library."
                : "Every file a session writes, and every file you attach to a message, appears here."}
            </p>
            <div className="docs-home-empty-actions">
              <button type="button" className="btn primary" onClick={() => { const d = NEW_KINDS[0]!; onNewKind(d.kind, d.ext, d.stem); }}>
                <Icon name="documents" size={14} />New document
              </button>
              <button ref={codeButton} type="button" className="btn" onClick={() => { void taken().catch(() => new Set<string>()).then(setCodePrompt); }}>
                <Icon name="code" size={14} />Code file…
              </button>
            </div>
          </div>
        ) : sections && (
          <>
            {sections.session && (!searching || sections.session.length > 0) && (
              <Section title="This session">
                {sections.session.length > 0 ? rowsOf("session", sections.session) : (
                  <p className="docs-home-note">
                    Nothing yet. Files the agent writes or edits in this session, and files you attach to a message, appear here.
                  </p>
                )}
              </Section>
            )}
            {(!searching || sections.library.length > 0) && (
              <Section title="Library" action={
                <button type="button" className="btn-quiet" onClick={() => openDestinationPage("library-page")}>Open the Library</button>
              }>
                {sections.library.length > 0 ? rowsOf("library", sections.library) : (
                  <p className="docs-home-note">
                    {sessionId ? "Files from your other sessions appear here." : "Every file a session writes, and every file you attach, is kept here."}
                  </p>
                )}
              </Section>
            )}
            {sections.checkout && sections.checkout.length > 0 && root && (
              <Section title={`In ${folderName(root)}`}>{rowsOf("checkout", sections.checkout)}</Section>
            )}
            {searching && (creatable?.ok ? (
              <ul className="docs-home-rows docs-home-create">
                <li className="docs-home-row">
                  <button type="button" className="docs-home-open" onClick={() => onNewFile(creatable.name)}>
                    <span className="docs-home-glyph"><Icon name="add" size={16} /></span>
                    <span className="docs-home-name">Create {creatable.name}</span>
                    <span className="docs-home-detail">{creatable.says}</span>
                  </button>
                </li>
              </ul>
            ) : sections.library.length === 0 && (sections.session ?? []).length === 0 && (sections.checkout ?? []).length === 0 && (
              <p className="docs-home-note docs-home-none">No file matches “{lists!.forQuery}”.</p>
            ))}
          </>
        )}
      </div>

      {codePrompt && (
        <CodeFilePrompt anchorRef={codeButton} taken={codePrompt}
          onCreate={(name) => { setCodePrompt(null); onNewFile(name); }} onClose={() => setCodePrompt(null)} />
      )}
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="docs-home-section" aria-label={title}>
      <div className="docs-home-section-head">
        <h3>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * One file: its kind's glyph, its name, the one thing its list knows (the folder it is in, that it
 * was attached, the session it came from), and when it was last touched. A row is a file the way a
 * Finder row is — Space shows it in Quick Look, it drags out, and a right-click is the file's menu, the
 * same one its Library tile has — and beside it, the one thing only this pane can do with it: put it in
 * the next message to the session.
 */
function HomeRow({ file, query, onOpen, attach, onRemove }: {
  file: HomeFile;
  query: string;
  onOpen: () => void;
  attach: { on: boolean; toggle: () => void } | null;
  /** Takes it out of the Library: a file the person added, and only that. */
  onRemove: (() => void) | null;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const abs = file.abs;
  const hit = matchRun(file.name, query);
  const where = file.rel ?? (file.abs ? tildePath(file.abs) : file.path);
  const from = !file.from ? null : file.from.kind === "added" ? "Added by you"
    : `${file.from.kind === "upload" ? "Attached to" : "Made in"} ${file.from.sessionTitle ?? "a session"}`;
  return (
    <li className="docs-home-row" data-key={file.key}
      onContextMenu={abs ? (e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); } : undefined}>
      <button type="button" className="docs-home-open" title={[where, from].filter(Boolean).join("\n")} onClick={onOpen}
        {...(abs ? {
          onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => {
            if (isMenuKey(e)) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4 }); return; }
            if (!removeOnDelete(onRemove)(e)) quickLookOnSpace(abs)(e);
          },
          ...fileDragProps(abs),
        } : {})}>
        <span className="docs-home-glyph" data-type={file.type}><Icon name={TYPE_ICON[file.type]} size={16} /></span>
        <span className="docs-home-name">{hit ? <>{hit.before}<mark>{hit.match}</mark>{hit.after}</> : file.name}</span>
        {file.detail && <span className="docs-home-detail">{file.detail}</span>}
        {/* Drawn with or without a time, so every row keeps the column the control comes up in. */}
        <span className="docs-home-time">{file.ts !== null ? relTime(file.ts) : ""}</span>
      </button>
      {attach && (
        // The name holds still and the state is `aria-pressed`: added, it reads "…, pressed".
        <button type="button" className="icon-btn docs-home-attach" aria-pressed={attach.on} aria-label={`Add ${file.name} to the next message`}
          title={attach.on ? "In the next message — click to take it out" : "Add to the next message"} onClick={attach.toggle}>
          <Icon name={attach.on ? "check" : "attach"} size={14} />
        </button>
      )}
      {menu && abs && (
        <Menu at={menu} label={file.name} onClose={() => setMenu(null)}
          items={fileMenuItems({ path: abs, onOpen, shareFrom: () => menu, ...(onRemove ? { onRemove } : {}) })} />
      )}
    </li>
  );
}
