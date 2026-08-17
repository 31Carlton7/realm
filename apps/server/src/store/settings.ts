import type { Db } from "../db/database";

export class SettingsStore {
  constructor(private db: Db) {}
  get(key: string): unknown {
    const r = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined;
    if (!r) return null;
    try { return JSON.parse(r.value_json) as unknown; } catch { return null; }
  }
  /** `undefined` (e.g. an omitted RPC `value`) is stored as null so the row stays valid JSON. */
  set(key: string, value: unknown): void {
    if (value === undefined) value = null;
    this.db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
      .run(key, JSON.stringify(value));
  }
}
