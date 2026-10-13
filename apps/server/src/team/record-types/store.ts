import { newId, type RecordHeadField, type RecordPreset, type RecordSection, type RecordType } from "@realm/contracts";
import type { Db } from "../../db/database";
import { now } from "../../store/rows";

type Raw = {
  id: string; space_id: string; key: string; one: string; many: string; folder: string; glyph: string; title_field: string;
  status_field: string | null; statuses_json: string; head_json: string; sections_json: string; preset: string | null;
  sort_order: number; archived: number; created_at: number; updated_at: number;
};

function json<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

const toType = (r: Raw): RecordType => ({
  id: r.id, spaceId: r.space_id, key: r.key, one: r.one, many: r.many, folder: r.folder, glyph: r.glyph,
  titleField: r.title_field, statusField: r.status_field,
  statuses: json<unknown[]>(r.statuses_json, []).filter((x): x is string => typeof x === "string"),
  head: json<RecordHeadField[]>(r.head_json, []).filter((h) => h && typeof h.key === "string"),
  sections: json<RecordSection[]>(r.sections_json, []).filter((s) => s && typeof s.heading === "string"),
  preset: r.preset, archived: r.archived === 1, sortOrder: r.sort_order, createdAt: r.created_at, updatedAt: r.updated_at,
});

export type TeamMeta = { spaceId: string; template: string | null; templateVersion: number | null; createdAt: number };
export type RecordTypeInsert = RecordPreset & { spaceId: string; preset: string | null };
export type RecordTypePatch = Partial<Omit<RecordPreset, "key">> & { archived?: boolean };

/**
 * `team_meta` and `team_record_types`: rows only. Which change is allowed — a folder renamed only
 * while empty, a key never — is `RecordTypeService`'s.
 */
export class RecordTypeStore {
  constructor(private db: Db, private clock: () => number = now) {}

  meta(spaceId: string): TeamMeta | null {
    const r = this.db.prepare("SELECT * FROM team_meta WHERE space_id = ?").get(spaceId) as { space_id: string; template: string | null; template_version: number | null; created_at: number } | undefined;
    return r ? { spaceId: r.space_id, template: r.template, templateVersion: r.template_version, createdAt: r.created_at } : null;
  }

  /** A team's meta row, made once; a second call keeps the first answer. */
  ensureMeta(spaceId: string, template: string | null, templateVersion: number | null): TeamMeta {
    this.db.prepare("INSERT OR IGNORE INTO team_meta (space_id, template, template_version, created_at) VALUES (?, ?, ?, ?)").run(spaceId, template, templateVersion, this.clock());
    return this.meta(spaceId)!;
  }

  types(spaceId: string, includeArchived = false): RecordType[] {
    return (this.db.prepare(`SELECT * FROM team_record_types WHERE space_id = ?${includeArchived ? "" : " AND archived = 0"} ORDER BY sort_order, created_at, key`)
      .all(spaceId) as Raw[]).map(toType);
  }

  type(id: string): RecordType | null {
    const r = this.db.prepare("SELECT * FROM team_record_types WHERE id = ?").get(id) as Raw | undefined;
    return r ? toType(r) : null;
  }

  /** By key or by folder, archived included: both are unique in a space whether or not a type is shown. */
  byKey(spaceId: string, key: string): RecordType | null {
    const r = this.db.prepare("SELECT * FROM team_record_types WHERE space_id = ? AND key = ?").get(spaceId, key) as Raw | undefined;
    return r ? toType(r) : null;
  }

  byFolder(spaceId: string, folder: string): RecordType | null {
    const r = this.db.prepare("SELECT * FROM team_record_types WHERE space_id = ? AND folder = ?").get(spaceId, folder) as Raw | undefined;
    return r ? toType(r) : null;
  }

  insert(t: RecordTypeInsert): RecordType {
    const id = newId(); const at = this.clock();
    const order = (this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM team_record_types WHERE space_id = ?").get(t.spaceId) as { n: number }).n;
    this.db.prepare(`INSERT INTO team_record_types (id, space_id, key, one, many, folder, glyph, title_field, status_field, statuses_json, head_json, sections_json, preset, sort_order, archived, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
      .run(id, t.spaceId, t.key, t.one, t.many, t.folder, t.glyph, t.titleField, t.statusField, JSON.stringify(t.statuses), JSON.stringify(t.head),
        JSON.stringify(t.sections), t.preset, order, at, at);
    return this.type(id)!;
  }

  update(id: string, p: RecordTypePatch): RecordType | null {
    const sets: string[] = []; const vals: (string | number | null)[] = [];
    const put = (col: string, v: string | number | null) => { sets.push(`${col} = ?`); vals.push(v); };
    if (p.one !== undefined) put("one", p.one);
    if (p.many !== undefined) put("many", p.many);
    if (p.folder !== undefined) put("folder", p.folder);
    if (p.glyph !== undefined) put("glyph", p.glyph);
    if (p.titleField !== undefined) put("title_field", p.titleField);
    if (p.statusField !== undefined) put("status_field", p.statusField);
    if (p.statuses !== undefined) put("statuses_json", JSON.stringify(p.statuses));
    if (p.head !== undefined) put("head_json", JSON.stringify(p.head));
    if (p.sections !== undefined) put("sections_json", JSON.stringify(p.sections));
    if (p.archived !== undefined) put("archived", p.archived ? 1 : 0);
    if (sets.length === 0) return this.type(id);
    put("updated_at", this.clock());
    vals.push(id);
    this.db.prepare(`UPDATE team_record_types SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    return this.type(id);
  }
}
