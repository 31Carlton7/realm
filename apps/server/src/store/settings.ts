import type { Db } from "../db/database";

export class SettingsStore {
  constructor(private db: Db) {}
  get(key: string): unknown {
    const r = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined;
    if (!r) return null;
    try { return JSON.parse(r.value_json) as unknown; } catch { return null; }
  }
  /** Several keys in one read, each as `get` would read it. A key with no row is absent from the map. */
  getMany(keys: readonly string[]): Map<string, unknown> {
    const out = new Map<string, unknown>();
    if (keys.length === 0) return out;
    const rows = this.db.prepare("SELECT key, value_json FROM settings WHERE key IN (SELECT value FROM json_each(?))").all(JSON.stringify(keys)) as { key: string; value_json: string }[];
    for (const r of rows) {
      try { out.set(r.key, JSON.parse(r.value_json) as unknown); } catch { out.set(r.key, null); }
    }
    return out;
  }
  /** Whether the key was ever written — `get` reads a key set to null and a missing one alike. */
  has(key: string): boolean {
    return this.db.prepare("SELECT 1 FROM settings WHERE key = ?").get(key) !== undefined;
  }
  /** A key holding a list of ids. A missing key, or one whose value is not an array of strings,
   *  reads as empty — settings rows are user-editable JSON and must not crash a caller. */
  getIds(key: string): string[] {
    const v = this.get(key);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  }

  /** `undefined` (e.g. an omitted RPC `value`) is stored as null so the row stays valid JSON. */
  set(key: string, value: unknown): void {
    if (value === undefined) value = null;
    this.db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
      .run(key, JSON.stringify(value));
  }
}
