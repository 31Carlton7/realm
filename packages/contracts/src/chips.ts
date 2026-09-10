import { z } from "zod";
import { normalizeOrigin, PICK_DEVICE_ID_MAX, PICK_HTML_MAX, PICK_NAME_MAX, PICK_SELECTOR_MAX, PICK_TEXT_MAX, PICK_TITLE_MAX, PICK_URL_MAX, type BrowserPickedElement } from "./browser-agent";
import { fenceUntrusted } from "./fence";
import { scanMentions } from "./mentions";
import { describeLink, type LinkService } from "./links";

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
export type ChipKind = "mention" | "element" | "link";

/** One chip found in a draft. `start`/`end` bound the whole token, `@` and brackets included.
 *  A link chip in SENT text carries the service and URL it stands for. */
export type Chip = { kind: ChipKind; label: string; start: number; end: number; service?: LinkService; url?: string };

/** A link chip in the DRAFT: the token's label, and the URL it stands for. Sidecar to the text like
 *  `ElementChip`, and kept alive by the same rule — the entry lives while its `@[label]` does. */
export type LinkChip = { label: string; url: string; service: LinkService };

/** What a link chip becomes on the wire: a markdown link, which every agent reads and which the
 *  transcript draws back as the chip. The agent gets the URL; its connection to that app does the rest. */
export const linkChipMarkdown = (c: LinkChip): string => `[${c.label}](${c.url})`;

/** Replace every link-chip token in a draft with its markdown, leaving element chips alone. */
export function expandLinkChips(text: string, links: readonly LinkChip[]): string {
  if (links.length === 0) return text;
  const byLabel = new Map(links.map((l) => [l.label, l]));
  return text.replace(ELEMENT_CHIP_RE, (whole, label: string) => { const l = byLabel.get(label); return l ? linkChipMarkdown(l) : whole; });
}

const MD_LINK_RE = /\[([^\][\n]{1,80})\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL_RE = /https?:\/\/[^\s<>()[\]"'`]+/g;
const URL_TRAIL = /[.,;:!?'"]+$/;

/**
 * Links to a known app in SENT text, as chips: markdown links (what a pasted chip became) and bare
 * URLs alike, because a URL typed into a sentence is the same thing as one pasted alone and should
 * not read differently once sent. Only links `describeLink` can name — an arbitrary `[text](url)`
 * or a URL to anywhere else is prose the user wrote and stays prose.
 */
export function scanLinkChips(text: string): Chip[] {
  const out: Chip[] = [];
  for (const m of text.matchAll(MD_LINK_RE)) {
    const ref = describeLink(m[2]!);
    if (!ref) continue;
    out.push({ kind: "link", label: m[1]!, start: m.index, end: m.index + m[0].length, service: ref.service, url: m[2]! });
  }
  for (const m of text.matchAll(BARE_URL_RE)) {
    const raw = m[0].replace(URL_TRAIL, "");
    if (out.some((c) => m.index >= c.start && m.index < c.end)) continue; // the href of a markdown link above
    const ref = describeLink(raw);
    if (!ref) continue;
    out.push({ kind: "link", label: ref.label, start: m.index, end: m.index + raw.length, service: ref.service, url: raw });
  }
  return out.sort((a, b) => a.start - b.start);
}

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
 * picker. Only `ref` is the browser's own — a CDP node id — and `url` is a fact just as far as its
 * origin, page-authored after it; everything else is the page's outright (see
 * `BrowserPickedElement`). The server neither interprets nor trusts any of them — it fences them
 * into the wire text and nothing else.
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
    /** Present only for a pick inside a streamed device surface — see `BrowserPickedElement.device`.
     *  Optional so every chip written before device picks existed still parses. */
    device: z.object({
      id: z.string().max(PICK_DEVICE_ID_MAX),
      path: z.string().max(PICK_DEVICE_ID_MAX),
      enabled: z.boolean(),
      frame: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
      screen: z.object({ width: z.number().positive(), height: z.number().positive() }),
    }).optional(),
  }),
});

/** How many picked elements one message may carry. A prompt that names eight things is already past
 *  the point where naming a ninth helps, and the cap bounds the fenced block's size at the schema. */
export const MAX_ELEMENT_CHIPS = 8;

/**
 * A label may not contain a bracket, a newline or an `@`.
 *
 * The first two would end the token early and split one chip into a chip and some debris. The `@` is
 * the one that matters: a label is PAGE-AUTHORED, and a page that names its button `hi @mac` would
 * otherwise put a live mention token inside the user's draft — recognised by the send-time scan,
 * resolved by the server, and prepended to the agent's turn as `/realm:mac`, none of it visible to
 * the user, whose composer paints the whole token as one chip. Whitespace collapses so a multi-line
 * element still reads as one run.
 */
export function chipLabel(raw: string): string {
  const flat = raw.replace(/[[\]@\n\r]/g, " ").replace(/\s+/g, " ").trim();
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
 * exactly as the send path scans them, so what is painted and what goes out can never disagree.
 *
 * A mention INSIDE an element chip is dropped. `chipLabel` already keeps `@` out of a label the
 * picker writes, so this covers a token typed or pasted by hand — and it has to, because overlapping
 * runs break `chipRuns`' partition and put characters on screen twice.
 */
export function scanChips(text: string, ids: Iterable<string>): Chip[] {
  const elements = scanElementChips(text);
  const links = scanLinkChips(text);
  const inside = (pos: number) => elements.some((e) => pos >= e.start && pos < e.end) || links.some((l) => pos >= l.start && pos < l.end);
  const mentions: Chip[] = scanMentions(text, ids)
    .filter((t) => !inside(t.start))
    .map((t) => ({ kind: "mention", label: t.id, start: t.start, end: t.end }));
  return [...mentions, ...elements, ...links].sort((a, b) => a.start - b.start);
}

/** The link entries a draft still refers to — `keepLiveChips`'s rule, for links. */
export function keepLiveLinks(text: string, links: readonly LinkChip[]): LinkChip[] {
  const present = new Set(scanElementChips(text).map((c) => c.label));
  return links.filter((l) => present.has(l.label));
}

/** A label for a link chip that no other chip in the draft already wears. */
export function linkChipLabel(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const first = chipLabel(base);
  if (!used.has(first)) return first;
  for (let n = 2; n < 100; n += 1) { const cand = chipLabel(`${first.slice(0, CHIP_LABEL_MAX - 4)} ${n}`); if (!used.has(cand)) return cand; }
  return first;
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
  // Room for the suffix is MADE, never hoped for. `chipLabel` clips to `CHIP_LABEL_MAX`, so appending
  // to an already-clipped base and re-clipping hands the base straight back — and a base is clipped
  // whenever the accessible name runs long, which `PICK_NAME_MAX` allows up to 120 characters. The
  // re-clipping form was an unbounded loop on the second such pick, on the click path, in the renderer.
  for (let n = 2; n <= MAX_ELEMENT_CHIPS + 1; n++) {
    const suffix = ` ${n}`;
    const candidate = `${base.slice(0, CHIP_LABEL_MAX - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  // Unreachable while the composer refuses a chip past `MAX_ELEMENT_CHIPS`. A collision here points
  // two tokens at one sidecar entry, which is a wrong prompt — strictly better than a hang.
  return base;
}

/**
 * What the picked elements add to the message the agent receives, appended to the user's text at send.
 *
 * It is appended rather than substituted because the transcript keeps what the user typed, exactly as
 * it does for mentions: the chip stays a chip in the bubble and the detail rides underneath. A draft
 * with no element chips gets no block at all, so the bytes on the wire are unchanged for every
 * message that never touched a browser pane.
 *
 * Only the ORIGIN sits outside the fence. That much is the browser's own — script cannot move a
 * webContents off its origin — but the path and query after it follow `history.pushState`, and the
 * title is `document.title` outright, so both are page-authored and both belong under the fence with
 * the markup.
 */
export function elementContext(chips: readonly ElementChip[]): string {
  if (chips.length === 0) return "";
  const detail = chips.map((c) => {
    const d = c.element.device;
    return [
      elementChipToken(c.label),
      `url: ${c.element.url}`,
      // A device element has no CSS path and no markup, so it is described by what it DOES have:
      // the device's own identity and the geometry a tap is computed from. Printing an empty
      // `selector:` beside it would read as "we looked and found none", which is a different fact.
      ...(d
        ? [`device element: yes`, `id: ${d.id}`, `path: ${d.path}`, `enabled: ${d.enabled}`,
           `frame: x=${round(d.frame.x)} y=${round(d.frame.y)} w=${round(d.frame.width)} h=${round(d.frame.height)} in a ${round(d.screen.width)}×${round(d.screen.height)} point screen`]
        : [`selector: ${c.element.selector || "(none found)"}`, `tag: ${c.element.tag}`]),
      `role: ${c.element.role}`,
      ...(c.element.text ? [`text: ${c.element.text}`] : []),
      ...(c.element.html ? [`html: ${c.element.html}`] : []),
    ].join("\n");
  }).join("\n\n");
  const index = chips.map((c) => `  ${elementChipToken(c.label)} — ${normalizeOrigin(c.element.url) ?? "(no ordinary web origin)"}`).join("\n");
  // Said in Realm's own voice, OUTSIDE the fence, because it is a fact about the tools rather than
  // anything the page or the device said: an agent that tries `browser_act` on one of these clicks
  // the middle of a video frame and reports success.
  const deviceNote = chips.some((c) => c.element.device)
    ? "\nOne or more of these is a DEVICE element, inside a simulator streamed into the pane. It has no DOM node, so browser_act cannot address it — drive it through the device's own input channel, computing the tap from the frame below.\n"
    : "";
  return `\n\nElements the user picked in Realm's browser pane, one per chip above:\n${index}\n${deviceNote}\n${fenceUntrusted(detail)}`;
}

/** Device frames arrive as floats (`293.33333333333337`). A prompt is read by a person and a model,
 *  and neither is helped by the eleventh decimal place. */
const round = (n: number): number => Math.round(n * 10) / 10;

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
