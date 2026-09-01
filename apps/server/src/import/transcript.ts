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
/**
 * Ceiling on events from one transcript — a guard against a runaway machine loop, NOT a routine clip.
 *
 * The number was measured, after a first pass set it at 4,000 and quietly truncated a real 15,479-event
 * Codex thread to a quarter of itself. Across the 392 transcripts on this machine, exactly two exceed
 * 4,000 and none exceed 20,000; the whole corpus is 360k events, so nothing is bought by cutting the
 * long tail and a genuine day-long session is lost by it.
 *
 * The cap also has to sit above any real conversation for a second reason: `messages` is what
 * `markDuplicates` compares replays on, and a truncated parse under-reports it — so a low cap makes
 * the fullest copy of a thread look like the smallest one.
 */
export const EVENTS_MAX = 20_000;

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

/**
 * Whether a user turn is a HARNESS PREAMBLE rather than something a person typed.
 *
 * Not every `user_message` is the user speaking. Conductor opens its sessions with a
 * `<system_instruction>` envelope, Claude injects a `# Files mentioned by the user:` block and a
 * `<local-command-caveat>` wrapper — all delivered on the user channel, all first in the file. On
 * this machine that put 30 imported sessions in the sidebar called `<system_instruction>`.
 *
 * The test is structural rather than a blocklist of products: a first line that is nothing but an
 * XML-style tag is an envelope, because a person typing a sentence does not start one that way. The
 * one literal header is named as well, since it carries no tag to be recognised by.
 *
 * This only ever affects the TITLE. The turn stays in the transcript — it really was part of what
 * the agent was given, and dropping it would misrepresent the conversation.
 */
export function isHarnessPreamble(text: string): boolean {
  const head = text.trim().split("\n").find((l) => l.trim())?.trim() ?? "";
  if (head.startsWith("# Files mentioned by the user:")) return true;
  const tag = /^<\/?([a-z][a-z0-9_-]*)>/i.exec(head);
  if (!tag) return false;
  // A line that is NOTHING but a tag is an envelope whatever the tag is called. When the tag opens a
  // line that continues (`<local-command-caveat>Caveat: The message below…`), the tag NAME decides:
  // a hyphen or underscore in it means a harness invented it, because HTML's own element names have
  // neither. That keeps "explain what <div> does" out of this while catching every wrapper these
  // CLIs actually emit.
  return head === tag[0] || /[-_]/.test(tag[1]!);
}

/**
 * The title a transcript takes when the source named none: its first turn that reads like a person
 * wrote it, which is what `titleFromMessage` already does for every session Realm creates itself.
 *
 * Falls through the harness preambles to the first real user turn, then to the assistant's first
 * words — a session that opened with an injected block and an agent reply is better named by the
 * reply than by the block.
 *
 * When EVERY spoken turn is an envelope the answer is the empty string, and the caller names the
 * session generically. That case is real and it is not a failure: a `/login` transcript is nothing
 * but `<local-command-caveat>` and `<command-name>` wrappers, and there is no human sentence in it
 * to find. "Imported session" describes that honestly; a row of XML in the sidebar does not.
 */
export function fallbackTitle(events: SessionEvent[]): string {
  const spoken = events.filter((e) => e.type === "user_message" || e.type === "assistant_text");
  const real = spoken.find((e) => e.type === "user_message" && !isHarnessPreamble(e.payload.text))
    ?? spoken.find((e) => e.type === "assistant_text" && !isHarnessPreamble(e.payload.text));
  return real && "text" in real.payload ? real.payload.text : "";
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
