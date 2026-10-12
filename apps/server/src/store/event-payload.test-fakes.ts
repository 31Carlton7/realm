import { deflateRawSync } from "node:zlib";
import type { Db } from "../db/database";

/** Rewrite every text payload as a compressed BLOB, however small, so a reader's test meets the
 *  compressed form on rows `encodePayload` would have left as text. */
export function deflateEveryPayload(db: Db): number {
  const rows = db.prepare("SELECT seq, payload_json FROM session_events WHERE typeof(payload_json) = 'text'").all() as { seq: number; payload_json: string }[];
  const put = db.prepare("UPDATE session_events SET payload_json = ? WHERE seq = ?");
  for (const r of rows) put.run(Buffer.concat([Buffer.from([1]), deflateRawSync(Buffer.from(r.payload_json, "utf8"))]), r.seq);
  return rows.length;
}

export const blobCount = (db: Db): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM session_events WHERE typeof(payload_json) = 'blob'").get() as { n: number }).n;
