import { Icon } from "@realm/ui";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from "react";
import { ARTIFACT_KINDS, artifactTypeOf, LIBRARY_PAGE_SIZE, type ArtifactKind, type ArtifactType, type LibraryAddResult, type LibraryEntry } from "@realm/contracts";
import { useApp } from "../../state/store";
import { folderOffer, folderOfferText, nameList, offerCount } from "../../state/library-add";
import { FileCard, FileRow } from "../../components/FileCard";
import { Menu, type MenuItem } from "../../components/Menu";
import { PageScroll } from "../../components/ScrollFades";

type Scope = "space" | "all";

/* The tabs along the top, as Codex's library has them: what KIND of thing a file is, which is the
   first thing a person narrows by ("the screenshot", "that CSV"). The other two narrowings — where it
   was made and whether an agent made it — are rarer, so they live behind the filter button and show
   themselves as chips only while they are narrowing something. */
const TYPE_TABS: { id: ArtifactType | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "image", label: "Images" },
  { id: "document", label: "Documents" },
  { id: "code", label: "Code" },
  { id: "data", label: "Data" },
];

const SCOPE_WORDS: Record<Scope, string> = { space: "In this space", all: "In every space" };
/* "Attached" and "Added" are both the person's own files and different facts: one was handed to a
   session with a message, the other was put in the Library itself, and belongs to no session. */
const KIND_WORDS: Record<ArtifactKind | "all", string> = { all: "All files", output: "Made by agents", upload: "Attached by you", added: "Added by you" };

/** The day a file landed, as a person asks about one. Groups the grid, the way a file browser does. */
function dayLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(new Date(now)) - startOf(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  if (d.getFullYear() === new Date(now).getFullYear()) return d.toLocaleDateString(undefined, { month: "long", day: "numeric" });
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

/** Consecutive runs of entries sharing a day. A `Map` keyed by label would silently merge two runs a
 *  year apart that happen to render the same words.
 *
 *  Generic over anything with a timestamp, because the session's file browser groups a directory
 *  listing by the same days with the same words — "Today" has to mean one thing in this app. */
export function groupByDay<T extends { ts: number }>(entries: T[], now = Date.now()): { label: string; entries: T[] }[] {
  const out: { label: string; entries: T[] }[] = [];
  for (const e of entries) {
    const label = dayLabel(e.ts, now);
    const last = out.at(-1);
    if (last && last.label === label) last.entries.push(e);
    else out.push({ label, entries: [e] });
  }
  return out;
}

/** The time of day a file landed, for a row under its day's heading. */
const timeOf = (ts: number): string => new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * Arrow keys walk the grid the way Finder's do: across a row, and up or down to the tile in the
 * nearest column. Asked of the layout rather than computed from a column count, because the count
 * changes with the pane and a day's run of files ends mid-row.
 */
function walkGrid(e: ReactKeyboardEvent<HTMLElement>) {
  const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (!dir || e.metaKey || e.altKey || e.ctrlKey) return;
  const from = (e.target as HTMLElement).closest<HTMLElement>(".library-tile");
  if (!from) return;
  const tiles = [...e.currentTarget.querySelectorAll<HTMLElement>(".library-tile")];
  const at = from.getBoundingClientRect();
  const [dx, dy] = dir as [number, number];
  let best: HTMLElement | null = null;
  let bestCost = Infinity;
  for (const t of tiles) {
    if (t === from) continue;
    const r = t.getBoundingClientRect();
    const ox = r.left - at.left, oy = r.top - at.top;
    // Only tiles that lie in the arrow's direction; a row is one band of tops, a column of lefts.
    if (dx !== 0 && (Math.abs(oy) > at.height / 2 || Math.sign(ox) !== dx)) continue;
    if (dy !== 0 && (Math.abs(oy) < at.height / 2 || Math.sign(oy) !== dy)) continue;
    const cost = dx !== 0 ? Math.abs(ox) : Math.abs(oy) * 4 + Math.abs(ox);
    if (cost < bestCost) { bestCost = cost; best = t; }
  }
  if (!best) return;
  e.preventDefault();
  best.focus();
  best.scrollIntoView({ block: "nearest" });
}

/**
 * Every file every session in this profile made or was given, browsable.
 *
 * Reads the server's `artifacts` index one keyset page at a time. It deliberately does NOT fold
 * transcripts the way the per-session summary does: that fold needs every block of every transcript
 * in memory, which is affordable for the one session you are looking at and is not for a home with
 * two hundred of them (packages/contracts/src/library.ts).
 *
 * Laid out as Codex's library is: one toolbar over the files — the kinds as tabs, then the filter,
 * the view and the search — and the files as tiles or rows under it. The toolbar stands OUTSIDE the
 * scroller, so it stays put and legible while the files move under it (design.md: chrome that must
 * stay legible belongs outside the scroller).
 *
 * Paging is driven by a sentinel at the end of the list rather than by a scroll handler, so the cost
 * of "am I near the bottom" is the browser's rather than a listener firing on every wheel tick.
 *
 * Files come IN here too (the owner, 10-05: "an add button so the user can upload files to realm"):
 * the toolbar's Add, or files dropped anywhere on the page. Realm keeps a copy of each under the
 * profile (`library.add`), and they are listed as any other file is, with "Added" where the others
 * name a session. A dropped folder is a question, not a copy: the page asks before its files come in.
 */
/** What the Library page hands the files it takes from a drop. The page is the drop target — the whole
 *  of it, as a pane is a session's — and this column is what knows what to do with them. */
export type LibraryFilesHandle = { drop(files: File[]): void };

export function LibraryFiles({ spaceId, head, ref }: { spaceId: string;
  /** The page's head, drawn first in this column and scrolling away with it, the toolbar under it. */
  head?: ReactNode;
  ref?: Ref<LibraryFilesHandle> }) {
  const libraryArtifacts = useApp((s) => s.libraryArtifacts);
  // "Every space" is every space of THIS window's profile — profiles are separate homes for their
  // spaces, and the sidebar beside this page lists only its own.
  const profileId = useApp((s) => s.spaces.find((x) => x.id === spaceId)?.profileId ?? null);
  const view = useApp((s) => s.libraryView);
  const setLibraryView = useApp((s) => s.setLibraryView);
  const openViewer = useApp((s) => s.openViewer);
  const addLibraryFiles = useApp((s) => s.addLibraryFiles);
  const pickFiles = useApp((s) => s.pickFiles);
  const pathForFile = useApp((s) => s.pathForFile);
  const toast = useApp((s) => s.toast);
  // Moves with every add from this window, which is what makes the page ask for its first page again.
  const revision = useApp((s) => s.libraryRevision);
  const run = useApp((s) => s.run);

  const [scope, setScope] = useState<Scope>("all");
  const [kind, setKind] = useState<ArtifactKind | "all">("all");
  const [type, setType] = useState<ArtifactType | "all">("all");
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [filtering, setFiltering] = useState(false);
  /** The folders a drop left alone, while the page asks whether to add their files. */
  const [offer, setOffer] = useState<LibraryAddResult["folders"] | null>(null);
  const [adding, setAdding] = useState(false);
  const filterBtn = useRef<HTMLButtonElement>(null);
  /* The card that was clicked, in the media viewer with the page's other files beside it — each with
     the provenance the index joined on (which session, which space, made or uploaded), which is what
     the viewer names and whom its prompter asks. Re-deriving that from a path would be a second query
     for rows already in hand. */
  const preview = (e: LibraryEntry) => openViewer({
    files: entries.map((x) => ({ path: x.path, name: x.name,
      from: { sessionId: x.sessionId, spaceId: x.spaceId, sessionTitle: x.sessionTitle, kind: x.kind },
      // A file added to the Library lives in Realm's own folder, inside no checkout the documents pane
      // can open — so the viewer offers its default app instead, rather than a button that is refused.
      ...(x.kind === "added" ? { inPane: false } : {}) })),
    index: entries.indexOf(e), spaceId,
  });
  const sentinel = useRef<HTMLDivElement>(null);
  /* Every fetch carries the generation it was started under. A filter changed mid-flight would
     otherwise let an older page land on top of a newer one — the classic out-of-order-response bug,
     and the one that makes a file browser show results for a search you have already retyped. */
  const generation = useRef(0);

  const params = useCallback((before: { ts: number; id: string } | null) => ({
    spaceId: scope === "space" ? spaceId : null,
    profileId,
    kind: kind === "all" ? null : kind,
    type: type === "all" ? null : type,
    query, limit: LIBRARY_PAGE_SIZE, before,
  }), [scope, spaceId, profileId, kind, type, query]);

  // First page, and every re-query a filter, the search box or an add causes.
  useEffect(() => {
    const gen = ++generation.current;
    setLoading(true);
    run(async () => {
      const page = await libraryArtifacts(params(null));
      if (generation.current !== gen) return;
      setEntries(page.entries);
      setTotal(page.total);
      setDone(page.entries.length < LIBRARY_PAGE_SIZE);
      setLoading(false);
    });
  }, [params, revision, libraryArtifacts, run]);

  const more = useCallback(() => {
    const last = entries.at(-1);
    if (!last || done || loading) return;
    const gen = generation.current;
    setLoading(true);
    run(async () => {
      const page = await libraryArtifacts(params({ ts: last.ts, id: last.id }));
      if (generation.current !== gen) return;
      setEntries((prev) => [...prev, ...page.entries]);
      setDone(page.entries.length < LIBRARY_PAGE_SIZE);
      setLoading(false);
    });
  }, [entries, done, loading, params, libraryArtifacts, run]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || done) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) more(); });
    io.observe(el);
    return () => io.disconnect();
  }, [more, done]);

  /**
   * Add these paths to the Library and land on what came in: a narrowing that would hide a new file —
   * a tab of another kind, a search it does not match, one space or the other kinds — is undone, the
   * way making a thing lands you in it (design.md).
   */
  const add = async (paths: string[], folders = false) => {
    if (!profileId || paths.length === 0) return;
    setAdding(true);
    try {
      const r = await addLibraryFiles(profileId, paths, { folders });
      if (!r) return;
      const hidden = (e: LibraryEntry) => (type !== "all" && artifactTypeOf(e.ext) !== type)
        || (query.trim() !== "" && !e.name.toLowerCase().includes(query.trim().toLowerCase()));
      if (r.added.some(hidden)) { setType("all"); setQuery(""); }
      if (r.added.length > 0) { setScope("all"); if (kind !== "added") setKind("all"); }
      const asked = folderOffer(r.folders);
      for (const notice of asked.notices) toast(notice);
      setOffer(asked.offer);
    } finally { setAdding(false); }
  };
  const addFromPicker = () => run(async () => {
    const picked = await pickFiles();
    await add(picked.map((p) => p.path));
  });
  /* A drop names files by where they are on disk. One with no place on disk — dragged out of a web
     page, say — is not a file Realm can copy, and says so rather than vanishing. */
  useImperativeHandle(ref, () => ({
    drop(dropped) {
      const paths = dropped.map((f) => pathForFile(f));
      const nowhere = dropped.filter((_, i) => !paths[i]).map((f) => f.name || "a file");
      if (nowhere.length > 0) toast({ tone: "warning", text: `Only files on this Mac can be added: ${nameList(nowhere)}.` });
      run(() => add(paths.filter(Boolean)));
    },
  }));

  const groups = groupByDay(entries);
  const narrowed = scope !== "all" || kind !== "all";
  const filterItems: MenuItem[] = [
    ...(["space", "all"] as const).map((s) => ({ label: SCOPE_WORDS[s], checked: scope === s, onSelect: () => setScope(s) })),
    { kind: "separator" as const },
    ...(["all", "output", "upload", "added"] as const).map((k) => ({ label: KIND_WORDS[k], checked: kind === k, onSelect: () => setKind(k) })),
  ];

  return (
    <div className="library-files">
      <PageScroll wide>
        {head}
        <div className="library-toolbar">
          <div className="filter-chips library-types" role="group" aria-label="Kind of file">
            {TYPE_TABS.map((t) => (
              <button key={t.id} type="button" className="filter-chip" data-selected={type === t.id || undefined}
                aria-pressed={type === t.id} onClick={() => setType(t.id)}>{t.label}</button>
            ))}
            {/* A narrowing the filter menu made, said where the tabs are — so a list that is shorter
                than it should be says why — and undone from the same place. Only while it narrows. */}
            {scope !== "all" && (
              <button type="button" className="filter-chip library-narrowing" onClick={() => setScope("all")}
                title="Show files from every space">
                {SCOPE_WORDS[scope]} <Icon name="close" size={12} />
              </button>
            )}
            {kind !== "all" && (
              <button type="button" className="filter-chip library-narrowing" onClick={() => setKind("all")}
                title="Show every file, made or uploaded">
                {KIND_WORDS[kind]} <Icon name="close" size={12} />
              </button>
            )}
          </div>
          <div className="library-tools">
            <button ref={filterBtn} type="button" className="icon-btn library-filter" aria-label="Filter files"
              aria-haspopup="menu" aria-expanded={filtering} data-on={narrowed || undefined}
              title={`${SCOPE_WORDS[scope]} · ${KIND_WORDS[kind]}`}
              onClick={() => setFiltering((v) => !v)}>
              <Icon name="filter" size={16} />
            </button>
            <fieldset className="seg library-view">
              <legend className="visually-hidden">View files as</legend>
              {(["grid", "list"] as const).map((v) => (
                <label key={v} className="seg-opt" data-selected={view === v || undefined} title={v === "grid" ? "Tiles" : "Rows"}>
                  <input type="radio" name="library-view" value={v} checked={view === v}
                    onChange={() => run(() => setLibraryView(v))} aria-label={v === "grid" ? "Tiles" : "Rows"} />
                  <Icon name={v} size={14} />
                </label>
              ))}
            </fieldset>
            <label className="library-search">
              <Icon name="search" size={14} />
              <input className="search-field" type="search" aria-label="Search files" placeholder="Search files"
                value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            {/* The toolbar's one action, at its end: what the page holds is the work's, and this is the
                way in for the person's own. */}
            <button type="button" className="btn library-add" onClick={addFromPicker} disabled={adding} aria-busy={adding || undefined}
              title="Add files from this Mac to the Library. Realm keeps its own copy of each.">
              <Icon name="add" size={14} />Add
            </button>
          </div>
        </div>
        {offer && (
          /* A decision, so it stays until it is answered, where the drop was — never a toast, which
             would leave before the person had read it. Escape leaves the page, and is no answer. */
          <div className="library-offer" role="group" aria-label="Add the files in a folder">
            <p className="library-offer-text">{folderOfferText(offer)}</p>
            <div className="library-offer-actions">
              <button type="button" className="btn" onClick={() => setOffer(null)}>Not now</button>
              <button type="button" className="btn primary" disabled={adding}
                onClick={() => { const paths = offer.map((f) => f.path); setOffer(null); run(() => add(paths, true)); }}>
                Add {offerCount(offer) === 1 ? "1 file" : `${offerCount(offer)} files`}
              </button>
            </div>
          </div>
        )}
        {filtering && <Menu items={filterItems} anchorRef={filterBtn} align="right" label="Filter files" onClose={() => setFiltering(false)} />}

        {/* Two different emptinesses, and they need different words. "Nothing here yet" over a home
            with four hundred files, because the search matched none of them, is a lie about the app. */}
        {entries.length === 0 && !loading && (
          <p className="env-empty library-empty">
            {total === 0
              ? "Nothing here yet. Every file a session writes, every file you attach to a message, and every file you add shows up here."
              : "No file here matches that."}
          </p>
        )}

        {groups.map((g) => (
          <section key={`${g.label}-${g.entries[0]!.id}`} className="library-day">
            <h2 className="library-day-label">{g.label}</h2>
            {view === "grid" ? (
              <ul className="library-grid" onKeyDown={walkGrid}>
                {g.entries.map((e) => (
                  <li key={e.id}>
                    <FileCard path={e.path} name={e.name} type={artifactTypeOf(e.ext)} title={e.path} onOpen={() => preview(e)}>
                      <Provenance entry={e} />
                    </FileCard>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="library-rows">
                {g.entries.map((e) => (
                  <li key={e.id}>
                    <FileRow path={e.path} name={e.name} type={artifactTypeOf(e.ext)} title={e.path} time={timeOf(e.ts)} onOpen={() => preview(e)}>
                      <Provenance entry={e} />
                    </FileRow>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}

        {/* The pager. Present only while there is more, so an exhausted list has no observer attached
            and no spinner sitting under it forever. */}
        {!done && <div ref={sentinel} className="library-more">{loading ? "Loading…" : ""}</div>}
      </PageScroll>
    </div>
  );
}

/**
 * A Library card's second line: where the file came from, which is the question a file browser over
 * many sessions is really answering. The kind rides here too — "made" and "uploaded" are the same
 * file to the filesystem and very different facts to the reader. The card itself is shared with the
 * session's file browser (`FileCard`); this line is the one thing the Library knows that a folder
 * listing does not.
 *
 * Every card opens, and that is the change the picture is only half of. The grid used to draw a live
 * tile for a file the documents pane could render and an inert grey box for every other one — which
 * in a home whose sessions write archives, images and binaries is most of them, sitting there
 * refusing the mouse with no way to find out why. A card now opens the media viewer whatever the
 * file is, and the viewer is where "what can Realm actually do with this" gets answered honestly.
 */
function Provenance({ entry }: { entry: LibraryEntry }) {
  /* A file the person added has no session to name, and the line says the one thing true of it, in
     the same quiet place and glyph-first shape: the Add button's mark, and "Added". */
  if (entry.kind === "added") {
    return (
      <span className="library-tile-from" title="Added by you">
        <Icon name="add" size={12} className="library-tile-kind" aria-hidden="true" />
        <span className="library-tile-session" aria-hidden="true">Added</span>
        <span className="visually-hidden">Added by you</span>
      </span>
    );
  }
  const fromLabel = `${entry.kind === "upload" ? "Attached to " : "Made in "}${entry.sessionTitle ?? "a session"}`;
  return (
    /* The kind is a GLYPH and the session title takes the whole line, which is the yielding order
       the row could not otherwise get right: the title is user data of unbounded length and
       "Made in " is eight fixed characters that always take their width first. On a 233px card
       that prefix was the difference between "planning a cool new app" and "planning a cool ne…",
       so the boilerplate was eating the only part of the line that varies. The sentence is not
       lost — it is the accessible name and the tooltip, which is where a thing that reads the
       same on every card in the grid belongs. */
    <span className="library-tile-from" title={fromLabel}>
      <Icon name={entry.kind === "upload" ? "attach" : "artifact"} size={12} className="library-tile-kind" aria-hidden="true" />
      <span className="library-tile-session" aria-hidden="true">{entry.sessionTitle}</span>
      <span className="visually-hidden">{fromLabel}</span>
    </span>
  );
}

export { ARTIFACT_KINDS };
