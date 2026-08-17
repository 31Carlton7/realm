import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database";

describe("database", () => {
  it("creates schema and records version", () => {
    const dir = mkdtempSync(join(tmpdir(), "realm-db-"));
    const db = openDatabase(join(dir, "realm.db"));
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    expect(row.v).toBeGreaterThanOrEqual(1);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const t of ["profiles", "spaces", "projects", "items", "terminals", "settings"]) expect(names).toContain(t);
    db.close();
  });
  it("is idempotent on reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "realm-db-"));
    const p = join(dir, "realm.db");
    openDatabase(p).close();
    expect(() => openDatabase(p).close()).not.toThrow();
  });
});
