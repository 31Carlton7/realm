import type { Db } from "../db/database";
import { COMPRESS_MIN_BYTES, decodePayload, encodePayload } from "./event-payload";

/** Seqs looked at per batch, and the most raw payload bytes one batch compresses. Together they keep a
 *  batch to tens of milliseconds of the event loop whatever the history holds: a stretch of small
 *  rows ends at the seq window, a stretch of page dumps at the byte budget. */
export const COMPACTION_SEQ_WINDOW = 2000;
export const COMPACTION_BATCH_BYTES = 2 * 1024 * 1024;

export type CompactionStep = { scanned: number; compressed: number; bytesBefore: number; bytesAfter: number; finished: boolean };

type Deps = {
  db: Db;
  /** True while an agent is working: the compactor waits rather than take event-loop time from a turn. */
  busy?: () => boolean;
  log?: (line: string) => void;
  /** Rest between batches, and while busy. */
  pauseMs?: number;
  busyPauseMs?: number;
};

/**
 * Compresses the event payloads written before v56, after boot, in the background.
 *
 * Each batch reads the text rows of one stretch of seqs, compresses those worth compressing
 * (`encodePayload`'s rule), and in one transaction replaces each row only if it still holds the text
 * that was read, reads it back, and checks it inflates to exactly that text. A mismatch rolls the
 * whole batch back and stops the compactor. The cursor (`event_payload_compaction`) moves in the
 * same transaction as the rows, so an interrupted run resumes where it stopped, and a batch run twice
 * finds its rows already BLOBs and leaves them alone. The end is MAX(seq) when the run starts: every
 * event after it was written by `SessionEventsStore.append`, which compresses as it writes.
 *
 * The space comes back as free pages inside realm.db, which new events reuse before the file grows
 * again. The file itself only shrinks on a VACUUM (Realm's databases are `auto_vacuum = NONE`).
 */
export class PayloadCompactor {
  private stopped = false;
  constructor(private d: Deps) {}

  stop(): void { this.stopped = true; }

  async run(): Promise<void> {
    const end = this.maxSeq();
    const total = { compressed: 0, bytesBefore: 0, bytesAfter: 0 };
    const log = this.d.log ?? ((l: string) => console.error(l));
    for (;;) {
      if (this.stopped) return;
      if (this.d.db.isTransaction || this.d.busy?.()) { await sleep(this.d.busyPauseMs ?? 1000); continue; }
      let step: CompactionStep;
      try { step = this.step(end); } catch (e) {
        log(`[events] compaction paused: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      total.compressed += step.compressed; total.bytesBefore += step.bytesBefore; total.bytesAfter += step.bytesAfter;
      if (step.finished) {
        if (total.compressed > 0) log(`[events] compressed ${total.compressed} payloads: ${mb(total.bytesBefore)} → ${mb(total.bytesAfter)}`);
        return;
      }
      await sleep(this.d.pauseMs ?? 20);
    }
  }

  /** One batch, up to `end`. Synchronous: the caller decides when the event loop can spare it. */
  step(end = this.maxSeq()): CompactionStep {
    const done = this.cursor();
    const out: CompactionStep = { scanned: 0, compressed: 0, bytesBefore: 0, bytesAfter: 0, finished: done === null || done >= end };
    if (out.finished) return out;
    const windowEnd = Math.min(done! + COMPACTION_SEQ_WINDOW, end);
    const rows: { seq: number; text: string }[] = [];
    let bytes = 0;
    let through = windowEnd;
    for (const r of this.d.db.prepare(`
      SELECT seq, payload_json AS text FROM session_events
      WHERE seq > ? AND seq <= ? AND typeof(payload_json) = 'text' AND octet_length(payload_json) >= ?
      ORDER BY seq`).iterate(done!, windowEnd, COMPRESS_MIN_BYTES) as Iterable<{ seq: number; text: string }>) {
      rows.push(r);
      bytes += r.text.length;
      if (bytes >= COMPACTION_BATCH_BYTES) { through = r.seq; break; }
    }
    const packed: { seq: number; text: string; blob: Uint8Array }[] = [];
    for (const r of rows) {
      const blob = encodePayload(r.text);
      if (typeof blob === "string") continue;
      if (decodePayload(blob) !== r.text) throw new Error(`payload ${r.seq} does not survive compression; left as it was`);
      packed.push({ seq: r.seq, text: r.text, blob });
    }
    const db = this.d.db;
    db.exec("BEGIN");
    try {
      const put = db.prepare("UPDATE session_events SET payload_json = ? WHERE seq = ? AND payload_json = ?");
      const name = db.prepare("INSERT OR IGNORE INTO event_tool_names (seq, tool) SELECT seq, json_extract(?, '$.name') FROM session_events WHERE seq = ? AND type = 'tool_call'");
      const back = db.prepare("SELECT payload_json FROM session_events WHERE seq = ?");
      for (const p of packed) {
        if (Number(put.run(p.blob, p.seq, p.text).changes) === 0) continue;
        name.run(p.text, p.seq);
        const stored = (back.get(p.seq) as { payload_json: Uint8Array | string }).payload_json;
        if (decodePayload(stored) !== p.text) throw new Error(`payload ${p.seq} read back different; batch rolled back`);
        out.compressed++;
        out.bytesBefore += Buffer.byteLength(p.text, "utf8");
        out.bytesAfter += p.blob.byteLength;
      }
      db.prepare("UPDATE event_payload_compaction SET done = ? WHERE id = 1").run(through);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    out.scanned = rows.length;
    out.finished = through >= end;
    return out;
  }

  /** The last seq looked at, from migration v56's row; null (nothing to do) without one. */
  private cursor(): number | null {
    const r = this.d.db.prepare("SELECT done FROM event_payload_compaction WHERE id = 1").get() as { done: number } | undefined;
    return r ? r.done : null;
  }

  private maxSeq(): number {
    return (this.d.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM session_events").get() as { m: number }).m;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref?.(); });
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
