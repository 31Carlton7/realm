import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CREATOR_PRESET, CreateRecordTypeSchema, RecordFolderSchema, UpdateRecordTypeSchema, recordPreset, recordToolDescriptions, recordsPreambleLine, typeNamesFromFolder,
  type CreateRecordTypeInput, type RecordPreset, type RecordType, type TeamRecordType, type UpdateRecordTypeInput,
} from "@realm/contracts";
import { NotFoundError, RpcError } from "../../store/rows";
import type { RecordTypePatch, RecordTypeStore } from "./store";

export type RecordTypeDeps = {
  store: RecordTypeStore;
  /** The space's memory repo, where every type's folder lives — null when it has none. */
  repoPath: (spaceId: string) => string | null;
  spaceExists: (spaceId: string) => boolean;
  log: (spaceId: string, actor: string, verb: string, object: string | null, detail: Record<string, unknown>) => void;
  /** `team.changed` for the space, and a re-list for its sessions: the record tools' words follow the types. */
  changed: (spaceId: string) => void;
};

/** A record file in a type's folder: Markdown, not a template (`_template.md`), not hidden. */
export const isRecordFile = (name: string): boolean => name.endsWith(".md") && !name.startsWith("_") && !name.startsWith(".");

/**
 * The kinds of record a team keeps (dynamic Teams, PR 1). A type is the team's data — its key, its
 * folder in the space's memory repo, its head fields and sections — and only a person changes one,
 * over RPC: no agent tool writes a type.
 *
 * **Paths.** A record is `<folder>/<slug>.md`, depth two, in a type's folder. A team with NO types
 * reads as v50 did — `creators/` is its one folder — and the first record made without a type adopts
 * the Creator preset, so nothing a v50 team could do stops working.
 *
 * **Folders never move under a record.** A folder that holds records is not renamed: a review's
 * `record_path` and a handoff's still point at the file. A new folder is a new type.
 */
export class RecordTypeService {
  constructor(private readonly d: RecordTypeDeps) {}

  /** A team's meta row, made once: the template it was made from, when it was. */
  ensureMeta(spaceId: string, template: string | null, templateVersion: number | null): void { this.d.store.ensureMeta(spaceId, template, templateVersion); }

  /** The space's types in order, the archived ones only when asked. */
  list(spaceId: string, includeArchived = false): RecordType[] { return this.d.store.types(spaceId, includeArchived); }

  /** The same, each with the records its folder holds. */
  views(spaceId: string, includeArchived = false): TeamRecordType[] {
    const repo = this.d.repoPath(spaceId);
    return this.list(spaceId, includeArchived).map((t) => ({ ...t, count: repo ? this.files(repo, t.folder).length : 0 }));
  }

  view(t: RecordType): TeamRecordType {
    const repo = this.d.repoPath(t.spaceId);
    return { ...t, count: repo ? this.files(repo, t.folder).length : 0 };
  }

  /** A folder's record files, as `<folder>/<name>.md`, sorted. */
  files(repo: string, folder: string): string[] {
    const dir = join(repo, folder);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
    return readdirSync(dir).filter(isRecordFile).sort().map((f) => `${folder}/${f}`);
  }

  /* ═══════════════════════════════ the person's edits ═══════════════════════════════ */

  create(input: CreateRecordTypeInput, actor = "user"): TeamRecordType {
    const p = CreateRecordTypeSchema.parse(input);
    if (!this.d.spaceExists(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    let fields: RecordPreset; let preset: string | null = null;
    if ("preset" in p) {
      const found = recordPreset(p.preset);
      if (!found) throw new RpcError("TEAM_RECORD_TYPE", `no preset "${p.preset}" — there are ${["creator", "topic", "source", "customer", "lead", "company", "release", "bug", "piece", "channel"].join(", ")}`);
      fields = found; preset = found.key;
    } else {
      const named = typeNamesFromFolder(p.one.toLowerCase());
      fields = {
        key: p.key ?? named.key, one: p.one, many: p.many, folder: p.folder, glyph: p.glyph ?? "records",
        titleField: p.titleField ?? "#", statusField: p.statusField ?? null, statuses: p.statuses ?? [],
        head: p.head ?? [], sections: p.sections ?? [],
      };
    }
    this.checkShape(fields);
    if (this.d.store.byKey(p.spaceId, fields.key)) throw new RpcError("TEAM_RECORD_TYPE", `this team already keeps a kind called ${fields.key} — give the new one another name`);
    const owner = this.d.store.byFolder(p.spaceId, fields.folder);
    if (owner) throw new RpcError("TEAM_RECORD_TYPE_FOLDER", `${fields.folder}/ is already ${owner.many}'s folder${owner.archived ? " (archived — bring it back instead)" : ""}`);
    const t = this.d.store.insert({ ...fields, spaceId: p.spaceId, preset });
    this.d.log(p.spaceId, actor, "made_record_type", t.many, { typeId: t.id, key: t.key, folder: t.folder, preset });
    this.d.changed(p.spaceId);
    return this.view(t);
  }

  update(input: UpdateRecordTypeInput): TeamRecordType {
    const p = UpdateRecordTypeSchema.parse(input);
    const before = this.d.store.type(p.id);
    if (!before) throw new NotFoundError("record type", p.id);
    const { id: _id, ...patch } = p;
    const next: RecordPreset = { ...before, ...patch, statusField: patch.statusField === undefined ? before.statusField : patch.statusField };
    this.checkShape(next);
    if (patch.folder !== undefined && patch.folder !== before.folder) {
      const repo = this.d.repoPath(before.spaceId);
      const held = repo ? this.files(repo, before.folder).length : 0;
      if (held > 0) throw new RpcError("TEAM_RECORD_TYPE_FOLDER", `${before.folder}/ holds ${held} record${held === 1 ? "" : "s"}, so its folder stays — reviews and handoffs point at those files. Make a new kind of record for a new folder.`);
      const owner = this.d.store.byFolder(before.spaceId, patch.folder);
      if (owner) throw new RpcError("TEAM_RECORD_TYPE_FOLDER", `${patch.folder}/ is already ${owner.many}'s folder`);
    }
    const t = this.d.store.update(p.id, patch as RecordTypePatch)!;
    this.d.log(t.spaceId, "user", "edited_record_type", t.many, { typeId: t.id, changed: Object.keys(patch) });
    this.d.changed(t.spaceId);
    return this.view(t);
  }

  /** Hide a type, or bring it back. Its files stay where they are either way. */
  archive(id: string, archived = true): TeamRecordType {
    const before = this.d.store.type(id);
    if (!before) throw new NotFoundError("record type", id);
    if (before.archived === archived) return this.view(before);
    const t = this.d.store.update(id, { archived })!;
    this.d.log(t.spaceId, "user", archived ? "archived_record_type" : "edited_record_type", t.many, { typeId: t.id, folder: t.folder, ...(archived ? {} : { changed: ["archived"] }) });
    this.d.changed(t.spaceId);
    return this.view(t);
  }

  /**
   * A preset's type for a space, made once: what migration v51 does in SQL for a creator team, and
   * what adoption and a first type-less record do at run time. Answers an existing type of that key
   * or folder rather than making a second.
   */
  ensurePreset(spaceId: string, key: string, actor: string, why: string): RecordType {
    const preset = recordPreset(key);
    if (!preset) throw new RpcError("TEAM_RECORD_TYPE", `no preset "${key}"`);
    const have = this.d.store.byKey(spaceId, preset.key) ?? this.d.store.byFolder(spaceId, preset.folder);
    if (have?.archived) throw new RpcError("TEAM_RECORD_TYPE", `${have.many} is archived on this team; a person brings it back on its Records page`);
    if (have) return have;
    const t = this.d.store.insert({ ...preset, spaceId, preset: preset.key });
    this.d.log(spaceId, actor, "adopted_record_type", t.many, { typeId: t.id, key: t.key, folder: t.folder, why });
    this.d.changed(spaceId);
    return t;
  }

  /** A plain type for a folder a person filled by hand, with the head fields and sections its files use. */
  adoptFolder(spaceId: string, folder: string, shape: Pick<RecordPreset, "head" | "sections" | "statusField" | "statuses">): RecordType | null {
    if (!RecordFolderSchema.safeParse(folder).success || this.d.store.byFolder(spaceId, folder)) return null;
    const names = typeNamesFromFolder(folder);
    let key = names.key;
    for (let n = 2; this.d.store.byKey(spaceId, key); n++) key = `${names.key}-${n}`;
    const t = this.d.store.insert({ key, one: names.one, many: names.many, folder, glyph: "records", titleField: "#", ...shape, spaceId, preset: null });
    this.d.log(spaceId, "realm", "adopted_record_type", t.many, { typeId: t.id, key: t.key, folder, why: "folder" });
    this.d.changed(spaceId);
    return t;
  }

  private checkShape(t: RecordPreset): void {
    if (t.titleField !== "#" && !t.head.some((h) => h.key.toLowerCase() === t.titleField.toLowerCase()))
      throw new RpcError("TEAM_RECORD_TYPE", `the title is the file's first line or one of its head fields — ${t.titleField} is neither`);
    const headings = t.sections.map((s) => s.heading.toLowerCase());
    const twice = headings.find((h, i) => headings.indexOf(h) !== i);
    if (twice) throw new RpcError("TEAM_RECORD_TYPE", `two sections are called ${t.sections.find((s) => s.heading.toLowerCase() === twice)!.heading}`);
    const keys = t.head.map((h) => h.key.toLowerCase());
    const again = keys.find((k, i) => keys.indexOf(k) !== i);
    if (again) throw new RpcError("TEAM_RECORD_TYPE", `two head fields are called ${t.head.find((h) => h.key.toLowerCase() === again)!.key}`);
  }

  /* ═══════════════════════════════ paths ═══════════════════════════════ */

  /** The type a tool or a page named: its key, its folder (with or without the slash), or its words. */
  resolve(spaceId: string, given: string): RecordType | null {
    const g = given.trim().replace(/\/+$/, "").toLowerCase();
    const types = this.list(spaceId);
    return types.find((t) => t.key === g) ?? types.find((t) => t.folder === g)
      ?? types.find((t) => t.one.toLowerCase() === g || t.many.toLowerCase() === g) ?? null;
  }

  /** The folders a record may live in: every shown type's — or, for a team with none, v50's one. */
  folders(spaceId: string): string[] {
    const types = this.list(spaceId);
    return types.length ? types.map((t) => t.folder) : [CREATOR_PRESET.folder];
  }

  /**
   * A record's path, normalised: `<folder>/<slug>.md`, `<folder>/<slug>`, or a bare `<slug>` when the
   * team keeps one kind. Never outside a type's folder, never deeper than one level, never `..`.
   */
  recordRel(spaceId: string, given: string): string {
    const folders = this.folders(spaceId);
    const where = `records are ${folders.map((f) => `${f}/<name>.md`).join(" or ")}`;
    let p = given.trim().replace(/^\[\[|\]\]$/g, "").replace(/^\/+/, "");
    if (!p.includes("/")) {
      if (folders.length !== 1) throw new RpcError("TEAM_RECORD_PATH", `${given} names no folder, and this team keeps ${folders.length} kinds — ${where}`);
      p = `${folders[0]}/${p}`;
    }
    if (!p.endsWith(".md")) p = `${p}.md`;
    const parts = p.split("/");
    if (parts.some((part) => part === ".." || part === "" || part === ".") || parts.length !== 2 || !folders.includes(parts[0]!))
      throw new RpcError("TEAM_RECORD_PATH", `${given} is not a record path — ${where}`);
    return p;
  }

  /** The type a record's path is in (null for v50's implicit `creators/` on a team with no types). */
  typeOfPath(spaceId: string, rel: string): RecordType | null {
    const folder = rel.split("/")[0] ?? "";
    return this.list(spaceId).find((t) => t.folder === folder) ?? null;
  }

  /* ═══════════════════════════════ what roles are told ═══════════════════════════════ */

  preambleLine(spaceId: string): string { return recordsPreambleLine(this.list(spaceId)); }

  descriptions(spaceId: string): ReturnType<typeof recordToolDescriptions> { return recordToolDescriptions(this.list(spaceId)); }

  /** `record_types`: each kind in words a role can plan with. */
  describe(spaceId: string): string {
    const types = this.list(spaceId);
    if (types.length === 0) return "This team keeps no kinds of record yet. A person sets them up on the team's Records page; until then a record made with record_update op \"create\" starts creators/.";
    return types.map((t) => {
      const hint = (k: string) => t.head.find((h) => h.key === k)?.hint;
      const head = [...new Set([t.statusField, ...t.head.map((h) => h.key)].filter((k): k is string => !!k))].map((k) => (hint(k) ? `${k} (${hint(k)})` : k));
      const sections = t.sections.map((s) => `## ${s.heading} — ${s.shape === "properties" ? "Key: value lines" : s.shape === "entries" ? `one per line${s.parts?.length ? `, with ${s.parts.map((x) => `${x}:`).join(" ")} parts after " · "` : ""}` : s.shape === "list" ? (s.dated ? "a dated list (YYYY-MM-DD first)" : "a list") : "prose as bullets"}`);
      return [
        `- ${t.one} (type \`${t.key}\`): ${t.folder}/<name>.md`,
        head.length ? `  head: ${head.join(", ")}` : null,
        t.statusField && t.statuses.length ? `  ${t.statusField}: ${t.statuses.join(" | ")}` : null,
        ...sections.map((s) => `  ${s}`),
      ].filter(Boolean).join("\n");
    }).join("\n");
  }
}
