import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { openDatabase } from "../../db/database";
import { migrations } from "../../db/migrations";

/**
 * The tool-classes migration (v53 on the integration line, after record types and deliverables),
 * against a hand-written home as v50 left it rather than one replayed from `migrations` — a replayed
 * fixture agrees with any mutation of the list it was built from. Found by its own text, never its
 * number, because a merge may reorder it.
 */
const AT = migrations.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS tool_classes"));

const BEFORE = `
CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL, color TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
`;

function v50Home(): string {
  const p = join(tempDir("realm-tool-classes-db-"), "realm.db");
  const db = new DatabaseSync(p);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  db.exec(BEFORE);
  for (let v = 1; v <= AT; v++) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, 1);
  db.prepare("INSERT INTO profiles (id, name, icon, color, created_at, updated_at) VALUES ('P1', 'Me', 'x', '#000', 1, 1)").run();
  db.prepare("INSERT INTO settings (key, value_json) VALUES ('mcp.allowedTools:S:R', '[\"a\"]')").run();
  db.close();
  return p;
}

describe("the tool_classes migration", () => {
  it("is the last migration on this branch", () => {
    expect(AT).toBe(migrations.length - 1);
  });

  it("adds an empty table keyed by profile, connector and tool, and leaves every other row alone", () => {
    const db = openDatabase(v50Home());
    expect(db.prepare("SELECT COUNT(*) AS n FROM tool_classes").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT key, value_json FROM settings").all()).toEqual([{ key: "mcp.allowedTools:S:R", value_json: "[\"a\"]" }]);
    const ins = db.prepare("INSERT INTO tool_classes (profile_id, connector, tool, class, set_at) VALUES ('P1', 'mcp:R', 'send_thing', 'irreversible-external', 1)");
    ins.run();
    expect(() => ins.run()).toThrow(/UNIQUE|PRIMARY/);
    // A row for a profile that does not exist is refused, and the profile's rows go with it.
    expect(() => db.prepare("INSERT INTO tool_classes (profile_id, connector, tool, class, set_at) VALUES ('NOPE', 'mcp:R', 'x', 'read', 1)").run()).toThrow(/FOREIGN KEY/);
    db.prepare("DELETE FROM profiles WHERE id = 'P1'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM tool_classes").get()).toEqual({ n: 0 });
  });

  it("is safe to meet twice", () => {
    const db = openDatabase(v50Home());
    db.prepare("INSERT INTO tool_classes (profile_id, connector, tool, class, set_at) VALUES ('P1', 'mcp:R', 'x', 'read', 1)").run();
    db.exec(migrations[AT]!);
    expect(db.prepare("SELECT COUNT(*) AS n FROM tool_classes").get()).toEqual({ n: 1 });
  });
});
