import { Icon } from "@realm/ui";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import { chordsForCommand, displayKeyChord, type DocumentKind, type LibraryEntry, type MeetingNotesFile } from "@realm/contracts";
import { useApp } from "../../state/store";
import { rpc } from "../../rpc/client";
import { FileMark } from "../../components/file-icon";
import { breakableName, useSeen } from "../../components/FileCard";
import { useThumbnail } from "../../components/use-thumbnail";
import { tileToward } from "../../components/walk-grid";
import { fileDragProps, quickLookOnSpace } from "../../components/file-actions";
import { fileMenuItems, isMenuKey, removeOnDelete } from "../../components/file-menu";
import { Menu } from "../../components/Menu";
import { EmptyState } from "../../components/EmptyState";
import { useDissolve } from "../../components/ScrollFades";
import { SEARCH_DEBOUNCE_MS, relTime } from "../../components/CommandPalette";
import { CodeFilePrompt, NEW_KINDS, NewMenu } from "./NewMenu";
import { canReveal, revealPath, showInLabel } from "./shown-file";
import { capabilities } from "../../platform";
import { previewSourceOf, useCardPreview } from "./card-preview";
import {
  checkoutFileOf, folderName, homeFilesOf, identityOf, libraryDetail, matchRun, meetingFileOf, paneTabOf, planNewFile, sessionDetail, tildePath, withoutShown, type HomeFile,
} from "./home-model";

/** Rows a section shows before folding the rest: enough to read the shape of a session's work in a
 *  side pane at a glance, few enough that the Library under it is still on the first screen. */
const SECTION_ROWS = 8;
/** The card's narrowest column and the gap between columns, as the stylesheet lays the grid out
 *  (`.docs-cards`): what a folded section reads its column count from. */
const CARD_MIN = 132;
const CARD_GAP = 12;
/** One page of the index for each list. The session's own is every file it has touched, near enough;
 *  the Library's is the newest of the profile's, and its page is where the rest are browsed. */
const SESSION_LIMIT = 100;
const LIBRARY_LIMIT = 60;

type Lists = { forQuery: string; session: LibraryEntry[] | null; meetings: MeetingNotesFile[]; library: LibraryEntry[]; checkout: string[] | null };

/**
 * The documents pane before a file is open, and whenever its Files tab is: what this session has
 * made and been given, the space's meetings, what the Library holds, and a search over them and the
 * checkout — the one place a file is found, opened, made, or added to the next message.
 *
 * It replaces "Nothing open yet" over a void, and a ⌘P palette that found a file in one place and
 * then opened a pane somewhere else. Every list here is a real record: the session's files and the
 * Library's are the artifacts index (a file the agent wrote or edited, a file attached to a message),
 * and the checkout's are `project.files`, which is git's own list. A meeting's notes are written by
 * Realm when the meeting ends, by no session, so the index never holds them: they are read from the
 * space's `meetings/` folder. Nothing is folded, guessed or kept on the side.
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
  const listMeetingNotes = useApp((s) => s.listMeetingNotes);
  const profileId = useApp((s) => s.spaces.find((x) => x.id === spaceId)?.profileId ?? null);
  /* What the session has DONE, as two numbers: re-reading on them is what makes a file the agent just
     wrote appear without a watcher, because the transcript growing is the same event as the agent
     having run something. The session's file browser listens the same way. The media a turn left on
     disk (`files_made`) arrives after the settle and adds no block, so it is counted beside them. */
  const beat = useApp((s) => {
    const t = sessionId ? s.transcripts[sessionId]?.t : undefined;
    return t ? t.blocks.length + Object.keys(t.made ?? {}).length : 0;
  });
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
  const view = useApp((s) => s.documentsView);
  const setDocumentsView = useApp((s) => s.setDocumentsView);
  const grid = view === "grid";
  // Its own group in each pane: two documents panes side by side must not share one set of radios.
  const viewGroup = useId();

  const [query, setQuery] = useState("");
  const [lists, setLists] = useState<Lists | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [codePrompt, setCodePrompt] = useState<ReadonlySet<string> | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const codeButton = useRef<HTMLButtonElement>(null);
  useDissolve(scroller);
  const columns = useColumns(scroller, grid);
  /* Every fetch carries the generation it was started under, so an answer for a query already retyped
     can never land on top of the answer for the one on screen. */
  const generation = useRef(0);
  const q = query.trim();
  // A meeting that ends while the home is up is listed when its file is written, and again when final.
  const [meetingsSaved, setMeetingsSaved] = useState(0);
  useEffect(() => rpc().on("meetings.notesProgress", (p) => { if (p.spaceId === spaceId) setMeetingsSaved((n) => n + 1); }), [spaceId]);

  useEffect(() => {
    const gen = ++generation.current;
    // Rested, so a word typed or a burst of tool calls in one turn is one round of asking.
    const t = setTimeout(() => {
      void Promise.all([
        sessionId ? libraryArtifacts({ sessionId, perFile: true, query: q, limit: SESSION_LIMIT }) : null,
        listMeetingNotes(spaceId).catch(() => []),
        libraryArtifacts({ profileId, perFile: true, query: q, limit: LIBRARY_LIMIT }),
        q && root ? searchProjectFiles(q, root).catch(() => null) : null,
      ]).then(([session, meetings, library, checkout]) => {
        if (generation.current !== gen) return;
        setLists({ forQuery: q, session: session?.entries ?? null, meetings, library: library.entries, checkout: checkout?.hits.map((h) => h.path) ?? null });
      }).catch(() => { /* the lists keep what they last showed; the next beat asks again */ });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [sessionId, spaceId, profileId, root, q, beat, status, libraryRevision, meetingsSaved, libraryArtifacts, searchProjectFiles, listMeetingNotes]);

  // ⌘P: the keyboard in the search, with what was typed last selected so the next word replaces it.
  useEffect(() => {
    if (searchAsk === 0) return;
    search.current?.focus();
    search.current?.select();
  }, [searchAsk]);

  /* The four lists, each one minus what a list above it already shows: a file is one file on this
     page, listed where it says the most — the session's own, then the space's meetings, then the
     Library's, then the checkout's. */
  const sections = useMemo(() => {
    if (!lists) return null;
    const session = lists.session ? homeFilesOf(lists.session, root, (e, place) => sessionDetail(e, place, e.path)) : null;
    const shown = new Set((session ?? []).map(identityOf));
    const named = root ? lists.meetings.map((note) => meetingFileOf(note, root)).filter((f) => !lists.forQuery || matchRun(f.name, lists.forQuery)) : [];
    const meetings = withoutShown(named, shown);
    for (const f of meetings) shown.add(identityOf(f));
    const library = withoutShown(homeFilesOf(lists.library, root, libraryDetail), shown);
    for (const f of library) shown.add(identityOf(f));
    const checkout = lists.checkout && root ? withoutShown(lists.checkout.map((rel) => checkoutFileOf(rel, root)), shown) : null;
    return { session, meetings, library, checkout };
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
    const shown = [...(sections?.session ?? []), ...(sections?.meetings ?? []), ...(sections?.library ?? []), ...(sections?.checkout ?? [])]
      .filter((x) => x.abs && !opensHere(x));
    openViewer({
      files: shown.map((x) => ({ path: x.abs!, name: x.name, from: x.from, inPane: inPane(x) })),
      index: Math.max(0, shown.findIndex((x) => x.key === f.key)), sessionId, spaceId,
    });
  };

  const searching = lists !== null && lists.forQuery !== "";
  const names = new Set([...(sections?.session ?? []), ...(sections?.meetings ?? []), ...(sections?.library ?? []), ...(sections?.checkout ?? [])].map((f) => f.name.toLowerCase()));
  /* A query that is a file name nothing here has is an offer to make it: ⌘P, "notes.md", Return.
     Only a name this pane would make — `planNewFile` refuses a path, a kind it cannot write, a name
     the folder already has. */
  const creatable = searching && !names.has(lists.forQuery.toLowerCase()) ? planNewFile(lists.forQuery) : null;
  const chord = chordsForCommand(keybindings, "palette.files")[0];
  const nothing = sections !== null && !searching && (sections.session ?? []).length === 0 && sections.meetings.length === 0 && sections.library.length === 0;

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const rows = [...(scroller.current?.querySelectorAll<HTMLButtonElement>(".docs-home-open, .docs-card") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const inSearch = e.target === search.current;
    if (inSearch && e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); rows[0]?.click(); return; }
    if (inSearch && e.key === "Escape" && query) { e.preventDefault(); setQuery(""); return; }
    if (grid && at >= 0 && !e.metaKey && !e.altKey && !e.ctrlKey && e.key.startsWith("Arrow")) {
      // Cards walk the grid as the Library's do; up off the first row is the search, as it is from the
      // first row of the list.
      const to = tileToward(e.key, rows[at]!, rows);
      if (!to && e.key !== "ArrowUp") return;
      e.preventDefault();
      if (!to) { search.current?.focus(); return; }
      to.focus();
      to.scrollIntoView({ block: "nearest" });
      return;
    }
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
    const row = scroller.current.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"] > :is(.docs-home-open, .docs-card)`);
    if (!row) return;
    focusNext.current = null;
    row.focus();
  }, [sections]);
  const remove = (f: HomeFile) => (f.from?.kind === "added" && f.abs && profileId ? () => run(async () => {
    const rows = [...(scroller.current?.querySelectorAll<HTMLElement>(":is(.docs-home-row, .docs-card-cell)[data-key]") ?? [])];
    const at = rows.findIndex((r) => r.dataset["key"] === f.key);
    const held = at >= 0 && rows[at]!.contains(document.activeElement);
    const next = rows[at + 1] ?? rows[at - 1];
    const r = await removeLibraryFiles(profileId, [f.abs!]);
    if (held && next && r?.removal) focusNext.current = next.dataset["key"] ?? null;
  }) : null);

  const toggle = (id: string) => setExpanded((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  /* Folded, a grid keeps whole rows: as many cards as fill the rows the list's eight would, so a
     section never ends on one card alone (design.md, "A picture ends where its subject does"). */
  const folded = grid ? columns * Math.ceil(SECTION_ROWS / columns) : SECTION_ROWS;
  const more = (id: string, files: HomeFile[]) => files.length > folded && (
    <button type="button" className="btn-quiet docs-home-more" onClick={() => toggle(id)}>
      {expanded.has(id) ? "Show fewer" : `Show all ${files.length}`}
    </button>
  );
  const rowsOf = (id: string, files: HomeFile[]) => {
    const shown = expanded.has(id) ? files : files.slice(0, folded);
    const query = lists?.forQuery ?? "";
    return grid ? (
      <>
        <ul className="docs-cards">
          {shown.map((f) => (
            <HomeCard key={f.key} file={f} query={query} onOpen={() => open(f)} attach={attach(f)} onRemove={remove(f)} />
          ))}
        </ul>
        {more(id, files)}
      </>
    ) : (
      <ul className="docs-home-rows">
        {shown.map((f) => (
          <HomeRow key={f.key} file={f} query={query} onOpen={() => open(f)} attach={attach(f)} onRemove={remove(f)} />
        ))}
        {files.length > folded && <li>{more(id, files)}</li>}
      </ul>
    );
  };

  return (
    <div className="docs-home" onKeyDown={onKeyDown}>
      <div className="docs-home-head">
        <label className="docs-home-search">
          <Icon name="search" size={14} />
          <input ref={search} className="search-field" type="search" placeholder="Search files" aria-label="Search files"
            value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
          {chord && !query && <kbd className="menu-kbd docs-home-kbd">{displayKeyChord(chord)}</kbd>}
        </label>
        <fieldset className="seg docs-home-view">
          <legend className="visually-hidden">Show files as</legend>
          {(["list", "grid"] as const).map((v) => (
            <label key={v} className="seg-opt" data-selected={view === v || undefined} title={v === "grid" ? "Grid" : "List"}>
              <input type="radio" name={viewGroup} value={v} checked={view === v}
                onChange={() => run(() => setDocumentsView(v))} aria-label={v === "grid" ? "Grid" : "List"} />
              <Icon name={v} size={14} />
            </label>
          ))}
        </fieldset>
        <NewMenu variant="home" folder={root ? folderName(root) : null}
          onNewKind={onNewKind} onNewFile={onNewFile} onOpenExisting={onBrowse} taken={taken} />
        {/* With no file open, the thing to show is the folder the pane writes into. */}
        {root && canReveal() && (
          <button type="button" className="icon-btn" aria-label={`Show ${folderName(root)} in ${capabilities().fileManager}`}
            title={showInLabel()} onClick={() => revealPath(root)}>
            <Icon name="folder" size={14} />
          </button>
        )}
      </div>

      <div className="docs-home-scroll" ref={scroller}>
        {nothing ? (
          <EmptyState icon="documents" title="No files yet" actions={<>
            <button type="button" className="btn primary" onClick={() => { const d = NEW_KINDS[0]!; onNewKind(d.kind, d.ext, d.stem); }}>
              <Icon name="documents" size={14} />New document
            </button>
            <button ref={codeButton} type="button" className="btn" onClick={() => { void taken().catch(() => new Set<string>()).then(setCodePrompt); }}>
              <Icon name="code" size={14} />Code file…
            </button>
          </>}>
            {sessionId
              ? "Files the agent writes or edits in this session, and files you attach to a message, appear here — with everything in your Library."
              : "Every file a session writes, and every file you attach to a message, appears here."}
          </EmptyState>
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
            {sections.meetings.length > 0 && (
              <Section title="Meetings">{rowsOf("meetings", sections.meetings)}</Section>
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
            ) : sections.library.length === 0 && (sections.session ?? []).length === 0 && sections.meetings.length === 0 && (sections.checkout ?? []).length === 0 && (
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

type FileProps = {
  file: HomeFile;
  query: string;
  onOpen: () => void;
  attach: { on: boolean; toggle: () => void } | null;
  /** Takes it out of the Library: a file the person added, and only that. */
  onRemove: (() => void) | null;
};

/**
 * What a row and a card share, so the two views of one file can never disagree: the tooltip, the
 * right-click and its keys, Space for Quick Look, Delete for a file the person added, the drag out,
 * and the control that puts it in the next message.
 */
function useFileControls({ file, onOpen, attach, onRemove }: FileProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const abs = file.abs;
  const where = file.rel ?? (file.abs ? tildePath(file.abs) : file.path);
  const from = !file.from ? null : file.from.kind === "added" ? "Added by you"
    : `${file.from.kind === "upload" ? "Attached to" : "Made in"} ${file.from.sessionTitle ?? "a session"}`;
  return {
    item: {
      "data-key": file.key,
      onContextMenu: abs ? (e: ReactMouseEvent) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); } : undefined,
    },
    button: {
      title: [where, from].filter(Boolean).join("\n"), onClick: onOpen,
      ...(abs ? {
        onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => {
          if (isMenuKey(e)) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4 }); return; }
          if (!removeOnDelete(onRemove)(e)) quickLookOnSpace(abs)(e);
        },
        ...fileDragProps(abs),
      } : {}),
    },
    extras: (
      <>
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
      </>
    ),
  };
}

/**
 * One file: its kind's glyph, its name, the one thing its list knows (the folder it is in, that it
 * was attached, the session it came from), and when it was last touched. A row is a file the way a
 * Finder row is — Space shows it in Quick Look, it drags out, and a right-click is the file's menu, the
 * same one its Library tile has — and beside it, the one thing only this pane can do with it: put it in
 * the next message to the session.
 */
function HomeRow(props: FileProps) {
  const { file, query } = props;
  const controls = useFileControls(props);
  const hit = matchRun(file.name, query);
  return (
    <li className="docs-home-row" {...controls.item}>
      <button type="button" className="docs-home-open" {...controls.button}>
        <span className="docs-home-glyph" data-type={file.type}><FileMark path={file.name} type={file.type} size={16} /></span>
        <span className="docs-home-name">{hit ? <>{hit.before}<mark>{hit.match}</mark>{hit.after}</> : file.name}</span>
        {file.detail && <span className="docs-home-detail">{file.detail}</span>}
        {/* Drawn with or without a time, so every row keeps the column the control comes up in. */}
        <span className="docs-home-time">{file.ts !== null ? relTime(file.ts) : ""}</span>
      </button>
      {controls.extras}
    </li>
  );
}

/**
 * The same file as a card, for the grid: a preview of it on top — the picture, a PDF's first page,
 * the top of its text — then its name on up to two lines and the row's quiet line under it. It opens,
 * drags, takes Space and Delete and offers its menu exactly as its row does (`useFileControls`).
 *
 * A preview is asked for only once the card has come near the screen (`useSeen`), and a file the home
 * cannot draw cheaply keeps its mark, drawn large.
 */
function HomeCard(props: FileProps) {
  const { file, query } = props;
  const controls = useFileControls(props);
  // The cell is what is watched: a card off screen is not laid out (`content-visibility`), so the
  // button inside it never reports coming into view, where the cell's own box does.
  const cell = useRef<HTMLLIElement>(null);
  const source = file.abs ? previewSourceOf(file.name, file.type) : null;
  const seen = useSeen(cell, source !== null);
  const thumb = useThumbnail(source === "thumbnail" ? file.abs : null, "card", seen);
  const read = useCardPreview(file.abs, source, seen, file.ts);
  const picture = thumb ?? (read?.kind === "picture" ? read.url : null);
  const hit = matchRun(file.name, query);
  return (
    <li ref={cell} className="docs-card-cell" {...controls.item}>
      <button type="button" className="docs-card" {...controls.button}>
        <span className="docs-card-preview" data-type={file.type}
          data-shows={picture ? "picture" : read?.kind === "markdown" || read?.kind === "text" ? read.kind : "mark"}>
          {picture ? <img src={picture} alt="" decoding="async" draggable={false} />
            : read?.kind === "markdown" ? <span className="docs-card-page md" dangerouslySetInnerHTML={{ __html: read.html }} />
            : read?.kind === "text" ? <span className="docs-card-page docs-card-source">{read.text}</span>
            : <FileMark path={file.name} type={file.type} size={32} />}
        </span>
        <span className="docs-card-name">{hit ? <>{hit.before}<mark>{hit.match}</mark>{hit.after}</> : breakableName(file.name)}</span>
        <span className="docs-card-line">
          {file.detail && <span className="docs-card-detail">{file.detail}</span>}
          {file.ts !== null && <span className="docs-card-time">{relTime(file.ts)}</span>}
        </span>
      </button>
      {controls.extras}
    </li>
  );
}

/** How many columns the grid lays out at the scroller's width, kept as the pane is resized. */
function useColumns(scroller: RefObject<HTMLElement | null>, on: boolean): number {
  const [columns, setColumns] = useState(1);
  useEffect(() => {
    const el = scroller.current;
    if (!on || !el) return;
    const measure = () => {
      const style = getComputedStyle(el);
      const width = el.clientWidth - parseFloat(style.paddingLeft || "0") - parseFloat(style.paddingRight || "0");
      setColumns(Math.max(1, Math.floor((width + CARD_GAP) / (CARD_MIN + CARD_GAP))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scroller, on]);
  return columns;
}
