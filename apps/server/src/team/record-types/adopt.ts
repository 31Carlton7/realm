import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CREATOR_PRESET, parseRecord, type ParsedRecord, type RecordPreset, type RecordSection } from "@realm/contracts";
import { isRecordFile, type RecordTypeService } from "./service";
import type { RecordTypeStore } from "./store";

const DATED = /^\d{4}-\d{2}-\d{2}\b/;
const PART = /^[A-Za-z][\w -]*:\s*\S/;

/**
 * The boot reconcile for record types: what migration v51 cannot see from SQL, because records are
 * files in git repos. For every team whose memory repo has a top-level folder of records — files in
 * the record's shape (a title, then bullets, then `##` sections) — that no type claims, it adds one:
 * the Creator preset for `creators/`, and a plain type named from the folder for anything else, with
 * the head fields and sections those files actually use. Each adoption writes one activity line.
 *
 * It only ever ADDS: a meta row for a team that lacks one, a type for an unclaimed folder. Run twice,
 * it adds nothing the second time, because the first run's type claims the folder.
 */
export function adoptRecordTypes(d: {
  teamSpaceIds: () => string[];
  repoPath: (spaceId: string) => string | null;
  store: Pick<RecordTypeStore, "ensureMeta" | "byFolder">;
  types: Pick<RecordTypeService, "ensurePreset" | "adoptFolder">;
}): { spaceId: string; folder: string; key: string }[] {
  const adopted: { spaceId: string; folder: string; key: string }[] = [];
  for (const spaceId of d.teamSpaceIds()) {
    d.store.ensureMeta(spaceId, null, null);
    const repo = d.repoPath(spaceId);
    if (!repo) continue;
    for (const folder of candidateFolders(repo)) {
      if (d.store.byFolder(spaceId, folder)) continue;
      const parsed = recordsIn(join(repo, folder));
      if (!parsed) continue;
      const t = folder === CREATOR_PRESET.folder
        ? d.types.ensurePreset(spaceId, CREATOR_PRESET.key, "realm", "folder")
        : d.types.adoptFolder(spaceId, folder, shapeOf(parsed));
      if (t) adopted.push({ spaceId, folder, key: t.key });
    }
  }
  return adopted;
}

/** Top-level folders that could hold records: not hidden, not a template's, not the repo's imports. */
function candidateFolders(repo: string): string[] {
  try {
    return readdirSync(repo, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_") && e.name !== "imported")
      .map((e) => e.name).sort();
  } catch { return []; }
}

/**
 * A folder's records, parsed — or null when it is not a folder of records: no record file, fewer than
 * half of them in the record's shape, or none with anything a record has beyond its title (a head
 * field or a section). A folder of notes is not a kind of record.
 */
export function recordsIn(dir: string): ParsedRecord[] | null {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const files = readdirSync(dir).filter(isRecordFile);
  if (files.length === 0) return null;
  const parsed = files.map((f) => { try { return parseRecord(readFileSync(join(dir, f), "utf8")); } catch { return null; } })
    .filter((r): r is ParsedRecord => r !== null);
  if (parsed.length * 2 < files.length) return null;
  if (!parsed.some((r) => r.sections.length > 0 || r.head.some((l) => l.field))) return null;
  return parsed;
}

/** The head fields and sections a folder's records use, in the order they first appear. */
export function shapeOf(records: readonly ParsedRecord[]): Pick<RecordPreset, "head" | "sections" | "statusField" | "statuses"> {
  const head: string[] = [];
  const statuses: string[] = [];
  let statusField: string | null = null;
  const sections = new Map<string, { heading: string; lines: string[]; fields: number; parts: string[] }>();
  for (const r of records) {
    for (const l of r.head) {
      if (!l.field) continue;
      if (!head.some((k) => k.toLowerCase() === l.field!.key.toLowerCase())) head.push(l.field.key);
      if (l.field.key.toLowerCase() === "status") {
        statusField ??= l.field.key;
        const word = (l.field.value.split(/[\s,·]/)[0] ?? "").toLowerCase();
        if (word && !statuses.includes(word)) statuses.push(word);
      }
    }
    for (const s of r.sections) {
      const k = s.heading.toLowerCase();
      const acc = sections.get(k) ?? { heading: s.heading, lines: [], fields: 0, parts: [] };
      for (const l of s.lines) {
        acc.lines.push(l.text);
        if (l.field) acc.fields++;
        for (const part of l.text.split(/\s+·\s+/).slice(1)) {
          if (!PART.test(part.trim())) continue;
          const key = part.trim().split(":")[0]!.trim().toLowerCase();
          if (!acc.parts.includes(key)) acc.parts.push(key);
        }
      }
      sections.set(k, acc);
    }
  }
  return {
    head: head.map((key) => ({ key })),
    statusField,
    statuses: statusField ? statuses : [],
    sections: [...sections.values()].map((s): RecordSection => {
      if (s.lines.length > 0 && s.fields === s.lines.length) return { heading: s.heading, shape: "properties" };
      if (s.parts.length > 0) return { heading: s.heading, shape: "entries", parts: s.parts };
      const dated = s.lines.length > 0 && s.lines.filter((l) => DATED.test(l)).length * 2 >= s.lines.length;
      return dated ? { heading: s.heading, shape: "list", dated: true } : { heading: s.heading, shape: "list" };
    }),
  };
}
