import { describe, expect, it } from "vitest";
import type { BrowserAction } from "@realm/contracts";
import { buildSnapshot, performAct, performFillCredential, SNAPSHOT_STYLES, isOpaqueColor, HIGHLIGHT_ATTR, highlightTargetRef, showActionHighlight, type CdpSend } from "./browser-agent";

/**
 * The executor mutants, killed against fake CDP payloads:
 *   - a password value reaching a snapshot in ANY form;
 *   - the occlusion filter dropped (a covered element listed as actionable);
 *   - a stale-coordinate act (quads not re-resolved at act time);
 *   - password-field type not refused (and: refused by the EXECUTOR, no mode involved).
 */

/** Builds `DOMSnapshot.captureSnapshot`-shaped payloads without hand-numbering string tables. */
function makeSnapshotDoc() {
  const strings: string[] = [];
  const intern = (v: string): number => {
    const existing = strings.indexOf(v);
    if (existing !== -1) return existing;
    strings.push(v);
    return strings.length - 1;
  };
  const nodes = { parentIndex: [] as number[], nodeType: [] as number[], nodeName: [] as number[], nodeValue: [] as number[], backendNodeId: [] as number[], attributes: [] as number[][], inputValue: { index: [] as number[], value: [] as number[] }, inputChecked: { index: [] as number[] }, isClickable: { index: [] as number[] } };
  const layout = { nodeIndex: [] as number[], styles: [] as number[][], bounds: [] as number[][], paintOrders: [] as number[] };

  const addNode = (o: { tag?: string; type?: number; parent?: number; text?: string; attrs?: Record<string, string>; backendId?: number; clickable?: boolean; value?: string; checked?: boolean }): number => {
    const ni = nodes.nodeType.length;
    nodes.parentIndex.push(o.parent ?? -1);
    nodes.nodeType.push(o.type ?? 1);
    nodes.nodeName.push(intern(o.tag ?? (o.type === 3 ? "#text" : "DIV")));
    nodes.nodeValue.push(intern(o.text ?? ""));
    nodes.backendNodeId.push(o.backendId ?? 1000 + ni);
    nodes.attributes.push(Object.entries(o.attrs ?? {}).flatMap(([k, v]) => [intern(k), intern(v)]));
    if (o.clickable) nodes.isClickable.index.push(ni);
    if (o.value !== undefined) { nodes.inputValue.index.push(ni); nodes.inputValue.value.push(intern(o.value)); }
    if (o.checked) nodes.inputChecked.index.push(ni);
    return ni;
  };
  const addLayout = (ni: number, bounds: [number, number, number, number], opts: { paint?: number; styles?: Partial<Record<(typeof SNAPSHOT_STYLES)[number], string>> } = {}): void => {
    layout.nodeIndex.push(ni);
    layout.bounds.push(bounds);
    layout.paintOrders.push(opts.paint ?? layout.nodeIndex.length);
    layout.styles.push(SNAPSHOT_STYLES.map((name) => intern(opts.styles?.[name] ?? "")));
  };
  const payload = (url = "https://example.com/") => ({
    documents: [{ documentURL: intern(url), title: intern("Example"), scrollOffsetX: 0, scrollOffsetY: 0, nodes, layout }],
    strings,
  });
  return { addNode, addLayout, payload, intern };
}

type AxEntry = { backendDOMNodeId: number; role?: string; name?: string; value?: string; protected?: boolean };

function fakeSend(opts: {
  snapshot?: unknown;
  ax?: AxEntry[];
  listeners?: Record<number, string[]>;
  quads?: Record<number, number[][] | "throw">;
  describe?: Record<number, { nodeName?: string; attributes?: string[] } | "throw">;
  /** What `Page.getNavigationHistory` reports — the BROWSER's record of the committed URL, which is
   *  what the credential fill's origin gate reads. `"throw"` is a history CDP will not give up. */
  history?: { url: string } | "throw";
  focus?: "throw";
}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const send: CdpSend = async (method, params = {}) => {
    calls.push({ method, params });
    switch (method) {
      case "DOMSnapshot.captureSnapshot": return opts.snapshot ?? { documents: [], strings: [] };
      case "Accessibility.getFullAXTree":
        return { nodes: (opts.ax ?? []).map((a) => ({ backendDOMNodeId: a.backendDOMNodeId, role: { value: a.role }, name: { value: a.name }, value: a.value !== undefined ? { value: a.value } : undefined, properties: a.protected ? [{ name: "protected", value: { value: true } }] : [] })) };
      case "Page.getLayoutMetrics": return { cssVisualViewport: { clientWidth: 1000, clientHeight: 800 } };
      case "DOM.getDocument": return {};
      case "DOM.resolveNode": return { object: { objectId: `obj-${params.backendNodeId}` } };
      case "DOMDebugger.getEventListeners": {
        const id = Number(String(params.objectId).replace("obj-", ""));
        return { listeners: (opts.listeners?.[id] ?? []).map((type) => ({ type })) };
      }
      case "Runtime.releaseObject": return {};
      case "DOM.scrollIntoViewIfNeeded": return {};
      case "DOM.getContentQuads": {
        const q = opts.quads?.[Number(params.backendNodeId)];
        if (q === "throw") throw new Error("no quads");
        return { quads: q ?? [] };
      }
      case "DOM.describeNode": {
        const d = opts.describe?.[Number(params.backendNodeId)];
        if (d === "throw") throw new Error("describe failed");
        return { node: d ?? { nodeName: "DIV", attributes: [] } };
      }
      case "Accessibility.getPartialAXTree": return { nodes: [] };
      case "DOM.focus":
        if (opts.focus === "throw") throw new Error("node is detached");
        return {};
      case "Page.getNavigationHistory": {
        if (opts.history === "throw") throw new Error("no history");
        return opts.history ? { currentIndex: 0, entries: [{ url: opts.history.url }] } : { currentIndex: 0, entries: [{ url: "https://example.com/login" }] };
      }
      case "Input.dispatchMouseEvent": case "Input.dispatchKeyEvent": case "Input.insertText": return {};
      default: return {};
    }
  };
  return { send, calls };
}

describe("buildSnapshot", () => {
  it("lists interactive elements with backendNodeId refs and AX roles/names", async () => {
    const doc = makeSnapshotDoc();
    const btn = doc.addNode({ tag: "BUTTON", backendId: 42 });
    doc.addLayout(btn, [10, 20, 100, 30]);
    const { send } = fakeSend({ snapshot: doc.payload(), ax: [{ backendDOMNodeId: 42, role: "button", name: "Submit order" }] });
    const snap = await buildSnapshot(send, null);
    expect(snap.text).toContain('[ref=42] button "Submit order" (10,20 100×30)');
    expect(snap.elementCount).toBe(1);
    expect(snap.url).toBe("https://example.com/");
  });

  it("NEVER includes a password field's value — not from inputValue, not from the AX tree (mutant: password leak)", async () => {
    const doc = makeSnapshotDoc();
    const pw = doc.addNode({ tag: "INPUT", attrs: { type: "password" }, backendId: 7, value: "hunter2-dom" });
    doc.addLayout(pw, [0, 0, 200, 30]);
    const user = doc.addNode({ tag: "INPUT", attrs: { type: "text" }, backendId: 8, value: "carlton" });
    doc.addLayout(user, [0, 40, 200, 30]);
    const { send } = fakeSend({ snapshot: doc.payload(), ax: [
      { backendDOMNodeId: 7, role: "textField", name: "Password", value: "hunter2-ax", protected: true },
      { backendDOMNodeId: 8, role: "textField", name: "Username", value: "carlton" },
    ] });
    const snap = await buildSnapshot(send, null);
    expect(snap.text).not.toContain("hunter2-dom");
    expect(snap.text).not.toContain("hunter2-ax");
    expect(snap.text).toContain("password field — typing is blocked");
    // The ordinary field's value IS there — redaction is targeted, not a blanket value drop.
    expect(snap.text).toContain('value="carlton"');
  });

  it("drops an element covered by a later-painted opaque box (mutant: occlusion filter removed)", async () => {
    const doc = makeSnapshotDoc();
    const btn = doc.addNode({ tag: "BUTTON", backendId: 42 });
    doc.addLayout(btn, [10, 10, 100, 30], { paint: 1 });
    const scrim = doc.addNode({ tag: "DIV", backendId: 99 });
    doc.addLayout(scrim, [0, 0, 1000, 800], { paint: 50, styles: { "background-color": "rgba(0, 0, 0, 0.8)" } });
    const dialogBtn = doc.addNode({ tag: "BUTTON", backendId: 43 });
    doc.addLayout(dialogBtn, [400, 300, 100, 30], { paint: 60 });
    const { send } = fakeSend({ snapshot: doc.payload(), ax: [
      { backendDOMNodeId: 42, role: "button", name: "Behind the modal" },
      { backendDOMNodeId: 43, role: "button", name: "In the dialog" },
    ] });
    const snap = await buildSnapshot(send, null);
    expect(snap.text).not.toContain("ref=42");
    expect(snap.text).toContain("ref=43");
    expect(snap.text).toContain("hidden behind overlays");
  });

  it("a TRANSPARENT later box does not count as cover, and neither does the element's own ancestor", async () => {
    const doc = makeSnapshotDoc();
    const wrapper = doc.addNode({ tag: "DIV", backendId: 1, clickable: true });
    doc.addLayout(wrapper, [0, 0, 300, 100], { paint: 1, styles: { "background-color": "rgb(255, 255, 255)" } });
    const btn = doc.addNode({ tag: "BUTTON", parent: wrapper, backendId: 42 });
    doc.addLayout(btn, [10, 10, 100, 30], { paint: 2 });
    // A transparent hit-area painted above everything (common analytics overlay).
    const transparent = doc.addNode({ tag: "DIV", backendId: 77 });
    doc.addLayout(transparent, [0, 0, 1000, 800], { paint: 99, styles: { "background-color": "rgba(0, 0, 0, 0)" } });
    const { send } = fakeSend({ snapshot: doc.payload(), ax: [{ backendDOMNodeId: 42, role: "button", name: "Click me" }] });
    const snap = await buildSnapshot(send, null);
    expect(snap.text).toContain("ref=42");
  });

  it("marks elements changed since the previous snapshot with [new], and only those", async () => {
    const doc = makeSnapshotDoc();
    const a = doc.addNode({ tag: "BUTTON", backendId: 1 });
    doc.addLayout(a, [0, 0, 100, 30]);
    const b = doc.addNode({ tag: "BUTTON", backendId: 2 });
    doc.addLayout(b, [0, 40, 100, 30]);
    const ax: AxEntry[] = [{ backendDOMNodeId: 1, role: "button", name: "Stable" }, { backendDOMNodeId: 2, role: "button", name: "Old label" }];
    const first = await buildSnapshot(fakeSend({ snapshot: doc.payload(), ax }).send, null);
    expect(first.text).not.toContain("[new]"); // no previous snapshot — nothing is "new"
    // Second pass: same geometry, one renamed button.
    const ax2: AxEntry[] = [{ backendDOMNodeId: 1, role: "button", name: "Stable" }, { backendDOMNodeId: 2, role: "button", name: "Fresh label" }];
    const second = await buildSnapshot(fakeSend({ snapshot: doc.payload(), ax: ax2 }).send, first.index);
    const lines = second.text.split("\n");
    expect(lines.find((l) => l.includes("ref=1"))).not.toContain("[new]");
    expect(lines.find((l) => l.includes("ref=2"))).toContain("[new]");
  });

  it("sweeps cursor:pointer div-soup through getEventListeners and includes only listeners that click", async () => {
    const doc = makeSnapshotDoc();
    const clicky = doc.addNode({ tag: "DIV", backendId: 11 });
    doc.addLayout(clicky, [0, 0, 100, 30], { styles: { cursor: "pointer" } });
    const inert = doc.addNode({ tag: "DIV", backendId: 12 });
    doc.addLayout(inert, [0, 40, 100, 30], { styles: { cursor: "pointer" } });
    const plain = doc.addNode({ tag: "DIV", backendId: 13 });
    doc.addLayout(plain, [0, 80, 100, 30]);
    const { send, calls } = fakeSend({ snapshot: doc.payload(), ax: [], listeners: { 11: ["click"], 12: ["mousemove"] } });
    const snap = await buildSnapshot(send, null);
    expect(snap.text).toContain("ref=11");
    expect(snap.text).not.toContain("ref=12");
    expect(snap.text).not.toContain("ref=13");
    // The sweep actually ran through the DOMDebugger — and only for the pointer-cursor candidates.
    const swept = calls.filter((c) => c.method === "DOM.resolveNode").map((c) => c.params.backendNodeId);
    expect(swept.sort()).toEqual([11, 12]);
  });

  it("caps long values", async () => {
    const doc = makeSnapshotDoc();
    const input = doc.addNode({ tag: "INPUT", attrs: { type: "text" }, backendId: 5, value: "x".repeat(500) });
    doc.addLayout(input, [0, 0, 100, 30]);
    const { send } = fakeSend({ snapshot: doc.payload(), ax: [{ backendDOMNodeId: 5, role: "textField", name: "Notes" }] });
    const snap = await buildSnapshot(send, null);
    expect(snap.text).not.toContain("x".repeat(200));
    expect(snap.text).toContain("…");
  });
});

describe("performAct — coordinates resolved at act time", () => {
  const click = (ref: number): BrowserAction => ({ kind: "click", ref, button: "left", clickCount: 1, modifiers: [] });

  it("clicks at the CURRENT quad center, three events in order (move→press→release)", async () => {
    const { send, calls } = fakeSend({ quads: { 42: [[100, 200, 140, 200, 140, 220, 100, 220]] } });
    const result = await performAct(send, click(42));
    expect(result.ok).toBe(true);
    const mouse = calls.filter((c) => c.method === "Input.dispatchMouseEvent");
    expect(mouse.map((c) => c.params.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(mouse[1]!.params).toMatchObject({ x: 120, y: 210, button: "left", buttons: 1, clickCount: 1 });
    // Quads were fetched on THIS act, before any mouse event went out.
    expect(calls.findIndex((c) => c.method === "DOM.getContentQuads")).toBeLessThan(calls.findIndex((c) => c.method === "Input.dispatchMouseEvent"));
  });

  it("re-resolves quads on EVERY act — a moved element moves the click with it (mutant: cached coordinates)", async () => {
    const quads: Record<number, number[][]> = { 42: [[0, 0, 40, 0, 40, 20, 0, 20]] };
    const { send, calls } = fakeSend({ quads });
    await performAct(send, click(42));
    quads[42] = [[500, 600, 540, 600, 540, 620, 500, 620]]; // layout shifted between acts
    await performAct(send, click(42));
    const presses = calls.filter((c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed");
    expect(presses[0]!.params).toMatchObject({ x: 20, y: 10 });
    expect(presses[1]!.params).toMatchObject({ x: 520, y: 610 });
    expect(calls.filter((c) => c.method === "DOM.getContentQuads")).toHaveLength(2);
  });

  it("an element with no quads fails honestly and tells the agent to re-snapshot", async () => {
    const { send, calls } = fakeSend({ quads: {} });
    const result = await performAct(send, click(42));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("browser_snapshot");
    expect(calls.filter((c) => c.method === "Input.dispatchMouseEvent")).toHaveLength(0);
  });

  it("modifier keys become the CDP bitmask", async () => {
    const { send, calls } = fakeSend({ quads: { 1: [[0, 0, 10, 0, 10, 10, 0, 10]] } });
    await performAct(send, { kind: "click", ref: 1, button: "left", clickCount: 1, modifiers: ["meta", "shift"] });
    const press = calls.find((c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed");
    expect(press!.params.modifiers).toBe(4 + 8);
  });
});

describe("performAct — the password hard block", () => {
  it("refuses to type into an input whose LIVE type is password, sending nothing (mutant: not refused under bypass)", async () => {
    // No permission mode exists at this layer at all — that is the point: the refusal cannot be
    // bypassed by a mode because the executor never consults one.
    const { send, calls } = fakeSend({ describe: { 7: { nodeName: "INPUT", attributes: ["type", "password", "name", "pw"] } } });
    const result = await performAct(send, { kind: "type", ref: 7, text: "hunter2", method: "keys", submit: false });
    expect(result).toEqual({ ok: false, error: "target is a password field", refused: "password" });
    expect(calls.filter((c) => c.method.startsWith("Input."))).toHaveLength(0);
    expect(calls.filter((c) => c.method === "DOM.focus")).toHaveLength(0);
  });

  it("fails CLOSED: a describeNode failure refuses rather than typing blind", async () => {
    const { send, calls } = fakeSend({ describe: { 7: "throw" } });
    const result = await performAct(send, { kind: "type", ref: 7, text: "secret", method: "keys", submit: false });
    expect(!result.ok && result.refused).toBe("password");
    expect(calls.filter((c) => c.method.startsWith("Input."))).toHaveLength(0);
  });

  it("types into an ordinary field with full per-character key events (React-compatible)", async () => {
    const { send, calls } = fakeSend({ describe: { 8: { nodeName: "INPUT", attributes: ["type", "text"] } } });
    const result = await performAct(send, { kind: "type", ref: 8, text: "hi", method: "keys", submit: true });
    expect(result.ok).toBe(true);
    const keys = calls.filter((c) => c.method === "Input.dispatchKeyEvent");
    // h down/up, i down/up, then Enter down/up for submit.
    expect(keys.map((c) => [c.params.type, c.params.key])).toEqual([
      ["keyDown", "h"], ["keyUp", "h"], ["keyDown", "i"], ["keyUp", "i"], ["keyDown", "Enter"], ["keyUp", "Enter"],
    ]);
    expect(calls.some((c) => c.method === "DOM.focus")).toBe(true);
  });

  it("insertText is the documented fallback path", async () => {
    const { send, calls } = fakeSend({ describe: { 8: { nodeName: "TEXTAREA", attributes: [] } } });
    await performAct(send, { kind: "type", ref: 8, text: "a large paste", method: "insertText", submit: false });
    expect(calls.some((c) => c.method === "Input.insertText" && c.params.text === "a large paste")).toBe(true);
    expect(calls.filter((c) => c.method === "Input.dispatchKeyEvent")).toHaveLength(0);
  });
});


/**
 * The credential fill, and the mutants the file header owes:
 *   - the value reaching a result, an error, or a detail string in ANY form;
 *   - the origin gate removed or loosened (a lookalike host filling);
 *   - presence prompted BEFORE the origin was checked, which trains the reflex the gate protects;
 *   - a fill proceeding after a refusal.
 *
 * `reveal` is the store's role, faked here: it records whether it was called at all, which is how a
 * test can see that a refused fill never even reached the presence check.
 */
describe("performFillCredential", () => {
  const SECRET = "correct horse battery staple";

  /** A store stand-in. `presence` false is a cancelled Touch ID; `revealed` records whether the
   *  presence/unseal path was entered, which the origin tests assert stays false. */
  function fakeStore(opts: { presence?: boolean } = {}) {
    const state = { revealed: false, typed: false };
    const reveal = async (type: (v: string) => Promise<void>) => {
      state.revealed = true;
      if (opts.presence === false) return { ok: false as const, refused: "no_presence" as const };
      await type(SECRET);
      state.typed = true;
      return { ok: true as const };
    };
    return { state, reveal };
  }

  const cred = { id: "cred-1", origin: "https://example.com" };

  it("types the value character by character and reports ONLY the origin (mutant: value or length in the detail)", async () => {
    const { send, calls } = fakeSend({ history: { url: "https://example.com/login" } });
    const store = fakeStore();
    const result = await performFillCredential(send, 7, { credential: cred, reveal: store.reveal });

    expect(result).toEqual({ ok: true, detail: "filled saved credential for https://example.com" });
    // The whole point: the secret went into the page and into nothing else.
    expect(store.state.typed).toBe(true);
    const keys = calls.filter((c) => c.method === "Input.dispatchKeyEvent" && c.params.type === "keyDown");
    expect(keys.map((c) => c.params.key).join("")).toBe(SECRET);
    // ...and the RESULT mentions neither the value nor its length.
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(String(SECRET.length));
  });

  it("REFUSES a lookalike origin and never asks for presence (mutant: origin gate removed)", async () => {
    const { send, calls } = fakeSend({ history: { url: "https://examp1e.com/login" } });
    const store = fakeStore();
    const result = await performFillCredential(send, 7, { credential: cred, reveal: store.reveal });

    expect(!result.ok && result.refused).toBe("origin_mismatch");
    expect(store.state.revealed).toBe(false); // no Touch ID prompt on a phishing page
    expect(calls.filter((c) => c.method === "Input.dispatchKeyEvent")).toHaveLength(0);
  });

  it("a SUBDOMAIN is a different site — no registrable-domain leniency (mutant: suffix match)", async () => {
    const { send } = fakeSend({ history: { url: "https://login.example.com/" } });
    const store = fakeStore();
    const result = await performFillCredential(send, 7, { credential: cred, reveal: store.reveal });
    expect(!result.ok && result.refused).toBe("origin_mismatch");
    expect(store.state.revealed).toBe(false);
  });

  it("http is not https, and a port is part of the origin", async () => {
    for (const url of ["http://example.com/", "https://example.com:8443/"]) {
      const { send } = fakeSend({ history: { url } });
      const store = fakeStore();
      const result = await performFillCredential(send, 7, { credential: cred, reveal: store.reveal });
      expect(!result.ok && result.refused, url).toBe("origin_mismatch");
      expect(store.state.revealed).toBe(false);
    }
  });

  it("fails CLOSED when the browser will not report a history (mutant: unknown origin treated as a match)", async () => {
    const { send } = fakeSend({ history: "throw" });
    const store = fakeStore();
    const result = await performFillCredential(send, 7, { credential: cred, reveal: store.reveal });
    expect(!result.ok && result.refused).toBe("origin_mismatch");
    expect(store.state.revealed).toBe(false);
  });

  it("an opaque page (about:blank) has no origin to match and is refused", async () => {
    const { send } = fakeSend({ history: { url: "about:blank" } });
    const store = fakeStore();
    const result = await performFillCredential(send, 7, { credential: cred, reveal: store.reveal });
    expect(!result.ok && result.refused).toBe("origin_mismatch");
  });

  it("a cancelled Touch ID refuses AFTER the origin matched, and types nothing", async () => {
    const { send, calls } = fakeSend({ history: { url: "https://example.com/login" } });
    const store = fakeStore({ presence: false });
    const result = await performFillCredential(send, 7, { credential: cred, reveal: store.reveal });

    expect(!result.ok && result.refused).toBe("no_presence");
    expect(store.state.revealed).toBe(true); // it DID get as far as asking
    expect(store.state.typed).toBe(false);
    expect(calls.filter((c) => c.method === "Input.dispatchKeyEvent")).toHaveLength(0);
  });

  it("a ref that will not focus fails as a stale ref, without burning a presence prompt", async () => {
    const { send } = fakeSend({ history: { url: "https://example.com/login" }, focus: "throw" });
    const store = fakeStore();
    const result = await performFillCredential(send, 7, { credential: cred, reveal: store.reveal });
    expect(result.ok).toBe(false);
    expect(store.state.revealed).toBe(false);
  });

  it("a CDP failure MID-TYPING never surfaces the characters it was dispatching (mutant: error message leak)", async () => {
    // The realistic leak: a CDP error whose message quotes the params it failed on. Nothing about a
    // caught error may reach the result, so the executor replaces it wholesale.
    const send: CdpSend = async (method) => {
      if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{ url: "https://example.com/x" }] };
      if (method === "DOM.focus") return {};
      if (method === "Input.dispatchKeyEvent") throw new Error(`dispatch failed for text "${SECRET}"`);
      return {};
    };
    const store = fakeStore();
    const result = await performFillCredential(send, 7, { credential: cred, reveal: store.reveal });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(!result.ok && result.error).toBe("the saved sign-in could not be typed into that field");
  });

  it("the value never reaches a SNAPSHOT either — the field it was typed into still reports no value", async () => {
    // The end-to-end statement of the header's oldest invariant, from the fill's side: filling a
    // password field does not make its value snapshot-visible.
    const b = makeSnapshotDoc();
    const root = b.addNode({ tag: "BODY" });
    const pw = b.addNode({ tag: "INPUT", parent: root, attrs: { type: "password" }, backendId: 7, value: SECRET });
    b.addLayout(root, [0, 0, 1000, 800]);
    b.addLayout(pw, [10, 10, 200, 30]);
    const { send } = fakeSend({ snapshot: b.payload(), ax: [{ backendDOMNodeId: 7, role: "textField", name: "Password", value: SECRET, protected: true }] });

    const snap = await buildSnapshot(send, null);
    expect(snap.text).not.toContain(SECRET);
    expect(JSON.stringify(snap)).not.toContain(SECRET);
  });

  it("plain browser_act STILL refuses a password field — fill_credential is not an escape hatch for it", async () => {
    // Guards the requirement most easily lost to a refactor: adding a sanctioned route must not have
    // relaxed the unsanctioned one. No mode exists at this layer, so this is the bypassPermissions
    // case too.
    const { send, calls } = fakeSend({ describe: { 7: { nodeName: "INPUT", attributes: ["type", "password"] } } });
    const result = await performAct(send, { kind: "type", ref: 7, text: SECRET, method: "keys", submit: false });
    expect(result).toEqual({ ok: false, error: "target is a password field", refused: "password" });
    expect(calls.filter((c) => c.method.startsWith("Input."))).toHaveLength(0);
  });
});

describe("isOpaqueColor", () => {
  it.each([
    ["rgb(255, 255, 255)", true],
    ["rgba(0, 0, 0, 1)", true],
    ["rgba(0, 0, 0, 0.5)", true], // the classic modal scrim — dims and intercepts clicks
    ["rgba(0, 0, 0, 0.2)", false],
    ["rgba(0, 0, 0, 0)", false],
    ["transparent", false],
    ["", false],
  ])("%s → %s", (color, expected) => {
    expect(isOpaqueColor(color)).toBe(expected);
  });
});

describe("action highlight (W4)", () => {
  it("rings the target via Runtime.evaluate using AT-HIGHLIGHT-TIME quads, tagged and inert", async () => {
    const { send, calls } = fakeSend({ quads: { 42: [[10, 20, 110, 20, 110, 50, 10, 50]] } });
    await showActionHighlight(send, 42);
    const evals = calls.filter((c) => c.method === "Runtime.evaluate");
    expect(evals).toHaveLength(1);
    const expr = String(evals[0]!.params.expression);
    expect(expr).toContain(HIGHLIGHT_ATTR);            // tagged: the snapshot filter keys off this
    expect(expr).toContain("pointer-events:none");     // inert to the click about to land
    expect(expr).toContain("background:transparent");  // see-through to the occlusion check
    expect(expr).toContain("setTimeout");              // self-removes
    expect(expr).toContain("left:7px");                // quad-derived geometry (10 - 3px pad)
    // Quads were read fresh, not taken from any snapshot.
    expect(calls.some((c) => c.method === "DOM.getContentQuads" && c.params.backendNodeId === 42)).toBe(true);
  });

  it("draws NO ring when the ref no longer resolves — the page navigated between permission and act", async () => {
    const throwing = fakeSend({ quads: { 42: "throw" } });
    await showActionHighlight(throwing.send, 42);
    expect(throwing.calls.filter((c) => c.method === "Runtime.evaluate")).toEqual([]);

    const empty = fakeSend({ quads: {} });
    await showActionHighlight(empty.send, 42);
    expect(empty.calls.filter((c) => c.method === "Runtime.evaluate")).toEqual([]);
  });

  it("a failed highlight NEVER throws (the named mutant: highlight failure failing the act)", async () => {
    const base = fakeSend({ quads: { 42: [[10, 20, 110, 20, 110, 50, 10, 50]] } });
    const send: CdpSend = (method, params) => {
      if (method === "Runtime.evaluate") throw new Error("CSP said no");
      return base.send(method, params);
    };
    await expect(showActionHighlight(send, 42)).resolves.toBeUndefined();
  });

  it("highlightTargetRef points at click/type/keyed-key targets and at nothing for scroll", () => {
    expect(highlightTargetRef({ kind: "click", ref: 7, button: "left", clickCount: 1, modifiers: [] })).toBe(7);
    expect(highlightTargetRef({ kind: "type", ref: 8, text: "hi", method: "keys", submit: false })).toBe(8);
    expect(highlightTargetRef({ kind: "key", key: "Enter", ref: 9 })).toBe(9);
    expect(highlightTargetRef({ kind: "key", key: "Enter" })).toBe(null);
    expect(highlightTargetRef({ kind: "scroll", deltaX: 0, deltaY: 100 })).toBe(null);
  });

  it("the ring is INVISIBLE to snapshots — tagged node never listed, even clickable (mutant: agent chases its own ring)", async () => {
    const doc = makeSnapshotDoc();
    const btn = doc.addNode({ tag: "BUTTON", backendId: 42 });
    doc.addLayout(btn, [10, 20, 100, 30]);
    // A ring as CDP would see it mid-fade: clickable-looking, painted last, cursor pointer even.
    const ring = doc.addNode({ tag: "DIV", backendId: 500, attrs: { "data-realm-agent-highlight": "" }, clickable: true });
    doc.addLayout(ring, [7, 17, 106, 36], { paint: 99, styles: { cursor: "pointer" } });
    const { send } = fakeSend({ snapshot: doc.payload(), ax: [{ backendDOMNodeId: 42, role: "button", name: "Submit order" }] });
    const first = await buildSnapshot(send, null);
    expect(first.text).toContain("ref=42");
    expect(first.text).not.toContain("ref=500");
    // And never as [new] on the NEXT snapshot either — it is not in the index at all.
    const second = await buildSnapshot(send, first.index);
    expect(second.text).not.toContain("ref=500");
    expect(second.text).not.toContain("[new]");
  });

  it("buildSnapshot sweeps lingering rings BEFORE capturing — the removal precedes the DOMSnapshot", async () => {
    const doc = makeSnapshotDoc();
    const btn = doc.addNode({ tag: "BUTTON", backendId: 42 });
    doc.addLayout(btn, [10, 20, 100, 30]);
    const { send, calls } = fakeSend({ snapshot: doc.payload(), ax: [{ backendDOMNodeId: 42, role: "button", name: "Go" }] });
    await buildSnapshot(send, null);
    const sweep = calls.findIndex((c) => c.method === "Runtime.evaluate" && String(c.params.expression).includes(HIGHLIGHT_ATTR));
    const capture = calls.findIndex((c) => c.method === "DOMSnapshot.captureSnapshot");
    expect(sweep).toBeGreaterThanOrEqual(0);
    expect(sweep).toBeLessThan(capture);
  });

  it("a page that refuses the sweep still snapshots", async () => {
    const doc = makeSnapshotDoc();
    const btn = doc.addNode({ tag: "BUTTON", backendId: 42 });
    doc.addLayout(btn, [10, 20, 100, 30]);
    const base = fakeSend({ snapshot: doc.payload(), ax: [{ backendDOMNodeId: 42, role: "button", name: "Go" }] });
    const send: CdpSend = (method, params) => {
      if (method === "Runtime.evaluate") return Promise.reject(new Error("no eval for you"));
      return base.send(method, params);
    };
    const snap = await buildSnapshot(send, null);
    expect(snap.text).toContain("ref=42");
  });
});
