import type { Db } from "../db/database";

export class SettingsStore {
  constructor(private db: Db) {}
  get(key: string): unknown {
    const r = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined;
    if (!r) return null;
    try { return JSON.parse(r.value_json) as unknown; } catch { return null; }
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

  /**
   * Each distinct value kept under a key that starts with `prefix`. For keys named after something
   * else, one per profile or per session, where no caller holds every name.
   *
   * Read as a range of the key's index. Its end is `prefix` with the last character stepped once,
   * so `prefix` must end in a character that can be stepped, as the `:` of `name:` can.
   */
  distinctUnder(prefix: string): unknown[] {
    const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    const rows = this.db.prepare("SELECT DISTINCT value_json FROM settings WHERE key >= ? AND key < ?").all(prefix, end) as { value_json: string }[];
    return rows.flatMap((r) => { try { return [JSON.parse(r.value_json) as unknown]; } catch { return []; } });
  }

  /** Drops the row. For a key named after something that can go away, such as a session: a null
   *  left behind for each would outlive what it described. */
  delete(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }
}
