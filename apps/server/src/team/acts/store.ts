import { newId, type ActKind, type SlotWhy, type TicketState } from "@realm/contracts";
import type { Db } from "../../db/database";
import { now } from "../../store/rows";

/** A ticket as stored. What the record says about its account, and the adapter's state, are the
 *  service's to add. */
export type TicketRow = {
  id: string; spaceId: string; reviewId: string; itemId: string;
  kind: ActKind; channel: string; account: string; to: string | null;
  contentHash: string; state: TicketState; slotAt: number; slotWhy: SlotWhy;
  pressedAt: number | null; disclosure: "caption" | "label" | null; actedAt: number | null;
  proofUrl: string | null; screenshot: string | null; error: string | null;
  createdAt: number; updatedAt: number;
};

type Raw = {
  id: string; space_id: string; review_id: string; item_id: string; kind: ActKind; channel: string; account: string; recipient: string | null;
  content_hash: string; state: TicketState; slot_at: number; slot_why: SlotWhy; pressed_at: number | null; disclosure: "caption" | "label" | null;
  acted_at: number | null; proof_url: string | null; screenshot: string | null; error: string | null; created_at: number; updated_at: number;
};

const toRow = (r: Raw): TicketRow => ({
  id: r.id, spaceId: r.space_id, reviewId: r.review_id, itemId: r.item_id, kind: r.kind, channel: r.channel, account: r.account, to: r.recipient,
  contentHash: r.content_hash, state: r.state, slotAt: r.slot_at, slotWhy: r.slot_why, pressedAt: r.pressed_at, disclosure: r.disclosure,
  actedAt: r.acted_at, proofUrl: r.proof_url, screenshot: r.screenshot, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at,
});

export type TicketInsert = Pick<TicketRow, "spaceId" | "reviewId" | "itemId" | "kind" | "channel" | "account" | "to" | "contentHash" | "slotAt" | "slotWhy">;
export type TicketPatch = Partial<Pick<TicketRow, "state" | "slotAt" | "slotWhy" | "pressedAt" | "disclosure" | "actedAt" | "proofUrl" | "screenshot" | "error">>;

/** The act tickets and the team's hold: rows only. Which change is allowed is `ActService`'s. */
export class ActStore {
  constructor(private db: Db, private clock: () => number = now) {}

  ticket(id: string): TicketRow | null {
    const r = this.db.prepare("SELECT * FROM team_act_tickets WHERE id = ?").get(id) as Raw | undefined;
    return r ? toRow(r) : null;
  }

  forReview(reviewId: string): TicketRow[] {
    return (this.db.prepare("SELECT * FROM team_act_tickets WHERE review_id = ? AND state <> 'cancelled' ORDER BY created_at, rowid").all(reviewId) as Raw[]).map(toRow);
  }

  forSpace(spaceId: string): TicketRow[] {
    return (this.db.prepare("SELECT * FROM team_act_tickets WHERE space_id = ? AND state <> 'cancelled' ORDER BY slot_at, rowid").all(spaceId) as Raw[]).map(toRow);
  }

  /** The item's ticket that is live or went out — at most one (a partial unique index). */
  liveForItem(itemId: string): TicketRow | null {
    const r = this.db.prepare("SELECT * FROM team_act_tickets WHERE item_id = ? AND state <> 'cancelled'").get(itemId) as Raw | undefined;
    return r ? toRow(r) : null;
  }

  /** Every ticket of a kind that holds or held a slot since `since`, across teams — what pacing plans
   *  around. A ready ticket counts only while its slot is ahead: one nobody pressed reserved nothing. */
  pacingSince(kind: ActKind, since: number, nowAt: number): TicketRow[] {
    return (this.db.prepare(`SELECT * FROM team_act_tickets WHERE kind = ? AND (
        (state = 'done' AND acted_at >= ?) OR (state IN ('scheduled', 'acting') AND slot_at >= ?) OR (state = 'ready' AND slot_at >= ?))`)
      .all(kind, since, since, nowAt) as Raw[]).map(toRow);
  }

  scheduled(): TicketRow[] {
    return (this.db.prepare("SELECT * FROM team_act_tickets WHERE state IN ('scheduled', 'acting') ORDER BY slot_at").all() as Raw[]).map(toRow);
  }

  insert(t: TicketInsert): TicketRow {
    const id = newId(); const at = this.clock();
    this.db.prepare(`INSERT INTO team_act_tickets (id, space_id, review_id, item_id, kind, channel, account, recipient, content_hash, state, slot_at, slot_why, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)`)
      .run(id, t.spaceId, t.reviewId, t.itemId, t.kind, t.channel, t.account, t.to, t.contentHash, t.slotAt, t.slotWhy, at, at);
    return this.ticket(id)!;
  }

  update(id: string, p: TicketPatch): TicketRow {
    const cols: Record<keyof TicketPatch, string> = {
      state: "state", slotAt: "slot_at", slotWhy: "slot_why", pressedAt: "pressed_at", disclosure: "disclosure", actedAt: "acted_at",
      proofUrl: "proof_url", screenshot: "screenshot", error: "error",
    };
    const sets: string[] = []; const vals: (string | number | null)[] = [];
    for (const [k, col] of Object.entries(cols) as [keyof TicketPatch, string][]) {
      if (p[k] !== undefined) { sets.push(`${col} = ?`); vals.push(p[k] as string | number | null); }
    }
    sets.push("updated_at = ?"); vals.push(this.clock());
    this.db.prepare(`UPDATE team_act_tickets SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.ticket(id)!;
  }

  /** Move a ticket only from the state it was read in — two presses, or a press and a hold, cannot
   *  both win. False when it had already moved. */
  transition(id: string, from: TicketState, p: TicketPatch & { state: TicketState }): boolean {
    const before = this.ticket(id);
    if (!before || before.state !== from) return false;
    const r = this.db.prepare("UPDATE team_act_tickets SET state = ?, updated_at = ? WHERE id = ? AND state = ?").run(p.state, this.clock(), id, from);
    if (Number(r.changes) !== 1) return false;
    this.update(id, p);
    return true;
  }

  /* ── the kill switch ── */

  held(spaceId: string): boolean {
    return this.db.prepare("SELECT 1 FROM team_act_holds WHERE space_id = ?").get(spaceId) !== undefined;
  }

  hold(spaceId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO team_act_holds (space_id, held_at) VALUES (?, ?)").run(spaceId, this.clock());
  }

  release(spaceId: string): void {
    this.db.prepare("DELETE FROM team_act_holds WHERE space_id = ?").run(spaceId);
  }
}
