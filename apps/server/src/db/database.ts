import { DatabaseSync } from "node:sqlite";
import { migrations } from "./migrations";

export type Db = DatabaseSync;

export function openDatabase(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_version").get() as { v: number };
  for (let v = row.v; v < migrations.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(migrations[v]!);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v + 1, Date.now());
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }
  return db;
}
