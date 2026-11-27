import { statSync } from "node:fs";
import type { SessionEvent } from "@realm/contracts";
import type { Db } from "../db/database";
import { decodePayload, encodePayload } from "./event-payload";

/** Days a session can go untouched before its tool payloads are cut to a head and a tail. 0 keeps
 *  every payload whole, and is the default: a cut can't be undone, so the owner turns it on. */
export const EVENT_RETENTION_DAYS_KEY = "storage.eventRetentionDays";
const DEFAULT_RETENTION_DAYS = 0;

/** A string longer than `TRIM_OVER` characters keeps its first `TRIM_HEAD` and last `TRIM_TAIL`.
 *  What is kept, plus the note, stays above `COMPRESS_MIN_BYTES`, so a trimmed payload is still a
 *  BLOB and its `event_tool_names` row still matches. */
export const TRIM_OVER = 2048;
export const TRIM_HEAD = 1024;
export const TRIM_TAIL = 512;

/** Space worth giving back to the disk. Below this a VACUUM costs more than it returns. */
export const RECLAIM_MIN_BYTES = 64 * 1024 * 1024;
/** A VACUUM writes a second copy of the database before it lets the first go. */
const RECLAIM_DISK_FACTOR = 2;

const RETENTION_BATCH_EVENTS = 200;

/** The ExitPlanMode card shows the plan in full, so its input is never cut. */
const UNTRIMMED_TOOLS = new Set(["ExitPlanMode"]);

export function retentionDays(stored: unknown): number {
  return typeof stored === "number" && Number.isFinite(stored) && stored >= 0 ? Math.floor(stored) : DEFAULT_RETENTION_DAYS;
}

export function trimText(s: string): string {
  if (s.length <= TRIM_OVER) return s;
  const cut = s.length - TRIM_HEAD - TRIM_TAIL;
  return `${s.slice(0, TRIM_HEAD)}\n\n… ${cut.toLocaleString("en-US")} characters trimmed from this old session …\n\n${s.slice(-TRIM_TAIL)}`;
}

function trimStrings(v: unknown): unknown {
  if (typeof v === "string") return trimText(v);
  if (Array.isArray(v)) return v.map(trimStrings);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trimStrings(x)]));
  return v;
}

/** The payload with its long text cut, or null when nothing in it is long enough to cut. Every field
 *  the transcript reads keeps its type, so the event still parses and renders. */
export function trimPayload(type: SessionEvent["type"], payload: unknown): unknown {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  let out: Record<string, unknown>;
  if (type === "tool_result" && typeof p.content === "string") out = { ...p, content: trimText(p.content) };
  else if (type === "tool_call" && !UNTRIMMED_TOOLS.has(String(p.name))) out = { ...p, input: trimStrings(p.input) };
  else return null;
  return JSON.stringify(out) === JSON.stringify(p) ? null : out;
}

/**
 * Sessions whose tool payloads may be cut: untouched since `cutoff`, not running or waiting on the
 * person, not pinned, not a teammate's home chat, and holding events past their cursor.
 */
function coldSessions(db: Db, cutoff: number): { id: string; through: number }[] {
  return db.prepare(`
    SELECT s.id, COALESCE(r.through_seq, 0) AS through FROM sessions s
    LEFT JOIN event_retention r ON r.session_id = s.id
    WHERE MAX(s.activity_at, s.created_at) < ?
      AND s.status NOT IN ('running', 'waiting_permission', 'moving')
      AND s.teammate_home = 0
      AND s.id NOT IN (SELECT ref_id FROM items WHERE kind = 'session' AND pinned = 1)
      AND (SELECT MAX(seq) FROM session_events e WHERE e.session_id = s.id) > COALESCE(r.through_seq, 0)
    ORDER BY s.id`).all(cutoff) as { id: string; through: number }[];
}

/** `freedBytes` is what trimming released inside pages that are still in use: only a VACUUM gives
 *  that back, and on a real home it was half of what a prune freed. */
export type ReclaimInputs = { freelistBytes: number; freedBytes: number; fileBytes: number; freeDiskBytes: number | null; busy: boolean };

export function reclaimDecision(i: ReclaimInputs, minBytes = RECLAIM_MIN_BYTES): { run: true } | { run: false; reason: string } {
  const reclaimable = i.freelistBytes + i.freedBytes;
  if (reclaimable < minBytes) return { run: false, reason: `${mb(reclaimable)} to reclaim` };
  if (i.busy) return { run: false, reason: "an agent is working" };
  const needs = i.fileBytes * RECLAIM_DISK_FACTOR;
  if (i.freeDiskBytes === null || i.freeDiskBytes < needs) {
    return { run: false, reason: `${i.freeDiskBytes === null ? "unknown" : mb(i.freeDiskBytes)} free on disk, needs ${mb(needs)}` };
  }
  return { run: true };
}

export type RetentionStep = { trimmed: number; bytesBefore: number; bytesAfter: number; finished: boolean };
export type ReclaimResult = { ran: boolean; reason?: string; before: number; after: number; ms: number };

type Deps = {
  db: Db;
  /** The database file; its size and its WAL's decide whether the disk can hold a VACUUM. */
  dbPath: string;
  settings: { get(key: string): unknown };
  /** True while an agent is working: retention waits, and never vacuums under a turn. */
  busy: () => boolean;
  freeDiskBytes: () => number | null;
  reclaimMinBytes?: number;
  now?: () => number;
  log?: (line: string) => void;
  pauseMs?: number;
  busyPauseMs?: number;
};

/**
 * Background housekeeping for realm.db's event log.
 *
 * A session untouched for the retention window keeps every event, and every message whole; only its
 * tool calls' and results' long strings are cut to a head and a tail, with a note saying how much was
 * cut. The transcript still opens and every card still renders, and resuming is untouched: the agent
 * CLI resumes from its own transcript, and a handover reads only the messages. Each session keeps a
 * cursor (`event_retention`), so an event is looked at once.
 *
 * Retention is off (0 days) until the owner sets a window, since a cut can't be undone.
 *
 * The space cut stays inside realm.db until a VACUUM. One runs only when enough has been freed, no
 * agent is working, and the disk has room for the second copy a VACUUM writes; never during boot.
 * It runs whether retention is on or off: with it off, only free pages count toward the threshold.
 */
export class EventRetention {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  /** Bytes trimmed since the last VACUUM in this process. */
  private freed = 0;
  constructor(private d: Deps) {}

  private get log() { return this.d.log ?? ((l: string) => console.error(l)); }

  days(): number { return retentionDays(this.d.settings.get(EVENT_RETENTION_DAYS_KEY)); }

  cutoff(): number { return (this.d.now ?? Date.now)() - this.days() * 86_400_000; }

  /** One batch of one cold session. Synchronous: the caller decides when the event loop can spare it. */
  step(cutoff = this.cutoff()): RetentionStep {
    const out: RetentionStep = { trimmed: 0, bytesBefore: 0, bytesAfter: 0, finished: true };
    if (this.days() === 0) return out;
    const next = coldSessions(this.d.db, cutoff)[0];
    if (!next) return out;
    out.finished = false;
    const db = this.d.db;
    const rows = db.prepare(`
      SELECT seq, type, payload_json FROM session_events
      WHERE session_id = ? AND seq > ? AND type IN ('tool_call', 'tool_result')
        AND (typeof(payload_json) = 'blob' OR length(payload_json) > ?)
      ORDER BY seq LIMIT ?`).all(next.id, next.through, TRIM_OVER, RETENTION_BATCH_EVENTS) as { seq: number; type: SessionEvent["type"]; payload_json: string | Uint8Array }[];
    const through = rows.length === RETENTION_BATCH_EVENTS
      ? rows[rows.length - 1]!.seq
      : (db.prepare("SELECT MAX(seq) AS m FROM session_events WHERE session_id = ?").get(next.id) as { m: number }).m;
    db.exec("BEGIN");
    try {
      const put = db.prepare("UPDATE session_events SET payload_json = ? WHERE seq = ? AND payload_json = ?");
      const name = db.prepare("INSERT OR IGNORE INTO event_tool_names (seq, tool) VALUES (?, ?)");
      for (const r of rows) {
        let payload: unknown;
        try { payload = JSON.parse(decodePayload(r.payload_json)); } catch { continue; }
        const cut = trimPayload(r.type, payload);
        if (cut === null) continue;
        const stored = encodePayload(JSON.stringify(cut));
        if (Number(put.run(stored, r.seq, r.payload_json).changes) === 0) continue;
        if (r.type === "tool_call" && typeof stored !== "string") name.run(r.seq, String((cut as { name: unknown }).name));
        out.trimmed++;
        out.bytesBefore += byteLength(r.payload_json);
        out.bytesAfter += byteLength(stored);
      }
      db.prepare("INSERT INTO event_retention (session_id, through_seq) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET through_seq = excluded.through_seq")
        .run(next.id, through);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    return out;
  }

  async prune(): Promise<RetentionStep> {
    const total: RetentionStep = { trimmed: 0, bytesBefore: 0, bytesAfter: 0, finished: false };
    const cutoff = this.cutoff();
    for (;;) {
      if (this.stopped) return total;
      if (this.d.db.isTransaction || this.d.busy()) { await sleep(this.d.busyPauseMs ?? 5000); continue; }
      const s = this.step(cutoff);
      total.trimmed += s.trimmed; total.bytesBefore += s.bytesBefore; total.bytesAfter += s.bytesAfter;
      this.freed += s.bytesBefore - s.bytesAfter;
      if (s.finished) {
        total.finished = true;
        if (total.trimmed > 0) this.log(`[events] trimmed ${total.trimmed} tool payloads in sessions idle over ${this.days()} days: ${mb(total.bytesBefore)} → ${mb(total.bytesAfter)}`);
        return total;
      }
      await sleep(this.d.pauseMs ?? 20);
    }
  }

  /** VACUUM, when `reclaimDecision` allows it. */
  reclaim(): ReclaimResult {
    const db = this.d.db;
    const pragma = (sql: string) => Object.values(db.prepare(sql).get() as Record<string, number>)[0]!;
    const before = this.fileBytes();
    const decision = reclaimDecision({
      freelistBytes: pragma("PRAGMA freelist_count") * pragma("PRAGMA page_size"),
      freedBytes: this.freed,
      fileBytes: before,
      freeDiskBytes: this.d.freeDiskBytes(),
      busy: db.isTransaction || this.d.busy(),
    }, this.d.reclaimMinBytes);
    if (!decision.run) return { ran: false, reason: decision.reason, before, after: before, ms: 0 };
    const started = Date.now();
    try {
      db.exec("VACUUM");
      db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.log(`[db] vacuum failed: ${reason}`);
      return { ran: false, reason, before, after: this.fileBytes(), ms: Date.now() - started };
    }
    this.freed = 0;
    const after = this.fileBytes();
    const ms = Date.now() - started;
    this.log(`[db] vacuum: ${mb(before)} → ${mb(after)}, ${mb(before - after)} reclaimed in ${(ms / 1000).toFixed(1)} s`);
    return { ran: true, before, after, ms };
  }

  /** Prune, then reclaim. With retention off nothing is trimmed, but free pages are still vacuumed
   *  away once they alone reach the threshold. A call during a run waits for it. */
  run(): Promise<void> {
    this.running ??= (async () => {
      if (this.days() !== 0) await this.prune();
      if (!this.stopped) this.reclaim();
    })()
      .catch((e) => { this.log(`[events] retention paused: ${e instanceof Error ? e.message : String(e)}`); })
      .finally(() => { this.running = null; });
    return this.running;
  }

  /** First run `firstAfterMs` after boot, then every `everyMs`. Unref'd, so it never holds a quit. */
  start(firstAfterMs: number, everyMs: number): void {
    if (this.stopped || this.timer) return;
    const tick = (ms: number) => {
      this.timer = setTimeout(() => { void this.run().then(() => { if (!this.stopped) tick(everyMs); }); }, ms);
      this.timer.unref?.();
    };
    tick(firstAfterMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private fileBytes(): number {
    const size = (p: string) => { try { return statSync(p).size; } catch { return 0; } };
    return size(this.d.dbPath) + size(`${this.d.dbPath}-wal`);
  }
}

const byteLength = (v: string | Uint8Array) => (typeof v === "string" ? Buffer.byteLength(v, "utf8") : v.byteLength);
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref?.(); });
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
