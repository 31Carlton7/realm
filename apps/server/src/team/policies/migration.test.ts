import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { openDatabase } from "../../db/database";
import { migrations } from "../../db/migrations";
import { BARE, PROFILE, RESEARCH, SHOP, STUDIO, V50_SCHEMA, V50_TABLES, VERSED, columnsOf, fixtureRepos, snapshot, v50Rows } from "../v50-fixture";

/**
 * The tool-classes (v53) and team-policies (v54) migrations, against the hand-written v50 home rather
 * than one replayed from `migrations` — a replayed fixture agrees with any mutation of the list it was
 * built from. Each is found by its own text, never its number, because a merge may reorder them.
 */
const V51_AT = migrations.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS team_record_types"));
const CLASSES_AT = migrations.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS tool_classes"));
const POLICIES_AT = migrations.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS team_policies"));

function v50Home(): string {
  const root = tempDir("realm-policies-db-");
  const repos = fixtureRepos(root);
  const p = join(root, "realm.db");
  const db = new DatabaseSync(p);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  db.exec(V50_SCHEMA);
  for (let v = 1; v <= V51_AT; v++) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, 1);
  db.exec(v50Rows({ root, repos, later: Date.now() + 3 * 86_400_000 }));
  db.close();
  return p;
}

const policies = (db: DatabaseSync) => db.prepare(
  "SELECT space_id, scope, scope_key, decision, caps_json, checks_json, set_by, seal FROM team_policies ORDER BY space_id, scope_key").all();

describe("the tool_classes migration", () => {
  it("comes after record types and deliverables", () => {
    expect(V51_AT).toBeGreaterThan(-1);
    expect(CLASSES_AT).toBeGreaterThan(V51_AT);
  });

  it("adds an empty table keyed by profile, connector and tool", () => {
    const db = openDatabase(v50Home());
    expect(db.prepare("SELECT COUNT(*) AS n FROM tool_classes").get()).toEqual({ n: 0 });
    const ins = db.prepare(`INSERT INTO tool_classes (profile_id, connector, tool, class, set_at) VALUES ('${PROFILE}', 'mcp:R', 'send_thing', 'irreversible-external', 1)`);
    ins.run();
    expect(() => ins.run()).toThrow(/UNIQUE|PRIMARY/);
    expect(() => db.prepare("INSERT INTO tool_classes (profile_id, connector, tool, class, set_at) VALUES ('NOPE', 'mcp:R', 'x', 'read', 1)").run()).toThrow(/FOREIGN KEY/);
    db.prepare("DELETE FROM profiles WHERE id = ?").run(PROFILE);
    expect(db.prepare("SELECT COUNT(*) AS n FROM tool_classes").get()).toEqual({ n: 0 });
  });

  it("is safe to meet twice", () => {
    const db = openDatabase(v50Home());
    db.prepare(`INSERT INTO tool_classes (profile_id, connector, tool, class, set_at) VALUES ('${PROFILE}', 'mcp:R', 'x', 'read', 1)`).run();
    db.exec(migrations[CLASSES_AT]!);
    expect(db.prepare("SELECT COUNT(*) AS n FROM tool_classes").get()).toEqual({ n: 1 });
  });
});

describe("migration v54 — team policies", () => {
  it("comes right after the tool classes", () => {
    expect(POLICIES_AT).toBe(CLASSES_AT + 1);
  });

  it("loses nothing: every v50 row of every table is byte-equal after, on its v50 columns", () => {
    const p = v50Home();
    const raw = new DatabaseSync(p);
    const columns = columnsOf(raw);
    const rows = snapshot(raw, V50_TABLES, columns);
    raw.close();
    const db = openDatabase(p);
    expect(snapshot(db, V50_TABLES, columns)).toEqual(rows);
    db.close();
  });

  it("gives every team the four class floors as unsealed migration rows, and a space with no team nothing", () => {
    const db = openDatabase(v50Home());
    const teams = (db.prepare("SELECT space_id FROM team_meta ORDER BY space_id").all() as { space_id: string }[]).map((r) => r.space_id);
    expect(teams).toEqual([VERSED, RESEARCH, STUDIO, SHOP].sort());
    const floors = [["internal-write", "auto"], ["irreversible-external", "ask"], ["read", "auto"], ["reversible-external", "ask"]];
    expect(policies(db)).toEqual(teams.flatMap((space_id) => floors.map(([scope_key, decision]) => ({
      space_id, scope: "class", scope_key, decision, caps_json: "{}", checks_json: "[]", set_by: "migration", seal: null,
    }))));
    // No verb rows: the creator-campaigns pacing as policy rows is v55's, with the tickets that carry it.
    expect(db.prepare("SELECT COUNT(*) AS n FROM team_policies WHERE scope <> 'class'").get()).toEqual({ n: 0 });
  });

  it("is safe to meet twice: a row the person changed since stays as they left it", () => {
    const db = openDatabase(v50Home());
    db.prepare("UPDATE team_policies SET decision = 'block', set_by = 'user' WHERE space_id = ? AND scope_key = 'irreversible-external'").run(VERSED);
    const was = policies(db);
    db.exec(migrations[POLICIES_AT]!);
    expect(policies(db)).toEqual(was);
  });

  it("gives a team made after it the same four floors, as its meta row is written", () => {
    const db = openDatabase(v50Home());
    db.prepare("INSERT INTO team_meta (space_id, template, template_version, created_at) VALUES (?, NULL, NULL, 7)").run(BARE);
    expect(db.prepare("SELECT scope, scope_key, decision, set_by, seal, created_at FROM team_policies WHERE space_id = ? ORDER BY scope_key").all(BARE)).toEqual([
      ["internal-write", "auto"], ["irreversible-external", "ask"], ["read", "auto"], ["reversible-external", "ask"],
    ].map(([scope_key, decision]) => ({ scope: "class", scope_key, decision, set_by: "template", seal: null, created_at: 7 })));
    // A second meta row for a team that has one is ignored, and its rows stay as they are.
    db.prepare("UPDATE team_policies SET decision = 'block' WHERE space_id = ? AND scope_key = 'read'").run(BARE);
    db.prepare("INSERT OR IGNORE INTO team_meta (space_id, template, template_version, created_at) VALUES (?, NULL, NULL, 8)").run(BARE);
    expect(db.prepare("SELECT decision FROM team_policies WHERE space_id = ? AND scope_key = 'read'").get(BARE)).toEqual({ decision: "block" });
  });

  it("holds one row per scope and key in a space, and a team's rows go with its space", () => {
    const db = openDatabase(v50Home());
    expect(() => db.prepare("INSERT INTO team_policies (id, space_id, scope, scope_key, decision, set_by, created_at, updated_at) VALUES ('x', ?, 'class', 'read', 'ask', 'user', 1, 1)").run(VERSED)).toThrow(/UNIQUE/);
    db.prepare("DELETE FROM spaces WHERE id = ?").run(VERSED);
    expect(db.prepare("SELECT COUNT(*) AS n FROM team_policies WHERE space_id = ?").get(VERSED)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM team_policies WHERE space_id = ?").get(RESEARCH)).toEqual({ n: 4 });
  });
});
