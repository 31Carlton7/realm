import type { SessionEvent } from "@realm/contracts";

/**
 * One transcript, parsed out of an agent CLI's own store and expressed in Realm's event vocabulary.
 *
 * Every parser in this directory produces exactly this, so `ImportService` never learns the shape of
 * any CLI's files: the per-agent knowledge stops at the parser boundary, and adding a fourth agent is
 * one more file that returns this type.
 */
export type ParsedTranscript = {
  /** The CLI's own session id — becomes `providerSessionId`, and with it the ability to resume. */
  providerSessionId: string;
  cwd: string;
  title: string;
  events: SessionEvent[];
  /** Spoken turns only (user + assistant text). What the preview counts, because tool chatter makes
   *  a session that did nothing look busy. */
  messages: number;
  startedAt: number;
  updatedAt: number;
  /** The source itself says this transcript was produced by Realm — Codex's `originator`. Never a
   *  guess: a parser that cannot know reports false, and dedup against the database catches the rest. */
  fromRealm: boolean;
  model: string | null;
};

/**
 * Caps, applied by every parser.
 *
 * A transcript is imported to be *read and searched*, not replayed byte-for-byte into a context
 * window — and a single `tool_result` in this corpus reaches hundreds of kilobytes. Storing those
 * whole would put tens of megabytes of file dumps into `session_events.payload_json` (and, for the
 * spoken types, into the FTS index) to no one's benefit.
 *
 * So tool payloads are clipped and SAY they were clipped. Spoken text — the user's own words and the
 * assistant's replies — is never clipped: it is the entire reason to keep the transcript, it is what
 * search matches on, and it is small.
 */
export const TOOL_PAYLOAD_MAX = 8_000;
/** Ceiling on events from one transcript. Reached only by machine-generated loops; a real
 *  conversation is orders of magnitude below it. The tail is dropped rather than the head, so an
 *  imported session always starts where the real one did. */
export const EVENTS_MAX = 4_000;

/** Clip a tool payload, stating the cut in the text itself rather than trailing off mid-value. */
export function clipTool(text: string): string {
  if (text.length <= TOOL_PAYLOAD_MAX) return text;
  const dropped = text.length - TOOL_PAYLOAD_MAX;
  return `${text.slice(0, TOOL_PAYLOAD_MAX)}\n\n… [Realm import clipped ${dropped.toLocaleString("en-US")} characters of tool output]`;
}

/** JSON that is guaranteed to fit `tool_call.input` (a `Record<string, unknown>`) and to stay small.
 *  A non-object input (some CLIs pass a bare string) is wrapped rather than dropped, so the call
 *  still shows what it was given. */
export function clipToolInput(raw: unknown): Record<string, unknown> {
  const obj = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : { input: raw };
  let json: string;
  try { json = JSON.stringify(obj); } catch { return { input: "[unserializable]" }; }
  if (json.length <= TOOL_PAYLOAD_MAX) return obj;
  return { _clipped: clipTool(json) };
}

/** ISO-8601 (Claude, Codex) or epoch milliseconds (Cursor) → epoch ms. `fallback` when neither
 *  parses, so one malformed line can never make a whole session claim to be from 1970. */
export function toMs(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") { const t = Date.parse(v); if (!Number.isNaN(t)) return t; }
  return fallback;
}

/** The title a transcript takes when the source named none: its first user turn, which is what
 *  `titleFromMessage` already does for every session Realm creates itself. Imported and native
 *  sessions therefore read the same way in the sidebar. */
export function fallbackTitle(events: SessionEvent[]): string {
  const first = events.find((e) => e.type === "user_message");
  return first && first.type === "user_message" ? first.payload.text : "";
}

/** Read JSONL defensively: blank lines skipped, unparseable lines skipped, and the count of the
 *  latter returned — a truncated last line (the CLI was killed mid-write) is normal, and it must
 *  cost that line only, never the transcript. */
export function readJsonl(text: string): { rows: Record<string, unknown>[]; bad: number } {
  const rows: Record<string, unknown>[] = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v: unknown = JSON.parse(line);
      if (v !== null && typeof v === "object" && !Array.isArray(v)) rows.push(v as Record<string, unknown>);
      else bad++;
    } catch { bad++; }
  }
  return { rows, bad };
}

export const str = (v: unknown): string => (typeof v === "string" ? v : "");
export const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
