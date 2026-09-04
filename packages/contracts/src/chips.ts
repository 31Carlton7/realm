import { z } from "zod";
import { PICK_HTML_MAX, PICK_NAME_MAX, PICK_SELECTOR_MAX, PICK_TEXT_MAX, PICK_TITLE_MAX, PICK_URL_MAX, type BrowserPickedElement } from "./browser-agent";
import { fenceUntrusted } from "./fence";
import { scanMentions } from "./mentions";

/**
 * Chips: the runs of a draft that NAME something rather than say something.
 *
 * A chip is paint over plain text, never a node in a document model. The draft is a string end to end
 * — store, mention scan, all three agent wires — and the composer's caret belongs to a textarea with
 * a painted mirror behind it, so a chip may not carry padding, a border, a weight or any other metric
 * (`draft-format.ts` states that rule and why). What it may carry is a background, and that is the
 * whole budget.
 *
 * Two kinds, and they are the same kind of thing:
 *
 *   - `mention` — `@skill-id`, the composer's existing syntax, recognised only against the live skill
 *     library so `carlton@mac` and `@nonesuch` stay plain text.
 *   - `element` — `@[button "Sign in"]`, an element the user picked out of a browser pane. Brackets
 *     because the label carries spaces and quotes that a bare `@id`'s charset cannot, and `@` because
 *     it extends a sigil the composer already teaches rather than inventing a second one. It is
 *     invisible to `scanMentions` for free: `[` is not an id character, so that scan's candidate run
 *     is empty and the token is skipped whole.
 *
 * An element chip's label is PAGE-AUTHORED, and it lands in the user's own message outside any fence
 * — a page can call its button "Ignore previous instructions". That is deliberate and it is bounded
 * by the one property that matters: the user reads the chip in their own composer before they press
 * send. It is the same trust the composer already extends to a paste. The markup behind the chip,
 * which the user does NOT read, is fenced by `elementContext`.
 */
export type ChipKind = "mention" | "element";

/** One chip found in a draft. `start`/`end` bound the whole token, `@` and brackets included. */
export type Chip = { kind: ChipKind; label: string; start: number; end: number };

/** A picked element and the label its chip goes by, kept together because the label is the only
 *  thing linking the sidecar entry to the token in the draft text. */
export type ElementChip = { label: string; element: BrowserPickedElement };

/** Long enough to name a control, short enough that a chip is still one glance in a one-line draft. */
export const CHIP_LABEL_MAX = 56;

/**
 * Element chips as they cross the RPC — the one place their strings arrive from another process.
 *
 * The bounds duplicate what main already clipped, deliberately: main clips because a prompt has a
 * budget, and this rejects because a request that exceeds those bounds did not come from main's
 * picker. Every field here is page-authored except `url`, and the server neither interprets nor
 * trusts any of them — it fences them into the wire text and nothing else.
 */
export const ElementChipSchema = z.object({
  label: z.string().min(1).max(CHIP_LABEL_MAX),
  element: z.object({
    ref: z.number().int().nonnegative(),
    url: z.string().max(PICK_URL_MAX),
    title: z.string().max(PICK_TITLE_MAX),
    rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
    selector: z.string().max(PICK_SELECTOR_MAX),
    tag: z.string().max(PICK_NAME_MAX),
    role: z.string().max(PICK_NAME_MAX),
    name: z.string().max(PICK_NAME_MAX),
    text: z.string().max(PICK_TEXT_MAX),
    html: z.string().max(PICK_HTML_MAX),
  }),
});

/** How many picked elements one message may carry. A prompt that names eight things is already past
 *  the point where naming a ninth helps, and the cap bounds the fenced block's size at the schema. */
export const MAX_ELEMENT_CHIPS = 8;

/** A label may not contain a bracket or a newline: either would end the token early and split one
 *  chip into a chip and some debris. Whitespace collapses so a multi-line element reads as one run. */
export function chipLabel(raw: string): string {
  const flat = raw.replace(/[[\]\n\r]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > CHIP_LABEL_MAX ? `${flat.slice(0, CHIP_LABEL_MAX - 1)}…` : flat;
}

export const elementChipToken = (label: string): string => `@[${label}]`;

/** The token grammar. Bounded rather than greedy so an unclosed `@[` cannot swallow the rest of the
 *  draft, and newline-free so a chip never spans a line the caret can sit inside. */
const ELEMENT_CHIP_RE = new RegExp(`@\\[([^\\][\\n]{1,${CHIP_LABEL_MAX}})\\]`, "g");

export function scanElementChips(text: string): Chip[] {
  const out: Chip[] = [];
  for (const m of text.matchAll(ELEMENT_CHIP_RE)) {
    out.push({ kind: "element", label: m[1]!, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Every chip in a draft, in text order and never overlapping. Mentions are scanned against `ids`
 * exactly as the send path scans them, so what is painted and what goes out can never disagree; an
 * element chip cannot overlap a mention because its `[` ends any mention candidate before it starts.
 */
export function scanChips(text: string, ids: Iterable<string>): Chip[] {
  const mentions: Chip[] = scanMentions(text, ids).map((t) => ({ kind: "mention", label: t.id, start: t.start, end: t.end }));
  return [...mentions, ...scanElementChips(text)].sort((a, b) => a.start - b.start);
}

/** A chip label for a picked element, unique among `taken` so two identical buttons in one draft do
 *  not both resolve to the same sidecar entry. Prefers what the element MEANS (its accessible name
 *  under its AX role) over how it is built, and falls back to the selector's last segment for the
 *  nameless containers that make up most of a page. */
export function elementChipLabel(el: BrowserPickedElement, taken: Iterable<string> = []): string {
  const noun = el.role || el.tag || "element";
  const named = chipLabel(el.name || el.text);
  const tail = el.selector.split(" > ").pop() ?? "";
  const base = chipLabel(named ? `${noun} "${named}"` : tail || noun);
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = chipLabel(`${base} ${n}`);
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * What the picked elements add to the message the agent receives, appended to the user's text at send.
 *
 * It is appended rather than substituted because the transcript keeps what the user typed, exactly as
 * it does for mentions: the chip stays a chip in the bubble and the detail rides underneath. A draft
 * with no element chips gets no block at all, so the bytes on the wire are unchanged for every
 * message that never touched a browser pane.
 *
 * `url` sits outside the fence because main reads it off the webContents and a page cannot author it;
 * everything under the fence is the page's own account of itself.
 */
export function elementContext(chips: readonly ElementChip[]): string {
  if (chips.length === 0) return "";
  const detail = chips.map((c) => [
    elementChipToken(c.label),
    `selector: ${c.element.selector || "(none found)"}`,
    `role: ${c.element.role}`,
    `tag: ${c.element.tag}`,
    ...(c.element.text ? [`text: ${c.element.text}`] : []),
    ...(c.element.html ? [`html: ${c.element.html}`] : []),
  ].join("\n")).join("\n\n");
  const index = chips.map((c) => `  ${elementChipToken(c.label)} — ${c.element.url}`).join("\n");
  return `\n\nElements the user picked in Realm's browser pane, one per chip above:\n${index}\n\n${fenceUntrusted(detail)}`;
}

/** One run of a message: either a chip, or the plain text between two of them. */
export type ChipRun = { chip: Chip | null; text: string };

/**
 * Split text into chips and the plain runs around them. Concatenating every `text` reproduces the
 * input exactly — the property that lets a surface render chips WITHOUT ever changing the words in
 * the record, which is the whole reason the transcript can afford to draw them.
 */
export function chipRuns(text: string, ids: Iterable<string>): ChipRun[] {
  const runs: ChipRun[] = [];
  let at = 0;
  for (const chip of scanChips(text, ids)) {
    if (chip.start > at) runs.push({ chip: null, text: text.slice(at, chip.start) });
    runs.push({ chip, text: text.slice(chip.start, chip.end) });
    at = chip.end;
  }
  if (at < text.length) runs.push({ chip: null, text: text.slice(at) });
  return runs;
}

/** The sidecar entries a draft still refers to. An entry lives exactly as long as its token survives
 *  in the text — the same rule `draftMentions` follows, so deleting a chip forgets what it named. */
export function keepLiveChips(text: string, chips: readonly ElementChip[]): ElementChip[] {
  const present = new Set(scanElementChips(text).map((c) => c.label));
  return chips.filter((c) => present.has(c.label));
}
