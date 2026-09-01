import type { Db } from "../db/database";
import { newId, type Notification, type NotificationCategory } from "@realm/contracts";
import { now } from "./rows";

type Row = { id: string; category: NotificationCategory; space_id: string | null; session_id: string | null; ref_id: string | null;
  title: string; body: string | null; created_at: number; read_at: number | null; acted_at: number | null };
const toNotification = (r: Row): Notification => ({
  id: r.id, category: r.category, spaceId: r.space_id, sessionId: r.session_id, refId: r.ref_id,
  title: r.title, body: r.body, createdAt: r.created_at, readAt: r.read_at, actedAt: r.acted_at,
});

export type NotificationInsert = {
  category: NotificationCategory; spaceId: string | null; sessionId: string | null; refId: string | null;
  title: string; body: string | null;
  /** Born with `acted_at` already set (a fact that is complete the moment it is written — a settle, a
   *  refused removal), as opposed to a row with a pending lifecycle (a permission, a down server). */
  acted?: boolean;
};

/**
 * Rows only — every rule (dedup, category toggles, what resolves what) lives in NotificationsService,
 * the one place that writes. Feed order is `created_at DESC, id DESC`: newest first, with the id as a
 * total-order tiebreak so keyset pagination can never skip or repeat a row whose neighbor shares its
 * millisecond.
 */
export class NotificationsStore {
  constructor(private db: Db) {}

  /** One page of the feed. `cursor` is the previous page's `nextCursor` (opaque to clients; here it is
   *  `${createdAt}:${id}` of the last row served). */
  list(input: { cursor: string | null; limit: number }): { notifications: Notification[]; nextCursor: string | null } {
    const parsed = parseCursor(input.cursor);
    const rows = (parsed
      ? this.db.prepare("SELECT * FROM notifications WHERE created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC LIMIT ?")
          .all(parsed.createdAt, parsed.createdAt, parsed.id, input.limit)
      : this.db.prepare("SELECT * FROM notifications ORDER BY created_at DESC, id DESC LIMIT ?").all(input.limit)) as Row[];
    const last = rows.at(-1);
    // A short page IS the end; only a full page might have more behind it.
    const nextCursor = rows.length === input.limit && last ? `${last.created_at}:${last.id}` : null;
    return { notifications: rows.map(toNotification), nextCursor };
  }

  /** THE unread count — the single derivation site every badge and broadcast reads. */
  unreadCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL").get() as { n: number }).n;
  }

  get(id: string): Notification | null {
    const r = this.db.prepare("SELECT * FROM notifications WHERE id = ?").get(id) as Row | undefined;
    return r ? toNotification(r) : null;
  }

  /** The open (unacted) row for a dedup key, if any — what a repeat of the same condition collapses into. */
  findOpen(category: NotificationCategory, refId: string): Notification | null {
    const r = this.db.prepare("SELECT * FROM notifications WHERE category = ? AND ref_id = ? AND acted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(category, refId) as Row | undefined;
    return r ? toNotification(r) : null;
  }

  /** The newest still-unread row for a dedup key — what a re-occurrence reuses instead of double-counting
   *  one story for a user who never saw the first telling. */
  findUnread(category: NotificationCategory, refId: string): Notification | null {
    const r = this.db.prepare("SELECT * FROM notifications WHERE category = ? AND ref_id = ? AND read_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(category, refId) as Row | undefined;
    return r ? toNotification(r) : null;
  }

  /** Every open row of one category on one session — the crash path's "close what this session can no
   *  longer answer" sweep. */
  listOpenForSession(category: NotificationCategory, sessionId: string): Notification[] {
    return (this.db.prepare("SELECT * FROM notifications WHERE category = ? AND session_id = ? AND acted_at IS NULL ORDER BY created_at DESC, id DESC")
      .all(category, sessionId) as Row[]).map(toNotification);
  }

  create(input: NotificationInsert): Notification {
    const id = newId(); const t = now();
    this.db.prepare("INSERT INTO notifications (id, category, space_id, session_id, ref_id, title, body, created_at, read_at, acted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)")
      .run(id, input.category, input.spaceId, input.sessionId, input.refId, input.title, input.body, t, input.acted ? t : null);
    return this.get(id)!;
  }

  /** Absorb a repeat into an existing OPEN row: fresher words, same row, same place in the feed —
   *  `created_at` untouched so a flapping condition does not pin itself to the top forever. */
  absorb(id: string, input: { title: string; body: string | null }): Notification {
    this.db.prepare("UPDATE notifications SET title = ?, body = ? WHERE id = ?").run(input.title, input.body, id);
    return this.get(id)!;
  }

  /** Re-surface an unread row for a NEW occurrence of its condition: fresher words, `created_at`
   *  bumped (it is the latest telling of the story), lifecycle state per `acted`. */
  reopen(id: string, input: { title: string; body: string | null; acted: boolean }): Notification {
    const t = now();
    this.db.prepare("UPDATE notifications SET title = ?, body = ?, created_at = ?, acted_at = ? WHERE id = ?")
      .run(input.title, input.body, t, input.acted ? t : null, id);
    return this.get(id)!;
  }

  /** The condition resolved: stamp `acted_at` and record what happened. Read state untouched — the user
   *  may still want to see how it ended. */
  resolve(id: string, body: string | null): Notification {
    this.db.prepare("UPDATE notifications SET acted_at = ?, body = COALESCE(?, body) WHERE id = ?").run(now(), body, id);
    return this.get(id)!;
  }

  /** Returns how many rows actually flipped — unknown or already-read ids are silently no-ops. */
  markRead(ids: string[]): number {
    let changed = 0; const t = now();
    const stmt = this.db.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL");
    for (const id of ids) changed += Number(stmt.run(t, id).changes);
    return changed;
  }

  markAllRead(): number {
    return Number(this.db.prepare("UPDATE notifications SET read_at = ? WHERE read_at IS NULL").run(now()).changes);
  }
}

/** A cursor that does not parse reads as "no cursor" (first page) rather than throwing — it is opaque
 *  client state, and a stale or mangled one should degrade to a fresh listing, not an error. */
function parseCursor(cursor: string | null): { createdAt: number; id: string } | null {
  if (!cursor) return null;
  const i = cursor.indexOf(":");
  if (i <= 0) return null;
  const createdAt = Number(cursor.slice(0, i));
  const id = cursor.slice(i + 1);
  return Number.isFinite(createdAt) && id ? { createdAt, id } : null;
}
