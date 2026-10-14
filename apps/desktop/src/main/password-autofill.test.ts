import { describe, expect, it } from "vitest";
import type { PasswordSaveOffer, SiteCredential } from "@realm/contracts";
import {
  AUTOFILL_BINDING, AUTOFILL_WORLD, MANAGE_PASSWORDS_ID, PasswordAutofill, SAVE_CAPTURE_WINDOW_MS,
  autofillMenuItems, autofillScriptSource, parseAutofillMessage, type AutofillDeps,
} from "./password-autofill";

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
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{ url: page.history }] };
      if (method === "Runtime.evaluate") {
        const which = String(params?.expression).includes('"pass"') ? "pass" : "user";
        return { result: { type: "object", objectId: `obj-${which}` } };
      }
      return {};
    },
    onEvent: (cb: (method: string, params: unknown) => void) => { emit = cb; },
  };
  const calls = { menus: [] as unknown[], values: [] as string[], offers: [] as PasswordSaveOffer[], withdrawn: [] as string[], saved: [] as unknown[], never: [] as string[], settings: 0, audit: [] as unknown[] };
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
    now: () => clock,
    newId: () => `offer-${++ids}`,
    ...over,
  };
  const autofill = new PasswordAutofill(deps);
  const context = (id: number, over2: { name?: string; origin?: string; frameId?: string } = {}) =>
    emit("Runtime.executionContextCreated", { context: { id, origin: over2.origin ?? "https://example.com", name: over2.name ?? AUTOFILL_WORLD, auxData: { frameId: over2.frameId ?? "main" } } });
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
