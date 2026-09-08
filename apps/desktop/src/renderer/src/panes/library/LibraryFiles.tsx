import { Icon, type IconName } from "@realm/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { ARTIFACT_KINDS, artifactTypeOf, isOpenableArtifact, LIBRARY_PAGE_SIZE, type ArtifactKind, type ArtifactType, type LibraryEntry } from "@realm/contracts";
import { useApp } from "../../state/store";
import { SCOPE_LABEL } from "../../components/scoped/ScopeGroups";

/** Files first, then a scope, then a kind — the three narrowings, coarsest first. */
const SCOPES = [
  { id: "space", label: SCOPE_LABEL.thisSpace },
  { id: "all", label: SCOPE_LABEL.everywhere },
] as const;
type Scope = (typeof SCOPES)[number]["id"];

const KIND_FILTERS: { id: ArtifactKind | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "output", label: "Made" },
  { id: "upload", label: "Uploaded" },
];

/** One glyph per broad type. Coarse on purpose — a file browser's icon answers "what kind of thing
 *  is this" at a glance, and thirty glyphs answer it more slowly than seven. */
const TYPE_ICON: Record<ArtifactType, IconName> = {
  document: "documents", image: "image", video: "video", audio: "musicNote",
  data: "table", code: "code", other: "artifact",
};

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
 *  year apart that happen to render the same words. */
export function groupByDay(entries: LibraryEntry[], now = Date.now()): { label: string; entries: LibraryEntry[] }[] {
  const out: { label: string; entries: LibraryEntry[] }[] = [];
  for (const e of entries) {
    const label = dayLabel(e.ts, now);
    const last = out.at(-1);
    if (last && last.label === label) last.entries.push(e);
    else out.push({ label, entries: [e] });
  }
  return out;
}

/**
 * Every file every session in this profile made or was given, browsable.
 *
 * Reads the server's `artifacts` index one keyset page at a time. It deliberately does NOT fold
 * transcripts the way the per-session summary does: that fold needs every block of every transcript
 * in memory, which is affordable for the one session you are looking at and is not for a home with
 * two hundred of them (packages/contracts/src/library.ts).
 *
 * Paging is driven by a sentinel at the end of the list rather than by a scroll handler, so the cost
 * of "am I near the bottom" is the browser's rather than a listener firing on every wheel tick.
 */
export function LibraryFiles({ spaceId }: { spaceId: string }) {
  const libraryArtifacts = useApp((s) => s.libraryArtifacts);
  const openDocumentPath = useApp((s) => s.openDocumentPath);
  const run = useApp((s) => s.run);

  const [scope, setScope] = useState<Scope>("all");
  const [kind, setKind] = useState<ArtifactKind | "all">("all");
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const sentinel = useRef<HTMLDivElement>(null);
  /* Every fetch carries the generation it was started under. A filter changed mid-flight would
     otherwise let an older page land on top of a newer one — the classic out-of-order-response bug,
     and the one that makes a file browser show results for a search you have already retyped. */
  const generation = useRef(0);

  const params = useCallback((before: { ts: number; id: string } | null) => ({
    spaceId: scope === "space" ? spaceId : null,
    kind: kind === "all" ? null : kind,
    query, limit: LIBRARY_PAGE_SIZE, before,
  }), [scope, spaceId, kind, query]);

  // First page, and every re-query a filter or the search box causes.
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
  }, [params, libraryArtifacts, run]);

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

  const groups = groupByDay(entries);

  return (
    <div className="library-files">
      <div className="page-filters">
        <input className="search-field" type="search" aria-label="Search files" placeholder="Search files…"
          value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="filter-chips" role="group" aria-label="Filter files">
          {SCOPES.map((s) => (
            <button key={s.id} type="button" className="filter-chip" data-selected={scope === s.id || undefined}
              aria-pressed={scope === s.id} onClick={() => setScope(s.id)}>{s.label}</button>
          ))}
          <span className="filter-sep" aria-hidden="true" />
          {KIND_FILTERS.map((k) => (
            <button key={k.id} type="button" className="filter-chip" data-selected={kind === k.id || undefined}
              aria-pressed={kind === k.id} onClick={() => setKind(k.id)}>{k.label}</button>
          ))}
        </div>
      </div>

      {/* Two different emptinesses, and they need different words. "Nothing here yet" over a home
          with four hundred files, because the search matched none of them, is a lie about the app. */}
      {entries.length === 0 && !loading && (
        <p className="env-empty">
          {total === 0
            ? "Nothing here yet. Every file a session writes, and every file you attach to a message, shows up here."
            : "No file here matches that."}
        </p>
      )}

      {groups.map((g) => (
        <section key={`${g.label}-${g.entries[0]!.id}`} className="library-day">
          <h2 className="library-day-label">{g.label}</h2>
          <ul className="library-grid">
            {g.entries.map((e) => (
              <li key={e.id}>
                <button type="button" className="library-tile" title={e.path}
                  data-openable={isOpenableArtifact(e.path) || undefined}
                  onClick={() => { if (isOpenableArtifact(e.path)) run(() => openDocumentPath(e.path)); }}>
                  <span className="library-tile-mark" data-type={artifactTypeOf(e.ext)}>
                    <Icon name={TYPE_ICON[artifactTypeOf(e.ext)]} size={18} />
                  </span>
                  <span className="library-tile-name">{e.name}</span>
                  {/* Where it came from, which is the question a file browser over many sessions is
                      really answering. The kind rides here too — "made" and "uploaded" are the same
                      file to the filesystem and very different facts to the reader. */}
                  <span className="library-tile-from">
                    {e.kind === "upload" ? "Uploaded to " : "Made in "}{e.sessionTitle}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {/* The pager. Present only while there is more, so an exhausted list has no observer attached
          and no spinner sitting under it forever. */}
      {!done && <div ref={sentinel} className="library-more">{loading ? "Loading…" : ""}</div>}
    </div>
  );
}

export { ARTIFACT_KINDS };
