import { artifactsFromEvent, extsOfType, KNOWN_EXTS, LibraryQuerySchema, type Artifact, type ArtifactKind, type ArtifactType, type LibraryEntry, type LibraryQuery } from "@realm/contracts";
import type { Db } from "../db/database";
import type { SettingsStore } from "./settings";

/** The resumable event-backfill cursor, written by migration v25 and advanced by `runBackfill`.
 *  `done` is the last seq indexed; `target` is frozen at migration time — events past it are indexed
 *  at write time (SessionEventsStore.append), so the two writers can never double-index a row. */
export const ARTIFACTS_BACKFILL_KEY = "artifacts.backfill";

/** Events scanned per backfill transaction. Same size and same reasoning as the search backfill's:
 *  small enough that one chunk never blocks the (synchronous) event loop noticeably, and the loop
 *  yields between chunks so RPC stays responsive while a long history is indexed for the first time. */
export const ARTIFACTS_BACKFILL_CHUNK = 500;

type Row = {
  id: string; session_id: string | null; kind: string; path: string; name: string; ext: string; ts: number;
  session_title: string | null; agent_kind: string | null; space_id: string | null;
};

const toEntry = (r: Row): LibraryEntry => ({
  id: r.id, sessionId: r.session_id, spaceId: r.space_id, kind: r.kind as LibraryEntry["kind"],
  path: r.path, name: r.name, ext: r.ext, ts: r.ts,
  sessionTitle: r.session_title, agentKind: r.agent_kind,
});

/**
 * One of the Library's two sources, as the rows it yields under the columns both share, and the clauses
 * that narrow it. `t` is the alias its file columns are read through.
 *
 * Two, because a file someone ADDED is not an artifact (migration v40): the index holds what sessions
 * made and were given, joined to its session for the title and the space, and `library_files` holds
 * what a person put in the Library, which belongs to a profile and to no session.
 */
type Source = { t: "a" | "f"; select: string; where: string[]; args: (string | number)[] };

const MADE = `SELECT a.id AS id, a.session_id AS session_id, a.kind AS kind, a.path AS path, a.name AS name, a.ext AS ext, a.ts AS ts,
  s.title AS session_title, s.agent_kind AS agent_kind, s.space_id AS space_id
  FROM artifacts a JOIN sessions s ON s.id = a.session_id`;
const ADDED = `SELECT f.id AS id, NULL AS session_id, 'added' AS kind, f.path AS path, f.name AS name, f.ext AS ext, f.ts AS ts,
  NULL AS session_title, NULL AS agent_kind, NULL AS space_id
  FROM library_files f`;

/**
 * The sources a query can find rows in, each narrowed to the query's scope. An added file is in no space
 * and no session and is only ever `added`, so a query for a space, a session or another kind leaves that
 * source out altogether — and one for `added` leaves out the index.
 */
function sourcesFor(q: { spaceId: string | null; profileId: string | null; sessionId: string | null; kind: ArtifactKind | null }): Source[] {
  const out: Source[] = [];
  if (q.kind !== "added") {
    const made: Source = { t: "a", select: MADE, where: [], args: [] };
    if (q.spaceId !== null) { made.where.push("s.space_id = ?"); made.args.push(q.spaceId); }
    if (q.profileId !== null) { made.where.push("s.space_id IN (SELECT id FROM spaces WHERE profile_id = ?)"); made.args.push(q.profileId); }
    if (q.sessionId !== null) { made.where.push("a.session_id = ?"); made.args.push(q.sessionId); }
    if (q.kind !== null) { made.where.push("a.kind = ?"); made.args.push(q.kind); }
    out.push(made);
  }
  if ((q.kind === null || q.kind === "added") && q.spaceId === null && q.sessionId === null) {
    const added: Source = { t: "f", select: ADDED, where: [], args: [] };
    if (q.profileId !== null) { added.where.push("f.profile_id = ?"); added.args.push(q.profileId); }
    out.push(added);
  }
  return out;
}

/** The type and the name a person narrowed by, applied to one source through its own alias. */
function narrow(src: Source, q: { type: ArtifactType | null; query: string }): void {
  if (q.type !== null) {
    // "Other" is everything no type claims, so it is the complement of the whole table of them —
    // an extension a later build learns to call code stops being other without a migration.
    const exts = q.type === "other" ? KNOWN_EXTS : extsOfType(q.type);
    src.where.push(`${src.t}.ext ${q.type === "other" ? "NOT IN" : "IN"} (${exts.map(() => "?").join(", ")})`);
    src.args.push(...exts);
  }
  const needle = q.query.trim();
  if (needle !== "") {
    src.where.push(`${src.t}.name LIKE ? ESCAPE '\\'`);
    src.args.push(`%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
}

const sqlOf = (src: Source): string => `${src.select}${src.where.length > 0 ? ` WHERE ${src.where.join(" AND ")}` : ""}`;
const argsOf = (sources: Source[]): (string | number)[] => sources.flatMap((src) => src.args);

/**
 * The Library's index over every file a session ever wrote or was given — read, for the page, together
 * with the files a person added to the Library themselves (`library_files`, `LibraryFilesStore`).
 *
 * Writes go through `index`, called from the one choke point every persisted event passes through
 * (`SessionEventsStore.append`) — the same placement the search index takes, and for the same
 * reason: no producer, not the pump, not `emitExternal`, not boot's synthetic denials, can skip it.
 *
 * Reads are one indexed range scan, keyset-paged. Never OFFSET: the table grows at the head, and an
 * offset page over a growing list repeats and skips rows under the user while they scroll it.
 */
export class ArtifactsStore {
  constructor(private db: Db, private settings: SettingsStore) {}

  /** Index whatever one persisted event produced. A no-op for the great majority of events, which is
   *  why the extraction is total rather than a type switch here — see `artifactsFromEvent`. */
  index(sessionId: string, seq: number, ts: number, type: string, payload: unknown): void {
    const rows = artifactsFromEvent({ sessionId, spaceId: "", seq, ts, type, payload });
    if (rows.length === 0) return;
    const ins = this.db.prepare(
      "INSERT OR REPLACE INTO artifacts (id, session_id, seq, kind, path, name, ext, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const a of rows) ins.run(a.id, a.sessionId, seq, a.kind, a.path, a.name, a.ext, a.ts);
  }

  /**
   * One page, newest first.
   *
   * `spaceId` filters through the join rather than a stored column (see the migration). `query`
   * matches the NAME — a user hunting for `report.md` should not have to also match the eleven
   * directories above it — and is escaped for LIKE so a path with a `%` in it is a literal.
   *
   * `perFile` collapses the rows to each path's newest BEFORE the keyset applies. The other order
   * pages wrongly: a cursor that cut off a file's newest row would make an older row of the same file
   * its newest, and the next page would list the file a second time.
   */
  list(input: LibraryQuery): LibraryEntry[] {
    const q = LibraryQuerySchema.parse(input);
    const sources = sourcesFor(q);
    if (sources.length === 0) return [];
    for (const src of sources) narrow(src, q);
    const rows = (q.perFile ? this.newestPerFile(sources, q) : this.everyRow(sources, q)) as Row[];
    return rows.map(toEntry);
  }

  /**
   * Newest first across both sources, one page of them. Each source is narrowed and keyset-cut on its
   * own and the two are merged in order, so each still reads off its own `(ts, id)` index and the page
   * stops at `limit` rather than sorting every row there is.
   */
  private everyRow(sources: Source[], q: { before: { ts: number; id: string } | null; limit: number }): unknown[] {
    if (q.before !== null) {
      // Strict lexicographic on the same pair the index is ordered by, so a page boundary that lands
      // inside a millisecond neither repeats a row nor drops one.
      for (const src of sources) {
        src.where.push(`(${src.t}.ts < ? OR (${src.t}.ts = ? AND ${src.t}.id < ?))`);
        src.args.push(q.before.ts, q.before.ts, q.before.id);
      }
    }
    return this.db.prepare(`${sources.map(sqlOf).join(" UNION ALL ")} ORDER BY ts DESC, id DESC LIMIT ?`).all(...argsOf(sources), q.limit);
  }

  /** The same rows collapsed to each path's newest, the keyset applied to what is left. */
  private newestPerFile(sources: Source[], q: { before: { ts: number; id: string } | null; limit: number }): unknown[] {
    const outer = q.before === null ? "" : "AND (ts < ? OR (ts = ? AND id < ?))";
    const page = q.before === null ? [] : [q.before.ts, q.before.ts, q.before.id];
    return this.db.prepare(`
      SELECT * FROM (
        SELECT r.*, ROW_NUMBER() OVER (PARTITION BY r.path ORDER BY r.ts DESC, r.id DESC) AS newest
        FROM (${sources.map(sqlOf).join(" UNION ALL ")}) r)
      WHERE newest = 1 ${outer}
      ORDER BY ts DESC, id DESC LIMIT ?`).all(...argsOf(sources), ...page, q.limit);
  }

  /** How many rows the Library holds in a scope, for the page's own "nothing here yet" versus "nothing
   *  matches" distinction — the same distinction the schedules page draws. Counted the way the list
   *  is read: files, not events, when the list is one row per file. */
  count(spaceId: string | null, profileId: string | null = null, { sessionId = null, perFile = false }: { sessionId?: string | null; perFile?: boolean } = {}): number {
    const sources = sourcesFor({ spaceId, profileId, sessionId, kind: null });
    if (sources.length === 0) return 0;
    const r = this.db.prepare(`SELECT COUNT(${perFile ? "DISTINCT path" : "*"}) AS n FROM (${sources.map(sqlOf).join(" UNION ALL ")})`)
      .get(...argsOf(sources)) as { n: number };
    return r.n;
  }

  /**
   * Whether a session made or was given this exact path, or a person added it to the Library — the
   * files the documents pane lists, and so the only files outside a space's folder it will READ
   * (`DocumentService.read`). Matched as recorded: a row is only ever a path some session or person
   * named, never one a caller composed.
   */
  records(path: string): boolean {
    return this.db.prepare("SELECT 1 FROM artifacts WHERE path = ? UNION ALL SELECT 1 FROM library_files WHERE path = ? LIMIT 1")
      .get(path, path) !== undefined;
  }

  readCursor(): { done: number; target: number } | null {
    const v = this.settings.get(ARTIFACTS_BACKFILL_KEY);
    if (!v || typeof v !== "object") return null;
    const { done, target } = v as { done?: unknown; target?: unknown };
    return typeof done === "number" && typeof target === "number" ? { done, target } : null;
  }

  /**
   * Walk the history once, in chunks, indexing what it finds.
   *
   * A failed chunk (disk full, database closing under shutdown) leaves the cursor where it was and
   * the next boot resumes from there. The Library over the not-yet-covered range is merely
   * incomplete, never wrong — which is the property that makes it safe to run this in the
   * background while the app is already usable.
   */
  async runBackfill(stopped: () => boolean, onLog: (line: string) => void = (l) => console.error(l)): Promise<void> {
    for (;;) {
      if (stopped()) return;
      const cursor = this.readCursor();
      if (!cursor || cursor.done >= cursor.target) return;
      try {
        const rows = this.db.prepare(`
          SELECT seq, session_id, ts, type, payload_json FROM session_events
          WHERE seq > ? AND seq <= ? AND type IN ('tool_call', 'user_message')
          ORDER BY seq LIMIT ?`).all(cursor.done, cursor.target, ARTIFACTS_BACKFILL_CHUNK) as
          { seq: number; session_id: string; ts: number; type: string; payload_json: string }[];
        /* A short chunk means the range is exhausted, so the cursor jumps to `target` rather than to
           the last row's seq — otherwise a history whose final events are all `assistant_text` would
           leave the cursor short of target forever and re-scan the same tail on every boot. */
        const done = rows.length < ARTIFACTS_BACKFILL_CHUNK ? cursor.target : Number(rows.at(-1)!.seq);
        this.db.exec("BEGIN");
        try {
          for (const r of rows) {
            let payload: unknown;
            try { payload = JSON.parse(r.payload_json); } catch { continue; }
            this.index(r.session_id, r.seq, r.ts, r.type, payload);
          }
          this.settings.set(ARTIFACTS_BACKFILL_KEY, { done, target: cursor.target });
          this.db.exec("COMMIT");
        } catch (e) { this.db.exec("ROLLBACK"); throw e; }
        if (rows.length > 0) onLog(`[library] indexed ${rows.length} events (through seq ${done} of ${cursor.target})`);
      } catch (e) {
        onLog(`[library] backfill paused: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      await new Promise((r) => setImmediate(r));
    }
  }
}

export type { Artifact };
