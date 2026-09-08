import { artifactsFromEvent, LibraryQuerySchema, type Artifact, type LibraryEntry, type LibraryQuery } from "@realm/contracts";
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
  id: string; session_id: string; seq: number; kind: string; path: string; name: string; ext: string; ts: number;
  session_title: string; agent_kind: string;
};

const toEntry = (r: Row): LibraryEntry => ({
  id: r.id, sessionId: r.session_id, spaceId: "", kind: r.kind as LibraryEntry["kind"],
  path: r.path, name: r.name, ext: r.ext, ts: r.ts,
  sessionTitle: r.session_title, agentKind: r.agent_kind,
});

/**
 * The Library's index over every file a session ever wrote or was given.
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
   */
  list(input: LibraryQuery): LibraryEntry[] {
    const q = LibraryQuerySchema.parse(input);
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.spaceId !== null) { where.push("s.space_id = ?"); args.push(q.spaceId); }
    if (q.kind !== null) { where.push("a.kind = ?"); args.push(q.kind); }
    const needle = q.query.trim();
    if (needle !== "") {
      where.push("a.name LIKE ? ESCAPE '\\'");
      args.push(`%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    if (q.before !== null) {
      // Strict lexicographic on the same pair the index is ordered by, so a page boundary that lands
      // inside a millisecond neither repeats a row nor drops one.
      where.push("(a.ts < ? OR (a.ts = ? AND a.id < ?))");
      args.push(q.before.ts, q.before.ts, q.before.id);
    }
    const rows = this.db.prepare(`
      SELECT a.*, s.title AS session_title, s.agent_kind, s.space_id
      FROM artifacts a JOIN sessions s ON s.id = a.session_id
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY a.ts DESC, a.id DESC LIMIT ?`).all(...args, q.limit) as (Row & { space_id: string })[];
    return rows.map((r) => ({ ...toEntry(r), spaceId: r.space_id }));
  }

  /** How many rows the index holds, for the page's own "nothing here yet" versus "nothing matches"
   *  distinction — the same distinction the schedules page draws. */
  count(spaceId: string | null): number {
    const r = spaceId === null
      ? this.db.prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number }
      : this.db.prepare("SELECT COUNT(*) AS n FROM artifacts a JOIN sessions s ON s.id = a.session_id WHERE s.space_id = ?").get(spaceId) as { n: number };
    return r.n;
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
