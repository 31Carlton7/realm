import { z } from "zod";
import { normalizeOrigin, PICK_DEVICE_ID_MAX, PICK_HTML_MAX, PICK_NAME_MAX, PICK_SELECTOR_MAX, PICK_TEXT_MAX, PICK_TITLE_MAX, PICK_URL_MAX, type BrowserPickedElement } from "./browser-agent";
import { basenameOf } from "./attachments";
import { fenceUntrusted } from "./fence";
import { scanMentions } from "./mentions";
import { describeLink, type LinkService } from "./links";
import { IdSchema } from "./ids";
import { SimulatorPlatformSchema, type SimulatorPlatform } from "./simulator";

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
 *   - `element` — `@[button "Sign in"]`, an element the user picked out of a browser pane,
 *     `@[Realm · Send button]`, a part of Realm's own window (`AppPickedElement`), or
 *     `@[iPhone · General button]`, an element on a device's screen (`DevicePickedElement`). Brackets
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
 *  thing linking the sidecar entry to the token in the draft text.
 *
 *  `pin` marks one of several elements an ANNOTATION chip carries (Plan 26 W7d): the user pinned them
 *  on one page and Sent them together, so one token — `@[3 annotations]` — stands for every entry that
 *  shares its label, and `pin` is the number the user saw drawn on the page. `shot` names the
 *  screenshot of those pins, attached to the same message. Both absent on an ordinary pick. */
export type ElementChip = { label: string; element: PickedElement; pin?: number; shot?: string };

/**
 * A part of Realm's OWN window the user picked (the renderer's `app-pick/`): the web picker's sibling
 * for the app around the pages. It rides the same chip as a page element — one `@[label]` token, one
 * sidecar entry, the same cap — so everything that keeps a chip alive keeps this one too.
 *
 * What it carries is for an agent working on Realm itself. `role` and `name` are what a screen reader
 * gives it, `text` what is visibly in it, `selector` a path through Realm's own class names — written
 * by hand, so they name the element in the source rather than in one build, which is why this path
 * leans on them where a page's must not. `app` is what only an app can know about itself: the React
 * components that rendered it, nearest first, the `data-*` hooks nearest to it, its classes, the
 * window its box was measured in, and the picture of it attached beside the message.
 *
 * `shot` is that picture's PATH, or null when there is none — `webView` says the reason was a browser
 * pane's page, which a capture of Realm's window cannot see and is never asked to. The path is checked
 * against the message's attachments at send (`elementContext`), so a picture taken off the message is
 * never described as one the agent has.
 */
export type AppPickedElement = {
  rect: { x: number; y: number; w: number; h: number };
  selector: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  html: string;
  app: {
    components: string[];
    hooks: string[];
    classes: string[];
    window: { w: number; h: number };
    shot: string | null;
    webView: boolean;
  };
};

/**
 * An element on a DEVICE's screen the user picked in the simulator pane — the picker's third sibling,
 * for the phone beside the session. It rides the same chip as the other two.
 *
 * A device has no DOM and no markup. What it says about an element is its accessibility tree: the
 * tree's own type for its `role` (Button, Cell, StaticText…), the `label` and `value` the app gives
 * it, its `id` when the app sets one, whether it is `enabled`, and its `frame`, in the tree's own
 * `units` out of a `screen` that size — all of them the app's words, which is why the description
 * fences them. `simulator` is what only the pane knows: the id the simulator tools reach the device
 * by, what the device is in a word (the chip's lead), its platform, whether it is a real phone, the
 * app the tree says is in front, and the picture of the element the pane took, by PATH — checked
 * against the message's attachments at send, as an app pick's is.
 */
export type DevicePickedElement = {
  role: string;
  label: string;
  value: string;
  id: string | null;
  enabled: boolean;
  frame: { x: number; y: number; width: number; height: number };
  screen: { width: number; height: number };
  units: "points" | "pixels";
  simulator: {
    id: string;
    kind: string;
    platform: SimulatorPlatform;
    physical: boolean;
    app: string;
    shot: string | null;
  };
};

/** Anything a chip can stand for: an element of a page, a part of Realm's window, or an element on a
 *  device's screen. */
export type PickedElement = BrowserPickedElement | AppPickedElement | DevicePickedElement;
export const isAppElement = (el: PickedElement): el is AppPickedElement => "app" in el;
export const isDeviceElement = (el: PickedElement): el is DevicePickedElement => "simulator" in el;

/** Clamps for what an app pick carries beyond a page's. Nearest first in each list, so the cut takes
 *  the far end — the component five levels up says less than the one that drew the element. */
export const APP_PICK_COMPONENTS_MAX = 5;
export const APP_PICK_HOOKS_MAX = 8;
export const APP_PICK_HOOK_MAX = 120;
export const APP_PICK_CLASSES_MAX = 12;

/** Long enough to name a control, short enough that a chip is still one glance in a one-line draft. */
export const CHIP_LABEL_MAX = 56;

/** How many picked elements one message may carry. A prompt that names eight things is already past
 *  the point where naming a ninth helps, and the cap bounds the fenced block's size at the schema.
 *  An annotation's pins count one each: they are elements, however many tokens stand for them. */
export const MAX_ELEMENT_CHIPS = 8;

/** A part of Realm's window on the wire (`AppPickedElement`), held to the same bounds as a page's. */
const AppElementSchema = z.object({
  rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  selector: z.string().max(PICK_SELECTOR_MAX),
  tag: z.string().max(PICK_NAME_MAX),
  role: z.string().max(PICK_NAME_MAX),
  name: z.string().max(PICK_NAME_MAX),
  text: z.string().max(PICK_TEXT_MAX),
  html: z.string().max(PICK_HTML_MAX),
  app: z.object({
    components: z.array(z.string().max(PICK_NAME_MAX)).max(APP_PICK_COMPONENTS_MAX),
    hooks: z.array(z.string().max(APP_PICK_HOOK_MAX)).max(APP_PICK_HOOKS_MAX),
    classes: z.array(z.string().max(PICK_NAME_MAX)).max(APP_PICK_CLASSES_MAX),
    window: z.object({ w: z.number().nonnegative(), h: z.number().nonnegative() }),
    shot: z.string().max(PICK_URL_MAX).nullable(),
    webView: z.boolean(),
  }),
});

/** An element on a device's screen on the wire (`DevicePickedElement`), held to a page pick's bounds. */
const DeviceElementSchema = z.object({
  role: z.string().max(PICK_NAME_MAX),
  label: z.string().max(PICK_TEXT_MAX),
  value: z.string().max(PICK_TEXT_MAX),
  id: z.string().max(PICK_DEVICE_ID_MAX).nullable(),
  enabled: z.boolean(),
  frame: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  screen: z.object({ width: z.number().positive(), height: z.number().positive() }),
  units: z.enum(["points", "pixels"]),
  simulator: z.object({
    id: IdSchema,
    kind: z.string().min(1).max(PICK_NAME_MAX),
    platform: SimulatorPlatformSchema,
    physical: z.boolean(),
    app: z.string().max(PICK_NAME_MAX),
    shot: z.string().max(PICK_URL_MAX).nullable(),
  }),
});

/**
 * Element chips as they cross the RPC — the one place their strings arrive from another process.
 *
 * The bounds duplicate what main already clipped, deliberately: main clips because a prompt has a
 * budget, and this rejects because a request that exceeds those bounds did not come from main's
 * picker. Only `ref` is the browser's own — a CDP node id — and `url` is a fact just as far as its
 * origin, page-authored after it; everything else is the page's outright (see
 * `BrowserPickedElement`). The server neither interprets nor trusts any of them — it fences them
 * into the wire text and nothing else. A part of Realm's window is the second shape `element` takes,
 * and an element on a device's screen the third.
 */
export const ElementChipSchema = z.object({
  label: z.string().min(1).max(CHIP_LABEL_MAX),
  element: z.union([z.object({
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
  }), AppElementSchema, DeviceElementSchema]),
  /** Plan 26 W7d — see `ElementChip`. Optional, so every chip written before annotations parses. */
  pin: z.number().int().min(1).max(MAX_ELEMENT_CHIPS).optional(),
  shot: z.string().max(PICK_NAME_MAX).optional(),
});


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

/** A page element by what it MEANS (its accessible name under its AX role) over how it is built, and
 *  by the selector's last segment for the nameless containers that make up most of a page. */
function pageElementLabel(el: BrowserPickedElement): string {
  const noun = el.role || el.tag || "element";
  const named = chipLabel(el.name || el.text);
  const tail = el.selector.split(" > ").pop() ?? "";
  return chipLabel(named ? `${noun} "${named}"` : tail || noun);
}

/** What a part of Realm's chip leads with, so it reads apart from a page's in the same draft. */
const APP_CHIP_PREFIX = "Realm · ";

/** What a role is called in a sentence — "Send button", "Reduce motion switch". A role nobody says
 *  aloud (a group, a region, a box with no role at all) leaves the element to its name alone. */
const ROLE_NOUNS: ReadonlyMap<string, string> = new Map(Object.entries({
  button: "button", link: "link", checkbox: "checkbox", switch: "switch", radio: "option", option: "option",
  textbox: "field", searchbox: "search field", spinbutton: "field", combobox: "menu", listbox: "list",
  slider: "slider", tab: "tab", tablist: "tabs", menuitem: "menu item", menuitemcheckbox: "menu item",
  menuitemradio: "menu item", menu: "menu", menubar: "menu bar", treeitem: "row", row: "row",
  listitem: "item", list: "list", heading: "heading", img: "image", dialog: "dialog", alertdialog: "dialog",
  toolbar: "toolbar", navigation: "navigation", table: "table", progressbar: "progress bar", status: "status",
}));

/** Tags whose own words are their name when nothing else gives one: a paragraph, a label, a cell. */
const TEXT_TAGS = new Set(["p", "span", "label", "li", "td", "th", "dt", "dd", "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "em", "small", "code", "kbd", "summary", "legend", "figcaption", "caption"]);
/** …and only while they are a phrase. A paragraph's opening forty words are not its name. */
const TEXT_NAME_MAX = 48;

/**
 * What a part of Realm is called, as the picker's hover label and the chip both say it: its accessible
 * name and what its role is called ("Send button"), the words of a short run of text where nothing
 * names it, and otherwise the component that drew it ("Composer") or the last step of its selector.
 */
export function appElementName(el: Pick<AppPickedElement, "role" | "name" | "text" | "tag" | "selector"> & { app: Pick<AppPickedElement["app"], "components"> }): string {
  const own = el.name || (TEXT_TAGS.has(el.tag) && el.text.length <= TEXT_NAME_MAX ? el.text : "");
  const named = chipLabel(own);
  // A combobox is a pop-up menu as a `<select>` and a field with suggestions as an `<input>`.
  const noun = el.role === "combobox" && el.tag === "input" ? "field" : ROLE_NOUNS.get(el.role) ?? "";
  if (named) return noun && !named.toLowerCase().endsWith(noun) ? `${named} ${noun}` : named;
  return el.app.components[0] ?? (el.selector.split(" > ").pop() || el.tag || "element");
}

/** "Realm · Send button". A pick that has no picture says so in the chip itself, where the person
 *  reads it before sending — the description cannot tell them, because they never see it. */
export function appElementChipLabel(el: AppPickedElement): string {
  const note = el.app.shot ? "" : " (no picture)";
  const name = chipLabel(appElementName(el));
  const room = CHIP_LABEL_MAX - APP_CHIP_PREFIX.length - note.length;
  return `${APP_CHIP_PREFIX}${name.length > room ? `${name.slice(0, room - 1)}…` : name}${note}`;
}

/** What a device's own element types are called in a sentence. The tree passes its types through —
 *  iOS's `Button`, Android's `android.widget.EditText` — so a type's last word is looked up, lowercased;
 *  a type nobody says aloud (a cell, a static text, an other) leaves the element to its label. */
const DEVICE_ROLE_NOUNS: ReadonlyMap<string, string> = new Map(Object.entries({
  button: "button", link: "link", switch: "switch", toggle: "switch", checkbox: "checkbox", slider: "slider",
  textfield: "field", securetextfield: "field", searchfield: "search field", edittext: "field",
  image: "image", imageview: "image", tab: "tab",
}));

/**
 * What an element on a device is called, as the overlay's box and the chip both say it: the label its
 * app gives it and what its type is called ("General button"), its value or its id where it has no
 * label, and otherwise its type.
 */
export function deviceElementName(el: Pick<DevicePickedElement, "role" | "label" | "value" | "id">): string {
  const named = chipLabel(el.label || el.value || el.id || "");
  const type = el.role.split(".").pop() ?? "";
  const noun = DEVICE_ROLE_NOUNS.get(type.toLowerCase()) ?? "";
  if (named) return noun && !named.toLowerCase().endsWith(noun) ? `${named} ${noun}` : named;
  return chipLabel(type) || "element";
}

/** "iPhone · General button": what the device is, then the element. A pick that has no picture says
 *  so in the chip, as a part of Realm's does. */
export function deviceElementChipLabel(el: DevicePickedElement): string {
  const lead = `${chipLabel(el.simulator.kind) || "Device"} · `;
  const note = el.simulator.shot ? "" : " (no picture)";
  const name = deviceElementName(el);
  const room = CHIP_LABEL_MAX - lead.length - note.length;
  return `${lead}${name.length > room ? `${name.slice(0, room - 1)}…` : name}${note}`;
}

/** A chip label for a picked element, unique among `taken` so two identical buttons in one draft do
 *  not both resolve to the same sidecar entry. */
export function elementChipLabel(el: PickedElement, taken: Iterable<string> = []): string {
  const base = isAppElement(el) ? appElementChipLabel(el) : isDeviceElement(el) ? deviceElementChipLabel(el) : pageElementLabel(el);
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
 * The label an annotation chip goes by: how many pins it carries, as a person counts them — "1
 * annotation", "3 annotations" — made unique among `taken` the way `elementChipLabel` makes a pick's.
 */
export function annotationChipLabel(count: number, taken: Iterable<string> = []): string {
  const base = count === 1 ? "1 annotation" : `${count} annotations`;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n <= MAX_ELEMENT_CHIPS + 1; n++) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate)) return candidate;
  }
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
 * A page's elements come first, then the parts of Realm's own window, then elements on a device's
 * screen. `attachments` are the message's own: a picture is named only when it is really on the message.
 */
export function elementContext(chips: readonly ElementChip[], attachments: readonly { path: string }[] = []): string {
  return pageElementContext(chips.filter(isPageChip)) + appElementContext(chips.filter(isAppChip), attachments)
    + deviceElementContext(chips.filter(isDeviceChip), attachments);
}

type PageChip = ElementChip & { element: BrowserPickedElement };
type AppChip = ElementChip & { element: AppPickedElement };
type DeviceChip = ElementChip & { element: DevicePickedElement };
const isPageChip = (c: ElementChip): c is PageChip => !isAppElement(c.element) && !isDeviceElement(c.element);
const isAppChip = (c: ElementChip): c is AppChip => isAppElement(c.element);
const isDeviceChip = (c: ElementChip): c is DeviceChip => isDeviceElement(c.element);

/**
 * The page half. Only the ORIGIN sits outside the fence. That much is the browser's own — script
 * cannot move a webContents off its origin — but the path and query after it follow
 * `history.pushState`, and the title is `document.title` outright, so both are page-authored and both
 * belong under the fence with the markup.
 */
function pageElementContext(chips: readonly PageChip[]): string {
  if (chips.length === 0) return "";
  const detail = chips.map((c) => {
    const d = c.element.device;
    return [
      // One token, several pins: each block says which number the user saw drawn on the page.
      c.pin ? `${elementChipToken(c.label)} pin ${c.pin}` : elementChipToken(c.label),
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
  // One line per TOKEN. An annotation chip is one token standing for every pin under its label, and
  // listing it once per pin would read as that many different chips.
  const tokens = [...new Map(chips.map((c) => [c.label, c])).values()];
  const pinsOf = (label: string) => chips.filter((c) => c.label === label && c.pin).length;
  const index = tokens.map((c) => {
    const pins = pinsOf(c.label);
    return `  ${elementChipToken(c.label)} — ${normalizeOrigin(c.element.url) ?? "(no ordinary web origin)"}${pins ? `, ${pins} pin${pins === 1 ? "" : "s"}` : ""}`;
  }).join("\n");
  // Said in Realm's own voice, OUTSIDE the fence, because it is a fact about the tools rather than
  // anything the page or the device said: an agent that tries `browser_act` on one of these clicks
  // the middle of a video frame and reports success.
  const deviceNote = chips.some((c) => c.element.device)
    ? "\nOne or more of these is a DEVICE element, inside a simulator streamed into the pane. It has no DOM node, so browser_act cannot address it — drive it through the device's own input channel, computing the tap from the frame below.\n"
    : "";
  // Realm's own voice, outside the fence, like the device note: what the numbers are, and which of the
  // attached files shows them. Only for a message that carries pins — every other one is unchanged.
  const shots = [...new Set(chips.map((c) => c.shot).filter((x): x is string => !!x))];
  const pinNote = chips.some((c) => c.pin)
    ? `\nAn annotation chip stands for several elements the user pinned on one page, numbered in the order they pinned them${shots.length ? `; the attached ${shots.join(", ")} shows each number where it is on the page` : ""}.\n`
    : "";
  return `\n\nElements the user picked in Realm's browser pane, one per chip above:\n${index}\n${deviceNote}${pinNote}\n${fenceUntrusted(detail)}`;
}

/**
 * The app half: each part of Realm's window the user picked, said plainly rather than fenced. It is
 * this app's own interface, drawn from this app's state in the user's own session — realm-app's
 * snapshot is left unfenced for the same reason, and a fence says a third party wrote what is inside.
 *
 * A picture is named only when the message really carries it: it rides as an ordinary attachment, and
 * one the person took off before sending is not one the agent can look at.
 */
function appElementContext(chips: readonly AppChip[], attachments: readonly { path: string }[]): string {
  if (chips.length === 0) return "";
  const attached = new Set(attachments.map((a) => a.path));
  const picture = ({ shot, webView }: AppPickedElement["app"]): string =>
    shot && attached.has(shot) ? `the attached ${basenameOf(shot)} shows it, with a margin of what is around it`
      : webView ? "no picture: it covers a browser pane's page, which a capture of Realm's window cannot see"
        : "no picture";
  const index = chips.map((c) => `  ${elementChipToken(c.label)} — ${picture(c.element.app)}`).join("\n");
  const detail = chips.map(({ label, element: el }) => {
    const [drew, ...outer] = el.app.components;
    return [
      elementChipToken(label),
      `component: ${drew ? `${drew}${outer.length ? `, inside ${outer.join(" › ")}` : ""}` : "(not known)"}`,
      `role: ${el.role || "(none)"}`,
      ...(el.name ? [`name: ${el.name}`] : []),
      ...(el.text ? [`text: ${el.text}`] : []),
      `selector: ${el.selector || "(none found)"}`,
      ...(el.app.classes.length ? [`classes: ${el.app.classes.join(" ")}`] : []),
      ...(el.app.hooks.length ? [`data hooks: ${el.app.hooks.join("; ")}`] : []),
      `box: x=${round(el.rect.x)} y=${round(el.rect.y)} w=${round(el.rect.w)} h=${round(el.rect.h)} in a ${round(el.app.window.w)}×${round(el.app.window.h)} window`,
      ...(el.html ? [`html: ${el.html}`] : []),
    ].join("\n");
  }).join("\n\n");
  return `\n\nParts of Realm's own window the user picked, one per chip above:\n${index}\n\n`
    + "They are Realm's interface, not a web page, so the browser tools cannot reach them. The component and class names are the ones in Realm's source.\n\n"
    + detail;
}

/**
 * The device half: where each element is and what its app says about it. The index — which device,
 * and whether its picture is on the message — is Realm's own and stands outside the fence; everything
 * the tree reported is the app's, the name it calls itself included, and goes under it.
 *
 * Said outside the fence, too, how to act on one: a device element has no DOM node, so the browser
 * tools cannot reach it, and the simulator tools take the device by its id and an element by the
 * number `simulator_elements` gives it — or a point, which the frame is for.
 */
function deviceElementContext(chips: readonly DeviceChip[], attachments: readonly { path: string }[]): string {
  if (chips.length === 0) return "";
  const attached = new Set(attachments.map((a) => a.path));
  const index = chips.map(({ label, element: { simulator: s } }) => {
    const what = `${s.physical ? `a real ${s.platform === "android" ? "Android" : "iOS"} device` : s.platform === "android" ? "an Android emulator" : "an iOS simulator"}, simulatorId ${s.id}`;
    const picture = s.shot && attached.has(s.shot) ? `the attached ${basenameOf(s.shot)} shows it, with a margin of what is around it` : "no picture";
    return `  ${elementChipToken(label)} — ${what}; ${picture}`;
  }).join("\n");
  const detail = chips.map(({ label, element: el }) => [
    elementChipToken(label),
    ...(el.simulator.app ? [`app in front: ${el.simulator.app}`] : []),
    `role: ${el.role || "(none)"}`,
    ...(el.label ? [`label: ${el.label}`] : []),
    ...(el.value ? [`value: ${el.value}`] : []),
    ...(el.id ? [`id: ${el.id}`] : []),
    `enabled: ${el.enabled}`,
    `frame: x=${round(el.frame.x)} y=${round(el.frame.y)} w=${round(el.frame.width)} h=${round(el.frame.height)} in a ${round(el.screen.width)}×${round(el.screen.height)} ${el.units === "pixels" ? "pixel" : "point"} screen`,
  ].join("\n")).join("\n\n");
  return `\n\nElements the user picked on a device's screen in Realm's simulator pane, one per chip above:\n${index}\n\n`
    + "They are on the device, not in a web page, so the browser tools cannot reach them. Act on one with the simulator tools and its simulatorId: "
    + "simulator_elements numbers what is on the screen now, and simulator_tap takes that number, or a point such as the middle of the frame below.\n\n"
    + fenceUntrusted(detail);
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
