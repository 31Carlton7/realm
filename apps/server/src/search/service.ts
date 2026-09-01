import type { ItemKind, ItemSearchHit, MemorySearchHit, SearchResults, SearchSnippet, SessionSearchHit, SkillSearchHit } from "@realm/contracts";
import { SEARCH_GROUP_LIMIT } from "@realm/contracts";
import type { Db } from "../db/database";
import type { SettingsStore } from "../store/settings";
import type { ProfilesStore } from "../store/profiles";
import type { SpacesStore } from "../store/spaces";
import type { SkillsService } from "../skills/service";
import type { MemoryService } from "../memory/service";
import { NotFoundError } from "../store/rows";

/** The resumable event-backfill cursor, written by migration v15 and advanced by `runBackfill`.
 *  `done` is the last seq indexed; `target` is frozen at migration time — events past it are indexed
 *  at write time (SessionEventsStore.append), so the two writers can never double-index a row. */
export const SEARCH_BACKFILL_KEY = "search.backfill";
/** Events scanned per backfill transaction. Small enough that one chunk never blocks the (sync)
 *  event loop noticeably; the loop yields between chunks so RPC stays responsive during a large
 *  history's first boot on this schema. */
export const BACKFILL_CHUNK = 500;

/** Snippet window bounds for the live (file-backed) sources, roughly matching what FTS5's own
 *  `snippet()` yields for the indexed ones. */
const LIVE_SNIPPET_BEFORE = 32;
const LIVE_SNIPPET_WINDOW = 120;

/** FTS5 snippet markers. Control bytes so they cannot collide with query syntax; they never reach the
 *  wire — `parseFtsSnippet` turns them into `{text, match}` segments. */
const MARK_START = "\u0001";
const MARK_END = "\u0002";

/**
 * Lowercased word tokens of a query. The split mirrors what unicode61 treats as separators closely
 * enough for the live sources; FTS applies its own tokenizer to the quoted tokens.
 */
export function queryTokens(raw: string): string[] {
  return raw.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((t) => t !== "");
}

/**
 * A raw palette query as a safe FTS5 MATCH expression: every token double-quoted (so `AND`, `-`,
 * `:` and stray quotes are content, never syntax), the last token a prefix query — the palette
 * searches while the user is mid-word. Null when the query holds no word characters at all.
 */
export function ftsExpression(raw: string): string | null {
  const tokens = queryTokens(raw);
  if (tokens.length === 0) return null;
  return tokens.map((t, i) => `"${t}"${i === tokens.length - 1 ? "*" : ""}`).join(" ");
}

/** FTS5 `snippet()` output (with the control-byte markers) as alternating segments. */
export function parseFtsSnippet(s: string): SearchSnippet {
  const out: SearchSnippet = [];
  let i = 0, match = false;
  while (i < s.length) {
    const next = s.indexOf(match ? MARK_END : MARK_START, i);
    const end = next === -1 ? s.length : next;
    if (end > i) out.push({ text: s.slice(i, end), match });
    if (next === -1) break;
    i = next + 1; match = !match;
  }
  return out;
}

/**
 * Whether live (unindexed, file-backed) text matches the query: every token a substring,
 * case-insensitive. Deliberately LOOSER than FTS's word-prefix semantics — a live source that
 * over-matches slightly is a row the user can ignore; one that under-matches is a skill they
 * cannot find.
 */
export function liveMatches(text: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const lower = text.toLowerCase();
  return tokens.every((t) => lower.includes(t));
}

/** A windowed snippet of live text with every in-window token occurrence marked. */
export function liveSnippet(text: string, tokens: string[]): SearchSnippet {
  const lower = text.toLowerCase();
  // Every occurrence of every token, as [start, end) ranges, merged where they overlap.
  const ranges: [number, number][] = [];
  for (const t of tokens) {
    for (let at = lower.indexOf(t); at !== -1; at = lower.indexOf(t, at + 1)) ranges.push([at, at + t.length]);
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([...r] as [number, number]);
  }
  const first = merged[0]?.[0] ?? 0;
  const start = Math.max(0, first - LIVE_SNIPPET_BEFORE);
  const end = Math.min(text.length, start + LIVE_SNIPPET_WINDOW);
  const out: SearchSnippet = [];
  if (start > 0) out.push({ text: "…", match: false });
  let i = start;
  for (const [a, b] of merged) {
    if (b <= start || a >= end) continue;
    const ca = Math.max(a, start), cb = Math.min(b, end);
    if (ca > i) out.push({ text: text.slice(i, ca), match: false });
    out.push({ text: text.slice(ca, cb), match: true });
    i = cb;
  }
  if (i < end) out.push({ text: text.slice(i, end), match: false });
  if (end < text.length) out.push({ text: "…", match: false });
  return out;
}

type SessionRow = { session_id: string; seq: number; space_id: string; title: string; snip: string };
type ItemRow = { item_id: string; space_id: string; item_kind: ItemKind; title: string; snip: string };

/**
 * Global search (Plan 16 W1), scoped to ONE profile per query.
 *
 * Two kinds of source, split by who owns the writes:
 *
 *  - **DB-backed text** (session user/assistant events, item titles) is FTS5-indexed at write time —
 *    every write path runs through a store choke point that also writes the index row, so the index
 *    can never miss a source. Scoping is a query-time join through the LIVE sessions/items→spaces
 *    tables: a space moved to another profile answers for its new profile immediately, because
 *    nothing profile-shaped is baked into the index.
 *  - **File-backed text** (skills, memory documents) is read live at query time. Both are files the
 *    user is invited to edit outside Realm (the library folder in Finder, the memory doc at a path
 *    the panel displays), so any index over them would be a cache with no invalidation story. They
 *    are small and few; a debounced palette query affords the reads.
 */
export class SearchService {
  private stopped = false;
  constructor(private d: {
    db: Db; settings: SettingsStore; profiles: ProfilesStore; spaces: SpacesStore;
    skills: SkillsService; memory: MemoryService;
  }) {}

  query(profileId: string, raw: string, limit = SEARCH_GROUP_LIMIT): SearchResults {
    if (!this.d.profiles.get(profileId)) throw new NotFoundError("profile", profileId);
    const expr = ftsExpression(raw);
    const tokens = queryTokens(raw);
    if (!expr) return { sessions: [], items: [], skills: [], memory: [] };
    return {
      sessions: this.sessions(profileId, expr, limit),
      items: this.items(profileId, expr, limit),
      skills: this.skills(profileId, tokens, limit),
      memory: this.memory(profileId, tokens, limit),
    };
  }

  /** Transcript hits, best (bm25) first, at most one per session — a session that said the word ten
   *  times is one place to jump to, not ten rows. */
  private sessions(profileId: string, expr: string, limit: number): SessionSearchHit[] {
    const rows = this.d.db.prepare(`
      SELECT search_index.ref AS session_id, search_index.seq AS seq, s.space_id, s.title,
             snippet(search_index, 0, ?, ?, '…', 12) AS snip
      FROM search_index
      JOIN sessions s ON s.id = search_index.ref
      JOIN spaces sp ON sp.id = s.space_id
      WHERE search_index MATCH ? AND search_index.kind = 'session' AND sp.profile_id = ?
      ORDER BY bm25(search_index) LIMIT ?`)
      .all(MARK_START, MARK_END, expr, profileId, limit * 4) as SessionRow[];
    const seen = new Set<string>();
    const out: SessionSearchHit[] = [];
    for (const r of rows) {
      if (seen.has(r.session_id)) continue;
      seen.add(r.session_id);
      out.push({ sessionId: r.session_id, spaceId: r.space_id, title: r.title, seq: Number(r.seq), snippet: parseFtsSnippet(r.snip) });
      if (out.length >= limit) break;
    }
    return out;
  }

  private items(profileId: string, expr: string, limit: number): ItemSearchHit[] {
    const rows = this.d.db.prepare(`
      SELECT search_index.ref AS item_id, i.space_id, i.kind AS item_kind, i.title,
             snippet(search_index, 0, ?, ?, '…', 12) AS snip
      FROM search_index
      JOIN items i ON i.id = search_index.ref
      JOIN spaces sp ON sp.id = i.space_id
      WHERE search_index MATCH ? AND search_index.kind = 'item' AND sp.profile_id = ?
        AND i.id NOT IN (SELECT terminal_item_id FROM sessions WHERE terminal_item_id IS NOT NULL)
      ORDER BY bm25(search_index) LIMIT ?`)
      .all(MARK_START, MARK_END, expr, profileId, limit) as ItemRow[];
    return rows.map((r) => ({ itemId: r.item_id, spaceId: r.space_id, itemKind: r.item_kind, title: r.title, snippet: parseFtsSnippet(r.snip) }));
  }

  /** Skills whose scope reaches any space of this profile, matched live against name + description.
   *  The union across the profile's spaces IS the scoping — `SkillsService.list` already answers the
   *  reach question per space, and search must not grow a second copy of that rule. */
  private skills(profileId: string, tokens: string[], limit: number): SkillSearchHit[] {
    const out = new Map<string, SkillSearchHit>();
    for (const sp of this.d.spaces.list(profileId)) {
      for (const sk of this.d.skills.list(sp.id).skills) {
        if (!sk.valid || out.has(sk.id)) continue;
        const haystack = `${sk.name} ${sk.description}`;
        if (!liveMatches(haystack, tokens)) continue;
        const source = liveMatches(sk.description, tokens) ? sk.description : haystack;
        out.set(sk.id, { id: sk.id, name: sk.name, description: sk.description, snippet: liveSnippet(source, tokens) });
      }
      if (out.size >= limit) break;
    }
    return [...out.values()].slice(0, limit);
  }

  /** Memory documents of this profile's world: the profile doc, then each of its spaces' docs. */
  private memory(profileId: string, tokens: string[], limit: number): MemorySearchHit[] {
    const out: MemorySearchHit[] = [];
    const profile = this.d.profiles.get(profileId);
    const profileDoc = this.d.memory.readProfileDoc(profileId);
    if (profile && liveMatches(profileDoc, tokens)) {
      out.push({ scope: "profile", profileId, spaceId: null, title: `${profile.name} profile memory`, snippet: liveSnippet(profileDoc, tokens) });
    }
    for (const sp of this.d.spaces.list(profileId)) {
      if (out.length >= limit) break;
      const doc = this.d.memory.readDoc(sp.id);
      if (!liveMatches(doc, tokens)) continue;
      out.push({ scope: "space", profileId: null, spaceId: sp.id, title: `${sp.name} memory`, snippet: liveSnippet(doc, tokens) });
    }
    return out.slice(0, limit);
  }

  /**
   * Index the pre-v15 event history, in chunks, resuming across restarts.
   *
   * The design, stated: migration v15 froze a cursor (`done: 0, target: MAX(seq)` at that moment)
   * instead of scanning inside the migration transaction. Each chunk here reads up to
   * `BACKFILL_CHUNK` matching events past `done`, writes their FTS rows and the advanced cursor in
   * one transaction, then yields the event loop. A crash mid-way resumes from the persisted `done`
   * on next boot; events past `target` are write-time indexed and never touched here. A chunk that
   * comes back short means the scan reached `target` — the cursor is closed by setting `done` to it.
   * There is no wall-clock time-box: the per-chunk yield keeps the server responsive, and the work
   * is bounded by the history that existed at migration time.
   *
   * An event whose session is deleted DURING the backfill can leave an orphan FTS row (the delete
   * scrubbed by ref before this chunk inserted); it is invisible to every query (the sessions join
   * fails) and costs a few bytes — accepted.
   */
  async runBackfill(onLog: (line: string) => void = (l) => console.error(l)): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const cursor = this.readCursor();
      if (!cursor || cursor.done >= cursor.target) return;
      try {
        const rows = this.d.db.prepare(`
          SELECT seq, session_id, payload_json FROM session_events
          WHERE seq > ? AND seq <= ? AND type IN ('user_message', 'assistant_text')
          ORDER BY seq LIMIT ?`).all(cursor.done, cursor.target, BACKFILL_CHUNK) as { seq: number; session_id: string; payload_json: string }[];
        const done = rows.length < BACKFILL_CHUNK ? cursor.target : Number(rows.at(-1)!.seq);
        this.d.db.exec("BEGIN");
        try {
          const ins = this.d.db.prepare("INSERT INTO search_index (text, kind, ref, seq) VALUES (?, 'session', ?, ?)");
          for (const r of rows) {
            let text: unknown;
            try { text = (JSON.parse(r.payload_json) as { text?: unknown }).text; } catch { continue; }
            if (typeof text !== "string" || text.trim() === "") continue;
            ins.run(text, r.session_id, r.seq);
          }
          this.d.settings.set(SEARCH_BACKFILL_KEY, { done, target: cursor.target });
          this.d.db.exec("COMMIT");
        } catch (e) { this.d.db.exec("ROLLBACK"); throw e; }
        if (rows.length > 0) onLog(`[search] backfilled ${rows.length} events (through seq ${done} of ${cursor.target})`);
      } catch (e) {
        // A failed chunk (disk full, db closing under shutdown) leaves the cursor where it was; the
        // next boot resumes. Search over the not-yet-covered range is merely incomplete, never wrong.
        onLog(`[search] backfill paused: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      await new Promise((r) => setImmediate(r));
    }
  }

  /** Halt the backfill loop before its next chunk — called at app close so it never races db.close. */
  stop(): void { this.stopped = true; }

  private readCursor(): { done: number; target: number } | null {
    const v = this.d.settings.get(SEARCH_BACKFILL_KEY);
    if (!v || typeof v !== "object") return null;
    const { done, target } = v as { done?: unknown; target?: unknown };
    if (typeof done !== "number" || typeof target !== "number") return null;
    return { done, target };
  }
}
