import {
  APP_PICK_CLASSES_MAX, APP_PICK_COMPONENTS_MAX, APP_PICK_HOOK_MAX, APP_PICK_HOOKS_MAX, PICK_HTML_MAX, PICK_NAME_MAX, PICK_SELECTOR_MAX, PICK_TEXT_MAX,
  type AppPickedElement,
} from "@realm/contracts";
import { PRESSABLE } from "../press-tracking";

/**
 * What a part of Realm's own window IS, read off the live DOM for the person who pointed at it and the
 * agent the chip goes to. Pure functions of an element, so every rule here dies in a jsdom test.
 *
 * Realm can say more about itself than a page can about itself, and this says it: the class names are
 * written by hand rather than hashed by a bundler, so a selector built from them names the element in
 * the source; the React fiber on every node names the component that drew it; and the `data-*` hooks
 * are the app's own statements about state, which is what a person working on Realm greps for.
 */

/** The picker's own chrome wears this, and nothing inside it is ever a pick. */
export const APP_PICKER_ATTR = "data-app-picker";

/**
 * What a press on a control's glyph or label MEANS: the control. The pointer is over the arrow inside
 * the send button, but the send button is what the person is pointing at. The app's own list of what
 * presses (`PRESSABLE`), and the fields and links beside it.
 */
const CONTROL = [PRESSABLE, "a[href]", "input", "select", "textarea", "label", "summary",
  '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="treeitem"]', '[role="slider"]',
  '[role="combobox"]', '[role="textbox"]', '[role="searchbox"]'].join(", ");

/**
 * The element a point over the window stands for, or null when it stands for nothing a person would
 * pick: the picker's own chrome, or the document itself — its root, its body, and the box React
 * renders the app into, which is the whole window again. `exact` (⌥ held) takes what is under the
 * pointer as it is — the icon inside the button, the word inside the row.
 */
export function pickTarget(hit: Element | null, exact = false): Element | null {
  if (!hit || hit.closest(`[${APP_PICKER_ATTR}]`)) return null;
  const doc = hit.ownerDocument;
  if (hit === doc.documentElement || hit === doc.body || hit.id === "root") return null;
  if (exact) return hit;
  return hit.closest(CONTROL) ?? hit.closest("svg") ?? hit;
}

const flat = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The role a screen reader gives it: its own `role`, or the one its tag carries. */
export function roleOf(el: Element): string {
  const own = el.getAttribute("role")?.trim().split(/\s+/)[0];
  if (own) return own;
  switch (el.localName) {
    case "button": case "summary": return "button";
    case "a": return el.hasAttribute("href") ? "link" : "";
    case "input": return inputRole((el.getAttribute("type") ?? "text").toLowerCase());
    case "textarea": return "textbox";
    case "select": return el.hasAttribute("multiple") ? "listbox" : "combobox";
    case "img": return "img";
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return "heading";
    case "nav": return "navigation";
    case "main": return "main";
    case "aside": return "complementary";
    case "ul": case "ol": return "list";
    case "li": return "listitem";
    case "table": return "table";
    case "tr": return "row";
    case "td": return "cell";
    case "th": return "columnheader";
    case "dialog": return "dialog";
    case "progress": return "progressbar";
    case "fieldset": return "group";
    case "p": return "paragraph";
    case "option": return "option";
    case "section": return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : "";
    default: return "";
  }
}

function inputRole(type: string): string {
  switch (type) {
    case "checkbox": return "checkbox";
    case "radio": return "radio";
    case "range": return "slider";
    case "number": return "spinbutton";
    case "search": return "searchbox";
    case "button": case "submit": case "reset": case "image": return "button";
    case "hidden": return "";
    default: return "textbox";
  }
}

/** Roles whose words ARE their name when nothing else gives one — accname's "name from content". */
const NAME_FROM_CONTENT = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox",
  "menuitemradio", "option", "treeitem", "heading", "cell", "columnheader", "row", "tooltip"]);

/**
 * The accessible name, in accname's order: what labels it by reference, its `aria-label`, a field's
 * label or placeholder, an image's alt, the words of a control that is named by them, its title.
 *
 * Read while the tooltip layer may be holding the title (tooltips.ts): it keeps a title-only control's
 * name in `aria-label` for exactly that time, so the order above finds it either way.
 */
export function accessibleName(el: Element): string {
  const doc = el.ownerDocument;
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const named = flat(by.split(/\s+/).map((id) => doc.getElementById(id)?.textContent ?? "").join(" "));
    if (named) return named;
  }
  const label = flat(el.getAttribute("aria-label"));
  if (label) return label;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const labelled = flat([...(el.labels ?? [])].map((l) => l.textContent ?? "").join(" "));
    if (labelled) return labelled;
    const hint = flat(el.getAttribute("placeholder"));
    if (hint) return hint;
  }
  if (el instanceof HTMLImageElement && flat(el.alt)) return flat(el.alt);
  if (NAME_FROM_CONTENT.has(roleOf(el))) {
    const words = flat(el.textContent);
    if (words) return words;
  }
  return flat(el.getAttribute("title"));
}

/** An id is part of a path only if it is a word: Realm's other ids carry a session's or React's
 *  generated id, which names this run of the app rather than the element. */
const STABLE_ID = /^[a-z][a-z-]*[a-z]$/i;
/** How many steps a path may climb before it stops looking for a unique one. */
const PATH_DEPTH = 6;

const esc = (v: string): string => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v.replace(/[^\w-]/g, (c) => `\\${c}`));
const classesOf = (el: Element): string[] => flat(el.getAttribute("class")).split(" ").filter(Boolean);

const quoted = (v: string): string => `"${v.replace(/["\\]/g, "\\$&")}"`;

/**
 * One step of a path: the tag and its first two classes, told apart from its siblings when it has to
 * be. A step with no class says what the element is called instead — a bare `input` is unique only
 * until the next field opens, and names nothing anyone could find in the source.
 */
function step(node: Element): string {
  const classes = classesOf(node).slice(0, 2);
  const label = node.getAttribute("aria-label");
  const named = classes.length === 0 && label ? `[aria-label=${quoted(label)}]` : "";
  const base = node.localName + classes.map((c) => `.${esc(c)}`).join("") + named;
  const parent = node.parentElement;
  if (!parent) return base;
  const alike = [...parent.children].filter((s) => s.matches(base));
  if (alike.length < 2) return base;
  // A name tells two buttons in a row apart in a way a person can read; a position is the fallback.
  if (label && !named && alike.filter((s) => s.getAttribute("aria-label") === label).length === 1) return `${base}[aria-label=${quoted(label)}]`;
  const sameTag = [...parent.children].filter((s) => s.localName === node.localName);
  return `${base}:nth-of-type(${sameTag.indexOf(node) + 1})`;
}

/** Whether a path holds something a person would search for — a class, a name, an id — rather than
 *  only tags and positions, which are unique by accident of the moment. */
const anchored = (path: string): boolean => /[.#[]/.test(path);

/**
 * A selector that finds exactly this element now, built the way a person working on Realm would write
 * one: class names first, the shortest path that is unique and holds one of them (or a name), climbing
 * no further than it has to. A word id ends the climb. Past `PATH_DEPTH` the path is the nearest steps,
 * which still name the element in the source even where they no longer name it alone.
 */
export function selectorFor(el: Element): string {
  const doc = el.ownerDocument;
  const unique = (sel: string): boolean => { try { return doc.querySelectorAll(sel).length === 1; } catch { return false; } };
  const parts: string[] = [];
  for (let node: Element | null = el; node && node !== doc.body && node !== doc.documentElement && parts.length < PATH_DEPTH; node = node.parentElement) {
    if (node.id && STABLE_ID.test(node.id) && unique(`#${esc(node.id)}`)) { parts.unshift(`#${esc(node.id)}`); break; }
    parts.unshift(step(node));
    if (anchored(parts.join(" > ")) && unique(parts.join(" > "))) break;
  }
  while (parts.length > 1 && parts.join(" > ").length > PICK_SELECTOR_MAX) parts.shift();
  return clip(parts.join(" > "), PICK_SELECTOR_MAX);
}

type Fiber = { type?: unknown; return?: Fiber | null };

/** A component's name as its source spells it. A name a minifier wrote — one or two letters — names
 *  nothing anyone can grep for, so it is not reported. */
const COMPONENT_NAME = /^[A-Z][A-Za-z0-9]{2,}$/;

const CONTEXTS = new Set<unknown>([Symbol.for("react.context"), Symbol.for("react.consumer"), Symbol.for("react.provider")]);

function componentName(type: unknown): string | null {
  if (typeof type === "function") {
    const fn = type as { displayName?: unknown; name?: unknown };
    const name = typeof fn.displayName === "string" ? fn.displayName : typeof fn.name === "string" ? fn.name : "";
    return COMPONENT_NAME.test(name) ? name : null;
  }
  if (type && typeof type === "object") {
    const t = type as { $$typeof?: unknown; displayName?: unknown; type?: unknown; render?: unknown };
    // A context's provider is plumbing, not something that drew the element.
    if (CONTEXTS.has(t.$$typeof)) return null;
    // memo() and forwardRef() wrap the component they name.
    if (typeof t.displayName === "string") return COMPONENT_NAME.test(t.displayName) ? t.displayName : null;
    return componentName(t.render ?? t.type);
  }
  return null;
}

/**
 * The React components that drew this element, nearest first: the fiber React keeps on every node it
 * rendered, walked up its `return` chain. The production build keeps the fiber and does not mangle the
 * names (electron-vite does not minify the renderer), and where either is ever missing this answers
 * nothing rather than guessing — it reads React's internals, so it must never be able to throw.
 */
export function componentChain(el: Element, max = APP_PICK_COMPONENTS_MAX): string[] {
  const out: string[] = [];
  try {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    let fiber = key ? (el as unknown as Record<string, Fiber | undefined>)[key] : undefined;
    for (let n = 0; fiber && out.length < max && n < 500; n++, fiber = fiber.return ?? undefined) {
      const name = componentName(fiber.type);
      if (name && out[out.length - 1] !== name) out.push(name);
    }
  } catch { /* an unfamiliar fiber is a component we cannot name */ }
  return out;
}

/** How a hook's element is named beside it: `button.composer-send`, `div.sb-row`. */
const shortName = (el: Element): string => el.localName + (classesOf(el)[0] ? `.${classesOf(el)[0]}` : "");
/** A press's own bookkeeping (press-tracking.ts) is state about the pointer, not about the element. */
const TRANSIENT_HOOKS = new Set(["data-pressed", "data-press-tracking"]);
/** A value that is an id this run of the app made — a pane leaf's ULID, a library's generated key —
 *  names nothing anyone can search for; the hook itself still does. */
const OPAQUE = /^(?=.*\d)(?=.*[a-z])[\w-]{16,}$/i;

/**
 * The `data-*` attributes on the element and its nearest ancestors, nearest first: Realm's own
 * statements about state (`data-state="send"`, `data-active`), each with the element it sits on.
 * The document's own (`data-mode` on the root) are the whole window's, so the walk stops under them.
 */
export function hooksOf(el: Element, max = APP_PICK_HOOKS_MAX): string[] {
  const out: string[] = [];
  const doc = el.ownerDocument;
  for (let node: Element | null = el; node && node !== doc.body && node !== doc.documentElement && out.length < max; node = node.parentElement) {
    for (const a of node.attributes) {
      if (!a.name.startsWith("data-") || TRANSIENT_HOOKS.has(a.name)) continue;
      const value = a.value && !OPAQUE.test(a.value) ? `="${clip(a.value, 40)}"` : "";
      out.push(clip(`${a.name}${value} on ${shortName(node)}`, APP_PICK_HOOK_MAX));
      if (out.length >= max) break;
    }
  }
  return out;
}

/** Its markup, with every icon's drawing dropped: one glyph's path data would otherwise spend the whole
 *  budget on numbers nobody reads. */
export function markupOf(el: Element): string {
  return clip(el.outerHTML.replace(/(<svg\b[^>]*>)[\s\S]*?(<\/svg>)/g, "$1$2"), PICK_HTML_MAX);
}

/** Everything a pick carries except its picture, which main takes once the picker is off the screen. */
export type AppPickDescription = Omit<AppPickedElement, "app"> & { app: Omit<AppPickedElement["app"], "shot" | "webView"> };

export function describeAppElement(el: Element): AppPickDescription {
  const box = el.getBoundingClientRect();
  const view = el.ownerDocument.defaultView;
  const text = (el as HTMLElement).innerText ?? el.textContent;
  return {
    rect: { x: box.x, y: box.y, w: box.width, h: box.height },
    selector: selectorFor(el),
    tag: el.localName,
    role: roleOf(el),
    name: clip(accessibleName(el), PICK_NAME_MAX),
    text: clip(flat(text), PICK_TEXT_MAX),
    html: markupOf(el),
    app: {
      components: componentChain(el),
      hooks: hooksOf(el),
      classes: classesOf(el).slice(0, APP_PICK_CLASSES_MAX).map((c) => clip(c, PICK_NAME_MAX)),
      window: { w: view?.innerWidth ?? 0, h: view?.innerHeight ?? 0 },
    },
  };
}
