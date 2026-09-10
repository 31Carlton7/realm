import { describe, expect, it } from "vitest";
import { PICK_HTML_MAX, PICK_TEXT_MAX } from "@realm/contracts";
import { BrowserAgentHost, type CdpBinding } from "./browser-agent-host";
import { createBridgeCore } from "./browser-agent-bridge";

const SECRET = "correct horse battery staple";

/** A fake pane: one live view ("b1") whose CDP send is programmable, plus event injection. */
function setup(opts: {
  responses?: Record<string, unknown>;
  attachFails?: boolean;
  /** Omitted = no secret store at all (safeStorage unavailable, or the app still starting). */
  credentials?: { id: string; origin: string; username: string; label: string; createdAt: number }[];
  presence?: boolean;
  /** Plan 23: a stand-in governor. Omitted = no download support, which must refuse rather than
   *  fall back to writing files. */
  downloads?: boolean;
} = {}) {
  let emit: ((method: string, params: unknown) => void) | null = null;
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const audit: { ts: number; origin: string; credentialId: string; outcome: string }[] = [];
  const grants: { browserId: string; origin: string; dir: string; expiresAt: number }[] = [];
  const liveViews = new Set(["b1"]);
  const touched: string[] = [];
  const binding: CdpBinding = {
    send: async (method, params) => {
      calls.push({ method, params });
      if (method === "DOMSnapshot.captureSnapshot") return opts.responses?.[method] ?? { documents: [], strings: [] };
      if (method === "Runtime.evaluate") return { result: { value: "page text here" } };
      if (method === "Page.captureScreenshot") return { data: "c2NyZWVu" };
      if (method === "Page.getNavigationHistory") return opts.responses?.[method] ?? { currentIndex: 0, entries: [{ url: "https://example.com/x" }] };
      if (method === "DOM.getContentQuads") return opts.responses?.[method] ?? { quads: [[10, 10, 30, 10, 30, 20, 10, 20]] };
      return opts.responses?.[method] ?? {};
    },
    onEvent: (cb) => { emit = cb; },
  };
  const host = new BrowserAgentHost({
    attach: (id) => (opts.attachFails || !liveViews.has(id) ? null : binding),
    hasView: (id) => liveViews.has(id),
    touch: (id) => { touched.push(id); },
    navigate: (id, url) => (liveViews.has(id) && url.startsWith("https://allowed.") ? url : null),
    pageState: (id) => (liveViews.has(id) ? { url: "https://example.com/x", title: "Example" } : null),
    secrets: opts.credentials === undefined ? undefined : {
      listCredentials: () => [...opts.credentials!],
      getCredential: (id) => opts.credentials!.find((c) => c.id === id) ?? null,
      withCredentialValue: async (id, use) => {
        if (!opts.credentials!.some((c) => c.id === id)) return { ok: false, refused: "no_credential" };
        if (opts.presence === false) return { ok: false, refused: "no_presence" };
        await use(SECRET);
        return { ok: true };
      },
      audit: (entry) => { audit.push(entry); },
    },
    downloads: opts.downloads === true ? {
      run: async (browserId, g, click) => {
        grants.push({ browserId, ...g });
        const clicked = await click();
        return clicked.ok
          ? { ok: true, name: "week-3.pdf", bytes: 2048, relPath: "downloads/week-3.pdf" }
          : { ok: false, error: clicked.error ?? "click failed" };
      },
    } : undefined,
  });
  return { host, calls, liveViews, audit, grants, touched, emitEvent: (method: string, params: unknown) => emit?.(method, params) };
}

describe("BrowserAgentHost", () => {
  it("an op against a browser whose pane is not open fails with the tell-the-user message", async () => {
    const { host } = setup();
    await expect(host.handleOp("snapshot", { browserId: "nope" })).rejects.toThrow(/pane is not open in the app/);
  });

  it("describe reports open:false (not an error) for a missing view — browser_list needs the distinction", async () => {
    const { host } = setup();
    expect(await host.handleOp("describe", { browserId: "nope" })).toEqual({ open: false, url: "", title: "", element: null });
  });

  it("describe returns the webContents' own url/title — trustworthy identity for permission prompts", async () => {
    const { host } = setup();
    expect(await host.handleOp("describe", { browserId: "b1" })).toEqual({ open: true, url: "https://example.com/x", title: "Example", element: null });
  });

  it("navigate goes through the pane host's allowlist path and reports refusal as url:null", async () => {
    const { host } = setup();
    expect(await host.handleOp("navigate", { browserId: "b1", url: "https://allowed.example/" })).toEqual({ url: "https://allowed.example/" });
    expect(await host.handleOp("navigate", { browserId: "b1", url: "https://blocked.example/" })).toEqual({ url: null });
  });

  it("keeps the snapshot fingerprint index per browser, so the SECOND snapshot can mark [new]", async () => {
    const strings = ["BUTTON", "", "https://x/", "T", "b"];
    const snapshot = {
      documents: [{ documentURL: 2, title: 3, nodes: { parentIndex: [-1], nodeType: [1], nodeName: [0], nodeValue: [1], backendNodeId: [42], attributes: [[]], isClickable: { index: [0] } }, layout: { nodeIndex: [0], bounds: [[0, 0, 10, 10]], styles: [[1, 1, 1, 1, 1]], paintOrders: [1] } }],
      strings,
    };
    const { host } = setup({ responses: { "DOMSnapshot.captureSnapshot": snapshot, "Accessibility.getFullAXTree": { nodes: [] } } });
    const first = (await host.handleOp("snapshot", { browserId: "b1" })) as { text: string };
    expect(first.text).not.toContain("[new]");
    strings[4] = "renamed"; // nothing changed structurally; fingerprint stays → still not new
    const second = (await host.handleOp("snapshot", { browserId: "b1" })) as { text: string };
    expect(second.text).not.toContain("[new]");
  });

  it("buffers console and network CDP events and serves them through read", async () => {
    const { host, emitEvent } = setup();
    await host.handleOp("read", { browserId: "b1", kind: "text" }); // attaches + enables
    emitEvent("Runtime.consoleAPICalled", { type: "error", args: [{ value: "boom" }, { description: "obj" }] });
    emitEvent("Network.requestWillBeSent", { requestId: "r1", request: { method: "GET", url: "https://api.example/v1" } });
    emitEvent("Network.responseReceived", { requestId: "r1", response: { status: 500, mimeType: "application/json" } });
    emitEvent("Network.requestWillBeSent", { requestId: "r2", request: { method: "POST", url: "https://api.example/save" } });
    emitEvent("Network.loadingFailed", { requestId: "r2", errorText: "net::ERR_FAILED" });
    const consoleOut = (await host.handleOp("read", { browserId: "b1", kind: "console" })) as { text: string };
    expect(consoleOut.text).toContain("[error] boom obj");
    const netOut = (await host.handleOp("read", { browserId: "b1", kind: "network" })) as { text: string };
    expect(netOut.text).toContain("500 GET https://api.example/v1 (application/json)");
    expect(netOut.text).toContain("FAIL POST https://api.example/save — net::ERR_FAILED");
  });

  it("read text is the article-first page text", async () => {
    const { host } = setup();
    expect(await host.handleOp("read", { browserId: "b1", kind: "text" })).toEqual({ text: "page text here" });
  });

  it("screenshot returns jpeg data", async () => {
    const { host } = setup();
    expect(await host.handleOp("screenshot", { browserId: "b1" })).toEqual({ data: "c2NyZWVu", mimeType: "image/jpeg" });
  });

  it("a blocked download lands in the console buffer", async () => {
    const { host } = setup();
    await host.handleOp("read", { browserId: "b1", kind: "text" }); // attach
    host.noteBlockedDownload("b1", "https://evil.example/payload.dmg");
    const out = (await host.handleOp("read", { browserId: "b1", kind: "console" })) as { text: string };
    expect(out.text).toContain("download blocked");
    expect(out.text).toContain("payload.dmg");
  });

  it("release drops buffers and snapshot state with the view", async () => {
    const { host, emitEvent } = setup();
    await host.handleOp("read", { browserId: "b1", kind: "text" });
    emitEvent("Runtime.consoleAPICalled", { type: "log", args: [{ value: "before" }] });
    host.release("b1");
    const out = (await host.handleOp("read", { browserId: "b1", kind: "console" })) as { text: string };
    expect(out.text).not.toContain("before");
  });

  it("a dead view mid-session re-fails honestly instead of using the stale binding", async () => {
    const { host, liveViews } = setup();
    await host.handleOp("read", { browserId: "b1", kind: "text" });
    liveViews.delete("b1");
    await expect(host.handleOp("snapshot", { browserId: "b1" })).rejects.toThrow(/pane is not open/);
  });

  it("unknown ops are refused by name", async () => {
    const { host } = setup();
    await expect(host.handleOp("format-disk", { browserId: "b1" })).rejects.toThrow(/unknown browser host op/);
  });
});

describe("createBridgeCore", () => {
  it("registers on open, answers ops with results, and reports thrown failures", async () => {
    const sent: { id: string; method: string; params: Record<string, unknown> }[] = [];
    const core = createBridgeCore(
      async (op) => { if (op === "boom") throw new Error("no view"); return { got: op }; },
      (json) => sent.push(JSON.parse(json)),
    );
    core.onOpen();
    expect(sent[0]).toMatchObject({ method: "browserHost.register", params: {} });
    await core.onMessage(JSON.stringify({ event: "browserHost.op", payload: { callId: "c1", op: "snapshot", params: {} } }));
    expect(sent[1]).toMatchObject({ method: "browserHost.result", params: { callId: "c1", ok: true, result: { got: "snapshot" } } });
    await core.onMessage(JSON.stringify({ event: "browserHost.op", payload: { callId: "c2", op: "boom", params: {} } }));
    expect(sent[2]).toMatchObject({ method: "browserHost.result", params: { callId: "c2", ok: false, error: "no view" } });
  });

  it("ignores RPC responses, other events, and garbage without replying", async () => {
    const sent: string[] = [];
    const core = createBridgeCore(async () => ({}), (json) => sent.push(json));
    await core.onMessage(JSON.stringify({ id: "1", ok: true, result: {} }));
    await core.onMessage(JSON.stringify({ event: "items.changed", payload: {} }));
    await core.onMessage("not json at all");
    expect(sent).toEqual([]);
  });
});

describe("act mark wiring (W4; the cursor and the frame, Plan 25 W2)", () => {
  const markEvals = (calls: { method: string; params?: Record<string, unknown> }[]): string[] =>
    calls.filter((c) => c.method === "Runtime.evaluate" && String(c.params?.expression).includes("data-realm-agent-highlight"))
      .map((c) => String(c.params?.expression));

  it("a permitted click is marked BEFORE the input dispatches — and the mark rides its own fresh quads", async () => {
    const { host, calls } = setup({ responses: { "DOM.getContentQuads": { quads: [[10, 20, 110, 20, 110, 50, 10, 50]] } } });
    const result = await host.handleOp("act", { browserId: "b1", action: { kind: "click", ref: 42, button: "left", clickCount: 1, modifiers: [] } });
    expect(result).toMatchObject({ ok: true });
    const markEval = calls.findIndex((c) => c.method === "Runtime.evaluate" && String(c.params?.expression).includes("data-realm-agent-highlight"));
    const firstInput = calls.findIndex((c) => c.method === "Input.dispatchMouseEvent");
    expect(markEval).toBeGreaterThanOrEqual(0);
    expect(firstInput).toBeGreaterThan(markEval);
  });

  /* A scroll had no mark at all before Plan 25: no ring, because there is no element to outline, and
     no cursor, because there was none. It is the one act the cursor exists for. */
  it("a scroll gets the cursor and the frame even though it has nothing to ring", async () => {
    const { host, calls } = setup();
    await host.handleOp("act", { browserId: "b1", action: { kind: "scroll", deltaX: 0, deltaY: 100 } });
    const [expr] = markEvals(calls);
    expect(expr).toBeDefined();
    expect(expr).toContain('var ringCss = "";');
    // The fake reports no layout metrics, so this is `viewportCentre`'s 800x600 fallback — the same
    // one `performAct` wheels at, which is the whole reason the two share it.
    expect(expr).toContain('"x":400');
    expect(expr).toContain('"y":300');
  });

  it("paints in the accent the renderer pushed, and in Realm's blue until one arrives", async () => {
    const first = setup();
    await first.host.handleOp("act", { browserId: "b1", action: { kind: "scroll", deltaX: 0, deltaY: 100 } });
    expect(markEvals(first.calls)[0]).toContain("rgb(76, 141, 255)");

    const themed = setup();
    themed.host.setAccent("oklch(0.7 0.2 140)");
    await themed.host.handleOp("act", { browserId: "b1", action: { kind: "scroll", deltaX: 0, deltaY: 100 } });
    const expr = markEvals(themed.calls)[0]!;
    expect(expr).toContain("oklch(0.7 0.2 140)");
    expect(expr).not.toContain("rgb(76, 141, 255)");

    // An empty push is not a colour, and must not blank the one the marks are drawn in.
    themed.host.setAccent("");
    await themed.host.handleOp("act", { browserId: "b1", action: { kind: "scroll", deltaX: 0, deltaY: 100 } });
    expect(markEvals(themed.calls)[1]).toContain("oklch(0.7 0.2 140)");
  });

  it("a download is marked like the click it is", async () => {
    const { host, calls } = setup({ downloads: true });
    await host.handleOp("download", { browserId: "b1", ref: 42, dir: "/tmp/downloads" });
    const [expr] = markEvals(calls);
    expect(expr).toBeDefined();
    expect(expr).toContain("ring");     // a download is a click that happens to produce a file
    expect(expr).toContain('"x":20');   // …so it is marked at the click's own point
  });
});

/**
 * The fill op at the host layer: the audit trail, and the degradation when there is no store.
 * The origin gate itself is the executor's (browser-agent.test.ts); what must die HERE is an outcome
 * that goes unlogged, and a log line that carries anything it shouldn't.
 */
describe("BrowserAgentHost — fillCredential", () => {
  const cred = { id: "cred-1", origin: "https://example.com", username: "ada", label: "Work", createdAt: 1 };

  it("fills on a matching origin and logs exactly timestamp/origin/credentialId/outcome", async () => {
    const { host, calls, audit } = setup({ credentials: [cred] });
    const result = await host.handleOp("fillCredential", { browserId: "b1", ref: 7, credentialId: "cred-1" });

    expect(result).toEqual({ ok: true, detail: "filled saved credential for https://example.com" });
    expect(audit).toHaveLength(1);
    expect(Object.keys(audit[0]!).sort()).toEqual(["credentialId", "origin", "outcome", "ts"]);
    expect(audit[0]).toMatchObject({ origin: "https://example.com", credentialId: "cred-1", outcome: "filled" });
    expect(JSON.stringify(audit)).not.toContain(SECRET);
    // The value went into key events and nowhere else.
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(calls.filter((c) => c.method === "Input.dispatchKeyEvent").length).toBe(SECRET.length * 2);
  });

  it("draws NO mark at all, unlike act — no ring, no cursor, no frame, in the one op that does the least in the page", async () => {
    const { host, calls } = setup({ credentials: [cred] });
    await host.handleOp("fillCredential", { browserId: "b1", ref: 7, credentialId: "cred-1" });
    expect(calls.some((c) => c.method === "Runtime.evaluate")).toBe(false);
  });

  it("an origin mismatch refuses, logs the refusal, and types nothing", async () => {
    const { host, calls, audit } = setup({
      credentials: [cred],
      responses: { "Page.getNavigationHistory": { currentIndex: 0, entries: [{ url: "https://examp1e.com/x" }] } },
    });
    const result = await host.handleOp("fillCredential", { browserId: "b1", ref: 7, credentialId: "cred-1" }) as { ok: boolean; refused?: string };

    expect(result.ok).toBe(false);
    expect(result.refused).toBe("origin_mismatch");
    expect(audit[0]).toMatchObject({ outcome: "origin_mismatch", credentialId: "cred-1" });
    expect(calls.some((c) => c.method === "Input.dispatchKeyEvent")).toBe(false);
  });

  it("a cancelled Touch ID is logged as no_presence", async () => {
    const { host, audit } = setup({ credentials: [cred], presence: false });
    const result = await host.handleOp("fillCredential", { browserId: "b1", ref: 7, credentialId: "cred-1" }) as { ok: boolean; refused?: string };
    expect(result.refused).toBe("no_presence");
    expect(audit[0]).toMatchObject({ outcome: "no_presence" });
  });

  it("an unknown id refuses BEFORE touching CDP, and is still logged", async () => {
    const { host, calls, audit } = setup({ credentials: [cred] });
    const result = await host.handleOp("fillCredential", { browserId: "b1", ref: 7, credentialId: "ghost" }) as { ok: boolean; refused?: string };

    expect(result.refused).toBe("no_credential");
    expect(audit[0]).toMatchObject({ outcome: "no_credential", credentialId: "ghost" });
    expect(calls.some((c) => c.method === "Page.getNavigationHistory")).toBe(false);
  });

  it("with NO store (safeStorage unavailable) it behaves as if nothing is enrolled — never as a fallback", async () => {
    const { host } = setup();
    expect(await host.handleOp("credentials", {})).toEqual({ credentials: [] });
    const result = await host.handleOp("fillCredential", { browserId: "b1", ref: 7, credentialId: "cred-1" }) as { ok: boolean; refused?: string };
    expect(result.refused).toBe("no_credential");
  });

  it("the credentials op returns metadata only — there is no value field to strip", async () => {
    const { host } = setup({ credentials: [cred] });
    const r = await host.handleOp("credentials", {}) as { credentials: Record<string, unknown>[] };
    expect(Object.keys(r.credentials[0]!).sort()).toEqual(["createdAt", "id", "label", "origin", "username"]);
  });
});

/**
 * The download op at the host layer. The gate itself is the governor's (downloads.test.ts); what must
 * die HERE is a grant pinned to the wrong origin, a directory the host invented, and a build with no
 * governor quietly writing files anyway.
 */
describe("BrowserAgentHost — download", () => {
  it("pins the grant to the pane's LIVE origin and the server-supplied directory", async () => {
    const { host, grants } = setup({ downloads: true });
    const r = await host.handleOp("download", { browserId: "b1", ref: 11, dir: "/Users/x/notes/downloads" });

    expect(r).toEqual({ ok: true, name: "week-3.pdf", bytes: 2048, relPath: "downloads/week-3.pdf" });
    // pageState is https://example.com/x — the same trustworthy source `describe` reports, never page text.
    expect(grants[0]).toMatchObject({ browserId: "b1", origin: "https://example.com", dir: "/Users/x/notes/downloads" });
    expect(grants[0]!.expiresAt).toBeGreaterThan(Date.now());
  });

  it("clicks through the ordinary act path, so a download is a click that produces a file", async () => {
    const { host, calls } = setup({ downloads: true });
    await host.handleOp("download", { browserId: "b1", ref: 11, dir: "/tmp/d" });
    expect(calls.some((c) => c.method === "DOM.getContentQuads")).toBe(true);
    expect(calls.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(true);
  });

  it("refuses a RELATIVE directory — this op writes to disk and a cwd-relative path is not a location", async () => {
    const { host, grants } = setup({ downloads: true });
    const r = await host.handleOp("download", { browserId: "b1", ref: 11, dir: "downloads" }) as { ok: boolean };
    expect(r.ok).toBe(false);
    expect(grants).toHaveLength(0);
  });

  it("with NO governor it refuses — never a fallback that writes files anyway", async () => {
    const { host } = setup();
    const r = await host.handleOp("download", { browserId: "b1", ref: 11, dir: "/tmp/d" }) as { ok: boolean };
    expect(r.ok).toBe(false);
  });

  it("a pane with no page identity refuses BEFORE touching CDP — the origin guard runs first", async () => {
    const { host, calls, grants } = setup({ downloads: true });
    const r = await host.handleOp("download", { browserId: "gone", ref: 11, dir: "/tmp/d" }) as { ok: boolean; refused?: string };

    expect(r.ok).toBe(false);
    expect(r.refused).toBe("origin_mismatch");
    // Deliberate ordering: no grant is minted and the debugger is never attached, so a pane Realm
    // cannot identify never gets as far as a click.
    expect(grants).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

/**
 * The USER's element picker. Every test here is about the promise's lifetime rather than the payload:
 * `pickElement` is the one browser call that stays pending until a person acts, and every way it can
 * fail to settle leaves the pane's toolbar button lit over a view that is still eating clicks.
 */
const PICKED = {
  // The stamped-attribute bridge: Realm's own overlay marks the element the user clicked, and the
  // host turns that mark into the backendNodeId everything downstream speaks in.
  "DOM.getDocument": { root: { nodeId: 1 } },
  "DOM.querySelector": { nodeId: 5 },
  "DOM.describeNode": { node: { backendNodeId: 42, nodeName: "BUTTON", attributes: ["id", "submit", "class", "btn"] } },
  "Accessibility.getPartialAXTree": { nodes: [{ role: { value: "button" }, name: { value: "Sign in" } }] },
  "DOM.resolveNode": { object: { objectId: "obj-1" } },
  "Runtime.callFunctionOn": {
    result: { value: { selector: "#submit", text: "Sign in", html: '<button id="submit">Sign in</button>', rect: { x: 4, y: 8, w: 90, h: 32 } } },
  },
};
/** The picker is Realm's own injected overlay now, not Chrome's inspector — so what is asserted is
 *  the binding it hands the pick back through and the evaluate that takes the overlay down. */
const pickCalls = (calls: { method: string; params?: Record<string, unknown> }[]) =>
  calls.filter((c) => c.method === "Runtime.addBinding" || c.method === "Runtime.removeBinding"
    || (c.method === "Runtime.evaluate" && String(c.params?.expression ?? "").includes("__realmPicker")))
    // Told apart by `addEventListener`, which only the arming script has. Matching on `.stop()`
    // does not work: the arming script defines and calls that too.
    .map((c) => (c.method === "Runtime.evaluate"
      ? (String(c.params?.expression ?? "").includes("addEventListener") ? "picker.arm" : "picker.stop")
      : c.method));

/** The page calling back through the binding: a non-empty payload is a pick, "" is Escape. */
const emitPick = (emitEvent: (m: string, p: unknown) => void, payload = "1") =>
  emitEvent("Runtime.bindingCalled", { name: "__realmPickDone", payload });

describe("BrowserAgentHost — element picking", () => {
  it("resolves with the element the user clicked, named by AX and located by a url the page cannot author", async () => {
    const { host, emitEvent } = setup({ responses: PICKED });
    const pending = host.pickElement("b1");
    emitPick(emitEvent);
    expect(await pending).toEqual({
      ref: 42, url: "https://example.com/x", title: "Example",
      tag: "button", role: "button", name: "Sign in",
      selector: "#submit", text: "Sign in", html: '<button id="submit">Sign in</button>',
      rect: { x: 4, y: 8, w: 90, h: 32 },
    });
  });

  it("arms Realm's own overlay and takes it down after the pick", async () => {
    /* It used to arm `Overlay.setInspectMode` — Chrome's DevTools inspector, which looks exactly
       like what it is. The overlay is injected now, so what has to hold is that the binding it
       reports through is added, the picker is installed, and BOTH are undone afterwards: a page
       left with a live mousemove listener keeps drawing a box over a pane nobody is picking in. */
    const { host, calls, emitEvent } = setup({ responses: PICKED });
    const pending = host.pickElement("b1");
    emitPick(emitEvent);
    await pending;
    expect(pickCalls(calls)).toEqual([
      "Runtime.addBinding", "picker.arm", "picker.stop", "Runtime.removeBinding",
    ]);
  });

  /* Two accent overlays chasing one pointer is the failure. The agent's cursor and the picker's box
     are the same colour and follow the same hand, so arming the picker takes the agent's marks down
     first — and the mutant is deleting that line, which leaves a user aiming at a page with a second
     accent mark on it that answers to nobody. */
  it("takes the agent's own cursor and frame down before arming the user's picker", async () => {
    const { host, calls, emitEvent } = setup({ responses: PICKED });
    const pending = host.pickElement("b1");
    emitPick(emitEvent);
    await pending;
    const evals = calls.filter((c) => c.method === "Runtime.evaluate").map((c) => String(c.params?.expression ?? ""));
    const removal = evals.findIndex((e) => e.includes("data-realm-agent-highlight") && !e.includes("__realmPicker"));
    const arm = evals.findIndex((e) => e.includes("__realmPicker") && e.includes("addEventListener"));
    expect(removal).toBeGreaterThanOrEqual(0);
    expect(removal).toBeLessThan(arm);
    // Rings are NOT swept here: one is already fading on its own 900ms timer, and taking it would
    // erase the record of the act the user is standing over.
    expect(evals[removal]).toContain("cursor");
    expect(evals[removal]).toContain("frame");
    expect(evals[removal]).not.toContain('="ring"');
  });

  it("cancelPick settles the armed pick empty and takes the overlay down", async () => {
    const { host, calls, emitEvent } = setup({ responses: PICKED });
    const pending = host.pickElement("b1");
    host.cancelPick("b1");
    expect(await pending).toBeNull();
    expect(pickCalls(calls)).toContain("picker.stop");
    // And the view is no longer picking. A late event must settle nothing and disarm nothing —
    // resolving an already-settled promise is silent, so the CDP traffic is what can be read.
    const after = calls.length;
    emitPick(emitEvent);
    expect(calls.length).toBe(after);
  });

  it("a main-frame navigation settles the pick empty — it resets the overlay agent and the picker is dead", async () => {
    const { host, emitEvent } = setup({ responses: PICKED });
    const pending = host.pickElement("b1");
    emitEvent("Page.frameNavigated", { frame: { id: "f1", url: "https://example.com/next" } });
    expect(await pending).toBeNull();
  });

  it("a SUBFRAME navigation leaves the pick armed — an ad iframe reloading is not the user's page changing", async () => {
    const { host, emitEvent } = setup({ responses: PICKED });
    const pending = host.pickElement("b1");
    emitEvent("Page.frameNavigated", { frame: { id: "f2", parentId: "f1", url: "https://ads.example/x" } });
    emitPick(emitEvent);
    // 42 rather than a number the event carried: the ref comes from resolving the STAMPED element
    // now, so it is the fixture's `DOM.describeNode`. What this test is about is that the pick was
    // still armed to be settled at all.
    expect((await pending)?.ref).toBe(42);
  });

  it("closing the pane settles the armed pick instead of leaving the toolbar button lit forever", async () => {
    const { host } = setup({ responses: PICKED });
    const pending = host.pickElement("b1");
    host.release("b1");
    expect(await pending).toBeNull();
  });

  it("re-arming settles the previous pick, so a double press leaves exactly one live promise", async () => {
    const { host, emitEvent } = setup({ responses: PICKED });
    const first = host.pickElement("b1");
    const second = host.pickElement("b1");
    expect(await first).toBeNull();
    emitPick(emitEvent);
    expect((await second)?.ref).toBe(42);
  });

  it("a superseded pick does not disarm on its way out — it would switch off the picker just re-armed", async () => {
    const { host, calls, emitEvent } = setup({ responses: PICKED });
    const first = host.pickElement("b1");
    const second = host.pickElement("b1");
    await first;
    expect(pickCalls(calls)).not.toContain("picker.stop");
    expect(pickCalls(calls)).not.toContain("Overlay.disable");
    emitPick(emitEvent);
    await second;
  });

  it("a pick on a pane that is not open answers null rather than throwing at the toolbar", async () => {
    const { host } = setup();
    expect(await host.pickElement("nope")).toBeNull();
  });

  it("an element whose page-side read fails is still picked — the AX identity alone is a usable chip", async () => {
    const { host, emitEvent } = setup({ responses: { ...PICKED, "DOM.resolveNode": {} } });
    const pending = host.pickElement("b1");
    emitPick(emitEvent);
    expect(await pending).toMatchObject({ ref: 42, role: "button", name: "Sign in", selector: "", html: "" });
  });

  it("clips the page-authored markup — a picked element is headed for a prompt, not a document", async () => {
    const html = `<div>${"x".repeat(5000)}</div>`;
    const { host, emitEvent } = setup({
      responses: { ...PICKED, "Runtime.callFunctionOn": { result: { value: { selector: "#a", text: "y".repeat(900), html, rect: { x: 0, y: 0, w: 1, h: 1 } } } } },
    });
    const pending = host.pickElement("b1");
    emitPick(emitEvent);
    const picked = (await pending)!;
    expect(picked.html).toHaveLength(PICK_HTML_MAX);
    expect(picked.text).toHaveLength(PICK_TEXT_MAX);
    expect(picked.html.endsWith("…")).toBe(true);
  });
});

/**
 * A browser whose space is off screen is retained, not closed — so the agent must still reach it,
 * and reaching it must be what keeps it retained rather than what gets it evicted.
 */
describe("driving a browser whose pane is off screen", () => {
  it("every op marks the view in use, not just the one that attached", async () => {
    const h = setup();
    await h.host.handleOp("read", { browserId: "b1", kind: "text" });
    await h.host.handleOp("read", { browserId: "b1", kind: "text" });
    await h.host.handleOp("snapshot", { browserId: "b1" });
    expect(h.touched).toEqual(["b1", "b1", "b1"]);
  });

  it("a view that is gone for real is still refused, and not marked in use", async () => {
    const h = setup();
    h.liveViews.delete("b1");
    await expect(h.host.handleOp("read", { browserId: "b1", kind: "text" })).rejects.toThrow(/pane is not open/);
    expect(h.touched).toEqual([]);
  });
});
