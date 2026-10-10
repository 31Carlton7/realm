import { z } from "zod";
import { IdSchema } from "./entities";
import type { ParsedRecord, RecordLine } from "./team";

/**
 * Record types (dynamic Teams, PR 1). A team keeps the records IT needs — creators, leads, topics,
 * releases — each kind a folder of Markdown files in the space's memory repo, with the fields at its
 * head and the `##` sections Realm draws. The kind is data the team owns (`team_record_types`), and
 * the creator record v50 hardcoded is the `creator` preset, kept byte for byte.
 *
 * A type changes how Realm DRAWS and DESCRIBES a record, never what a file may hold: a record is the
 * person's Markdown, so a section the type does not name is kept and shown under "Other".
 */

/** How a section's bullets are drawn. `properties`: `Key: value` lines as a card. `entries`: one thing
 *  per line with ` · `-separated `key: value` parts (an account, a contact). `list`: lines, dated or
 *  not. `text`: prose. */
export const RECORD_SECTION_SHAPES = ["properties", "entries", "list", "text"] as const;
export const RecordSectionShapeSchema = z.enum(RECORD_SECTION_SHAPES);
export type RecordSectionShape = z.infer<typeof RecordSectionShapeSchema>;

export const RecordSectionSchema = z.object({
  heading: z.string().trim().min(1).max(60).refine((s) => !/[\n#]/.test(s), "a heading is one line, without #"),
  shape: RecordSectionShapeSchema,
  /** For `entries`: the `key: value` parts a line carries, in the order they are drawn. */
  parts: z.array(z.string().trim().min(1).max(30)).max(12).optional(),
  /** For `list`: each line starts with a date. */
  dated: z.boolean().optional(),
}).strict();
export type RecordSection = z.infer<typeof RecordSectionSchema>;

export const RecordHeadFieldSchema = z.object({
  key: z.string().trim().min(1).max(40).regex(/^[A-Za-z][A-Za-z0-9 '’/&-]{0,39}$/, "a field's name is letters, digits and spaces"),
  hint: z.string().max(200).optional(),
}).strict();
export type RecordHeadField = z.infer<typeof RecordHeadFieldSchema>;

/** A type's key, used in tool arguments: `creator`, `lead`. */
export const RecordTypeKeySchema = z.string().trim().min(1).max(40).regex(/^[a-z][a-z0-9-]*$/, "a key is lower-case letters, digits and dashes");
/** A type's folder: ONE path segment in the space's memory repo. Never hidden, never `_`-led (a
 *  template's prefix), never the repo's own `imported/`. */
export const RecordFolderSchema = z.string().trim().min(1).max(60)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "a folder is one lower-case name, without slashes")
  .refine((s) => s !== "imported" && !s.endsWith(".md") && !s.includes(".."), "that name is the memory repo's own");

export const RecordTypeSchema = z.object({
  id: IdSchema,
  spaceId: IdSchema,
  key: RecordTypeKeySchema,
  /** "Creator" / "Creators" — what the column and the pages say. */
  one: z.string(),
  many: z.string(),
  folder: z.string(),
  glyph: z.string(),
  /** `#` is the file's first line; anything else names a head field. */
  titleField: z.string(),
  statusField: z.string().nullable(),
  statuses: z.array(z.string()),
  head: z.array(RecordHeadFieldSchema),
  sections: z.array(RecordSectionSchema),
  /** The preset it came from (`creator`), kept so the page can say so. */
  preset: z.string().nullable(),
  archived: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type RecordType = z.infer<typeof RecordTypeSchema>;

/** A type as the column and its pages need it: how many records its folder holds. */
export const TeamRecordTypeSchema = RecordTypeSchema.extend({ count: z.number().int() });
export type TeamRecordType = z.infer<typeof TeamRecordTypeSchema>;

const NameSchema = z.string().trim().min(1).max(40);
const TypeFieldsSchema = z.object({
  one: NameSchema,
  many: NameSchema,
  folder: RecordFolderSchema,
  glyph: z.string().trim().min(1).max(40).optional(),
  titleField: z.string().trim().min(1).max(40).optional(),
  statusField: z.string().trim().min(1).max(40).nullable().optional(),
  statuses: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  head: z.array(RecordHeadFieldSchema).max(20).optional(),
  sections: z.array(RecordSectionSchema).max(20).optional(),
});

/** Make a type: from a preset by its key, or written out. */
export const CreateRecordTypeSchema = z.union([
  z.object({ spaceId: IdSchema, preset: z.string().min(1).max(40) }).strict(),
  TypeFieldsSchema.extend({ spaceId: IdSchema, key: RecordTypeKeySchema.optional() }).strict(),
]);
export type CreateRecordTypeInput = z.infer<typeof CreateRecordTypeSchema>;

/** Change a type. Its key never changes (tools name it); its folder changes only while empty. */
export const UpdateRecordTypeSchema = TypeFieldsSchema.partial().extend({ id: IdSchema }).strict();
export type UpdateRecordTypeInput = z.infer<typeof UpdateRecordTypeSchema>;

/* ────────────────────────────── presets ────────────────────────────── */

export type RecordPreset = Pick<RecordType, "key" | "one" | "many" | "folder" | "glyph" | "titleField" | "statusField" | "statuses" | "head" | "sections">;

/** The creator record exactly as v50 kept it (`creatorRecordTemplate`, the Teams plan's section 8).
 *  Migration v51 writes these same values in SQL; a test holds the two together. */
export const CREATOR_PRESET: RecordPreset = {
  key: "creator", one: "Creator", many: "Creators", folder: "creators", glyph: "records", titleField: "#", statusField: "Status",
  statuses: ["prospect", "contacted", "signed", "paused", "ended"],
  head: [{ key: "Status" }, { key: "Contact" }, { key: "Sends from" }],
  sections: [
    { heading: "Deal", shape: "properties" },
    { heading: "Accounts", shape: "entries", parts: ["vault", "device", "consent"] },
    { heading: "Deadlines", shape: "list", dated: true },
    { heading: "Content", shape: "list", dated: true },
  ],
};

/** Every preset: the creator, and the kinds the team templates use (the dynamic-Teams plan, 6). */
export const RECORD_PRESETS: readonly RecordPreset[] = [
  CREATOR_PRESET,
  { key: "topic", one: "Topic", many: "Topics", folder: "topics", glyph: "note", titleField: "#", statusField: "Status",
    statuses: ["open", "answered"], head: [{ key: "Status" }, { key: "Question" }],
    sections: [{ heading: "Findings", shape: "list" }, { heading: "Sources", shape: "list" }, { heading: "Open questions", shape: "list" }] },
  { key: "source", one: "Source", many: "Sources", folder: "sources", glyph: "link", titleField: "#", statusField: null,
    statuses: [], head: [{ key: "URL" }, { key: "Read", hint: "yes or no" }],
    sections: [{ heading: "Notes", shape: "text" }, { heading: "Claims", shape: "list" }] },
  { key: "customer", one: "Customer", many: "Customers", folder: "customers", glyph: "user", titleField: "#", statusField: "Status",
    statuses: ["active", "at-risk", "churned"], head: [{ key: "Status" }, { key: "Contact" }, { key: "Plan" }],
    sections: [{ heading: "History", shape: "list", dated: true }, { heading: "Open issues", shape: "list" }] },
  { key: "lead", one: "Lead", many: "Leads", folder: "leads", glyph: "user", titleField: "#", statusField: "Status",
    statuses: ["prospect", "contacted", "replied", "meeting", "won", "lost"], head: [{ key: "Status" }, { key: "Company" }, { key: "Contact" }, { key: "Sends from" }],
    sections: [{ heading: "Notes", shape: "text" }, { heading: "Touches", shape: "list", dated: true }] },
  { key: "company", one: "Company", many: "Companies", folder: "companies", glyph: "briefcase", titleField: "#", statusField: null,
    statuses: [], head: [{ key: "Website" }],
    sections: [{ heading: "People", shape: "entries", parts: ["role", "contact"] }, { heading: "Notes", shape: "text" }] },
  { key: "release", one: "Release", many: "Releases", folder: "releases", glyph: "flag", titleField: "#", statusField: "Status",
    statuses: ["planned", "building", "in review", "live"], head: [{ key: "Status" }, { key: "Version" }],
    sections: [{ heading: "Changes", shape: "list" }, { heading: "Checks", shape: "list" }, { heading: "Notes", shape: "text" }] },
  { key: "bug", one: "Bug", many: "Bugs", folder: "bugs", glyph: "alert", titleField: "#", statusField: "Status",
    statuses: ["open", "fixing", "fixed", "won't fix"], head: [{ key: "Status" }, { key: "Severity" }],
    sections: [{ heading: "Steps", shape: "list" }, { heading: "Fix", shape: "text" }] },
  { key: "piece", one: "Piece", many: "Pieces", folder: "pieces", glyph: "note", titleField: "#", statusField: "Status",
    statuses: ["idea", "draft", "review", "scheduled", "published"], head: [{ key: "Status" }, { key: "Channel" }, { key: "Due" }],
    sections: [{ heading: "Brief", shape: "text" }, { heading: "Drafts", shape: "list", dated: true }, { heading: "Links", shape: "list" }] },
  { key: "channel", one: "Channel", many: "Channels", folder: "channels", glyph: "browser", titleField: "#", statusField: null,
    statuses: [], head: [{ key: "Handle" }], sections: [{ heading: "Rules", shape: "list" }] },
];

export const recordPreset = (key: string): RecordPreset | null => RECORD_PRESETS.find((p) => p.key === key) ?? null;

/* ────────────────────────────── a record from its type ────────────────────────────── */

type TypeShape = Pick<RecordType, "titleField" | "statusField" | "statuses" | "sections">;

/**
 * The file a new record of this type starts as: its title, its status at the first value, and each
 * section's heading. For the creator preset this is v50's `creatorRecordTemplate`, byte for byte.
 */
export function recordTemplate(type: TypeShape, name: string): string {
  const lines = [`# ${name}`];
  if (type.titleField !== "#" && type.titleField !== type.statusField) lines.push(`- ${type.titleField}: ${name}`);
  if (type.statusField && type.statuses[0]) lines.push(`- ${type.statusField}: ${type.statuses[0]}`);
  for (const s of type.sections) lines.push("", `## ${s.heading}`);
  lines.push("");
  return lines.join("\n");
}

/** A record's name as its type says: the first line, or a head field's value. */
export function recordTitle(type: Pick<RecordType, "titleField">, r: ParsedRecord): string {
  if (type.titleField === "#") return r.title;
  const k = type.titleField.toLowerCase();
  return r.head.find((l) => l.field?.key.toLowerCase() === k)?.field?.value ?? r.title;
}

export type RecordEntry = {
  /** What the line is about: "TikTok", "Dana Lee". */
  label: string;
  /** The first `@word` of the first part, if any. */
  handle: string | null;
  /** `key: value` parts after the first, as written, keys lower-cased: vault, device, consent… */
  parts: Record<string, string>;
  /** Free words after a colon on a line with no handle ("waiting on Nathan"). */
  note: string | null;
  /** The type's parts this line does not carry. */
  missing: string[];
};

/**
 * One line of an `entries` section: `TikTok @versed.nathan · vault: tiktok.com/nathan · consent:
 * contract §4`, or `YouTube Shorts: waiting on Nathan`. The same split as v50's `parseAccount`: on
 * ` · `, the handle the first `@word` of the first part, the rest `key: value` parts.
 */
export function parseEntry(line: RecordLine, parts: readonly string[] = []): RecordEntry {
  const [first = "", ...rest] = line.text.split(/\s+·\s+/);
  const found: Record<string, string> = {};
  for (const p of rest) {
    const m = /^([A-Za-z][\w -]*):\s*(.+)$/.exec(p.trim());
    if (m) found[m[1]!.trim().toLowerCase()] = m[2]!.trim();
  }
  const missing = parts.map((p) => p.toLowerCase()).filter((p) => !(p in found));
  const handle = /(@[\w.]+)/.exec(first)?.[1] ?? null;
  if (handle) return { label: first.replace(handle, "").trim() || first, handle, parts: found, note: null, missing };
  const colon = /^([^:]+):\s*(.+)$/.exec(first);
  return colon ? { label: colon[1]!.trim(), handle: null, parts: found, note: colon[2]!.trim(), missing }
    : { label: first.trim(), handle: null, parts: found, note: null, missing };
}

/** The entries a record's section holds, by heading, case-insensitively. */
export function recordEntries(r: ParsedRecord, heading: string, parts: readonly string[] = []): RecordEntry[] {
  const h = heading.toLowerCase();
  return (r.sections.find((s) => s.heading.toLowerCase() === h)?.lines ?? []).map((l) => parseEntry(l, parts));
}

/** The record's sections laid against its type: the type's own, in its order (empty when the file
 *  lacks one), then every other section the file has, under "Other". */
export function recordSectionsByType(type: Pick<RecordType, "sections">, r: ParsedRecord): {
  named: { section: RecordSection; lines: RecordLine[] }[];
  other: { heading: string; lines: RecordLine[] }[];
} {
  const known = new Set(type.sections.map((s) => s.heading.toLowerCase()));
  return {
    named: type.sections.map((section) => ({ section, lines: r.sections.find((s) => s.heading.toLowerCase() === section.heading.toLowerCase())?.lines ?? [] })),
    other: r.sections.filter((s) => !known.has(s.heading.toLowerCase())),
  };
}

/* ────────────────────────────── what a role is told ────────────────────────────── */

type Described = Pick<RecordType, "key" | "one" | "many" | "folder" | "head" | "sections" | "statusField" | "statuses">;

/** An entries section that names where a sign-in is kept: what makes "never a password" worth saying. */
const keepsSignIns = (types: readonly Described[]) => types.some((t) => t.sections.some((s) => s.shape === "entries" && (s.parts ?? []).includes("vault")));

const words = (xs: readonly string[], last = "and"): string => xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} ${last} ${xs.at(-1)}`;

/**
 * The preamble's records line, from the team's types. One type renders v50's sentence exactly (a
 * test holds it); several list each folder with its sections; none says so.
 */
export function recordsPreambleLine(types: readonly Described[]): string {
  if (types.length === 0) return "- This team keeps no records yet. A person sets up the kinds it keeps on the team's Records page; `record_types` lists them.";
  const tail = keepsSignIns(types) ? " An account names where its sign-in is kept, never a password or key." : " A record never holds a password or key.";
  if (types.length === 1) {
    return `- Records are Markdown files under \`${types[0]!.folder}/\` in the team's memory. Read them with \`record_list\` and \`record_read\`; change them with \`record_update\`.${tail}`;
  }
  const each = types.map((t) => `\`${t.folder}/\` (${t.one}${t.sections.length ? `: ${t.sections.map((s) => s.heading).join(", ")}` : ""})`);
  return `- Records are Markdown files in the team's memory: ${words(each)}. Read them with \`record_list\` and \`record_read\`; change them with \`record_update\`, naming the \`type\` when you make one.${tail}`;
}

/** The record tools' descriptions for one space, from its types (the plan, 3.3). The tool LIST never
 *  changes with them; only these words do. */
export function recordToolDescriptions(types: readonly Described[]): { list: string; read: string; update: string; section: string; path: string; types: string } {
  const paths = types.length ? words(types.map((t) => `${t.folder}/<name>.md`), "or") : "creators/<name>.md";
  const headsOf = (t: Described) => [t.statusField, ...t.head.map((h) => h.key)].filter((k, i, a): k is string => !!k && a.indexOf(k) === i);
  const shapeOf = (t: Described) => `${headsOf(t).length ? `its head (${headsOf(t).join(", ")}), then ` : ""}${t.sections.map((s) => `## ${s.heading}`).join(", ") || "its sections"}`;
  const kinds = types.length === 0 ? "This team keeps no kinds of record yet; making one with no `type` starts the creators/ folder."
    : types.length === 1 ? `The team keeps ${types[0]!.many.toLowerCase()}: ${types[0]!.folder}/<name>.md.`
    : `The team keeps ${words(types.map((t) => `${t.many.toLowerCase()} (${t.folder}/, type \`${t.key}\`)`))}.`;
  const sections = [...new Set(types.flatMap((t) => t.sections.map((s) => s.heading)))];
  const entryHint = keepsSignIns(types)
    ? " An account line is `TikTok @handle · vault: <where its sign-in is kept> · consent: <where the creator agreed>` — the sign-in's NAME, never a password or key, which is refused."
    : " Never a password or key, which is refused.";
  return {
    types: "The kinds of record this team keeps: each one's `type` key, folder, head fields, sections (and how each is drawn) and statuses. Read-only.",
    list: `The team's records — one Markdown file each, in the team's memory — with each one's name and status. ${kinds} Give \`type\` (a key or a folder) for one kind. Read-only.`,
    read: types.length === 1
      ? `One record, whole: ${shapeOf(types[0]!)}. Read it before you act for it. \`path\` is \`${types[0]!.folder}/<name>.md\` or just \`<name>\`.`
      : `One record, whole: its head, then its ## sections${types.length ? ` (${types.map((t) => `${t.many}: ${shapeOf(t)}`).join("; ")})` : ""}. Read it before you act for it. \`path\` is ${paths}.`,
    update: [
      `Change one line of a record, or make a new one. \`op\`: \`create\` (with \`name\`${types.length > 1 ? ", and `type`" : ""}) makes ${types.length > 1 ? "<folder>/<name>.md" : types.length === 1 ? `${types[0]!.folder}/<name>.md` : "creators/<name>.md"} from its type's template;`,
      `\`add\` puts \`entry\` at the end of \`section\` (${sections.length ? `${words(sections, "or")} — ` : ""}made if missing; omit it for the head);`,
      "`replace` swaps the one line holding `match` for `entry`; `remove` deletes it.",
      `Write an entry as \`Key: value\` where it is a fact with a name ("Rate: $5 per video").${entryHint}`,
      "A section the record's type does not name is kept, and shown under Other.",
      "Each line is stamped with this session and today's date, and committed under your role's name.",
    ].join(" "),
    section: `op add: ${sections.length ? words(sections, "or") : "the section's heading"}; omit for the head`,
    path: types.length > 1 ? paths : `${types[0]?.folder ?? "creators"}/<name>.md, or <name>`,
  };
}

/** A plain type named from a folder a person filled by hand: `leads` → Lead / Leads, key `lead`. */
export function typeNamesFromFolder(folder: string): { key: string; one: string; many: string } {
  const base = folder.replace(/[._-]+/g, " ").trim() || folder;
  const many = base.charAt(0).toUpperCase() + base.slice(1);
  const one = /ies$/i.test(many) ? `${many.slice(0, -3)}y`
    : /(sh|ch|x|z|ss)es$/i.test(many) ? many.slice(0, -2)
    : /(ss|us|is)$/i.test(many) || !/s$/i.test(many) ? many
    : many.slice(0, -1);
  const key = one.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^([^a-z])/, "t-$1") || "record";
  return { key, one, many };
}
