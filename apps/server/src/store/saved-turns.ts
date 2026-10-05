import { SAVED_REPLY_MAX, SAVED_TURNS_MAX, type SavedTurn } from "@realm/contracts";
import type { Db } from "../db/database";
import { NotFoundError, RpcError, now } from "./rows";

type ListRow = {
  seq: number; session_id: string; saved_at: number; ts: number; payload_json: string;
  reply_json: string | null; session_title: string; space_id: string;
};

/** An event's payload as an object, or `{}` for one that does not parse — a damaged row still lists,
 *  as a prompt with no words, rather than failing the whole read. */
const payload = (json: string | null): Record<string, unknown> => {
  if (json === null) return {};
  try { const v: unknown = JSON.parse(json); return v && typeof v === "object" ? v as Record<string, unknown> : {}; } catch { return {}; }
};

/** What a saved turn says about its prompt, read off the `user_message` it names. */
function promptOf(json: string): Pick<SavedTurn, "text" | "attachments" | "goal"> {
  const p = payload(json);
  const files = Array.isArray(p.attachments) ? p.attachments : [];
  return {
    text: typeof p.text === "string" ? p.text : "",
    attachments: files.flatMap((a) => (a && typeof a === "object" && typeof (a as { path?: unknown }).path === "string" ? [(a as { path: string }).path] : [])),
    goal: p.goal === "continuation" || p.goal === "budget" ? p.goal : null,
  };
}

/** The answer's first stretch: enough for three lines of a card, and no more of a long answer than that. */
function replyOf(json: string | null): string | null {
  const text = payload(json).text;
  return typeof text === "string" && text.trim() !== "" ? text.slice(0, SAVED_REPLY_MAX) : null;
}

/**
 * The turns a reader saved (migration v41): each row names its prompt's `user_message` event and when
 * it was saved, and nothing else — every word a list shows is read back off the events themselves.
 */
export class SavedTurnsStore {
  constructor(private db: Db) {}

  /** One session's saved prompts, as their events' seqs, in the log's order. */
  forSession(sessionId: string): number[] {
    return (this.db.prepare("SELECT event_seq FROM saved_turns WHERE session_id = ? ORDER BY event_seq").all(sessionId) as { event_seq: number }[])
      .map((r) => r.event_seq);
  }

  /**
   * Save the turn whose prompt is event `seq` of this session, or unsave it, and answer with the
   * session's saved set as it now stands. Only a prompt can be saved, and only in its own session: a
   * seq that names a tool call, or a prompt of another session, is refused rather than kept as a number
   * that points at the wrong thing. Saving twice keeps the first time it was saved.
   */
  set(sessionId: string, seq: number, saved: boolean): number[] {
    const event = this.db.prepare("SELECT session_id, type FROM session_events WHERE seq = ?").get(seq) as { session_id: string; type: string } | undefined;
    if (!event || event.session_id !== sessionId) throw new NotFoundError("prompt", `${seq} in session ${sessionId}`);
    if (event.type !== "user_message") throw new RpcError("INVALID_ARGUMENT", `event ${seq} is not a prompt`);
    if (saved) this.db.prepare("INSERT INTO saved_turns (event_seq, session_id, saved_at) VALUES (?, ?, ?) ON CONFLICT (event_seq) DO NOTHING").run(seq, sessionId, now());
    else this.db.prepare("DELETE FROM saved_turns WHERE event_seq = ?").run(seq);
    return this.forSession(sessionId);
  }

  /**
   * Every saved turn in a profile's sessions, the newest saved first, each with its prompt's words and
   * the opening of the answer it got — the first `assistant_text` after the prompt and before the next
   * one, which the `(session_id, seq)` index finds without reading the log.
   */
  list(profileId: string, limit = SAVED_TURNS_MAX): { entries: SavedTurn[]; total: number } {
    const scope = "s.space_id IN (SELECT id FROM spaces WHERE profile_id = ?)";
    const rows = this.db.prepare(`
      SELECT st.event_seq AS seq, st.session_id, st.saved_at, e.ts, e.payload_json, s.title AS session_title, s.space_id,
        (SELECT r.payload_json FROM session_events r
          WHERE r.session_id = st.session_id AND r.type = 'assistant_text' AND r.seq > st.event_seq
            AND r.seq < COALESCE((SELECT MIN(n.seq) FROM session_events n
              WHERE n.session_id = st.session_id AND n.type = 'user_message' AND n.seq > st.event_seq), 9223372036854775807)
          ORDER BY r.seq LIMIT 1) AS reply_json
      FROM saved_turns st
      JOIN session_events e ON e.seq = st.event_seq
      JOIN sessions s ON s.id = st.session_id
      WHERE ${scope}
      ORDER BY st.saved_at DESC, st.event_seq DESC LIMIT ?`).all(profileId, limit) as ListRow[];
    const { n } = this.db.prepare(`SELECT COUNT(*) AS n FROM saved_turns st JOIN sessions s ON s.id = st.session_id WHERE ${scope}`).get(profileId) as { n: number };
    return {
      entries: rows.map((r) => ({
        sessionId: r.session_id, seq: r.seq, savedAt: r.saved_at, ts: r.ts, ...promptOf(r.payload_json),
        reply: replyOf(r.reply_json), sessionTitle: r.session_title, spaceId: r.space_id,
      })),
      total: n,
    };
  }
}
