import { sessionEvent, type SessionEvent } from "@realm/contracts";
import { EVENTS_MAX, arr, clipTool, clipToolInput, fallbackTitle, rec, str, type ParsedTranscript } from "./transcript";

/**
 * `~/.cursor/acp-sessions/<id>/store.db` (and `~/.cursor/chats/<hash>/<id>/store.db`) — a SQLite
 * content-addressed blob store, not a log.
 *
 * Two tables: `meta`, whose single row holds hex-encoded JSON naming the conversation and pointing at
 * a root blob; and `blobs`, keyed by content hash. The root blob is protobuf, and its repeated field 1
 * is the ORDERED list of 32-byte message-blob hashes — the conversation. Each of those resolves to a
 * plain JSON message (`{role, content}`).
 *
 * Most blobs in a store are NOT in the chain (superseded roots, older revisions) and many are not
 * valid UTF-8. That is why the chain is followed rather than the table scanned: reading every blob
 * would produce a jumble of half a dozen conversations in no order, and would then have to guess
 * which binary rows were messages it had failed to decode. Following field 1, every id resolves and
 * every one is a message — verified across all 21 stores on this machine, 156 of 156.
 */

/** The store's `meta` row, already decoded. Read separately from the chain because a store whose
 *  blobs are unreadable can still contribute a name and a date to the preview. */
export type CursorMeta = { agentId: string; latestRootBlobId: string; name: string; createdAt: number };

export function parseCursorMeta(hex: string): CursorMeta | null {
  try {
    const json: unknown = JSON.parse(Buffer.from(hex, "hex").toString("utf8"));
    const m = rec(json);
    const agentId = str(m.agentId), root = str(m.latestRootBlobId);
    if (!agentId || !root) return null;
    return { agentId, latestRootBlobId: root, name: str(m.name), createdAt: typeof m.createdAt === "number" ? m.createdAt : 0 };
  } catch { return null; }
}

/**
 * The repeated 32-byte hashes of protobuf field 1, in order — a deliberately minimal wire-format
 * reader rather than a protobuf dependency, because the ONE thing needed from this message is that
 * field, and a schema for the rest is not published.
 *
 * Every other field is skipped by wire type. An unknown or malformed field ends the walk and returns
 * what was read so far: a truncated chain imports a shorter conversation, which is a far better
 * failure than a thrown parse error losing the session entirely.
 */
export function chainIds(root: Buffer): string[] {
  const out: string[] = [];
  let i = 0;
  const varint = (): number | null => {
    let v = 0, shift = 0;
    while (i < root.length) {
      const b = root[i++]!;
      v |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return v;
      shift += 7;
      if (shift > 35) return null; // longer than any field number or length this message can hold
    }
    return null;
  };
  while (i < root.length) {
    const key = varint();
    if (key === null) break;
    const field = key >>> 3, wire = key & 7;
    if (wire === 2) {
      const len = varint();
      if (len === null || len < 0 || i + len > root.length) break;
      if (field === 1 && len === 32) out.push(root.subarray(i, i + len).toString("hex"));
      i += len;
    } else if (wire === 0) { if (varint() === null) break; }
    else if (wire === 5) i += 4;
    else if (wire === 1) i += 8;
    else break; // group wire types: not emitted by this message, and not worth guessing past
  }
  return out;
}

/**
 * The conversation, from the ordered chain messages.
 *
 * The store keeps NO per-message timestamps, so events are stamped from the session's creation time,
 * one millisecond apart in chain order. Stated rather than hidden: the ordering is exact (it is the
 * chain's own), the wall-clock is not, and nothing downstream needs it to be — Realm orders a
 * transcript by `seq`, and `ts` only ever renders a time next to a message.
 */
export function parseCursorChain(messages: unknown[], meta: CursorMeta, now: number): ParsedTranscript | null {
  const events: SessionEvent[] = [];
  const base = meta.createdAt || now;
  let messageCount = 0, cwd = "";
  let truncated = false;

  for (const raw of messages) {
    const m = rec(raw);
    const role = str(m.role);
    // The system prompt is Cursor's, not the user's conversation, and it is the largest blob in
    // every store. Never imported.
    if (role === "system") continue;
    const content = m.content;
    // A bare-string USER message is the harness's injected `<user_info>` preamble — OS, shell,
    // workspace path, the transcripts folder — never something the user typed; their real turns are
    // always block lists. So the string form is mined for the cwd and then dropped, exactly as the
    // Codex parser drops `response_item` speech in favour of `event_msg`.
    if (typeof content === "string") {
      if (!cwd) cwd = workspacePath(content);
      continue;
    }
    const ts = base + events.length;
    for (const rawBlock of arr(content)) {
      const b = rec(rawBlock);
      const kind = str(b.type);
      if (kind === "text") {
        const t = str(b.text);
        if (t.trim() === "") continue;
        if (role === "user") { events.push(sessionEvent("user_message", { text: stripTimestampTag(t), attachments: [] }, ts)); messageCount++; }
        else { events.push(sessionEvent("assistant_text", { messageId: str(m.id) || `cursor-${events.length}`, text: t }, ts)); messageCount++; }
      } else if (kind === "tool-call") {
        events.push(sessionEvent("tool_call", {
          toolUseId: str(b.toolCallId) || `cursor-${events.length}`, name: str(b.toolName) || "tool",
          input: clipToolInput(b.args), parentToolUseId: null,
        }, ts));
      } else if (kind === "tool-result") {
        events.push(sessionEvent("tool_result", {
          toolUseId: str(b.toolCallId), content: clipTool(typeof b.result === "string" ? b.result : safeJson(b.result)), isError: false,
        }, ts));
      } else if (kind === "image" && role === "user") {
        events.push(sessionEvent("user_message", { text: "[image]", attachments: [] }, ts));
      }
      // `redacted-reasoning` carries an opaque provider blob and no readable text — there is nothing
      // to import, and a `thinking` event holding base64 would be noise pretending to be thought.
    }
    if (events.length >= EVENTS_MAX) { truncated = true; break; }
  }

  if (events.length === 0) return null;
  if (truncated) {
    events.push(sessionEvent("error", { message: `Realm imported the first ${EVENTS_MAX.toLocaleString("en-US")} events of this conversation; the rest is still in the source store.` }, base + events.length));
  }
  return {
    providerSessionId: meta.agentId, cwd,
    title: meta.name || fallbackTitle(events),
    events, messages: messageCount,
    startedAt: base,
    updatedAt: base + events.length,
    // Cursor records nothing about who drove it. Realm's own ACP live checks are caught by the
    // scratch filter (they run in temp directories) and by the database dedup, not by a guess here.
    fromRealm: false,
    model: null,
  };
}

/** `Workspace Path: <path>` out of the injected preamble — the only place the store names the
 *  directory. `meta.json` beside the store has a `cwd` too and is preferred; this is the fallback
 *  for chat stores that have no `meta.json`. */
function workspacePath(preamble: string): string {
  return /^Workspace Path:[ \t]*(.+)$/m.exec(preamble)?.[1]?.trim() ?? "";
}

/** Cursor prefixes each user turn with a `<timestamp>…</timestamp>` tag its own harness injected.
 *  Stripped so the imported message is what the user typed. */
function stripTimestampTag(text: string): string {
  return text.replace(/^<timestamp>[^<]*<\/timestamp>\s*/, "");
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v) ?? ""; } catch { return "[unserializable]"; }
}
