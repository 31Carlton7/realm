import type { Db } from "../db/database";
import { newId, type Ship } from "@realm/contracts";
import { now } from "./rows";

type Row = { id: string; environment_id: string; space_id: string; branch: string | null; sha: string;
  subject: string; pr_url: string | null; push_state: Ship["pushState"]; created_at: number };
const toShip = (r: Row): Ship => ({
  id: r.id, environmentId: r.environment_id, spaceId: r.space_id, branch: r.branch, sha: r.sha,
  subject: r.subject, prUrl: r.pr_url, pushState: r.push_state, createdAt: r.created_at,
});

export type ShipInsert = {
  environmentId: string; spaceId: string; branch: string | null; sha: string; subject: string;
  prUrl: string | null; pushState: Ship["pushState"];
};

/**
 * Rows only — the rule for WHEN a ship logs (something durable happened) lives in
 * `GitWriteService.ship`, the one writer. Feed order and pagination are the notifications store's,
 * verbatim: `created_at DESC, id DESC`, keyset cursor `${createdAt}:${id}`.
 */
export class ShipsStore {
  constructor(private db: Db) {}

  record(input: ShipInsert): Ship {
    const id = newId();
    this.db.prepare("INSERT INTO ships (id, environment_id, space_id, branch, sha, subject, pr_url, push_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.environmentId, input.spaceId, input.branch, input.sha, input.subject, input.prUrl, input.pushState, now());
    return toShip(this.db.prepare("SELECT * FROM ships WHERE id = ?").get(id) as Row);
  }

  /** One page of one space's log. The `space_id = ?` filter is load-bearing (a named W1 mutant):
   *  two spaces' ships must never appear in one listing, however their timestamps interleave. */
  list(input: { spaceId: string; cursor: string | null; limit: number }): { ships: Ship[]; nextCursor: string | null } {
    const parsed = parseCursor(input.cursor);
    const rows = (parsed
      ? this.db.prepare("SELECT * FROM ships WHERE space_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?")
          .all(input.spaceId, parsed.createdAt, parsed.createdAt, parsed.id, input.limit)
      : this.db.prepare("SELECT * FROM ships WHERE space_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(input.spaceId, input.limit)) as Row[];
    const last = rows.at(-1);
    // A short page IS the end; only a full page might have more behind it.
    const nextCursor = rows.length === input.limit && last ? `${last.created_at}:${last.id}` : null;
    return { ships: rows.map(toShip), nextCursor };
  }
}

/** A cursor that does not parse reads as "no cursor" (first page) — it is opaque client state, and a
 *  stale or mangled one should degrade to a fresh listing, not an error. */
function parseCursor(cursor: string | null): { createdAt: number; id: string } | null {
  if (!cursor) return null;
  const i = cursor.indexOf(":");
  if (i <= 0) return null;
  const createdAt = Number(cursor.slice(0, i));
  const id = cursor.slice(i + 1);
  return Number.isFinite(createdAt) && id ? { createdAt, id } : null;
}
