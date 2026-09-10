/**
 * The browser agent's CDP logic (Plan 11 W3), Electron-free and pure over a `CdpSend` function so the
 * mutants that must die here — occlusion dropped, password value leaked, stale-coordinate acts,
 * a credential filled on the wrong origin — die in unit tests against fake CDP payloads, not only in
 * live runs. Executed in Electron MAIN (the process that owns `webContents.debugger`); realm-server
 * reaches it over the browserHost bridge.
 */
import { normalizeOrigin, PICK_HTML_MAX, PICK_NAME_MAX, PICK_SELECTOR_MAX, PICK_TEXT_MAX, type BrowserAction, type BrowserActResult, type BrowserPickedElement, type BrowserRefusal, type BrowserSnapshotResult } from "@realm/contracts";
import { AGENT_CURSOR, AGENT_CURSOR_FORMS, AGENT_MOTION, CURSOR_FORM_FOR_CSS, type CursorForm, type CursorFormName } from "./agent-cursor";

export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/* ------------------------------------ snapshot ------------------------------------ */

/** Per-element fingerprints from the previous snapshot, kept per browser by the host. The `*[new]`
 *  diff marks an element whose ref was absent last time OR whose identity/geometry changed. */
export type SnapshotIndex = Map<number, string>;

/** How many elements a snapshot lists before cutting off — beyond this a page is better served by
 *  browser_read + scrolling than by a five-thousand-line tree. */
const MAX_ELEMENTS = 400;
const NAME_MAX = 80;
const VALUE_MAX = 120;
/** getEventListeners sweep budget: candidates beyond this are included on the cursor:pointer signal
 *  alone (honest over-inclusion beats a silent cap). Batched per `SWEEP_BATCH` — Browser-Use ships the
 *  same batching for the same reason (capability research §5: describeNode calls in twenties). */
const SWEEP_MAX = 100;
const SWEEP_BATCH = 20;

/** Chrome AX roles that make an element interactive on their own. Mixed casing on purpose: the AX
 *  tree reports Chrome-internal names (`textField`, `checkBox`); compared case-insensitively. */
const INTERACTIVE_AX_ROLES = new Set([
  "button", "link", "textfield", "textbox", "searchbox", "checkbox", "radio", "radiobutton",
  "combobox", "comboboxmenubutton", "textfieldwithcombobox", "listbox", "option", "menulistoption",
  "menuitem", "menuitemcheckbox", "menuitemradio", "popupbutton", "slider", "spinbutton", "switch",
  "tab", "togglebutton", "disclosuretriangle",
]);
const INTERACTIVE_TAGS = new Set(["BUTTON", "SELECT", "TEXTAREA", "SUMMARY"]);
const INTERACTIVE_ARIA_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option",
  "menuitem", "menuitemcheckbox", "menuitemradio", "slider", "spinbutton", "switch", "tab",
]);
const CLICK_LISTENER_TYPES = new Set(["click", "mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "keydown"]);

/** The computed styles `captureSnapshot` is asked for — order matters, layout.styles indexes into it. */
export const SNAPSHOT_STYLES = ["cursor", "visibility", "opacity", "pointer-events", "background-color"] as const;

type Rect = { x: number; y: number; w: number; h: number };
type Candidate = {
  backendNodeId: number;
  nodeIndex: number;
  docIndex: number;
  tag: string;
  attrs: Record<string, string>;
  rect: Rect;
  paintOrder: number;
  styles: Record<string, string>;
  role: string;
  name: string;
  value: string | null;
  checked: boolean | null;
  disabled: boolean;
  password: boolean;
  interactive: boolean;
  sweepCandidate: boolean;
  offscreen: boolean;
};

/* Minimal shapes of the CDP payloads this module reads — not the full protocol. */
type RareBool = { index: number[] };
type RareString = { index: number[]; value: number[] };
type SnapshotDoc = {
  documentURL: number; title: number; scrollOffsetX?: number; scrollOffsetY?: number;
  nodes: {
    parentIndex?: number[]; nodeType?: number[]; nodeName?: number[]; nodeValue?: number[];
    backendNodeId?: number[]; attributes?: number[][];
    inputValue?: RareString; inputChecked?: RareBool; isClickable?: RareBool;
  };
  layout: { nodeIndex: number[]; styles?: number[][]; bounds: number[][]; paintOrders?: number[] };
};
type CaptureSnapshot = { documents: SnapshotDoc[]; strings: string[] };
type AxNode = { backendDOMNodeId?: number; ignored?: boolean; role?: { value?: unknown }; name?: { value?: unknown }; value?: { value?: unknown }; properties?: { name: string; value?: { value?: unknown } }[] };
type LayoutMetrics = { cssVisualViewport?: { clientWidth?: number; clientHeight?: number; pageLeft?: number; pageTop?: number } };

const s = (strings: string[], i: number | undefined): string => (i !== undefined && i >= 0 && i < strings.length ? strings[i]! : "");
const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/**
 * The fused pass: `DOMSnapshot.captureSnapshot` + `DOM.getDocument({pierce:true})` +
 * `Accessibility.getFullAXTree` + `Page.getLayoutMetrics`, fired in PARALLEL (the plan's shape), then
 * one bounded `getEventListeners` sweep for div-soup candidates. Returns the formatted element list
 * plus the fingerprint index the next snapshot diffs against.
 */
export async function buildSnapshot(send: CdpSend, previous: SnapshotIndex | null): Promise<BrowserSnapshotResult & { index: SnapshotIndex }> {
  // Any lingering action RING is removed BEFORE the capture (belt to the filter's braces): the ring
  // is the watcher's, and an agent that sees it — even as a phantom layout box — is an agent chasing
  // its own tail. Rings only, deliberately: the cursor and the frame last the whole drive, and a
  // sweep that took them would blink them on every snapshot of a `browser_batch`. They are invisible
  // to the capture anyway, by the attribute filter below. Best-effort: a page that refuses the
  // evaluate still snapshots.
  await send("Runtime.evaluate", { expression: REMOVE_RINGS_JS }).catch(() => {});
  const [snapRaw, axRaw, metricsRaw] = await Promise.all([
    send("DOMSnapshot.captureSnapshot", { computedStyles: [...SNAPSHOT_STYLES], includePaintOrder: true }),
    send("Accessibility.getFullAXTree").catch(() => ({ nodes: [] })),
    send("Page.getLayoutMetrics").catch(() => ({})),
    // Primes the DOM agent so later backendNodeId-addressed commands (focus, quads) resolve; the
    // document tree itself is not read — the DOMSnapshot is the read.
    send("DOM.getDocument", { depth: -1, pierce: true }).catch(() => null),
  ]);
  const snap = snapRaw as CaptureSnapshot;
  const ax = (axRaw as { nodes?: AxNode[] }).nodes ?? [];
  const metrics = metricsRaw as LayoutMetrics;

  const axByBackendId = new Map<number, AxNode>();
  for (const node of ax) {
    if (node.backendDOMNodeId !== undefined && !node.ignored && !axByBackendId.has(node.backendDOMNodeId)) axByBackendId.set(node.backendDOMNodeId, node);
  }

  const viewport = {
    w: metrics.cssVisualViewport?.clientWidth ?? 100000,
    h: metrics.cssVisualViewport?.clientHeight ?? 100000,
  };

  const all: Candidate[] = [];
  const layoutByDoc: LayoutInfo[] = [];
  for (const [docIndex, doc] of (snap.documents ?? []).entries()) {
    const collected = collectDoc(snap.strings, doc, docIndex, axByBackendId, viewport);
    all.push(...collected.candidates);
    layoutByDoc.push(collected.layoutInfo);
  }

  // The getEventListeners sweep: cursor:pointer nodes that nothing else marked interactive. Batched.
  const sweepList = all.filter((c) => c.sweepCandidate && !c.interactive);
  for (let i = 0; i < sweepList.length && i < SWEEP_MAX; i += SWEEP_BATCH) {
    const batch = sweepList.slice(i, i + SWEEP_BATCH);
    await Promise.all(batch.map(async (c) => {
      c.interactive = await hasClickListeners(send, c.backendNodeId);
    }));
  }
  // Over budget: include on the style signal alone rather than silently dropping.
  for (const c of sweepList.slice(SWEEP_MAX)) c.interactive = true;

  const interactive = all.filter((c) => c.interactive);

  // Paint-order occlusion — the check naive implementations miss. An element whose center is under a
  // later-painted, opaque, non-related box is NOT actionable and must not be listed as if it were.
  const visible = interactive.filter((c) => c.offscreen || !isCovered(c, layoutByDoc[c.docIndex]!));
  const coveredCount = interactive.length - visible.length;

  const index: SnapshotIndex = new Map();
  const lines: string[] = [];
  for (const c of visible.slice(0, MAX_ELEMENTS)) {
    const fingerprint = `${c.role}|${c.name}|${c.value ?? ""}|${Math.round(c.rect.x / 8)},${Math.round(c.rect.y / 8)}`;
    index.set(c.backendNodeId, fingerprint);
    const isNew = previous !== null && previous.get(c.backendNodeId) !== fingerprint;
    lines.push(formatLine(c, isNew));
  }
  const notes: string[] = [];
  if (visible.length > MAX_ELEMENTS) notes.push(`(${visible.length - MAX_ELEMENTS} more elements not listed — scroll or read instead)`);
  if (coveredCount > 0) notes.push(`(${coveredCount} interactive element(s) hidden behind overlays — not actionable, not listed)`);

  const doc0 = snap.documents?.[0];
  return {
    url: doc0 ? s(snap.strings, doc0.documentURL) : "",
    title: doc0 ? s(snap.strings, doc0.title) : "",
    text: [...lines, ...notes].join("\n"),
    elementCount: Math.min(visible.length, MAX_ELEMENTS),
    index,
  };
}

/** What occlusion needs about every layout box in a document — rects, paint order, the tree shape
 *  for the ancestor exemption, and the two styles that decide whether a box actually hides things. */
type LayoutInfo = { rects: Rect[]; paint: number[]; nodeIndexes: number[]; parentIndex: number[]; nodeType: number[]; bg: string[]; boxOpacity: string[] };

function collectDoc(strings: string[], doc: SnapshotDoc, docIndex: number, axByBackendId: Map<number, AxNode>, viewport: { w: number; h: number }) {
  const nodes = doc.nodes;
  const layout = doc.layout;
  const nodeType = nodes.nodeType ?? [];
  const nodeName = nodes.nodeName ?? [];
  const nodeValue = nodes.nodeValue ?? [];
  const parentIndex = nodes.parentIndex ?? [];
  const backendIds = nodes.backendNodeId ?? [];
  const attrsRaw = nodes.attributes ?? [];
  const clickable = new Set(nodes.isClickable?.index ?? []);
  const inputValues = new Map<number, string>();
  nodes.inputValue?.index.forEach((ni, k) => inputValues.set(ni, s(strings, nodes.inputValue!.value[k])));
  const checkedSet = new Set(nodes.inputChecked?.index ?? []);
  const scrollX = doc.scrollOffsetX ?? 0;
  const scrollY = doc.scrollOffsetY ?? 0;

  // Children lists for the text-content name fallback.
  const children = new Map<number, number[]>();
  parentIndex.forEach((p, ni) => {
    if (p >= 0) { const list = children.get(p); if (list) list.push(ni); else children.set(p, [ni]); }
  });
  const textOf = (ni: number, depth = 0): string => {
    if (depth > 3) return "";
    const parts: string[] = [];
    for (const child of children.get(ni) ?? []) {
      if (nodeType[child] === 3) parts.push(s(strings, nodeValue[child]).trim());
      else parts.push(textOf(child, depth + 1));
      if (parts.join(" ").length > NAME_MAX) break;
    }
    return parts.filter(Boolean).join(" ").trim();
  };

  const candidates: Candidate[] = [];
  layout.nodeIndex.forEach((ni, li) => {
    if (nodeType[ni] !== 1) return; // elements only
    const bounds = layout.bounds[li] ?? [0, 0, 0, 0];
    const rect: Rect = { x: bounds[0]!, y: bounds[1]!, w: bounds[2]!, h: bounds[3]! };
    if (rect.w <= 0 || rect.h <= 0) return;
    const styles: Record<string, string> = {};
    SNAPSHOT_STYLES.forEach((styleName, k) => { styles[styleName] = s(strings, layout.styles?.[li]?.[k]); });
    if (styles.visibility === "hidden" || styles["pointer-events"] === "none") return;
    if (styles.opacity !== "" && Number(styles.opacity) === 0) return;

    const tag = s(strings, nodeName[ni]).toUpperCase();
    if (tag === "HTML" || tag === "BODY") return;
    const attrs: Record<string, string> = {};
    const flat = attrsRaw[ni] ?? [];
    for (let k = 0; k + 1 < flat.length; k += 2) attrs[s(strings, flat[k]).toLowerCase()] = s(strings, flat[k + 1]);
    // Every mark Realm draws in the page — ring, cursor, frame, stylesheet — is Realm's own
    // furniture, never page content: a snapshot that lists one hands the agent a `[new]` element
    // that is its OWN last click, and it chases it. Presence, not a value: a filter written as
    // `[attr=""]` would start listing the cursor the moment the attribute took a value.
    if (attrs[HIGHLIGHT_ATTR] !== undefined) return;

    const backendNodeId = backendIds[ni] ?? -1;
    if (backendNodeId < 0) return;
    const axNode = axByBackendId.get(backendNodeId);
    const axRole = String(axNode?.role?.value ?? "").toLowerCase();
    const ariaRole = (attrs.role ?? "").toLowerCase();
    const password = tag === "INPUT" && (attrs.type ?? "").toLowerCase() === "password"
      || axNode?.properties?.some((p) => p.name === "protected" && p.value?.value === true) === true;

    const interactive =
      INTERACTIVE_TAGS.has(tag)
      || (tag === "A" && attrs.href !== undefined)
      || (tag === "INPUT" && (attrs.type ?? "").toLowerCase() !== "hidden")
      || attrs.contenteditable === "" || attrs.contenteditable === "true"
      || INTERACTIVE_ARIA_ROLES.has(ariaRole)
      || INTERACTIVE_AX_ROLES.has(axRole)
      || clickable.has(ni);
    const sweepCandidate = !interactive && styles.cursor === "pointer";
    if (!interactive && !sweepCandidate) return;

    const axName = String(axNode?.name?.value ?? "").trim();
    const name = clip(axName || attrs["aria-label"] || attrs.placeholder || attrs.alt || attrs.title || textOf(ni) || attrs.name || "", NAME_MAX);
    // The password hard line: a password field's value NEVER enters a snapshot, from any source.
    const rawValue = password ? null : inputValues.get(ni) ?? (axNode?.value?.value !== undefined && axNode.value.value !== null ? String(axNode.value.value) : null);
    const offscreen = rect.x + rect.w < scrollX || rect.y + rect.h < scrollY || rect.x > scrollX + viewport.w || rect.y > scrollY + viewport.h;

    candidates.push({
      backendNodeId, nodeIndex: ni, docIndex, tag, attrs, rect,
      paintOrder: layout.paintOrders?.[li] ?? 0, styles,
      role: axRole || ariaRole || tag.toLowerCase(),
      name,
      value: rawValue === null ? null : clip(rawValue, VALUE_MAX),
      checked: tag === "INPUT" && ["checkbox", "radio"].includes((attrs.type ?? "").toLowerCase()) ? checkedSet.has(ni) : null,
      disabled: attrs.disabled !== undefined || axNode?.properties?.some((p) => p.name === "disabled" && p.value?.value === true) === true,
      password, interactive, sweepCandidate, offscreen,
    });
  });

  const bgIdx = SNAPSHOT_STYLES.indexOf("background-color");
  const opIdx = SNAPSHOT_STYLES.indexOf("opacity");
  const layoutInfo: LayoutInfo = {
    rects: layout.nodeIndex.map((_, li) => ({ x: layout.bounds[li]?.[0] ?? 0, y: layout.bounds[li]?.[1] ?? 0, w: layout.bounds[li]?.[2] ?? 0, h: layout.bounds[li]?.[3] ?? 0 })),
    paint: layout.nodeIndex.map((_, li) => layout.paintOrders?.[li] ?? 0),
    nodeIndexes: [...layout.nodeIndex],
    parentIndex: [...parentIndex],
    nodeType: [...nodeType],
    bg: layout.nodeIndex.map((_, li) => s(strings, layout.styles?.[li]?.[bgIdx])),
    boxOpacity: layout.nodeIndex.map((_, li) => s(strings, layout.styles?.[li]?.[opIdx])),
  };
  return { candidates, layoutInfo };
}

/**
 * Paint-order occlusion for one candidate: covered when some OTHER element box, painted later, whose
 * rect contains the candidate's center, is opaque enough to actually hide it, and is neither an
 * ancestor nor a descendant (a button's own later-painted label must not "cover" the button).
 */
function isCovered(c: Candidate, layoutInfo: LayoutInfo): boolean {
  const cx = c.rect.x + c.rect.w / 2;
  const cy = c.rect.y + c.rect.h / 2;
  const isAncestorOf = (a: number, b: number): boolean => {
    // Is node index `a` an ancestor of node index `b` (walking parentIndex up from b)?
    let cur = b;
    for (let hops = 0; hops < 500 && cur >= 0; hops++) {
      if (cur === a) return true;
      cur = layoutInfo.parentIndex[cur] ?? -1;
    }
    return false;
  };
  for (let li = 0; li < layoutInfo.nodeIndexes.length; li++) {
    if (layoutInfo.paint[li]! <= c.paintOrder) continue;
    const ni = layoutInfo.nodeIndexes[li]!;
    if (ni === c.nodeIndex || layoutInfo.nodeType[ni] !== 1) continue;
    const r = layoutInfo.rects[li]!;
    if (cx < r.x || cx > r.x + r.w || cy < r.y || cy > r.y + r.h) continue;
    // Opaque enough to hide? A translucent scrim (opacity ≥ .5 over an opaque color) counts — that is
    // exactly the modal-backdrop case where the element underneath must not be listed as actionable.
    const opacity = layoutInfo.boxOpacity[li]!;
    if (!isOpaqueColor(layoutInfo.bg[li]!) || (opacity !== "" && Number(opacity) < 0.5)) continue;
    if (isAncestorOf(ni, c.nodeIndex) || isAncestorOf(c.nodeIndex, ni)) continue;
    return true;
  }
  return false;
}

/**
 * Does this background actually hide what is under it? The threshold is 0.5, not ~1: a modal scrim at
 * `rgba(0,0,0,.5)` dims AND intercepts clicks — exactly the "covered element listed as actionable"
 * mutant — while a faint tint under that is treated as see-through. Pure hit-testing (any covering
 * box counts) was rejected: structural wrapper divs painted after their siblings would swallow whole
 * pages of real elements.
 */
export function isOpaqueColor(cssColor: string): boolean {
  if (!cssColor) return false;
  const m = cssColor.match(/rgba?\(([^)]+)\)/);
  if (!m) return cssColor !== "transparent"; // named colors are opaque
  const parts = m[1]!.split(",").map((p) => p.trim());
  if (parts.length < 4) return true; // rgb() — opaque
  return Number(parts[3]) >= 0.5;
}

function formatLine(c: Candidate, isNew: boolean): string {
  const flags = [
    c.password ? "password field — typing is blocked, hand this to the user" : null,
    c.disabled ? "disabled" : null,
    c.checked === true ? "checked" : c.checked === false ? "unchecked" : null,
    c.offscreen ? "offscreen" : null,
  ].filter(Boolean);
  const pos = `(${Math.round(c.rect.x)},${Math.round(c.rect.y)} ${Math.round(c.rect.w)}×${Math.round(c.rect.h)})`;
  const value = c.value !== null && c.value !== "" ? ` value="${c.value}"` : "";
  return `[ref=${c.backendNodeId}] ${c.role} "${c.name}"${value} ${pos}${flags.length ? ` {${flags.join(", ")}}` : ""}${isNew ? " [new]" : ""}`;
}

async function hasClickListeners(send: CdpSend, backendNodeId: number): Promise<boolean> {
  try {
    const resolved = (await send("DOM.resolveNode", { backendNodeId })) as { object?: { objectId?: string } };
    const objectId = resolved.object?.objectId;
    if (!objectId) return false;
    const result = (await send("DOMDebugger.getEventListeners", { objectId, depth: 0 })) as { listeners?: { type: string }[] };
    void send("Runtime.releaseObject", { objectId }).catch(() => {});
    return (result.listeners ?? []).some((l) => CLICK_LISTENER_TYPES.has(l.type));
  } catch {
    return false;
  }
}

/* ------------------------------------ act ------------------------------------ */

const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;
const BUTTON_BITS = { left: 1, right: 2, middle: 4 } as const;

/** Named keys for `kind: "key"` — key, code, and Windows virtual key code (React and most frameworks
 *  key off one of these three; sending all three is what makes synthetic keys indistinguishable). */
const NAMED_KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
  PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
  PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
  Space: { key: " ", code: "Space", vk: 32, text: " " },
};

/**
 * Execute one action. The two invariants the mutants target:
 *
 *   1. **Coordinates are resolved AT ACT TIME** — `DOM.getContentQuads` on the ref, after a
 *      scrollIntoView, every single act. Nothing here accepts or caches coordinates from a snapshot;
 *      a layout that shifted since the snapshot moves the click WITH the element or fails honestly
 *      ("no visible geometry"), never clicks where the element used to be.
 *   2. **Password fields refuse `type` in every mode.** The check runs here, against the LIVE node
 *      (`DOM.describeNode` + the AX protected bit at act time — not the snapshot, which can be stale),
 *      and no permission mode is consulted: `bypassPermissions` bypasses prompts, not this.
 */
export async function performAct(send: CdpSend, action: BrowserAction): Promise<BrowserActResult> {
  try {
    switch (action.kind) {
      case "click": {
        const point = await resolvePoint(send, action.ref);
        if (!point) return noGeometry(action.ref);
        const modifiers = (action.modifiers ?? []).reduce((acc, m) => acc | MODIFIER_BITS[m], 0);
        const button = action.button ?? "left";
        const clickCount = action.clickCount ?? 1;
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, buttons: 0, modifiers });
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button, buttons: BUTTON_BITS[button], clickCount, modifiers });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button, buttons: 0, clickCount, modifiers });
        return { ok: true, detail: `clicked ref=${action.ref} at (${Math.round(point.x)},${Math.round(point.y)})${clickCount > 1 ? ` ×${clickCount}` : ""}` };
      }
      case "type": {
        if (await isPasswordField(send, action.ref)) return { ok: false, error: "target is a password field", refused: "password" };
        const focused = await focusRef(send, action.ref);
        if (!focused) return { ok: false, error: `could not focus ref=${action.ref} — it may be gone; take a fresh browser_snapshot` };
        if ((action.method ?? "keys") === "insertText") {
          await send("Input.insertText", { text: action.text });
        } else {
          await typeCharacters(send, action.text);
        }
        if (action.submit) await pressNamedKey(send, "Enter");
        return { ok: true, detail: `typed ${action.text.length} character(s) into ref=${action.ref}${action.submit ? " and pressed Enter" : ""}` };
      }
      case "key": {
        if (action.ref !== undefined) await focusRef(send, action.ref);
        const known = NAMED_KEYS[action.key];
        if (!known) return { ok: false, error: `unknown key "${action.key}" — one of: ${Object.keys(NAMED_KEYS).join(", ")}` };
        await pressNamedKey(send, action.key);
        return { ok: true, detail: `pressed ${action.key}` };
      }
      case "scroll": {
        let point = action.ref !== undefined ? await resolvePoint(send, action.ref) : null;
        if (!point) {
          point = viewportCentre((await send("Page.getLayoutMetrics")) as LayoutMetrics);
        }
        await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: action.deltaX ?? 0, deltaY: action.deltaY ?? 0 });
        return { ok: true, detail: `scrolled by (${action.deltaX ?? 0}, ${action.deltaY ?? 0})` };
      }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * What the fill executor is handed instead of a password.
 *
 * `reveal` is inversion of control used as a security boundary: the store runs the OS presence check,
 * unseals, and calls `type` with the plaintext. There is no path by which the value becomes a return
 * value, a local `const` in this file, or a field on anything this module can serialize — the only
 * thing this file ever sees is the `type` closure it wrote itself.
 */
export type CredentialFill = {
  /** Metadata only. `origin` is the enrolled origin the live page must EXACTLY equal. */
  credential: { id: string; origin: string };
  reveal(type: (value: string) => Promise<void>): Promise<{ ok: true } | { ok: false; refused: BrowserRefusal }>;
};

/**
 * `fill_credential` — the ONLY route by which a real secret reaches a page, and the only thing that
 * may type into a password field. It is not a relaxation of `performAct`'s password block: that block
 * is unconditional and stays unconditional, because it governs a `type` action carrying agent-authored
 * text. This op carries no text at all.
 *
 * The order of the three gates is load-bearing:
 *
 *   1. **Origin, from CDP, before anything else.** `Page.getNavigationHistory`'s current entry is the
 *      browser's own record of what it loaded — the same class of trustworthy identity
 *      `browser_describe` reports, and specifically NOT page text, a snapshot, a title, or anything a
 *      page can author. It must normalize to exactly the enrolled origin: no subdomain match, no
 *      registrable-domain fallback (see `normalizeOrigin`). A lookalike host gets `origin_mismatch`.
 *   2. **Presence, only after the origin matched.** Deliberately second. Prompting for Touch ID on a
 *      phishing page and then refusing would teach the user that the fingerprint prompt is noise to
 *      swat away; by the time a prompt appears, Realm has already established the page is the right
 *      one and the only question left is whether the human is there.
 *   3. **Type, into the ref, character by character** — the same key events `performAct`'s `type`
 *      dispatches, because a password field behind React ignores value writes.
 *
 * FAIL CLOSED everywhere: an unreadable navigation history, a ref that will not focus, or a thrown
 * CDP call all refuse. No branch here falls through to typing.
 *
 * The success `detail` names the origin and nothing else. Not the username, not the field, and above
 * all not a character count — "filled 14 characters" is a fact about a password, and this string goes
 * into a tool result, which goes into the model's context.
 */
export async function performFillCredential(send: CdpSend, ref: number, fill: CredentialFill): Promise<BrowserActResult> {
  const { credential } = fill;
  let pageOrigin: string | null;
  try {
    pageOrigin = await currentOrigin(send);
  } catch {
    pageOrigin = null;
  }
  if (pageOrigin === null) {
    return { ok: false, refused: "origin_mismatch", error: "could not establish the page's current origin from the browser, so nothing was filled" };
  }
  if (pageOrigin !== credential.origin) {
    // Both origins are named because both are Realm's own normalized strings — neither is page-authored
    // text, and the user (who sees this through the tool error) needs to know which page they are on.
    return { ok: false, refused: "origin_mismatch", error: `this pane is on ${pageOrigin}, but that saved sign-in is for ${credential.origin} — nothing was filled` };
  }

  // Focus BEFORE presence: a ref that is already gone should fail as a stale ref, not burn a Touch ID
  // prompt on an act that cannot land.
  if (!(await focusRef(send, ref))) {
    return { ok: false, error: `could not focus ref=${ref} — it may be gone; take a fresh browser_snapshot` };
  }

  try {
    const outcome = await fill.reveal(async (value) => { await typeCharacters(send, value); });
    if (!outcome.ok) {
      return { ok: false, refused: outcome.refused, error: REVEAL_REFUSALS[outcome.refused] ?? "the saved sign-in was not available" };
    }
  } catch {
    // The catch is bare ON PURPOSE. A CDP failure mid-typing can carry the characters it was
    // dispatching in its message, and that message would otherwise reach a tool result. Nothing about
    // the caught error is inspected, formatted, or forwarded.
    return { ok: false, error: "the saved sign-in could not be typed into that field" };
  }
  return { ok: true, detail: `filled saved credential for ${credential.origin}` };
}

/** Refusal wording for the reasons the STORE decides (this module never learns more than the code). */
const REVEAL_REFUSALS: Partial<Record<BrowserRefusal, string>> = {
  no_credential: "no saved sign-in is enrolled under that id — the user adds them in Realm's Settings, under Sign-ins",
  no_presence: "the Touch ID / login check was cancelled or failed, so nothing was filled",
};

/**
 * The page's origin according to the BROWSER, not the page. `Page.getNavigationHistory` reports what
 * the navigation stack actually committed; a page can change what it *renders*, and with the History
 * API it can change the path, but it cannot make this report an origin it is not served from.
 *
 * Returns null (→ refusal) for a history CDP will not give up, an out-of-range current index, and any
 * URL without a real http(s) origin (`about:blank`, `data:` — see `normalizeOrigin`).
 */
async function currentOrigin(send: CdpSend): Promise<string | null> {
  const history = (await send("Page.getNavigationHistory")) as { currentIndex?: number; entries?: { url?: string }[] } | null;
  const entries = history?.entries;
  const index = history?.currentIndex;
  if (!Array.isArray(entries) || typeof index !== "number") return null;
  const url = entries[index]?.url;
  return typeof url === "string" ? normalizeOrigin(url) : null;
}

/** Per-character key events — what React-style inputs need, and what a password field needs most of
 *  all. Shared by `type` and by the credential fill so there is ONE typist: a fill that took a
 *  different path could drift into `Input.insertText`, which some login forms ignore entirely. */
async function typeCharacters(send: CdpSend, text: string): Promise<void> {
  for (const ch of text) {
    if (ch === "\n") { await pressNamedKey(send, "Enter"); continue; }
    await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, key: ch });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
  }
}

const noGeometry = (ref: number): BrowserActResult =>
  ({ ok: false, error: `ref=${ref} has no visible geometry — it may be hidden, detached, or from a stale snapshot; take a fresh browser_snapshot` });

/** Scroll the node into view, then read its quads NOW. Center of the first quad. */
async function resolvePoint(send: CdpSend, backendNodeId: number): Promise<{ x: number; y: number } | null> {
  await send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
  try {
    const { quads } = (await send("DOM.getContentQuads", { backendNodeId })) as { quads?: number[][] };
    const quad = quads?.[0];
    if (!quad || quad.length < 8) return null;
    const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
    const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
    const x = xs.reduce((a, b) => a + b, 0) / 4;
    const y = ys.reduce((a, b) => a + b, 0) / 4;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  } catch {
    return null;
  }
}

/** The act-time password check: the LIVE node's input type, plus the AX `protected` bit where the
 *  tree offers one — `-webkit-text-security`-style disguises fall to the latter when Chrome exposes
 *  them, and a describeNode failure counts as REFUSAL (fail closed: no proof it's safe, no typing). */
async function isPasswordField(send: CdpSend, backendNodeId: number): Promise<boolean> {
  try {
    const { node } = (await send("DOM.describeNode", { backendNodeId })) as { node?: { nodeName?: string; attributes?: string[] } };
    if (!node) return true;
    const attrs = node.attributes ?? [];
    for (let i = 0; i + 1 < attrs.length; i += 2) {
      if (attrs[i]!.toLowerCase() === "type" && attrs[i + 1]!.toLowerCase() === "password") return true;
    }
    const ax = (await send("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false }).catch(() => null)) as { nodes?: AxNode[] } | null;
    if (ax?.nodes?.some((n) => n.properties?.some((p) => p.name === "protected" && p.value?.value === true))) return true;
    return false;
  } catch {
    return true;
  }
}

async function focusRef(send: CdpSend, backendNodeId: number): Promise<boolean> {
  try { await send("DOM.focus", { backendNodeId }); return true; } catch { return false; }
}

async function pressNamedKey(send: CdpSend, name: string): Promise<void> {
  const k = NAMED_KEYS[name]!;
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
}

/* ------------------------------------ read ------------------------------------ */

const PAGE_TEXT_MAX = 40_000;

/** Article-first page text: the reader's priority order, falling back to body. */
export async function readPageText(send: CdpSend): Promise<string> {
  const expression = `(() => {
    const pick = document.querySelector("article") ?? document.querySelector("main") ?? document.querySelector("[role=main]") ?? document.body;
    return pick ? pick.innerText : "";
  })()`;
  const result = (await send("Runtime.evaluate", { expression, returnByValue: true })) as { result?: { value?: unknown } };
  const text = typeof result.result?.value === "string" ? result.result.value : "";
  return text.length > PAGE_TEXT_MAX ? `${text.slice(0, PAGE_TEXT_MAX)}\n…(truncated at ${PAGE_TEXT_MAX} chars)` : text;
}

/* --------------------------- the marks an act leaves in the page --------------------------- */

/**
 * The attribute that marks everything Realm draws INSIDE an agent-driven page as Realm's furniture,
 * never page content. Everything that touches a mark keys off this one name: the injector sets it,
 * `buildSnapshot` filters it out of the element list, and the sweeps below remove by it.
 *
 * It carries a VALUE (Plan 25 W2), and the value is load-bearing. The ring and the cursor have
 * different lifetimes — the ring is one act's 900ms flash, the cursor and the frame last the whole
 * drive — so a sweep that removed "every mark" would delete the cursor every time a ring was drawn,
 * and `buildSnapshot`'s pre-capture sweep would blink it mid-`browser_batch`. The snapshot FILTER
 * stays presence-based (`attrs[HIGHLIGHT_ATTR] !== undefined`), which covers every value for free;
 * only the removals narrow.
 */
export const HIGHLIGHT_ATTR = "data-realm-agent-highlight";

/** The attribute's values. `css` is the injected stylesheet, tagged so the snapshot filter excludes
 *  it for free and so neither sweep takes it — it is shared by every mark and outlives all of them. */
export const MARK_RING = "ring";
export const MARK_CURSOR = "cursor";
export const MARK_FRAME = "frame";
const MARK_CSS = "css";

/** How long the ring stays before fading itself out. Long enough for the eye to land where the click
 *  did, short enough that it is gone before the page's own reaction finishes drawing. */
const HIGHLIGHT_TTL_MS = 900;

const removeJs = (...values: string[]): string =>
  `(() => { try { for (const n of document.querySelectorAll(${JSON.stringify(values.map((v) => `[${HIGHLIGHT_ATTR}="${v}"]`).join(","))})) n.remove(); } catch (e) {} })()`;

/** Rings only — this is what `buildSnapshot` sweeps before every capture, and what one act's ring
 *  clears before drawing the next. Widening it to the whole attribute is the named mutant: it would
 *  delete the cursor the very act that placed it. */
export const REMOVE_RINGS_JS = removeJs(MARK_RING);

/** The drive's own marks: the cursor and the controlled-screen frame. Used by `armElementPick`,
 *  because two accent overlays chasing one pointer is the failure the picker would otherwise have. */
export const REMOVE_AGENT_MARKS_JS = removeJs(MARK_CURSOR, MARK_FRAME);

/** The element ref the RING should trace for this action, or null when there is nothing to outline.
 *  The ring says "this element": it is quad-shaped, it outlives the act, and it is the only honest
 *  mark for `type` and `key`, which dispatch no mouse event at all. */
export function highlightTargetRef(action: BrowserAction): number | null {
  switch (action.kind) {
    case "click": case "type": return action.ref;
    case "key": return action.ref ?? null;
    case "scroll": return null;
  }
}

/** How the mark answers the act at the moment it lands. `count` repeats the contraction once per
 *  click; `sign` is the DELTA'S sign and nothing else — magnitude is not depicted, because the page
 *  is not told how far it scrolled either. */
export type CursorPress =
  | { kind: "click"; count: number }
  | { kind: "scroll"; axis: "x" | "y"; sign: -1 | 0 | 1 };

/** Where the cursor goes. `ref: null` means "the viewport centre `performAct` computes", which is
 *  the only fallback there is — see `viewportCentre`. */
export type CursorTarget = { ref: number | null; press: CursorPress };

/**
 * The point the CURSOR marks for this action, or null when a pointer there would be a lie.
 *
 * `type` and `key` dispatch no mouse event whatsoever, so a pointer at that field is the one outright
 * false thing this feature could draw — they get the ring and nothing else. `scroll` is the inverse:
 * it has no ring today and a wheel event really is dispatched at a point, so it is the one act whose
 * ONLY honest mark is the cursor.
 *
 * A `download` reaches this through the ordinary click it performs (`browser-agent-host.ts`), which
 * is why there is no case for it here. `fillCredential` deliberately reaches nothing at all.
 */
export function cursorTargetFor(action: BrowserAction): CursorTarget | null {
  switch (action.kind) {
    case "click":
      return { ref: action.ref, press: { kind: "click", count: action.clickCount ?? 1 } };
    case "type": case "key":
      return null;
    case "scroll": {
      const dx = action.deltaX ?? 0;
      const dy = action.deltaY ?? 0;
      // The dominant axis, so a sideways scroll is not drawn as a vertical one. Ties go to y, which
      // is what a wheel means when nothing distinguishes the two.
      const axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      const sign = Math.sign(axis === "x" ? dx : dy) as -1 | 0 | 1;
      return { ref: action.ref ?? null, press: { kind: "scroll", axis, sign } };
    }
  }
}

/** The centre of the visual viewport, in the exact form `performAct`'s scroll fallback uses. Shared
 *  rather than repeated: a mark at a point the wheel event did not go to is the whole failure. */
export function viewportCentre(metrics: LayoutMetrics): { x: number; y: number } {
  return {
    x: (metrics.cssVisualViewport?.clientWidth ?? 800) / 2,
    y: (metrics.cssVisualViewport?.clientHeight ?? 600) / 2,
  };
}

/** The accent used when the renderer has not told main the theme's — Realm's default blue. Shared by
 *  the ring, the cursor, the frame and the picker, so all four are one colour or none of them are. */
export const DEFAULT_AGENT_ACCENT = "rgb(76, 141, 255)";

/** The picker's own name for it, kept because that is what its parameter has always been called. */
export const DEFAULT_PICK_ACCENT = DEFAULT_AGENT_ACCENT;

/**
 * The injected stylesheet: every transition, animation and reduced-motion rule the marks use.
 *
 * A stylesheet rather than inline `style.transition` strings, and a CSS media query rather than a
 * `matchMedia` read in JS, for one reason each. The sheet is where a keyframe can live at all, and
 * the pulse needs one. And a media query is re-evaluated by the page the moment the preference
 * changes, where a boolean sampled at injection time would keep a user who turned motion off
 * mid-drive in full motion — and could be inverted by a single edit with nothing to catch it.
 *
 * Geometry and colour stay INLINE on each node, where they beat any rule the page itself might
 * carry; only motion is declared here, which no page has a reason to target.
 */
function markStylesheet(): string {
  const { pressScale } = AGENT_CURSOR;
  const { pressMs, fastMs, swapMs, enterMs, easeOutStrong, framePulseMs } = AGENT_MOTION;
  const cursor = `[${HIGHLIGHT_ATTR}="${MARK_CURSOR}"]`;
  const glyph = `[${HIGHLIGHT_ATTR}="${MARK_CURSOR}"] svg`;
  const glow = `[${HIGHLIGHT_ATTR}="${MARK_FRAME}"] > u`;
  return [
    // The mark SWAPS position. Only `translate` and `opacity` are named — there is no path, no
    // intermediate point drawn, no trail and no afterimage, because the page received one
    // instantaneous arrival and a drawn traversal would depict a journey that never happened.
    `${cursor}{transition:translate ${swapMs}ms ${easeOutStrong},opacity ${enterMs}ms ${easeOutStrong}}`,
    // The press scales about the HOTSPOT (`transform-origin` is set inline, per form): a pointer
    // that contracts toward its own middle walks its tip off the pixel the input went to, which is
    // the one thing the mark exists to be right about.
    `${cursor}[data-press]{animation:rl-agent-press ${pressMs}ms ${easeOutStrong} both}`,
    `@keyframes rl-agent-press{50%{scale:${pressScale}}}`,
    // A white pointer has to survive a white page. `overflow:visible` so the accent outline, which
    // is drawn outside the fill, is never clipped by the glyph's own box.
    `${glyph}{overflow:visible;display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.32))}`,
    `${cursor} i{transition:opacity ${fastMs}ms linear}`,
    `${glow}{animation:rl-agent-pulse ${framePulseMs}ms ease-in-out infinite}`,
    `@keyframes rl-agent-pulse{0%,100%{opacity:1}50%{opacity:.3}}`,
    // Under the preference the mark JUMPS to the point — which is literally the event stream, so it
    // is the MORE honest rendering — and the press becomes an opacity flash rather than a
    // contraction nobody would see without motion. The frame's ring stays painted and only its glow
    // stops moving: the rule `styles.css` already writes down for the in-flight ping, that what
    // carries the state has to survive when the motion carrying it is taken away.
    `@media (prefers-reduced-motion:reduce){`,
    `${cursor}{transition:opacity ${enterMs}ms ${easeOutStrong}}`,
    `${cursor}[data-press]{animation-name:rl-agent-press-flat}`,
    `@keyframes rl-agent-press-flat{50%{opacity:.35}}`,
    `${glow}{animation:none}`,
    `}`,
  ].join("");
}

/**
 * The two ticks beside the mark on a scroll, on the side matching the delta's SIGN — one entry per
 * form, because the mark is a directional glyph now and each one occupies its box differently.
 *
 * Anchored to the HOTSPOT's row or column and pushed clear of the glyph's own box, so a downward
 * tick beside an arrow sits below the arrow rather than on top of its tail. Precomputed per form
 * here rather than worked out inside the page, so the arithmetic is something a test can read.
 *
 * A sign of 0 — a wheel event with no delta at all — draws none, because there is no side to put
 * them on and the magnitude is not depicted either way.
 */
export function tickStylesFor(press: CursorPress, accent: string): Record<string, string> | null {
  if (press.kind !== "scroll" || press.sign === 0) return null;
  const line = `1px solid ${accent}`;
  const common = "position:absolute;pointer-events:none;";
  const gap = 5;
  const out: Record<string, string> = {};
  for (const [name, form] of Object.entries(AGENT_CURSOR_FORMS)) {
    const [w, h] = form.box;
    const [hx, hy] = form.hot;
    if (press.axis === "y") {
      const top = press.sign < 0 ? -gap - 3 : h + gap;
      out[name] = `${common}left:${hx - 3}px;top:${top}px;width:6px;height:3px;border-top:${line};border-bottom:${line}`;
    } else {
      const left = press.sign < 0 ? -gap - 3 : w + gap;
      out[name] = `${common}top:${hy - 3}px;left:${left}px;width:3px;height:6px;border-left:${line};border-right:${line}`;
    }
  }
  return out;
}

/**
 * One form's node, ready for the page to build: the element styles that place it by its hotspot, and
 * the SVG the glyph is drawn from.
 *
 * `paint-order: stroke fill` is what makes the outline sit OUTSIDE the white rather than eating half
 * of it, and it is what tells a reader at a glance whose pointer this is: theirs is white with a
 * black edge, this one is white with an edge in their own accent.
 */
function formNode(name: CursorFormName): { css: string; svg: { box: readonly [number, number]; paths: readonly { d: string; evenOdd?: true }[]; stroke: number } } {
  // Widened deliberately: the table is `as const` so each entry keeps its own literal shape, and
  // only the barred circle declares a `stroke`. Read through the interface and the optional is back.
  const form: CursorForm = AGENT_CURSOR_FORMS[name];
  const [w, h] = form.box;
  const [hx, hy] = form.hot;
  return {
    // `left:0;top:0` with a negative margin, so `translate` stays the act's own point and the swap
    // transition interpolates that point directly rather than some offset derived from it.
    css: `position:fixed;left:0;top:0;width:${w}px;height:${h}px;margin:${-hy}px 0 0 ${-hx}px;`
      + `transform-origin:${hx}px ${hy}px;pointer-events:none;z-index:2147483647;opacity:0;`,
    svg: { box: form.box, paths: form.paths, stroke: (form.stroke ?? AGENT_CURSOR.stroke) * 2 },
  };
}

/**
 * Draw everything one permitted act leaves in the page — the ring, the cursor and the
 * controlled-screen frame — in ONE `Runtime.evaluate` over ONE geometry read.
 *
 * Injected into the page over CDP rather than drawn by the renderer, because a `WebContentsView`
 * composites above all DOM unconditionally: nothing Realm paints beside one can reach it. DOM
 * injection rides the debugger, so a CSP that blocks page scripts does not block this.
 *
 * The constraints, each load-bearing:
 *   - geometry comes from `DOM.getContentQuads` on the ref NOW, after the same `scrollIntoViewIfNeeded`
 *     the act itself is about to perform — so the ring's rect and the cursor's point are resolved
 *     under the act's own precondition and cannot diverge from where the input lands. Nothing here
 *     accepts a rect from a snapshot;
 *   - a page that navigated between permission and execution has no quads for the ref, so the ring is
 *     silently skipped and the act fails honestly on its own;
 *   - every node carries `HIGHLIGHT_ATTR` and `pointer-events:none` over a transparent background —
 *     invisible to snapshots (filtered by the attribute), inert to the click about to land, and
 *     see-through to the occlusion check (a transparent background never "covers" anything);
 *   - the caller does NOT await the settle. The mark is placed before the dispatch and the press
 *     flash is what marks the moment, so there is no added latency per act;
 *   - EVERY failure path is swallowed. A failed mark must never fail — or even delay-fail — the act
 *     it decorates.
 */
export async function markAct(send: CdpSend, action: BrowserAction, accent = DEFAULT_AGENT_ACCENT): Promise<void> {
  try {
    const ringRef = highlightTargetRef(action);
    const cursor = cursorTargetFor(action);
    // At most one quads read: the ring and the cursor address the same ref whenever both exist.
    const geomRef = ringRef ?? cursor?.ref ?? null;
    let quad: number[] | null = null;
    if (geomRef !== null) {
      await send("DOM.scrollIntoViewIfNeeded", { backendNodeId: geomRef }).catch(() => {});
      const { quads } = (await send("DOM.getContentQuads", { backendNodeId: geomRef })) as { quads?: number[][] };
      const first = quads?.[0];
      quad = first && first.length >= 8 ? first : null;
      if (!quad) return; // no live geometry — likely navigated away; draw nothing
    }
    let ring = "";
    let point: { x: number; y: number } | null = null;
    if (quad) {
      const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
      const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
      const left = Math.min(...xs), top = Math.min(...ys);
      const w = Math.max(...xs) - left, h = Math.max(...ys) - top;
      if (!Number.isFinite(left + top + w + h)) return;
      if (ringRef !== null) {
        ring = `position:fixed;left:${left - 3}px;top:${top - 3}px;width:${w + 6}px;height:${h + 6}px;`
          + `border:2px solid ${accent};border-radius:6px;box-shadow:0 0 0 3px color-mix(in srgb, ${accent} 28%, transparent);`
          + "background:transparent;pointer-events:none;z-index:2147483647;transition:opacity 220ms ease;";
      }
      if (cursor) point = { x: xs.reduce((a, b) => a + b, 0) / 4, y: ys.reduce((a, b) => a + b, 0) / 4 };
    }
    if (cursor && cursor.ref === null) {
      point = viewportCentre((await send("Page.getLayoutMetrics")) as LayoutMetrics);
    }
    await send("Runtime.evaluate", { expression: markScript({ accent, ring, point, press: cursor?.press ?? null }) });
  } catch { /* the marks are decoration; the act must proceed untouched */ }
}

/** The page-side half, written as a string because it runs in the PAGE, whose globals are not ours.
 *  Every value it needs is `JSON.stringify`d in, so nothing here has to quote anything by hand. */
function markScript(o: { accent: string; ring: string; point: { x: number; y: number } | null; press: CursorPress | null }): string {
  const forms = Object.fromEntries(
    (Object.keys(AGENT_CURSOR_FORMS) as CursorFormName[]).map((name) => [name, formNode(name)]),
  );
  const ticks = tickStylesFor(o.press ?? { kind: "click", count: 1 }, o.accent);
  const frameCss = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;opacity:1;"
    + `box-shadow:inset 0 0 0 2px ${o.accent};`;
  const glowCss = `position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 48px -12px ${o.accent};`;
  const labelCss = "position:absolute;left:50%;bottom:12px;translate:-50% 0;padding:4px 10px;border-radius:8px;"
    + `background:${o.accent};color:#fff;font:500 12px/1.4 ui-sans-serif,system-ui,sans-serif;white-space:nowrap;`
    + "box-shadow:0 2px 10px rgba(0,0,0,0.25);pointer-events:none;";
  const j = JSON.stringify;
  return `(() => { try {
    var A = ${j(HIGHLIGHT_ATTR)}, D = document, R = D.body || D.documentElement;
    if (!R) return;
    var sel = function (v) { return D.querySelector("[" + A + "=\\"" + v + "\\"]"); };
    var make = function (v, css, tag) { var n = D.createElement(tag || "div"); n.setAttribute(A, v); n.style.cssText = css; return n; };
    if (!sel(${j(MARK_CSS)})) { var st = make(${j(MARK_CSS)}, "", "style"); st.textContent = ${j(markStylesheet())}; (D.head || R).appendChild(st); }
    ${REMOVE_RINGS_JS};
    var ringCss = ${j(o.ring)};
    if (ringCss) {
      var ring = make(${j(MARK_RING)}, ringCss);
      R.appendChild(ring);
      setTimeout(function () { try { ring.style.opacity = "0"; setTimeout(function () { try { ring.remove(); } catch (e) {} }, 260); } catch (e) {} }, ${HIGHLIGHT_TTL_MS});
    }
    var pt = ${j(o.point)};
    if (pt) {
      var FORMS = ${j(forms)}, TICKS = ${j(ticks)}, MAP = ${j(CURSOR_FORM_FOR_CSS)};
      /* WHICH pointer to draw, asked of the page rather than guessed from the element.
         The page's computed \`cursor\` at this point is its own statement about what a real pointer
         here would look like — a hand over something it means to be clicked, an I-beam over a field,
         a barred circle over a control it has disabled. Drawing that is reporting; drawing an arrow
         over all of them and calling it a cursor would be decoration.
         The mark itself is \`pointer-events:none\`, so elementFromPoint never finds Realm's own
         furniture and the answer is always about the page. */
      var form = "default";
      try {
        var under = D.elementFromPoint(pt.x, pt.y);
        if (under) {
          /* \`url(a.png) 4 12, pointer\` is a legal computed value; the keyword is the last fallback
             in the list, which is also the one Chromium lands on for any image it cannot fetch. */
          var css = (getComputedStyle(under).cursor || "auto").split(",").pop().trim().split(/\\s+/).pop();
          if (css === "auto") {
            /* \`auto\` means the browser decides, and only the page knows what it decided. Resolved
               the way Chromium renders it: an I-beam over something a caret can go in, an arrow
               everywhere else. */
            var tag = under.tagName;
            css = (tag === "TEXTAREA" || under.isContentEditable
              || (tag === "INPUT" && !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/i.test(under.type || "text")))
              ? "text" : "default";
          }
          form = MAP[css] || "default";
        }
      } catch (e) { /* a cross-origin or detached point: the arrow is the honest fallback */ }

      var mark = sel(${j(MARK_CURSOR)});
      /* Rebuilt whenever the FORM changes — the box, the hotspot and the transform origin all move
         with it, so morphing one glyph into another would leave the tip off the point. Position and
         the swap transition survive the rebuild because they are re-applied below either way. */
      var fresh = !mark || mark.getAttribute("data-form") !== form;
      if (mark && fresh) { var was = mark.style.translate; mark.remove(); mark = null; }
      if (!mark) {
        var spec = FORMS[form];
        mark = make(${j(MARK_CURSOR)}, spec.css);
        mark.setAttribute("data-form", form);
        var NS = "http://www.w3.org/2000/svg";
        var svg = D.createElementNS(NS, "svg");
        svg.setAttribute(A, ${j(MARK_CURSOR)} + "-glyph");
        svg.setAttribute("viewBox", "0 0 " + spec.svg.box[0] + " " + spec.svg.box[1]);
        svg.setAttribute("width", String(spec.svg.box[0]));
        svg.setAttribute("height", String(spec.svg.box[1]));
        svg.setAttribute("fill", "#fff");
        svg.setAttribute("stroke", ${j(o.accent)});
        svg.setAttribute("stroke-width", String(spec.svg.stroke));
        svg.setAttribute("stroke-linejoin", "round");
        /* The outline is drawn UNDER the fill, so it sits outside the white instead of eating half
           of it — the difference between a pointer with an accent edge and a pointer that has gone
           thin. Built node by node rather than through innerHTML, which is a Trusted Types sink and
           throws outright on the pages that enforce it. */
        svg.setAttribute("paint-order", "stroke fill");
        for (var pi = 0; pi < spec.svg.paths.length; pi++) {
          var pth = D.createElementNS(NS, "path");
          pth.setAttribute("d", spec.svg.paths[pi].d);
          if (spec.svg.paths[pi].evenOdd) pth.setAttribute("fill-rule", "evenodd");
          svg.appendChild(pth);
        }
        mark.appendChild(svg);
        R.appendChild(mark);
      }
      var tick = mark.querySelector("i");
      if (tick) tick.remove();
      if (TICKS) mark.appendChild(make(${j(MARK_CURSOR)} + "-tick", TICKS[form], "i"));
      /* A fresh mark is positioned with the transition OFF and one forced reflow, then faded in at
         the point. Transitioning from the (0,0) it was created at would fabricate a sweep in from the
         corner of the page — motion depicting a journey nothing made. A form swap carries the last
         position across for the same reason: the pointer changed shape, it did not go anywhere. */
      var here = pt.x + "px " + pt.y + "px";
      if (fresh) {
        mark.style.transition = "none";
        mark.style.translate = was || here;
        void mark.offsetWidth;
        mark.style.transition = "";
      }
      mark.style.translate = here;
      mark.style.opacity = "1";
      /* Removed and re-added around a reflow so a second click in the same burst replays the press
         rather than sitting on a finished animation. */
      mark.removeAttribute("data-press");
      void mark.offsetWidth;
      mark.style.animationIterationCount = String(${o.press?.kind === "click" ? Math.max(1, o.press.count) : 1});
      mark.setAttribute("data-press", ${j(o.press?.kind ?? "click")});
    }
    if (!sel(${j(MARK_FRAME)})) {
      var frame = make(${j(MARK_FRAME)}, ${j(frameCss)});
      frame.appendChild(make(${j(MARK_FRAME)} + "-glow", ${j(glowCss)}, "u"));
      var label = make(${j(MARK_FRAME)} + "-label", ${j(labelCss)});
      label.textContent = "An agent is controlling this page";
      frame.appendChild(label);
      R.appendChild(frame);
    }
    /* The dwell watchdog, owned by the PAGE and reset on every placement: a dead bridge, a crashed
       host or a lost driving:false must not be able to leave a pointer stuck on someone's page. */
    if (window.__realmAgentIdle) clearTimeout(window.__realmAgentIdle);
    window.__realmAgentIdle = setTimeout(function () {
      try {
        var gone = D.querySelectorAll("[" + A + "=\\"${MARK_CURSOR}\\"],[" + A + "=\\"${MARK_FRAME}\\"]");
        for (var i = 0; i < gone.length; i++) { gone[i].style.transition = "opacity ${AGENT_MOTION.fastMs}ms linear"; gone[i].style.opacity = "0"; }
        setTimeout(function () { try { for (var k = 0; k < gone.length; k++) gone[k].remove(); } catch (e) {} }, ${AGENT_MOTION.fastMs});
      } catch (e) {}
    }, ${AGENT_CURSOR.idleMs});
  } catch (e) {} })()`;
}

/* ------------------------------------ describe ------------------------------------ */

/**
 * An element's identity as Realm names it everywhere a human reads one: the permission cards, the
 * action ticker, and a picked element's chip. AX role and name come first because they are what the
 * page MEANS rather than how it is built (`<div role=button>` is a button here); the tag and the
 * label-ish attributes are the fallback for nodes the AX tree ignores.
 */
export type ElementIdentity = { role: string; name: string; tag: string; inputType: string | null };

export async function describeElement(send: CdpSend, backendNodeId: number): Promise<ElementIdentity> {
  const { node } = (await send("DOM.describeNode", { backendNodeId })) as { node?: { nodeName?: string; attributes?: string[] } };
  const attrs: Record<string, string> = {};
  const flat = node?.attributes ?? [];
  for (let i = 0; i + 1 < flat.length; i += 2) attrs[flat[i]!.toLowerCase()] = flat[i + 1]!;
  let role = "";
  let name = "";
  const ax = (await send("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false }).catch(() => null)) as { nodes?: AxNode[] } | null;
  const axNode = ax?.nodes?.[0];
  if (axNode) { role = String(axNode.role?.value ?? ""); name = String(axNode.name?.value ?? ""); }
  return {
    role: role || (node?.nodeName ?? "").toLowerCase(),
    name: name || attrs["aria-label"] || attrs.placeholder || attrs.title || "",
    tag: (node?.nodeName ?? "").toLowerCase(),
    inputType: attrs.type ?? null,
  };
}

/* ------------------------------------ element picking ------------------------------------ */

/**
 * The USER's element picker, over CDP's `Overlay` domain.
 *
 * `Overlay.setInspectMode("searchForNode")` is the mechanism behind DevTools' own inspect button, and
 * every reason to prefer it here over injecting a click listener with `Runtime.addBinding` +
 * `Page.addScriptToEvaluateOnNewDocument` is something an injected listener cannot do:
 *
 *   - Chrome CONSUMES the picking click. It never reaches the page, so picking a link does not
 *     navigate and picking a submit button does not submit. An injected listener can only try to
 *     `preventDefault` in the capture phase, and loses to any page that registered its own capture
 *     listener on `window` first — which is most of the pages worth picking from.
 *   - the hit test is the browser's own, so it is right through shadow roots, cross-origin iframes
 *     and `pointer-events`, none of which `document.elementFromPoint` reports correctly from a
 *     single world.
 *   - the highlight is drawn by the overlay layer, not by page DOM. Nothing is appended to the page,
 *     so there is no second `HIGHLIGHT_ATTR` to hold in step across the snapshot filter and the
 *     pre-capture sweep, and the page can neither see nor restyle the marker saying it is inspected.
 *   - nothing is injected into an untrusted page at all, and no script has to be re-established
 *     after a navigation.
 *
 * The cost is the look: this is DevTools' box-model highlight with its tag/size tooltip, not Realm's
 * action ring. For a picker that is the better trade — the tooltip names what the box IS, which is
 * the one thing someone choosing an element needs to read before they commit.
 *
 * One behaviour worth knowing, because it is invisible until it bites: inspect mode inspects the node
 * it is HOVERING, which it learns from mouse moves. A press with no move before it finds nothing
 * highlighted and falls through to the page. A hand always moves before it clicks, so this costs a
 * user nothing — but a synthetic click that skips the move is not a test of this code
 * (`element-picker-live.cjs` sends the move for exactly that reason).
 */
/**
 * The picker's page-side half — Realm's own overlay, not Chrome's.
 *
 * `Overlay.setInspectMode` is the DevTools inspector: a flat blue box with a node-info tooltip, and
 * it looks exactly like what it is. This app is not DevTools, and a person picking an element to
 * talk to an agent about is doing a Realm thing.
 *
 * So the overlay is injected. It follows the pointer over `elementFromPoint`, draws a thick accent
 * border with an inward glow on the app's own curve, and names the element in a chip that reads like
 * every other chip in Realm. The click is taken in the CAPTURE phase and cancelled, so picking a
 * link does not navigate — the failure the whole feature would otherwise have on any real page.
 *
 * The element is handed back by stamping a one-shot attribute on it and calling a CDP binding; main
 * turns that attribute into a `backendNodeId` (`resolvePickedNode`) and clears it. That is the whole
 * bridge: everything downstream — `describePick`, `describeElement` — is untouched and still speaks
 * in backendNodeIds.
 *
 * Written as a string rather than a real module because it runs in the PAGE, whose globals are not
 * ours and whose bundler is not ours either. No backticks inside: this is embedded in a template
 * literal, and one would end it.
 */
export const PICK_BINDING = "__realmPickDone";
export const PICK_ATTR = "data-realm-picked";

const PICKER_SCRIPT = `(() => {
  if (window.__realmPicker) window.__realmPicker.stop();
  const ACCENT = ACCENT_RGB;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  const box = document.createElement("div");
  /* 2px rather than the inspector's hairline, an inward glow instead of a flat fill, and the app's
     own large corner. inset box-shadow so the glow reads as light coming off the edge of the thing
     you are about to pick rather than as a tint laid over it. */
  box.style.cssText = "position:absolute;box-sizing:border-box;border:2px solid " + ACCENT
    + ";border-radius:14px;box-shadow: inset 0 0 24px -4px " + ACCENT + ", 0 0 0 9999px rgba(0,0,0,0.04);"
    + "transition:all 90ms cubic-bezier(0.2,0,0,1);opacity:0";
  const chip = document.createElement("div");
  chip.style.cssText = "position:absolute;padding:3px 9px;border-radius:8px;background:" + ACCENT
    + ";color:#fff;font:500 11px/1.4 ui-sans-serif,system-ui,sans-serif;white-space:nowrap;"
    + "box-shadow:0 2px 10px rgba(0,0,0,0.25);opacity:0";
  host.appendChild(box); host.appendChild(chip);
  document.documentElement.appendChild(host);

  let current = null;
  const name = (el) => {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? "#" + el.id : "";
    const cls = typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    return (tag + id + cls).slice(0, 60);
  };
  const draw = (el) => {
    current = el;
    if (!el) { box.style.opacity = "0"; chip.style.opacity = "0"; return; }
    const r = el.getBoundingClientRect();
    box.style.opacity = "1"; chip.style.opacity = "1";
    box.style.left = r.left + "px"; box.style.top = r.top + "px";
    box.style.width = r.width + "px"; box.style.height = r.height + "px";
    chip.textContent = name(el) + "  " + Math.round(r.width) + "x" + Math.round(r.height);
    /* Above the element, unless there is no room — then inside its top edge. A label that runs off
       the viewport is a label nobody can read. */
    const above = r.top >= 26;
    chip.style.left = Math.max(4, Math.min(r.left, window.innerWidth - chip.offsetWidth - 4)) + "px";
    chip.style.top = (above ? r.top - 24 : r.top + 4) + "px";
  };
  const onMove = (e) => {
    host.style.display = "none";
    const el = document.elementFromPoint(e.clientX, e.clientY);
    host.style.display = "";
    if (el && el !== current) draw(el);
  };
  const onClick = (e) => {
    if (!current) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const el = current;
    /* WHERE the click landed, and whether it landed on a STREAMED SURFACE.
       Ordinarily the picked element is the whole answer and this is redundant. It stops being
       redundant over a mirrored device: the entire screen is drawn into one <canvas>, so the element
       says only "the simulator" and the point is the whole content of the pick.
       The surface is looked up through elementsFromPoint rather than taken from the picked element,
       because a page may lay its own transparent divs over the canvas — serve-sim does — and the
       topmost node at the point is then a div while the geometry that matters is still the canvas's.
       Its box travels too: it is what a device point is scaled by, and only the page can measure it. */
    const stack = typeof document.elementsFromPoint === "function" ? document.elementsFromPoint(e.clientX, e.clientY) : [];
    const surfaceEl = stack.find((n) => n.tagName === "CANVAS" || n.tagName === "IMG") || null;
    const boxEl = surfaceEl || el;
    const box = boxEl.getBoundingClientRect();
    const nx = box.width > 0 ? (e.clientX - box.left) / box.width : 0;
    const ny = box.height > 0 ? (e.clientY - box.top) / box.height : 0;
    const surface = surfaceEl ? { x: box.left, y: box.top, w: box.width, h: box.height } : null;
    stop();
    el.setAttribute(PICK_ATTR_NAME, "1");
    window[BINDING_NAME](JSON.stringify({ x: nx, y: ny, surface }));
  };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); stop(); window[BINDING_NAME](""); } };
  function stop() {
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("keydown", onKey, true);
    host.remove();
    window.__realmPicker = null;
  }
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKey, true);
  window.__realmPicker = { stop };
})()`;

/** The picker script with its three page-side constants substituted in. `accent` is the user's own
 *  theme colour, so the overlay is the colour of the app it belongs to rather than a fixed blue. */
function pickerScript(accent: string): string {
  return PICKER_SCRIPT
    .replace("ACCENT_RGB", JSON.stringify(accent))
    .replace(/PICK_ATTR_NAME/g, JSON.stringify(PICK_ATTR))
    .replace(/BINDING_NAME/g, JSON.stringify(PICK_BINDING));
}

/**
 * Arm the picker. The caller listens for `Runtime.bindingCalled` on `PICK_BINDING`; a non-empty
 * payload means the page has stamped `PICK_ATTR` on the chosen element, and an empty one means the
 * user pressed Escape.
 */
export async function armElementPick(send: CdpSend, accent?: string): Promise<void> {
  await send("Runtime.enable").catch(() => {});
  await send("Runtime.addBinding", { name: PICK_BINDING });
  // Two accent overlays chasing one pointer is the failure this removal exists to prevent: the
  // agent's cursor and the picker's box are the same colour and follow the same hand.
  await send("Runtime.evaluate", { expression: REMOVE_AGENT_MARKS_JS }).catch(() => {});
  await send("Runtime.evaluate", { expression: pickerScript(accent ?? DEFAULT_PICK_ACCENT), returnByValue: true });
}

/**
 * Turn the stamped attribute into the `backendNodeId` everything downstream speaks in, and clear it.
 *
 * The attribute is removed whatever happens: a page left carrying `data-realm-picked` would match
 * the NEXT pick's query and hand back the wrong element — the kind of bug that only appears on the
 * second use and is then very hard to see.
 */
export async function resolvePickedNode(send: CdpSend): Promise<number | null> {
  try {
    const { root } = await send("DOM.getDocument", { depth: 0 }) as { root: { nodeId: number } };
    const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: `[${PICK_ATTR}]` }) as { nodeId: number };
    if (!nodeId) return null;
    const { node } = await send("DOM.describeNode", { nodeId }) as { node: { backendNodeId: number } };
    await send("DOM.removeAttribute", { nodeId, name: PICK_ATTR }).catch(() => {});
    return node.backendNodeId > 0 ? node.backendNodeId : null;
  } catch { return null; }
}

export async function disarmElementPick(send: CdpSend): Promise<void> {
  // Idempotent on the page side (`stop()` removes its own listeners and its own overlay), so calling
  // this on a page that was never armed, or twice, costs nothing.
  await send("Runtime.evaluate", { expression: "window.__realmPicker && window.__realmPicker.stop()" }).catch(() => {});
  await send("Runtime.removeBinding", { name: PICK_BINDING }).catch(() => {});
}

/**
 * The page-side half of a pick: a CSS path, the collapsed text, the markup and the live rect, read
 * off the node in one round trip.
 *
 * The path prefers a test hook, then an id, and otherwise walks up composing `:nth-of-type` segments
 * — checking `querySelectorAll(...).length === 1` at every level so it stops at the shortest path
 * that is actually unambiguous, and only reaching the document element when nothing shorter is. A
 * class-based path was rejected: CSS-in-JS class names are content-hashed, so a selector built from
 * them names this build of the page rather than the element.
 *
 * Evaluated in the page's own world, like `readPageText` and the action ring. A page that has
 * replaced `querySelectorAll` can lie about all of it, which is why the result is treated as page
 * text everywhere downstream and why `ref` — which the page cannot influence — stays the handle
 * anything acts through.
 */
const PICK_DETAIL_JS = `function () {
  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; } };
  const esc = (v) => (self.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/[^\\w-]/g, (c) => "\\\\" + c));
  const hook = (node) => {
    for (const a of ["data-testid", "data-test-id", "data-test", "data-cy"]) {
      const v = node.getAttribute(a);
      if (v) return "[" + a + '="' + v.replace(/["\\\\]/g, "\\\\$&") + '"]';
    }
    return node.id ? "#" + esc(node.id) : null;
  };
  const segment = (node) => {
    const parent = node.parentElement;
    if (!parent) return node.localName;
    let total = 0, index = 0;
    for (const sib of parent.children) if (sib.localName === node.localName) { total++; if (sib === node) index = total; }
    return total > 1 ? node.localName + ":nth-of-type(" + index + ")" : node.localName;
  };
  const parts = [];
  let selector = "";
  for (let node = this; node && node.nodeType === 1; node = node.parentElement) {
    const anchor = hook(node);
    if (anchor && unique(anchor)) { parts.unshift(anchor); selector = parts.join(" > "); break; }
    parts.unshift(segment(node));
    selector = parts.join(" > ");
    if (unique(selector)) break;
  }
  const box = this.getBoundingClientRect();
  return {
    selector,
    text: (this.innerText || this.textContent || "").replace(/\\s+/g, " ").trim(),
    html: this.outerHTML || "",
    rect: { x: box.x, y: box.y, w: box.width, h: box.height },
  };
}`;

type PickDetail = { selector: string; text: string; html: string; rect: { x: number; y: number; w: number; h: number } };

const NO_DETAIL: PickDetail = { selector: "", text: "", html: "", rect: { x: 0, y: 0, w: 0, h: 0 } };

async function pickDetail(send: CdpSend, backendNodeId: number): Promise<PickDetail> {
  const resolved = (await send("DOM.resolveNode", { backendNodeId })) as { object?: { objectId?: string } };
  const objectId = resolved.object?.objectId;
  if (!objectId) return NO_DETAIL;
  try {
    const result = (await send("Runtime.callFunctionOn", {
      objectId, functionDeclaration: PICK_DETAIL_JS, returnByValue: true,
    })) as { result?: { value?: Partial<PickDetail> } };
    const value = result.result?.value;
    if (!value || typeof value !== "object") return NO_DETAIL;
    return {
      selector: clip(String(value.selector ?? ""), PICK_SELECTOR_MAX),
      text: clip(String(value.text ?? ""), PICK_TEXT_MAX),
      html: clip(String(value.html ?? ""), PICK_HTML_MAX),
      rect: value.rect ?? NO_DETAIL.rect,
    };
  } finally {
    void send("Runtime.releaseObject", { objectId }).catch(() => {});
  }
}

/** A picked ref → everything the prompt carries about it, minus the url/title only main can vouch
 *  for. AX identity comes from `describeElement` — the same read the permission cards use, so a
 *  picked element and an acted-on element are named the same way. */
export async function describePick(send: CdpSend, backendNodeId: number): Promise<Omit<BrowserPickedElement, "url" | "title">> {
  const [identity, detail] = await Promise.all([
    describeElement(send, backendNodeId),
    pickDetail(send, backendNodeId).catch(() => NO_DETAIL),
  ]);
  return {
    ref: backendNodeId,
    tag: clip(identity.tag, PICK_NAME_MAX),
    role: clip(identity.role, PICK_NAME_MAX),
    name: clip(identity.name, PICK_NAME_MAX),
    ...detail,
  };
}
