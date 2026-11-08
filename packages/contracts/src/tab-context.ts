import { z } from "zod";
import { IdSchema } from "./entities";
import { fenceUntrusted } from "./fence";

/**
 * A pane of the space handed to the agent as context: the prompter's `@` list names the space's
 * browser tabs, documents, terminals and simulators, and a pick is a card beside the draft rather
 * than a token in it, as an attachment is.
 *
 * What reaches the agent is read when the message is sent, not when the card was picked: a page
 * read at the pick and sent a minute later would be a copy of something the user has since changed.
 * The card's size, shown before sending, is a preview of that read.
 *
 * Each card becomes one `<tab>` block appended to the text the adapter is handed (`tabsContext`), so
 * Claude, Codex and ACP agents all get the same thing; a simulator's card is a screenshot, attached as
 * an image. The transcript keeps the user's own words and the cards (`TabCard`), never the blocks.
 */

export const TAB_KINDS = ["browser", "documents", "terminal", "simulator"] as const;
export type TabKind = (typeof TAB_KINDS)[number];

/** Eight, as for the other things a prompter carries beside the text: a row of cards nobody can scan
 *  before sending is a row nobody checks. */
export const MAX_TAB_REFS = 8;

/** How much of each kind's text is sent, in characters. A page or a document is kept from its top,
 *  where its title and lead are; a terminal from its end, where the latest output is. */
export const TAB_TEXT_CAPS = { browser: 24_000, documents: 32_000, terminal: 12_000 } as const;

/** A card over this many bytes says it is large, so a person sending six of them sees what that costs. */
export const TAB_LARGE_BYTES = 16 * 1024;

/** One pane, as the `@` list offers it (`tabs.list`). `url` is a browser's page and `path` the file
 *  a documents pane shows; `favicon` is the browser row's data URL, '' when none is known. `cwd` is
 *  where a terminal runs and `program` the name of what is in front of it, absent at its shell: never
 *  its command line, which can hold whatever was typed. */
export type TabEntry = { itemId: string; kind: TabKind; title: string; favicon: string; url?: string; path?: string; cwd?: string; program?: string };

/** What the prompter sends for a card: which pane, and the title it read as when it was picked. */
export const TabRefSchema = z.object({
  itemId: IdSchema,
  kind: z.enum(TAB_KINDS),
  title: z.string().max(200),
});
export type TabRef = z.infer<typeof TabRefSchema>;

/**
 * A card as it was read: the preview's answer before sending (`tabs.preview`), and what the
 * `user_message` keeps afterwards, so the transcript can draw the card and open its pane. `bytes` is
 * what was sent of it (a screenshot's file size for a simulator), and `truncated` that the source was
 * longer than its kind's cap. `closed` is a pane that was gone when it was read, so nothing was sent.
 */
export const TabCardSchema = TabRefSchema.extend({
  url: z.string().max(2048).optional(),
  path: z.string().max(4096).optional(),
  cwd: z.string().max(4096).optional(),
  program: z.string().max(200).optional(),
  bytes: z.number().int().min(0),
  truncated: z.boolean(),
  closed: z.boolean().optional(),
});
export type TabCard = z.infer<typeof TabCardSchema>;

/** Whether a card is worth a word before it is sent: cut to its cap, or large. */
export function tabCardFlag(card: Pick<TabCard, "bytes" | "truncated" | "closed">): "truncated" | "large" | null {
  if (card.closed) return null;
  if (card.truncated) return "truncated";
  return card.bytes > TAB_LARGE_BYTES ? "large" : null;
}

/** A browser page's form field, as the page read reports it (`readPageFields`). A secret field's value
 *  never leaves the page: it arrives as `hidden` with no value at all. */
export type PageField = { label: string; value: string | null; hidden: boolean };

/**
 * The fields whose values are never handed to an agent or a phone: a password field (its dots, and its
 * text once a page's "Show password" has made it plain), and any field whose type, name, id or
 * autocomplete names a password, a one-time code, a token or a card's number or security code. Broad
 * on purpose — hiding a passport number by mistake costs a reader nothing.
 */
export const SECRET_FIELD_WORDS = /pass|pwd|secret|token|otp|one-time-code|cc-number|cc-csc|cvc|cvv|csc/i;

/** Input types that hold no typed value worth reading or hiding. */
export const PLAIN_INPUT_TYPES = ["hidden", "checkbox", "radio", "submit", "button", "reset", "image", "file", "range", "color"] as const;

/** Whether a field, by what it says about itself, may hold a secret. */
export function isSecretField(f: { type?: string | null; name?: string | null; id?: string | null; autocomplete?: string | null }): boolean {
  const type = (f.type || "text").toLowerCase();
  if (type === "password") return true;
  return SECRET_FIELD_WORDS.test([type, f.name, f.id, f.autocomplete].filter(Boolean).join(" "));
}

/** A page's text with its filled-in fields after it, a secret field named and its value said to be
 *  hidden: the agent learns the form has a password in it, and never what it is. */
export function pageWithFields(text: string, fields: readonly PageField[]): string {
  const filled = fields.filter((f) => f.hidden || (f.value ?? "") !== "");
  if (filled.length === 0) return text;
  const lines = filled.map((f) => `  ${f.label || "(unlabelled field)"}: ${f.hidden ? "(hidden by Realm)" : f.value}`);
  return `${text}\n\nForm fields on the page:\n${lines.join("\n")}`;
}

/** The text kept of a source, by its kind's rule, and whether anything was cut. */
export function capTabText(kind: Exclude<TabKind, "simulator">, text: string): { text: string; truncated: boolean } {
  const cap = TAB_TEXT_CAPS[kind];
  if (text.length <= cap) return { text, truncated: false };
  return { text: kind === "terminal" ? text.slice(text.length - cap) : text.slice(0, cap), truncated: true };
}

/** What a block's body weighs on the wire, in UTF-8 bytes. */
export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;

const attr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const FENCE_SUBJECT: Record<Exclude<TabKind, "simulator">, string> = {
  browser: "WEB PAGE CONTENT",
  documents: "A DOCUMENT'S CONTENT",
  terminal: "TERMINAL OUTPUT",
};

/** What a cut says inside its block, so the agent knows which part it has. */
const CUT_NOTE: Record<Exclude<TabKind, "simulator">, string> = {
  browser: "the page's start",
  documents: "the document's start",
  terminal: "the latest output",
};

/**
 * One card's block. The attributes are Realm's (the pane's kind, its title, its address or path) and
 * the body is the pane's, fenced as untrusted: a page's text can say anything, and a tab's title is
 * the page's to set, which is why it is escaped. A simulator's body says where its picture went.
 */
export function tabBlock(card: TabCard, body: string | null): string {
  const attrs = [`kind="${card.kind}"`, `title="${attr(card.title)}"`];
  if (card.url) attrs.push(`url="${attr(card.url)}"`);
  if (card.path) attrs.push(`path="${attr(card.path)}"`);
  if (card.truncated && card.kind !== "simulator") attrs.push(`truncated="${CUT_NOTE[card.kind]}, ${TAB_TEXT_CAPS[card.kind]} characters"`);
  const head = `<tab ${attrs.join(" ")}>`;
  if (card.closed) return `${head}\nThis pane was closed before the message was sent, so nothing of it is attached.\n</tab>`;
  if (card.kind === "simulator") return `${head}\nA screenshot of this device's screen is attached as an image.\n</tab>`;
  return `${head}\n${fenceUntrusted(body || "(empty)", FENCE_SUBJECT[card.kind])}\n</tab>`;
}

/** Everything the cards add to the message the agent receives, appended to the user's text. */
export function tabsContext(blocks: readonly string[]): string {
  if (blocks.length === 0) return "";
  return `\n\nPanes the user attached from this Realm space, one <tab> block per card, read as the message was sent:\n${blocks.join("\n")}`;
}
