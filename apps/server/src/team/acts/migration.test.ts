import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { openDatabase } from "../../db/database";
import { migrations } from "../../db/migrations";

/**
 * The act tickets' migration (v50 on the integration line), against a hand-written home as the vault
 * left it rather than one replayed from `migrations` — a replayed fixture agrees with any mutation of
 * the list it was built from.
 *
 * Found by its own text, never by number: on this branch it follows the vault's grants, and at merge it
 * goes last, after handoffs, the lab and activity_at (v47–v49).
 */
const ACTS_AT = migrations.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS team_act_tickets"));
const VAULT_AT = migrations.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS vault_grants"));

/** What it stands on, as the vault's migration left it: the spaces, Review's two tables and the log. */
const BEFORE = `
CREATE TABLE spaces (id TEXT PRIMARY KEY);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE team_reviews (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  role_id TEXT, run_id TEXT, session_id TEXT, record_path TEXT,
  kind TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, note TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, decided_at INTEGER, updated_at INTEGER NOT NULL);
CREATE TABLE team_review_items (
  id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES team_reviews(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1, ord INTEGER NOT NULL,
  files_json TEXT NOT NULL, body TEXT, target_json TEXT,
  content_hash TEXT NOT NULL, approved_hash TEXT,
  act_state TEXT NOT NULL DEFAULT 'none');
CREATE TABLE team_activity (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL, actor TEXT NOT NULL, run_id TEXT, session_id TEXT, verb TEXT NOT NULL, object TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE vault_grants (
  secret_id TEXT NOT NULL, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
  hosts_json TEXT NOT NULL DEFAULT '[]', purpose TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (secret_id, role_id));
-- What the record types' migration (v51) reads on the way to the end of the chain: the team's roles.
CREATE TABLE team_roles (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, template TEXT, created_at INTEGER NOT NULL);
`;

function vaultHome(): string {
  const p = join(tempDir("realm-acts-db-"), "realm.db");
  const db = new DatabaseSync(p);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  db.exec(BEFORE);
  for (let v = 1; v <= ACTS_AT; v++) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, 1);
  db.prepare("INSERT INTO spaces (id) VALUES ('sp1'), ('sp2')").run();
  db.prepare(`INSERT INTO team_reviews (id, space_id, kind, title, state, created_at, updated_at) VALUES ('R1', 'sp1', 'slideshows', '6 slideshows', 'approved', 1, 1)`).run();
  db.prepare(`INSERT INTO team_review_items (id, review_id, ord, files_json, content_hash, approved_hash, act_state) VALUES ('I1', 'R1', 0, '[]', 'h1', 'h1', 'ready'), ('I2', 'R1', 1, '[]', 'h2', 'h2', 'ready')`).run();
  db.prepare(`INSERT INTO team_activity (id, space_id, ts, actor, verb, detail_json) VALUES ('A1', 'sp1', 7, 'user', 'approved', '{}')`).run();
  db.close();
  return p;
}

const cols = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const ticket = (db: DatabaseSync, id: string, item: string, state = "ready") => db.prepare(`INSERT INTO team_act_tickets (id, space_id, review_id, item_id, kind, channel, account, content_hash, state, slot_at, created_at, updated_at)
  VALUES (?, 'sp1', 'R1', ?, 'post', 'TikTok', '@versed.nathan', 'h1', ?, 10, 1, 1)`).run(id, item, state);

describe("migration v50 — act tickets", () => {
  it("is appended after the vault's grants, and after sessions' activity_at", () => {
    // At merge the integration line puts v47–v49 between them, and the dynamic-Teams migrations
    // (v51 on) after it; it follows the last of the five whatever its index.
    expect(VAULT_AT).toBeGreaterThan(-1);
    expect(ACTS_AT).toBeGreaterThan(VAULT_AT);
    expect(ACTS_AT).toBe(migrations.findIndex((m) => m.includes("ALTER TABLE sessions ADD COLUMN activity_at")) + 1);
  });

  it("brings the vault's home to the end of the chain, and leaves Review and the log as they were", () => {
    const db = openDatabase(vaultHome());
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    expect(cols(db, "team_act_tickets")).toEqual(["id", "space_id", "review_id", "item_id", "kind", "channel", "account", "recipient", "content_hash",
      "state", "slot_at", "slot_why", "pressed_at", "disclosure", "acted_at", "proof_url", "screenshot", "error", "created_at", "updated_at"]);
    expect(cols(db, "team_act_holds")).toEqual(["space_id", "held_at"]);
    // THE MUTANT: a backfill that issues tickets for batches approved before this, or holds a team.
    expect(db.prepare("SELECT COUNT(*) AS n FROM team_act_tickets").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM team_act_holds").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT id, act_state FROM team_review_items ORDER BY id").all()).toEqual([{ id: "I1", act_state: "ready" }, { id: "I2", act_state: "ready" }]);
    expect(db.prepare("SELECT id, verb FROM team_activity").all()).toEqual([{ id: "A1", verb: "approved" }]);
    db.close();
  });

  it("starts a ticket ready, in the next slot, with no press and no proof", () => {
    const db = openDatabase(vaultHome());
    ticket(db, "T1", "I1");
    expect(db.prepare("SELECT state, slot_why, pressed_at, proof_url, screenshot FROM team_act_tickets").get())
      .toEqual({ state: "ready", slot_why: "next", pressed_at: null, proof_url: null, screenshot: null });
    db.close();
  });

  it("holds one live-or-done ticket per item — an item goes out once — while a cancelled one makes room", () => {
    const db = openDatabase(vaultHome());
    ticket(db, "T1", "I1", "cancelled");
    ticket(db, "T2", "I1", "done");
    // THE MUTANT: the unique index without its `WHERE state <> 'cancelled'`, or no index at all.
    expect(() => ticket(db, "T3", "I1", "ready")).toThrow(/UNIQUE/);
    ticket(db, "T4", "I2", "ready");
    db.close();
  });

  it("goes with its space — the tickets and the hold — and only that space's", () => {
    const db = openDatabase(vaultHome());
    ticket(db, "T1", "I1");
    db.prepare("INSERT INTO team_act_holds (space_id, held_at) VALUES ('sp1', 5), ('sp2', 5)").run();
    db.prepare("DELETE FROM spaces WHERE id = 'sp1'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM team_act_tickets").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT space_id FROM team_act_holds").all()).toEqual([{ space_id: "sp2" }]);
    db.close();
  });

  it("is idempotent: reopened, and its SQL met again, nothing re-runs or throws, and a ticket written since stays", () => {
    const p = vaultHome();
    const db = openDatabase(p);
    ticket(db, "T1", "I1");
    expect(() => db.exec(migrations[ACTS_AT]!)).not.toThrow();
    db.close();
    const again = openDatabase(p);
    expect((again.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n).toBe(migrations.length);
    expect(again.prepare("SELECT id FROM team_act_tickets").all()).toEqual([{ id: "T1" }]);
    again.close();
  });

  it("plans an account's slots off an index", () => {
    const db = openDatabase(vaultHome());
    const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT * FROM team_act_tickets WHERE kind = ? AND channel = ? AND account = ? AND slot_at >= ?").all("post", "TikTok", "@a", 0) as { detail: string }[]).map((r) => r.detail).join(" ");
    expect(plan).toContain("team_act_tickets_account");
    db.close();
  });
});
