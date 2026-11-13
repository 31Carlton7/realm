import { describe, expect, it, vi } from "vitest";
import type { PasswordSaveOffer, SiteCredential } from "@realm/contracts";
import {
  AUTOFILL_BINDING, AUTOFILL_WORLD, FILL_CODE_ID, MANAGE_PASSWORDS_ID, PasswordAutofill, SAVE_CAPTURE_WINDOW_MS,
  autofillMenuItems, autofillScriptSource, parseAutofillMessage, type AutofillDeps,
} from "./password-autofill";
import { CODE_FIELD_JS } from "./browser-agent";

/**
 * The mutants:
 *   - a report from the page's own world, a frame, or another origin opening a menu (or a fill);
 *   - a fill typed after the page moved to another site between the menu and the pick;
 *   - the password reached for when only a username field was picked;
 *   - a save offer carrying the password to the renderer, or made with no sign the sign-in went through;
 *   - an answer from a window that does not hold the pane acting on its offer.
 */

const SECRET = "correct horse battery staple";
const flush = () => new Promise((r) => setTimeout(r, 0));

function credential(over: Partial<SiteCredential> = {}): SiteCredential {
  return { id: "c1", origin: "https://example.com", username: "ada", label: "", createdAt: 0, generated: false, match: "exact", agentAllowed: false, ...over };
}

function harness(over: Partial<AutofillDeps> & { rows?: SiteCredential[]; choice?: string | null; url?: string } = {}) {
  const sent: { method: string; params?: Record<string, unknown> }[] = [];
  let emit: (method: string, params: unknown) => void = () => {};
  const page = { url: over.url ?? "https://example.com/login", history: "https://example.com/login" };
  const cdp = {
    send: async (method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params });
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", securityOrigin: new URL(page.history).origin } } };
      if (method === "DOM.getDocument") return { root: { backendNodeId: 1, children: [{ backendNodeId: 41 }, { backendNodeId: 42 }] } };
      if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{ url: page.history }] };
      if (method === "Runtime.evaluate") {
        const which = String(params?.expression).includes('"pass"') ? "pass" : "user";
        return { result: { type: "object", objectId: `obj-${which}` } };
      }
      if (method === "DOM.describeNode") return { node: { backendNodeId: params?.objectId === "obj-pass" ? 42 : 41 } };
      return {};
    },
    onEvent: (cb: (method: string, params: unknown) => void) => { emit = cb; },
  };
  const calls = { filled: [] as [string, number][], menus: [] as unknown[], values: [] as string[], offers: [] as PasswordSaveOffer[], withdrawn: [] as string[], saved: [] as unknown[], never: [] as string[], settings: 0, audit: [] as unknown[] };
  let clock = 1_000;
  let ids = 0;
  const deps: AutofillDeps = {
    pageUrl: () => page.url,
    credentialsFor: async () => over.rows ?? [credential()],
    popupMenu: async (_p, items) => { calls.menus.push(items); return over.choice === undefined ? "c1" : over.choice; },
    withValue: async (_p, id, use) => { calls.values.push(id); await use(SECRET); return { ok: true }; },
    saveOfferFor: () => ({ kind: "save" }),
    saveOffered: (_p, input) => { calls.saved.push(input); },
    neverSave: (_p, origin) => { calls.never.push(origin); },
    offer: (o) => { calls.offers.push(o); },
    withdraw: (_b, id) => { calls.withdrawn.push(id); },
    openSettings: () => { calls.settings++; },
    audit: (e) => { calls.audit.push(e); },
    passwordFilled: (paneId, ref) => { calls.filled.push([paneId, ref]); },
    now: () => clock,
    newId: () => `offer-${++ids}`,
    ...over,
  };
  const autofill = new PasswordAutofill(deps);
  /** Realm's world in a frame (which, as in Electron, reports no origin of its own), beside the frame's
   *  page context, which carries the origin the browser committed. */
  const context = (id: number, over2: { name?: string; origin?: string; frameId?: string } = {}) => {
    const frameId = over2.frameId ?? "main";
    emit("Runtime.executionContextCreated", { context: { id: 1000 + id, origin: over2.origin ?? "https://example.com", name: "", auxData: { frameId, isDefault: true } } });
    emit("Runtime.executionContextCreated", { context: { id, origin: "", name: over2.name ?? AUTOFILL_WORLD, auxData: { frameId, isDefault: false } } });
  };
  const report = (contextId: number, payload: unknown) =>
    emit("Runtime.bindingCalled", { name: AUTOFILL_BINDING, payload: JSON.stringify(payload), executionContextId: contextId });
  const field = (over3: Record<string, unknown> = {}) => ({ t: "field", id: 1, how: "click", hasUser: true, hasPass: true, rect: { x: 10, y: 20, w: 200, h: 30 }, ...over3 });
  const typed = () => sent.filter((c) => c.method === "Input.dispatchKeyEvent" && c.params?.type === "keyDown").map((c) => c.params?.text).join("");
  return { autofill, cdp, sent, calls, page, context, report, field, typed, emit: (m: string, p: unknown) => emit(m, p), tick: (ms: number) => { clock += ms; } };
}

describe("installing", () => {
  it("exposes its binding to Realm's isolated world only, and runs its script there", async () => {
    const h = harness();
    await h.autofill.install("b1", h.cdp);
    expect(h.sent.find((c) => c.method === "Runtime.addBinding")?.params).toEqual({ name: AUTOFILL_BINDING, executionContextName: AUTOFILL_WORLD });
    const script = h.sent.find((c) => c.method === "Page.addScriptToEvaluateOnNewDocument")?.params;
    expect(script?.worldName).toBe(AUTOFILL_WORLD);
    expect(String(script?.source)).toContain("window.top !== window");
    expect(String(script?.source)).toContain("isTrusted");
  });
});

describe("the menu", () => {
  it("opens for a report from Realm's world in the top frame, and fills both fields on a pick", async () => {
    const h = harness();
    await h.autofill.install("b1", h.cdp);
    h.context(7);
    h.report(7, h.field());
    await flush(); await flush(); await flush();
    expect(h.calls.menus).toHaveLength(1);
    expect(h.calls.values).toEqual(["c1"]);
    expect(h.typed()).toBe(`ada${SECRET}`);
    expect(h.calls.audit).toEqual([expect.objectContaining({ outcome: "filled", by: "person", credentialId: "c1" })]);
    expect(JSON.stringify(h.calls.audit)).not.toContain(SECRET);
    // The password's field, and only it, is marked as holding one, so no snapshot shows it later.
    expect(h.calls.filled).toEqual([["b1", 42]]);
  });

  it("ignores the page's own world, a frame, and a context at another origin", async () => {
    // THE MUTANT: a report trusted on its say-so.
    const h = harness();
    await h.autofill.install("b1", h.cdp);
    h.context(1, { name: "" });
    h.context(2, { frameId: "child" });
    h.context(3, { origin: "https://evil.example.net" });
    for (const id of [1, 2, 3, 99]) h.report(id, h.field());
    await flush(); await flush();
    expect(h.calls.menus).toEqual([]);
  });

  it("types nothing when the page moved to another site between the menu and the pick", async () => {
    const h = harness();
    h.page.history = "https://evil.example.net/";
    await h.autofill.install("b1", h.cdp);
    h.context(7);
    h.report(7, h.field());
    await flush(); await flush(); await flush();
    expect(h.calls.menus).toHaveLength(1);
    expect(h.typed()).toBe("");
    expect(h.calls.values).toEqual([]);
    expect(h.calls.audit).toEqual([expect.objectContaining({ outcome: "origin_mismatch" })]);
  });

  it("fills a username alone without unlocking anything", async () => {
    const h = harness();
    await h.autofill.install("b1", h.cdp);
    h.context(7);
    h.report(7, h.field({ hasPass: false }));
    await flush(); await flush(); await flush();
    expect(h.typed()).toBe("ada");
    expect(h.calls.values).toEqual([]);
  });

  it("offers nothing when the site has no passwords, and opens Settings from its last row", async () => {
    const none = harness({ rows: [] });
    await none.autofill.install("b1", none.cdp);
    none.context(7);
    none.report(7, none.field());
    await flush(); await flush();
    expect(none.calls.menus).toEqual([]);

    const manage = harness({ choice: MANAGE_PASSWORDS_ID });
    await manage.autofill.install("b1", manage.cdp);
    manage.context(7);
    manage.report(7, manage.field());
    await flush(); await flush();
    expect(manage.calls.settings).toBe(1);
    expect(manage.typed()).toBe("");
  });

  it("names the site where a row is not this exact origin, and the keychain where it came from there", () => {
    const items = autofillMenuItems([
      credential(),
      credential({ id: "c2", origin: "https://www.example.com", match: "same-site", username: "" }),
      credential({ id: "c3", source: "keychain", username: "bob" }),
    ]);
    expect(items.map((i) => ("label" in i ? i.label : "—"))).toEqual(["ada", "No username — www.example.com", "bob — Keychain", "—", "Manage passwords…"]);
  });
});

describe("saving", () => {
  async function sentForm(h: ReturnType<typeof harness>) {
    await h.autofill.install("b1", h.cdp);
    h.context(7);
    h.report(7, { t: "sent", username: "ada", password: SECRET });
    await flush();
  }

  it("offers once the top frame navigates, with no password in the offer, and saves on Save", async () => {
    const h = harness();
    await sentForm(h);
    expect(h.calls.offers).toEqual([]);
    h.emit("Page.frameNavigated", { frame: { id: "main" } });
    await flush();
    expect(h.calls.offers).toEqual([{ browserId: "b1", offerId: "offer-1", origin: "https://example.com", username: "ada", kind: "save" }]);
    expect(JSON.stringify(h.calls.offers)).not.toContain(SECRET);
    expect(h.autofill.answer("offer-1", "save", "b1")).toBe(true);
    expect(h.calls.saved).toEqual([{ origin: "https://example.com", username: "ada", value: SECRET }]);
    // Answered once: the held password is gone.
    expect(h.autofill.answer("offer-1", "save", "b1")).toBe(false);
  });

  it("offers when the password field goes away, as a sign-in that stays on one page does", async () => {
    const h = harness();
    await sentForm(h);
    h.report(7, { t: "gone" });
    await flush();
    expect(h.calls.offers).toHaveLength(1);
  });

  it("does not offer a form whose page never moved on, or one too old", async () => {
    const h = harness();
    await sentForm(h);
    h.emit("Page.frameNavigated", { frame: { id: "child", parentId: "main" } });
    await flush();
    expect(h.calls.offers).toEqual([]);
    h.tick(SAVE_CAPTURE_WINDOW_MS + 1);
    h.emit("Page.frameNavigated", { frame: { id: "main" } });
    await flush();
    expect(h.calls.offers).toEqual([]);
  });

  it("remembers Never, and lets only the pane's own window answer", async () => {
    const h = harness();
    await sentForm(h);
    h.emit("Page.frameNavigated", { frame: { id: "main" } });
    await flush();
    expect(h.autofill.answer("offer-1", "never", "b2")).toBe(false);
    expect(h.autofill.answer("offer-1", "never", "b1")).toBe(true);
    expect(h.calls.never).toEqual(["https://example.com"]);
    expect(h.calls.saved).toEqual([]);
  });

  it("asks nothing when the store has nothing to offer", async () => {
    const h = harness({ saveOfferFor: () => null });
    await sentForm(h);
    h.emit("Page.frameNavigated", { frame: { id: "main" } });
    await flush();
    expect(h.calls.offers).toEqual([]);
  });

  it("drops the pane's offer when the pane goes", async () => {
    const h = harness();
    await sentForm(h);
    h.emit("Page.frameNavigated", { frame: { id: "main" } });
    await flush();
    h.autofill.release("b1");
    expect(h.calls.withdrawn).toEqual(["offer-1"]);
    expect(h.autofill.answer("offer-1", "save", "b1")).toBe(false);
  });
});

describe("parseAutofillMessage", () => {
  it("refuses what is not a well-formed report", () => {
    expect(parseAutofillMessage("nope")).toBeNull();
    expect(parseAutofillMessage(JSON.stringify({ t: "sent", password: "" }))).toBeNull();
    expect(parseAutofillMessage(JSON.stringify({ t: "sent", password: "x".repeat(5000) }))).toBeNull();
    expect(parseAutofillMessage(JSON.stringify({ t: "field", id: 1, rect: { x: "1" } }))).toBeNull();
  });
});

describe("the script", () => {
  it("parses as JavaScript", () => {
    expect(() => new Function(autofillScriptSource())).not.toThrow();
  });
});

describe("security codes", () => {
  const CODE = "482913";
  const code = (over: Record<string, unknown> = {}) => ({ t: "code", id: 1, how: "click", boxes: 1, rect: { x: 10, y: 20, w: 200, h: 30 }, ...over });
  function codeHarness(over: Partial<AutofillDeps> & { choice?: string | null } = {}) {
    const asked: string[] = [];
    const filled: number[][] = [];
    const codes: string[] = [];
    const h = harness({
      choice: FILL_CODE_ID,
      codeFor: async (_p, origin) => { asked.push(origin); return { code: CODE, source: "Messages" }; },
      codeFilled: (_p, ids, typed) => { filled.push(ids); codes.push(typed); },
      ...over,
    });
    return { ...h, asked, filled, codes };
  }

  it("offers the code under a code field, and one pick types it", async () => {
    const h = codeHarness();
    await h.autofill.install("b1", h.cdp);
    h.context(7);
    h.report(7, code());
    await flush(); await flush(); await flush();
    expect(h.asked).toEqual(["https://example.com"]);
    expect(h.calls.menus).toEqual([[{ id: FILL_CODE_ID, label: "482 913 — from Messages", toolTip: expect.any(String) }]]);
    expect(h.typed()).toBe(CODE);
    expect(h.filled).toHaveLength(1);
    // The code goes with the nodes, so the agent host can take it out of what the agent reads.
    expect(h.codes).toEqual([CODE]);
    // A code is not a saved password: nothing is unlocked and no audit line is written.
    expect(h.calls.values).toEqual([]);
    expect(h.calls.audit).toEqual([]);
  });

  it("types one digit into each box of a split field", async () => {
    const h = codeHarness();
    await h.autofill.install("b1", h.cdp);
    h.context(7);
    h.report(7, code({ boxes: 6 }));
    for (let i = 0; i < 8; i++) await flush();
    const steps = h.sent.filter((c) => c.method === "Runtime.callFunctionOn" || (c.method === "Input.dispatchKeyEvent" && c.params?.type === "keyDown"))
      .map((c) => (c.method === "Runtime.callFunctionOn" ? "|" : String(c.params?.text))).join("");
    expect(steps).toBe("|4|8|2|9|1|3");
  });

  it("asks for each box by its index in Realm's world", async () => {
    const h = codeHarness();
    await h.autofill.install("b1", h.cdp);
    h.context(7);
    h.report(7, code({ boxes: 4 }));
    for (let i = 0; i < 8; i++) await flush();
    const asks = h.sent.filter((c) => c.method === "Runtime.evaluate").map((c) => [c.params?.expression, c.params?.contextId]);
    expect(asks).toEqual([0, 1, 2, 3].map((i) => [`__realmAutofillTarget(1, ${i})`, 7]));
  });

  it("offers nothing, and opens no menu, when there is no code or the switch is off", async () => {
    const h = codeHarness({ codeFor: async () => null });
    await h.autofill.install("b1", h.cdp);
    h.context(7);
    h.report(7, code());
    await flush(); await flush();
    expect(h.calls.menus).toEqual([]);
    expect(h.typed()).toBe("");
  });

  it("never reads a code for the page's own world, a frame or another origin", async () => {
    const h = codeHarness();
    await h.autofill.install("b1", h.cdp);
    h.context(1, { name: "" });
    h.context(2, { frameId: "child" });
    h.context(3, { origin: "https://evil.example.net" });
    for (const id of [1, 2, 3]) h.report(id, code());
    await flush(); await flush();
    expect(h.asked).toEqual([]);
    expect(h.calls.menus).toEqual([]);
  });

  it("types nothing when the page moved to another site between the menu and the pick", async () => {
    const h = codeHarness();
    h.page.history = "https://evil.example.net/";
    await h.autofill.install("b1", h.cdp);
    h.context(7);
    h.report(7, code());
    await flush(); await flush(); await flush();
    expect(h.calls.menus).toHaveLength(1);
    expect(h.typed()).toBe("");
    expect(h.filled).toEqual([]);
  });

  it("types nothing when the menu is dismissed", async () => {
    const h = codeHarness({ choice: null });
    await h.autofill.install("b1", h.cdp);
    h.context(7);
    h.report(7, code());
    await flush(); await flush(); await flush();
    expect(h.typed()).toBe("");
  });

  it("refuses a report with no boxes or more than eight", () => {
    expect(parseAutofillMessage(JSON.stringify(code({ boxes: 0 })))).toBeNull();
    expect(parseAutofillMessage(JSON.stringify(code({ boxes: 9 })))).toBeNull();
    expect(parseAutofillMessage(JSON.stringify(code({ boxes: 6 })))).toMatchObject({ t: "code", boxes: 6 });
  });

  it("logs nothing about the code", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const h = codeHarness();
    await h.autofill.install("b1", h.cdp);
    h.context(7);
    h.report(7, code({ boxes: 6 }));
    for (let i = 0; i < 8; i++) await flush();
    expect(h.typed()).toBe(CODE);
    for (const spy of spies) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
  });
});

describe("what a code field is (CODE_FIELD_JS)", () => {
  const codeGroupOf = new Function(`${CODE_FIELD_JS}; return codeGroupOf;`)() as (el: Element) => Element[] | null;
  const page = (html: string) => { document.body.innerHTML = html; return (sel: string) => document.querySelector(sel)!; };

  it.each([
    ['<input id="f" autocomplete="one-time-code">', "autocomplete=one-time-code"],
    ['<input id="f" name="otp">', "a name"],
    ['<input id="f" placeholder="Enter verification code">', "a placeholder"],
    ['<input id="f" aria-label="2FA code">', "an aria-label"],
    ['<label for="f">Security code</label><input id="f">', "its label"],
    ['<input id="f" inputmode="numeric" maxlength="6">', "a numeric field of six"],
    ['<input id="f" type="tel" maxlength="4">', "a phone-keypad field of four"],
  ])("takes %s (%s)", (html) => {
    const $ = page(html);
    expect(codeGroupOf($("#f"))).toEqual([$("#f")]);
  });

  it.each([
    ['<input id="f" name="promo_code">', "a promo code"],
    ['<input id="f" name="postcode">', "a postcode"],
    ['<input id="f" name="email">', "an email field"],
    ['<input id="f" type="password" name="password">', "a password field"],
    ['<input id="f" inputmode="numeric" maxlength="12">', "a long number"],
    ['<input id="f" name="otp" disabled>', "a disabled field"],
  ])("refuses %s (%s)", (html) => {
    expect(codeGroupOf(page(html)("#f"))).toBeNull();
  });

  it("takes a row of single-character boxes as one field, in order", () => {
    const $ = page(`<div id="row">${[0, 1, 2, 3, 4, 5].map((i) => `<input id="b${i}" maxlength="1" inputmode="numeric">`).join("")}</div>`);
    const group = codeGroupOf($("#b2"));
    expect(group).toEqual([0, 1, 2, 3, 4, 5].map((i) => $(`#b${i}`)));
  });

  it("does not take a lone single-character box, or boxes mixed with other fields", () => {
    const $ = page('<form><input id="a" maxlength="1"><input id="b" maxlength="1"><input id="c" maxlength="1"><input id="d" maxlength="1"><input name="email"></form><input id="lone" maxlength="1">');
    expect(codeGroupOf($("#a"))).toBeNull();
    expect(codeGroupOf($("#lone"))).toBeNull();
  });
});
