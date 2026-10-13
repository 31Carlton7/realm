import { z } from "zod";
import { actKindFor, type ActKind } from "./team-acts";

/**
 * Generic deliverables (dynamic Teams, PR 2): what a role sends to Review is files, text and
 * metadata, drawn by what it IS rather than by which business it came from, with an optional
 * proposed outward action riding along.
 *
 * The four words Teams began with — slideshows, message, document, report — are still read. They
 * are labels now, free words a role writes, and only those four carry the wording and the act rules
 * they always had (`LEGACY_REVIEW_LABELS`). Everything else is decided by the item: its format, and
 * the verb of its action.
 */

/** How an item is drawn. NULL in the column means "infer it" (`inferFormat`). */
export const DELIVERABLE_FORMATS = ["images", "pdf", "markdown", "email", "message", "diff", "links", "table", "text", "files"] as const;
export const DeliverableFormatSchema = z.enum(DELIVERABLE_FORMATS);
export type DeliverableFormat = z.infer<typeof DeliverableFormatSchema>;

/** The formats whose body a person may edit in place before approving: the body IS the deliverable.
 *  A picture or a PDF is edited in Documents instead, and the item drops back to waiting by its hash. */
export const EDITABLE_FORMATS: readonly DeliverableFormat[] = ["text", "markdown", "email", "message"];

export const LEGACY_REVIEW_LABELS = ["slideshows", "message", "document", "report"] as const;
export const isLegacyLabel = (label: string): boolean => (LEGACY_REVIEW_LABELS as readonly string[]).includes(label);

/** A review's label, as the role wrote it ("6 slideshows", "Replies for Tuesday"). */
export const ReviewLabelSchema = z.string().trim().min(1).max(40);

/** Free key/values an item carries ("Subject", "Due", "Version"): at most 20, each one line. */
export const ItemMetaSchema = z.record(z.string().trim().min(1).max(40), z.string().max(500))
  .refine((m) => Object.keys(m).length <= 20, { message: "an item carries at most 20 meta keys" });

/** The proposed outward action, as stored. Lenient on read: the v52 backfill writes nulls for what a
 *  legacy target did not name, and marks its rows `legacy: 1`. */
export const ReviewActionSchema = z.object({
  /** `channel:tiktok` for the acts Teams began with; `mcp:<server>` for a connector's tool. */
  connector: z.string().min(1).max(200),
  tool: z.string().max(200).nullish(),
  args: z.record(z.string(), z.unknown()).nullish(),
  /** `post`, `dm`, `email`, `send`… — what the action does, in one word. */
  verb: z.string().max(40).nullish(),
  /** Who it goes out as, and to. */
  account: z.string().max(200).nullish(),
  to: z.string().max(200).nullish(),
  legacy: z.number().nullish(),
});
export type ReviewAction = z.infer<typeof ReviewActionSchema>;

/** What a role may propose with `review_submit`: the same shape, strictly, and never `legacy`. */
export const ProposedActionSchema = z.object({
  connector: z.string().trim().min(1).max(200),
  tool: z.string().min(1).max(200).optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  verb: z.string().trim().min(1).max(40).optional(),
  account: z.string().trim().min(1).max(200).optional(),
  to: z.string().trim().min(1).max(200).optional(),
}).strict();
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

/** The part of an item these rules read. */
export type DeliverableItem = {
  files: readonly string[];
  body: string | null;
  target?: { channel?: string | undefined; account?: string | undefined; to?: string | undefined } | null;
  meta?: Record<string, string> | undefined;
  format?: string | null | undefined;
  action?: ReviewAction | null | undefined;
};

/** The channel a `channel:` connector names, or null. */
export const actionChannel = (a: ReviewAction | null | undefined): string | null =>
  a?.connector.startsWith("channel:") ? a.connector.slice("channel:".length) || null : null;

/**
 * Where an item would go, whichever way it was said: the legacy `target` as written (its channel's
 * case kept), else what its action names. Null: nothing outward.
 */
export function itemTarget(item: DeliverableItem): { channel?: string; account?: string; to?: string } | null {
  if (item.target && (item.target.channel || item.target.account || item.target.to)) {
    const t = item.target;
    return { ...(t.channel ? { channel: t.channel } : {}), ...(t.account ? { account: t.account } : {}), ...(t.to ? { to: t.to } : {}) };
  }
  const a = item.action;
  if (!a) return null;
  const channel = actionChannel(a);
  return { ...(channel ? { channel } : {}), ...(a.account ? { account: a.account } : {}), ...(a.to ? { to: a.to } : {}) };
}

/** An item's verb: its action's, else the one a legacy label implies for its target (`actKindFor`). */
export function itemVerb(label: string, item: DeliverableItem): string | null {
  return item.action?.verb?.trim().toLowerCase() || actKindFor(label, itemTarget(item)?.channel) || null;
}

/**
 * The paced act a channel ticket would make for this item — post, dm or email on a `channel:` — or
 * null. For a legacy row this is exactly `actKindFor` (the v52 backfill wrote its verb from those
 * rules); an action on any other connector is not a channel act, and issues no ticket here.
 */
export function itemActKind(label: string, item: DeliverableItem): ActKind | null {
  const target = itemTarget(item);
  const channel = (target?.channel ?? "").trim().toLowerCase();
  if (!item.action) return actKindFor(label, target?.channel);
  if (!item.target && !actionChannel(item.action)) return null;
  if (!channel) return null;
  switch (item.action.verb?.trim().toLowerCase()) {
    case "post": return "post";
    case "dm": return "dm";
    case "email": return "email";
    case "send": return channel === "email" || channel === "mail" ? "email" : "dm";
    default: return null;
  }
}

/** Whether a verb posts (a caption under a picture) or sends (a message to someone), or neither. */
export function verbFamily(verb: string | null): "post" | "send" | null {
  if (!verb) return null;
  if (/^(post|publish|tweet|share)$/.test(verb)) return "post";
  if (/^(send|email|dm|reply|message|forward)$/.test(verb)) return "send";
  return null;
}

/** The verb a whole review is read by: the first item's that has one, else what a legacy label
 *  always meant (slideshows are posted, a message is sent). */
export function reviewVerb(label: string, items: readonly DeliverableItem[]): string | null {
  for (const i of items) { const v = itemVerb(label, i); if (v) return v; }
  return label === "slideshows" ? "post" : label === "message" ? "send" : null;
}

/** The head over an item's text, from its verb and never from the review's label. */
export function bodyHead(verb: string | null): "Caption" | "Message" | "Text" {
  const f = verbFamily(verb);
  return f === "post" ? "Caption" : f === "send" ? "Message" : "Text";
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|heic|avif)$/i;
const URL_LINE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\[[^\]]*\]\()?<?https?:\/\/\S+?>?\)?\s*$/i;
const MD_TABLE = /^\s*\|.+\|\s*\n\s*\|[\s:|-]+\|\s*(\n|$)/m;
const MD_SYNTAX = /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)/;
const DIFF_BODY = /^(?:diff --git |--- \S|@@ )/m;

export const isImageFile = (f: string): boolean => IMAGE_FILE.test(f);

/** Whether a body is nothing but links, one to a line (markdown links or bare URLs). */
export function isLinkList(body: string | null): boolean {
  const lines = (body ?? "").split(/\r?\n/).filter((l) => l.trim());
  return lines.length > 0 && lines.every((l) => URL_LINE.test(l));
}

/**
 * How an item is drawn when it does not say: by its files' extensions first, then by the shape of its
 * body and its action. The rules of `DELIVERABLE_FORMATS`' table (the plan, section 5.2).
 */
export function inferFormat(item: DeliverableItem): DeliverableFormat {
  const parsed = DeliverableFormatSchema.safeParse(item.format);
  if (parsed.success) return parsed.data;
  const files = item.files;
  const ext = (f: string) => f.toLowerCase();
  if (files.length > 0) {
    if (files.every(isImageFile)) return "images";
    if (files.some((f) => /\.(diff|patch)$/.test(ext(f)))) return "diff";
    if (files.some((f) => ext(f).endsWith(".pdf"))) return "pdf";
    if (files.some((f) => /\.(csv|tsv)$/.test(ext(f)))) return "table";
    if (files.some((f) => ext(f).endsWith(".links.md"))) return "links";
    if (files.some((f) => /\.(md|markdown)$/.test(ext(f)))) return "markdown";
    return "files";
  }
  if (item.meta && Object.keys(item.meta).some((k) => k.toLowerCase() === "base")) return "diff";
  const body = item.body ?? "";
  const verb = item.action?.verb?.trim().toLowerCase() ?? null;
  if (DIFF_BODY.test(body)) return "diff";
  if (verb === "send" || verb === "email" || Object.keys(item.meta ?? {}).some((k) => k.toLowerCase() === "subject")
    || (!verb && /^(email|mail)$/i.test(item.target?.channel?.trim() ?? ""))) return "email";
  if ((verb === "dm" || verb === "post") && body.trim()) return "message";
  if (!item.action && item.target?.account && body.trim()) return "message";
  if (isLinkList(body)) return "links";
  if (MD_TABLE.test(body)) return "table";
  if (MD_SYNTAX.test(body)) return "markdown";
  return "text";
}

/** A review's line on its card: the legacy words as they always read, a label as written, or the
 *  count and the format when the role gave no label. */
export function reviewCardKind(r: { kind: string; itemCount: number; format?: string | null | undefined }): string {
  const n = r.itemCount;
  switch (r.kind) {
    case "message": return "email draft";
    case "report": return "report";
    case "document": return "document";
    case "slideshows": return `${n} slideshow${n === 1 ? "" : "s"}`;
  }
  if (r.format && r.kind === r.format) return `${n} item${n === 1 ? "" : "s"} · ${r.format}`;
  return r.kind;
}

/** What one of a review's items is called when a head counts them: "slideshow 1 of 6", "item 2 of 4". */
export function itemNoun(label: string): string {
  switch (label) {
    case "slideshows": return "slideshow";
    case "message": return "message";
    case "document": return "document";
    case "report": return "report";
    default: return "item";
  }
}

/**
 * A short line diff of a person's edit, for the activity log: removed lines with `-`, added with `+`,
 * the common head and tail left out. Longest-common-subsequence over lines, capped so a huge body
 * cannot make the log slow.
 */
export function lineDiff(before: string, after: string, maxLines = 400): string {
  const a = before.split(/\r?\n/).slice(0, maxLines);
  const b = after.split(/\r?\n/).slice(0, maxLines);
  const m = a.length; const n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let i = 0; let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) { i++; j++; continue; }
    // What went out before what came in, as a unified diff reads.
    if (i < m && (j === n || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push(`-${a[i++]}`);
    else out.push(`+${b[j++]}`);
  }
  return out.join("\n");
}
