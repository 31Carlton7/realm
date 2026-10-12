import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { Db } from "../db/database";

/**
 * How `session_events.payload_json` is stored (migration v56).
 *
 * A payload is either the JSON text, as every build before v56 wrote it, or a BLOB: one codec byte
 * followed by the compressed UTF-8 of that same text. The column's storage class is the marker —
 * `typeof(payload_json)` is 'text' or 'blob' — so no column was added and a plain row never changes.
 * SQLite keeps a BLOB a BLOB under the column's TEXT affinity.
 *
 * Only a payload of at least `COMPRESS_MIN_BYTES` is compressed, and only when that saves at least a
 * tenth: the short rows (status, usage, most messages) stay text, which keeps the `json_extract`
 * reads over them as cheap as they were. Measured on a copy of a real home (2026-10-12): raw deflate
 * at level 6 takes the event log from 496 MB to 218 MB at this threshold, and inflates at ~240 MB/s.
 * Brotli 6 was 5 % smaller and slower to write; zstd is still experimental in Node 22.
 */
export const COMPRESS_MIN_BYTES = 512;

/** The codec byte. Only one exists; the byte is there so another can be added without guessing. */
const CODEC_DEFLATE_RAW = 1;

export type StoredPayload = string | Uint8Array;

/** The value to write to `payload_json` for this JSON text. */
export function encodePayload(json: string): StoredPayload {
  const raw = Buffer.from(json, "utf8");
  if (raw.length < COMPRESS_MIN_BYTES) return json;
  const packed = deflateRawSync(raw);
  if (packed.length + 1 > raw.length * 0.9) return json;
  const out = Buffer.allocUnsafe(packed.length + 1);
  out[0] = CODEC_DEFLATE_RAW;
  packed.copy(out, 1);
  return out;
}

/** The JSON text a stored `payload_json` holds, whichever form it was written in. */
export function decodePayload(stored: StoredPayload): string {
  if (typeof stored === "string") return stored;
  const bytes = Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength);
  if (bytes[0] !== CODEC_DEFLATE_RAW) throw new Error(`unknown event payload codec ${bytes[0]}`);
  return inflateRawSync(bytes.subarray(1)).toString("utf8");
}

/** A stored payload parsed, or `undefined` when it does not decode or parse — the same "skip this
 *  row" every reader already did for a payload that was not JSON. */
export function parsePayload(stored: StoredPayload | null | undefined): unknown {
  if (stored === null || stored === undefined) return undefined;
  try { return JSON.parse(decodePayload(stored)); } catch { return undefined; }
}

/** The SQL function `payloadSql` calls, registered on every connection `openDatabase` makes. */
export const PAYLOAD_SQL_FUNCTION = "realm_event_payload";

/**
 * `payload_json` as JSON text, for SQL that reads into it (`json_extract`). Text rows never leave
 * SQLite; only a compressed row crosses into JS to be inflated. `col` is the column as written in
 * the query (`payload_json`, `ev.payload_json`).
 */
export const payloadSql = (col: string): string =>
  `(CASE WHEN typeof(${col}) = 'blob' THEN ${PAYLOAD_SQL_FUNCTION}(${col}) ELSE ${col} END)`;

export function registerPayloadFunction(db: Db): void {
  db.function(PAYLOAD_SQL_FUNCTION, { deterministic: true }, (v) => {
    if (typeof v === "string" || v === null) return v;
    if (v instanceof Uint8Array) {
      try { return decodePayload(v); } catch { return null; }
    }
    return null;
  });
}
