import type { Db } from "../db/database";

export class SettingsStore {
  constructor(private db: Db) {}
  get(key: string): unknown {
    const r = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined;
    return r ? JSON.parse(r.value_json) : null;
  }
  set(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
      .run(key, JSON.stringify(value));
  }
}
