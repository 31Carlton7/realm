/**
 * The browser agent's CDP logic (Plan 11 W3), Electron-free and pure over a `CdpSend` function so the
 * mutants that must die here — occlusion dropped, password value leaked, stale-coordinate acts — die
 * in unit tests against fake CDP payloads, not only in live runs. Executed in Electron MAIN (the
 * process that owns `webContents.debugger`); realm-server reaches it over the browserHost bridge.
 */
import type { BrowserAction, BrowserActResult, BrowserSnapshotResult } from "@realm/contracts";

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
  // Any lingering W4 action highlight is removed BEFORE the capture (belt to the filter's braces):
  // the ring is the watcher's, and an agent that sees it — even as a phantom layout box — is an
  // agent chasing its own tail. Best-effort: a page that refuses the evaluate still snapshots.
  await send("Runtime.evaluate", { expression: REMOVE_HIGHLIGHTS_JS }).catch(() => {});
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
    // W4's action highlight is Realm's own furniture, never page content: a snapshot that lists it
    // hands the agent a `[new]` element that is its OWN last click's ring — and it chases it.
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
          for (const ch of action.text) {
            if (ch === "\n") { await pressNamedKey(send, "Enter"); continue; }
            await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, key: ch });
            await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
          }
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
          const metrics = (await send("Page.getLayoutMetrics")) as LayoutMetrics;
          point = { x: (metrics.cssVisualViewport?.clientWidth ?? 800) / 2, y: (metrics.cssVisualViewport?.clientHeight ?? 600) / 2 };
        }
        await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: action.deltaX ?? 0, deltaY: action.deltaY ?? 0 });
        return { ok: true, detail: `scrolled by (${action.deltaX ?? 0}, ${action.deltaY ?? 0})` };
      }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
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

/* ------------------------------------ action highlight (W4) ------------------------------------ */

/** The attribute that marks W4's in-page action highlight as Realm furniture. Everything that touches
 *  the ring keys off this one name: the injector sets it, `buildSnapshot` filters it out of the
 *  element list AND removes lingering rings before capturing, and the ring's own timeout removes it. */
export const HIGHLIGHT_ATTR = "data-realm-agent-highlight";

/** How long the ring stays before fading itself out. Long enough for the eye to land where the click
 *  did, short enough that it is gone before the page's own reaction finishes drawing. */
const HIGHLIGHT_TTL_MS = 900;

export const REMOVE_HIGHLIGHTS_JS = `(() => { try { for (const n of document.querySelectorAll("[${HIGHLIGHT_ATTR}]")) n.remove(); } catch (e) {} })()`;

/** The element ref a highlight should ring for this action, or null when there is nothing to point
 *  at (a bare key press, a page scroll). */
export function highlightTargetRef(action: BrowserAction): number | null {
  switch (action.kind) {
    case "click": case "type": return action.ref;
    case "key": return action.ref ?? null;
    case "scroll": return null;
  }
}

/**
 * W4's in-page action highlight: a brief ring around the element a permitted act is about to touch —
 * injected INTO the page via `Runtime.evaluate` (DOM injection rides the debugger, so CSP that blocks
 * page scripts does not block it), which is what keeps the no-overlay invariant untouched: nothing of
 * Realm's ever paints over the view.
 *
 * The constraints, each load-bearing:
 *   - geometry comes from `DOM.getContentQuads` on the ref NOW — the same at-act-time re-resolution
 *     the act itself performs. A page that navigated between permission and execution has no quads
 *     for the ref, so the ring is silently skipped (and the act will fail honestly on its own);
 *   - the node carries `HIGHLIGHT_ATTR` and `pointer-events:none` with a transparent background —
 *     invisible to snapshots (filtered by the attribute), inert to the click about to land, and
 *     see-through to the occlusion check (its background never "covers" anything);
 *   - it removes itself (fade + remove after `HIGHLIGHT_TTL_MS`), any predecessor is removed first,
 *     and `buildSnapshot` sweeps stragglers before every capture;
 *   - EVERY failure path is swallowed: a failed highlight must never fail — or even delay-fail — the
 *     act it decorates.
 */
export async function showActionHighlight(send: CdpSend, backendNodeId: number): Promise<void> {
  try {
    const { quads } = (await send("DOM.getContentQuads", { backendNodeId })) as { quads?: number[][] };
    const quad = quads?.[0];
    if (!quad || quad.length < 8) return; // no live geometry — likely navigated away; no ring
    const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
    const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
    const x = Math.min(...xs), y = Math.min(...ys);
    const w = Math.max(...xs) - x, h = Math.max(...ys) - y;
    if (!Number.isFinite(x + y + w + h)) return;
    const expression = `(() => { try {
      ${REMOVE_HIGHLIGHTS_JS};
      const ring = document.createElement("div");
      ring.setAttribute("${HIGHLIGHT_ATTR}", "");
      ring.style.cssText = "position:fixed;left:${x - 3}px;top:${y - 3}px;width:${w + 6}px;height:${h + 6}px;" +
        "border:2px solid #4c8dff;border-radius:6px;box-shadow:0 0 0 3px rgba(76,141,255,0.28);" +
        "background:transparent;pointer-events:none;z-index:2147483647;transition:opacity 220ms ease;";
      (document.body || document.documentElement).appendChild(ring);
      setTimeout(() => { try { ring.style.opacity = "0"; setTimeout(() => { try { ring.remove(); } catch (e) {} }, 260); } catch (e) {} }, ${HIGHLIGHT_TTL_MS});
    } catch (e) {} })()`;
    await send("Runtime.evaluate", { expression });
  } catch { /* the ring is decoration; the act must proceed untouched */ }
}
