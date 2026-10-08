import { newId, type AgentKind, type ReviewKind, type ReviewState, type ReviewTarget, type TeamActivity, type TeamReviewItem } from "@realm/contracts";
import type { Db } from "../db/database";
import { now } from "../store/rows";

/** A role row as stored — the derived half of `TeamRole` (state, spend, schedule) is the service's. */
export type RoleRow = {
  id: string; spaceId: string; name: string; brief: string; realmite: Record<string, unknown>; template: string | null;
  agentKind: AgentKind; model: string | null; effort: string | null; permissionMode: "plan" | "default" | "acceptEdits";
  skills: string[]; wakeOnReview: boolean; weekBudgetUsd: number | null; runCapUsd: number; runCapMs: number;
  maxConcurrent: number; archived: boolean; sortOrder: number; createdAt: number; updatedAt: number;
};

type RawRole = {
  id: string; space_id: string; name: string; brief: string; realmite_json: string; template: string | null;
  agent_kind: AgentKind; model: string | null; effort: string | null; permission_mode: RoleRow["permissionMode"];
  skills_json: string; wake_on_review: number; week_budget_usd: number | null; run_cap_usd: number; run_cap_ms: number;
  max_concurrent: number; archived: number; sort_order: number; created_at: number; updated_at: number;
};

function json<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

const toRole = (r: RawRole): RoleRow => ({
  id: r.id, spaceId: r.space_id, name: r.name, brief: r.brief,
  realmite: json<Record<string, unknown>>(r.realmite_json, {}), template: r.template,
  agentKind: r.agent_kind, model: r.model, effort: r.effort, permissionMode: r.permission_mode,
  skills: json<string[]>(r.skills_json, []).filter((x) => typeof x === "string"),
  wakeOnReview: r.wake_on_review === 1, weekBudgetUsd: r.week_budget_usd, runCapUsd: r.run_cap_usd, runCapMs: r.run_cap_ms,
  maxConcurrent: r.max_concurrent, archived: r.archived === 1, sortOrder: r.sort_order, createdAt: r.created_at, updatedAt: r.updated_at,
});

export type ReviewRow = {
  id: string; spaceId: string; roleId: string | null; runId: string | null; sessionId: string | null; recordPath: string | null;
  kind: ReviewKind; title: string; state: ReviewState; note: string | null; version: number;
  createdAt: number; decidedAt: number | null; updatedAt: number;
};
type RawReview = {
  id: string; space_id: string; role_id: string | null; run_id: string | null; session_id: string | null; record_path: string | null;
  kind: ReviewKind; title: string; state: ReviewState; note: string | null; version: number;
  created_at: number; decided_at: number | null; updated_at: number;
};
const toReview = (r: RawReview): ReviewRow => ({
  id: r.id, spaceId: r.space_id, roleId: r.role_id, runId: r.run_id, sessionId: r.session_id, recordPath: r.record_path,
  kind: r.kind, title: r.title, state: r.state, note: r.note, version: r.version,
  createdAt: r.created_at, decidedAt: r.decided_at, updatedAt: r.updated_at,
});

type RawItem = {
  id: string; review_id: string; version: number; ord: number; files_json: string; body: string | null; target_json: string | null;
  content_hash: string; approved_hash: string | null; act_state: string;
};
const toItem = (r: RawItem): TeamReviewItem => ({
  id: r.id, reviewId: r.review_id, version: r.version, ord: r.ord,
  files: json<string[]>(r.files_json, []), body: r.body, target: json<ReviewTarget | null>(r.target_json, null),
  contentHash: r.content_hash, approvedHash: r.approved_hash, actState: r.act_state,
});

type RawActivity = {
  id: string; space_id: string; ts: number; actor: string; run_id: string | null; session_id: string | null;
  verb: string; object: string | null; detail_json: string;
};
const toActivity = (r: RawActivity): TeamActivity => ({
  id: r.id, spaceId: r.space_id, ts: r.ts, actor: r.actor, runId: r.run_id, sessionId: r.session_id,
  verb: r.verb, object: r.object, detail: json<Record<string, unknown>>(r.detail_json, {}),
});

export type RoleInsert = Omit<RoleRow, "id" | "archived" | "sortOrder" | "createdAt" | "updatedAt">;
export type RolePatch = Partial<Omit<RoleRow, "id" | "spaceId" | "createdAt" | "updatedAt">>;
export type ItemInsert = { files: string[]; body: string | null; target: ReviewTarget | null; contentHash: string };

/**
 * The team tables: rows only. Every rule about which change is allowed is `TeamService`'s.
 *
 * `team_activity` is APPEND-ONLY: this store has `appendActivity` and reads, and nothing that updates
 * or deletes a line (`store.test.ts` holds that by reading this file).
 */
export class TeamStore {
  constructor(private db: Db, private clock: () => number = now) {}

  /* ── roles ── */

  roles(spaceId: string, includeArchived = false): RoleRow[] {
    return (this.db.prepare(`SELECT * FROM team_roles WHERE space_id = ?${includeArchived ? "" : " AND archived = 0"} ORDER BY sort_order, created_at`)
      .all(spaceId) as RawRole[]).map(toRole);
  }

  role(id: string): RoleRow | null {
    const r = this.db.prepare("SELECT * FROM team_roles WHERE id = ?").get(id) as RawRole | undefined;
    return r ? toRole(r) : null;
  }

  /** Spaces that have ever had a role: what "a team" means. */
  teamSpaceIds(): string[] {
    return (this.db.prepare("SELECT DISTINCT space_id AS s FROM team_roles").all() as { s: string }[]).map((r) => r.s);
  }

  roleByName(spaceId: string, name: string): RoleRow | null {
    const r = this.db.prepare("SELECT * FROM team_roles WHERE space_id = ? AND archived = 0 AND name = ? COLLATE NOCASE").get(spaceId, name) as RawRole | undefined;
    return r ? toRole(r) : null;
  }

  createRole(input: RoleInsert): RoleRow {
    const id = newId(); const t = this.clock();
    const order = (this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM team_roles WHERE space_id = ?").get(input.spaceId) as { n: number }).n;
    this.db.prepare(`INSERT INTO team_roles (id, space_id, name, brief, realmite_json, template, agent_kind, model, effort, permission_mode,
        skills_json, wake_on_review, week_budget_usd, run_cap_usd, run_cap_ms, max_concurrent, archived, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
      .run(id, input.spaceId, input.name, input.brief, JSON.stringify(input.realmite), input.template, input.agentKind, input.model, input.effort,
        input.permissionMode, JSON.stringify(input.skills), input.wakeOnReview ? 1 : 0, input.weekBudgetUsd, input.runCapUsd, input.runCapMs,
        input.maxConcurrent, order, t, t);
    return this.role(id)!;
  }

  updateRole(id: string, p: RolePatch): RoleRow | null {
    const sets: string[] = []; const vals: (string | number | null)[] = [];
    const put = (col: string, v: string | number | null) => { sets.push(`${col} = ?`); vals.push(v); };
    if (p.name !== undefined) put("name", p.name);
    if (p.brief !== undefined) put("brief", p.brief);
    if (p.realmite !== undefined) put("realmite_json", JSON.stringify(p.realmite));
    if (p.template !== undefined) put("template", p.template);
    if (p.agentKind !== undefined) put("agent_kind", p.agentKind);
    if (p.model !== undefined) put("model", p.model);
    if (p.effort !== undefined) put("effort", p.effort);
    if (p.permissionMode !== undefined) put("permission_mode", p.permissionMode);
    if (p.skills !== undefined) put("skills_json", JSON.stringify(p.skills));
    if (p.wakeOnReview !== undefined) put("wake_on_review", p.wakeOnReview ? 1 : 0);
    if (p.weekBudgetUsd !== undefined) put("week_budget_usd", p.weekBudgetUsd);
    if (p.runCapUsd !== undefined) put("run_cap_usd", p.runCapUsd);
    if (p.runCapMs !== undefined) put("run_cap_ms", p.runCapMs);
    if (p.maxConcurrent !== undefined) put("max_concurrent", p.maxConcurrent);
    if (p.archived !== undefined) put("archived", p.archived ? 1 : 0);
    if (p.sortOrder !== undefined) put("sort_order", p.sortOrder);
    if (sets.length === 0) return this.role(id);
    put("updated_at", this.clock());
    vals.push(id);
    this.db.prepare(`UPDATE team_roles SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    return this.role(id);
  }

  /* ── reviews ── */

  reviews(spaceId: string, limit = 200): ReviewRow[] {
    return (this.db.prepare("SELECT * FROM team_reviews WHERE space_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(spaceId, limit) as RawReview[]).map(toReview);
  }

  /** Every review still waiting on a person, across spaces — the sidebar's Needs you. */
  waiting(): ReviewRow[] {
    return (this.db.prepare("SELECT * FROM team_reviews WHERE state = 'waiting' ORDER BY created_at ASC").all() as RawReview[]).map(toReview);
  }

  review(id: string): ReviewRow | null {
    const r = this.db.prepare("SELECT * FROM team_reviews WHERE id = ?").get(id) as RawReview | undefined;
    return r ? toReview(r) : null;
  }

  reviewForRun(runId: string): ReviewRow | null {
    const r = this.db.prepare("SELECT * FROM team_reviews WHERE run_id = ? ORDER BY created_at DESC LIMIT 1").get(runId) as RawReview | undefined;
    return r ? toReview(r) : null;
  }

  createReview(input: { spaceId: string; roleId: string | null; runId: string | null; sessionId: string | null; recordPath: string | null; kind: ReviewKind; title: string },
    items: ItemInsert[]): ReviewRow {
    const id = newId(); const t = this.clock();
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`INSERT INTO team_reviews (id, space_id, role_id, run_id, session_id, record_path, kind, title, state, note, version, created_at, decided_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', NULL, 1, ?, NULL, ?)`)
        .run(id, input.spaceId, input.roleId, input.runId, input.sessionId, input.recordPath, input.kind, input.title, t, t);
      this.insertItems(id, 1, items);
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    return this.review(id)!;
  }

  /** A revision: the new items become the review's current version, the old ones stay one step back,
   *  and the review is waiting again. */
  revise(id: string, input: { runId: string | null; sessionId: string | null; title: string }, items: ItemInsert[]): ReviewRow {
    const before = this.review(id)!;
    const version = before.version + 1; const t = this.clock();
    this.db.exec("BEGIN");
    try {
      this.insertItems(id, version, items);
      this.db.prepare(`UPDATE team_reviews SET version = ?, state = 'waiting', run_id = COALESCE(?, run_id), session_id = COALESCE(?, session_id),
        title = ?, decided_at = NULL, updated_at = ? WHERE id = ?`).run(version, input.runId, input.sessionId, input.title, t, id);
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    return this.review(id)!;
  }

  private insertItems(reviewId: string, version: number, items: ItemInsert[]): void {
    const ins = this.db.prepare(`INSERT INTO team_review_items (id, review_id, version, ord, files_json, body, target_json, content_hash, approved_hash, act_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'none')`);
    items.forEach((it, ord) => ins.run(newId(), reviewId, version, ord, JSON.stringify(it.files), it.body, it.target ? JSON.stringify(it.target) : null, it.contentHash));
  }

  setReviewState(id: string, state: ReviewState, o: { note?: string | null; decided?: boolean } = {}): ReviewRow | null {
    const t = this.clock();
    this.db.prepare(`UPDATE team_reviews SET state = ?, note = CASE WHEN ? THEN ? ELSE note END, decided_at = CASE WHEN ? THEN ? ELSE decided_at END, updated_at = ? WHERE id = ?`)
      .run(state, o.note !== undefined ? 1 : 0, o.note ?? null, o.decided ? 1 : 0, t, t, id);
    return this.review(id);
  }

  items(reviewId: string, version?: number): TeamReviewItem[] {
    const rows = version === undefined
      ? this.db.prepare("SELECT * FROM team_review_items WHERE review_id = ? ORDER BY version DESC, ord ASC").all(reviewId)
      : this.db.prepare("SELECT * FROM team_review_items WHERE review_id = ? AND version = ? ORDER BY ord ASC").all(reviewId, version);
    return (rows as RawItem[]).map(toItem);
  }

  /** Record what was approved: each current item's hash as it stood, and the item ready to act on. */
  approveItems(reviewId: string, version: number): void {
    this.db.prepare("UPDATE team_review_items SET approved_hash = content_hash, act_state = 'ready' WHERE review_id = ? AND version = ?").run(reviewId, version);
  }

  /** A file changed under an item: its hash moves, and a yes given to the old bytes no longer covers it. */
  setItemHash(itemId: string, hash: string): void {
    this.db.prepare("UPDATE team_review_items SET content_hash = ?, act_state = CASE WHEN approved_hash IS NOT NULL AND approved_hash <> ? THEN 'none' ELSE act_state END WHERE id = ?")
      .run(hash, hash, itemId);
  }

  /* ── activity (append-only) ── */

  appendActivity(a: { spaceId: string; actor: string; runId?: string | null; sessionId?: string | null; verb: string; object?: string | null; detail?: Record<string, unknown> }): TeamActivity {
    const id = newId();
    this.db.prepare("INSERT INTO team_activity (id, space_id, ts, actor, run_id, session_id, verb, object, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, a.spaceId, this.clock(), a.actor, a.runId ?? null, a.sessionId ?? null, a.verb, a.object ?? null, JSON.stringify(a.detail ?? {}));
    return toActivity(this.db.prepare("SELECT * FROM team_activity WHERE id = ?").get(id) as RawActivity);
  }

  activity(spaceId: string, limit: number, before?: number): TeamActivity[] {
    const rows = before === undefined
      ? this.db.prepare("SELECT * FROM team_activity WHERE space_id = ? ORDER BY ts DESC, id DESC LIMIT ?").all(spaceId, limit)
      : this.db.prepare("SELECT * FROM team_activity WHERE space_id = ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT ?").all(spaceId, before, limit);
    return (rows as RawActivity[]).map(toActivity);
  }

  activityForRun(runId: string): TeamActivity[] {
    return (this.db.prepare("SELECT * FROM team_activity WHERE run_id = ? ORDER BY ts ASC, id ASC").all(runId) as RawActivity[]).map(toActivity);
  }
}
