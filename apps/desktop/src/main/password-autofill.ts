/**
 * Password autofill in Realm's browser panes, for the PERSON (Realm 2.3), Electron-free like
 * passkeys.ts and installed beside it over the same in-process CDP.
 *
 * ## What the person sees
 *
 * Clicking into an empty sign-in field — or pressing ↓ in one — opens a menu under the field listing
 * the passwords saved for the site: this exact origin first, then the rest of the site
 * (`password-match.ts`). Picking one fills the username and the password, after Touch ID (the
 * profile's unlock policy, with a one-minute window for the person's own picks). After the page sends
 * a sign-in form, the pane's bar offers to save the password, or to update the saved one.
 *
 * ## Why a native menu
 *
 * The menu is the OS's (`NSMenu`, through Electron), drawn by main at the field's place in the
 * window. Nothing a page draws can be trusted to stand between it and a password, and nothing Realm's
 * renderer draws can appear over a pane's native view (design.md: menus are the system's, and the
 * only surface that opens over a browser pane). An NSMenu is also outside every page and every
 * renderer: a page cannot script it, restyle it, cover it or click it, so a pick in it is the person.
 *
 * ## What the page can and cannot do
 *
 * Realm's script runs in an ISOLATED WORLD (`AUTOFILL_WORLD`), and the binding it reports through is
 * exposed to that world alone: the page cannot call it, read the fields map it keeps, or see the
 * global main reaches the fields by. What a page CAN do is be clicked on. So:
 *
 *   - Every report is checked against what the BROWSER says, not what it says: the context it came
 *     from must be Realm's world, in the pane's top frame, at the origin the pane's navigation
 *     committed. A frame — same-origin or not — never gets a menu, and so never gets a fill.
 *   - Only a trusted event (`isTrusted`: a real click or key, which a page cannot synthesize) opens
 *     the menu, and only on an empty field or on ↓, so focus moved by script, autofocus, or a click to
 *     put the caret in a filled field never pops anything.
 *   - The fill re-reads the origin from the browser at the moment of typing, and refuses if the page
 *     moved since the menu opened, or if the password's site is not this page's.
 *   - A username alone is typed with no unlock (it is not a secret); a password never without one.
 *
 * ## Saving
 *
 * The script reads the form when it is sent — a submit, Enter in a field, or a click on a button
 * beside a filled password field — within a few seconds of the person's own input, and hands the
 * username and password to main. Main holds them, in memory only, and offers to save once the sign-in
 * looks like it went through: the top frame navigated, or the password field went away. The offer
 * names the pane's own origin, never the form's action. The value goes no further than main: the bar
 * says "Save password for ada on example.com?", and only main's press handler seals it.
 */
import {
  normalizeOrigin, SAVE_OFFER_TTL_MS,
  type PasswordSaveAnswer, type PasswordSaveOffer, type SiteCredential,
} from "@realm/contracts";
import { performAutofill, type CdpSend } from "./browser-agent";
import type { CredentialAuditEntry } from "./secret-store";
import type { NativeMenuItem } from "./native-menu";

export const AUTOFILL_WORLD = "realm-autofill";
export const AUTOFILL_BINDING = "__realmAutofill";
/** The isolated world's own global main reads a field through. Invisible to the page. */
export const AUTOFILL_TARGET = "__realmAutofillTarget";
/** The menu row that opens Settings ▸ Passwords. */
export const MANAGE_PASSWORDS_ID = "__manage";

/** How long after it was sent a form may still be offered for saving, waiting for the navigation or
 *  the field going away that says it went through. */
export const SAVE_CAPTURE_WINDOW_MS = 30_000;
/** The longest password a form may hand over to be saved — `BrowserCredentialInputSchema`'s cap. */
const VALUE_MAX = 4096;
const NAME_MAX = 255;

export type AutofillCdp = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(cb: (method: string, params: unknown) => void): void;
};

export type AutofillDeps = {
  /** The pane's committed URL, straight off the webContents. */
  pageUrl(paneId: string): string | null;
  /** The passwords this pane's profile may be offered on `origin`, in menu order. */
  credentialsFor(paneId: string, origin: string): Promise<SiteCredential[]>;
  /** Pop the OS menu under a rect given in the page's CSS pixels; the chosen row's id, or null. */
  popupMenu(paneId: string, items: NativeMenuItem[], rect: { x: number; y: number; w: number; h: number }): Promise<string | null>;
  /** Run `use` with one password after the profile's unlock, as a PERSON's pick. */
  withValue(paneId: string, credentialId: string, use: (value: string) => Promise<void>): Promise<{ ok: true } | { ok: false; refused: "no_credential" | "no_presence" }>;
  /** What to offer for a form that went out: save, update, or nothing. */
  saveOfferFor(paneId: string, origin: string, username: string, value: string): { kind: "save" } | { kind: "update"; id: string } | null;
  saveOffered(paneId: string, input: { origin: string; username: string; value: string }): void;
  neverSave(paneId: string, origin: string): void;
  /** Show the bar. The offer has no field for the password. */
  offer(offer: PasswordSaveOffer): void;
  /** Take the bar down (answered elsewhere, expired, or the pane went). */
  withdraw(browserId: string, offerId: string): void;
  openSettings(paneId: string): void;
  audit(entry: CredentialAuditEntry): void;
  now(): number;
  newId(): string;
};

/**
 * The script every top-level document in a pane runs, in Realm's isolated world. Frames return at
 * once: Realm never offers or fills inside one.
 */
export function autofillScriptSource(): string {
  return `(() => {
  if (window.top !== window) return;
  const BIND = ${JSON.stringify(AUTOFILL_BINDING)};
  const fields = new Map();
  let seq = 0;
  let lastInput = 0;
  const say = (m) => { try { window[BIND](JSON.stringify(m)); } catch (e) {} };
  const isInput = (el) => el instanceof HTMLInputElement;
  const isPassword = (el) => isInput(el) && el.type === "password";
  const isText = (el) => isInput(el) && ["text", "email", "tel", ""].includes(el.type);
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.disabled; };
  const isNew = (el) => (el.autocomplete || "").toLowerCase().includes("new-password");
  const inputsOf = (el) => Array.from((el.form || document).querySelectorAll("input")).filter(shown);
  const looksLikeLogin = (el) => /user|email|login|account|phone|mail/i.test([el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.autocomplete].join(" "));
  const userBefore = (list, i) => { for (let j = i - 1; j >= 0; j--) if (isText(list[j])) return list[j]; return null; };
  const pairFor = (el) => {
    const list = inputsOf(el);
    const i = list.indexOf(el);
    if (isPassword(el)) return isNew(el) ? null : { user: userBefore(list, i), pass: el, kind: "password" };
    if (!isText(el)) return null;
    const pass = list.slice(i + 1).find((x) => isPassword(x) && !isNew(x)) || null;
    const named = (el.autocomplete || "").toLowerCase().includes("username");
    if (!pass && !named && !(el.form && looksLikeLogin(el))) return null;
    return { user: el, pass, kind: "username" };
  };
  const ask = (el, how) => {
    const pair = pairFor(el);
    if (!pair) return;
    const id = ++seq;
    fields.set(id, pair);
    if (fields.size > 16) fields.delete(fields.keys().next().value);
    const r = el.getBoundingClientRect();
    say({ t: "field", id, how, hasUser: !!pair.user, hasPass: !!pair.pass, rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
  };
  Object.defineProperty(window, ${JSON.stringify(AUTOFILL_TARGET)}, {
    value: (id, which) => { const p = fields.get(id); return p ? (which === "pass" ? p.pass : p.user) : null; },
    writable: false, enumerable: false, configurable: false,
  });
  const sent = (scopeEl) => {
    if (Date.now() - lastInput > 5000) return;
    const list = Array.from((scopeEl && scopeEl.form ? scopeEl.form : scopeEl instanceof HTMLFormElement ? scopeEl : document).querySelectorAll("input")).filter(shown);
    const filled = list.filter((x) => isPassword(x) && x.value);
    if (filled.length === 0) return;
    const pass = filled.find(isNew) || filled[0];
    const user = userBefore(list, list.indexOf(filled[0]));
    say({ t: "sent", username: user ? user.value : "", password: pass.value });
    let n = 0;
    const watch = setInterval(() => {
      if (!pass.isConnected || !shown(pass)) { clearInterval(watch); say({ t: "gone" }); }
      else if (++n >= 20) clearInterval(watch);
    }, 500);
  };
  document.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    lastInput = Date.now();
    const el = e.composedPath()[0];
    if (isInput(el) && (isText(el) || isPassword(el))) { if (el.value === "") ask(el, "click"); return; }
    const button = el && el.closest ? el.closest("button, input[type=submit], [role=button]") : null;
    if (button && !(button.form && button.type === "submit")) sent(button);
  }, true);
  document.addEventListener("keydown", (e) => {
    if (!e.isTrusted) return;
    lastInput = Date.now();
    const el = e.composedPath()[0];
    if (!isInput(el)) return;
    if (e.key === "ArrowDown" && !e.altKey && !e.metaKey && !e.ctrlKey) ask(el, "key");
    else if (e.key === "Enter" && !el.form) sent(el);
  }, true);
  document.addEventListener("submit", (e) => { sent(e.target); }, true);
})();`;
}

type FieldReport = { t: "field"; id: number; how: "click" | "key"; hasUser: boolean; hasPass: boolean; rect: { x: number; y: number; w: number; h: number } };
type SentReport = { t: "sent"; username: string; password: string };
type GoneReport = { t: "gone" };

/** A report from the isolated world, checked field by field. The rect only places a menu; the two
 *  strings are the form's, clipped, and the password never leaves main from here. */
export function parseAutofillMessage(payload: string): FieldReport | SentReport | GoneReport | null {
  let v: Record<string, unknown>;
  try { v = JSON.parse(payload) as Record<string, unknown>; } catch { return null; }
  if (v?.t === "gone") return { t: "gone" };
  if (v?.t === "sent") {
    if (typeof v.password !== "string" || v.password === "" || v.password.length > VALUE_MAX) return null;
    return { t: "sent", username: typeof v.username === "string" ? v.username.slice(0, NAME_MAX) : "", password: v.password };
  }
  if (v?.t !== "field" || typeof v.id !== "number" || !Number.isInteger(v.id)) return null;
  const r = v.rect as Record<string, unknown> | undefined;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const rect = r ? { x: num(r.x), y: num(r.y), w: num(r.w), h: num(r.h) } : null;
  if (!rect || rect.x === null || rect.y === null || rect.w === null || rect.h === null) return null;
  return { t: "field", id: v.id, how: v.how === "key" ? "key" : "click", hasUser: v.hasUser === true, hasPass: v.hasPass === true, rect: rect as FieldReport["rect"] };
}

/** The menu's rows: each password by its username, with the site where it is not this exact origin
 *  and the keychain where it came from there; then the way to Settings. Every label is the user's own
 *  words or Realm's — none is page-authored. */
export function autofillMenuItems(rows: readonly SiteCredential[]): NativeMenuItem[] {
  const items: NativeMenuItem[] = rows.map((c) => {
    const host = new URL(c.origin).host;
    const where = [c.match === "same-site" ? host : "", c.source === "keychain" ? "Keychain" : ""].filter(Boolean).join(" · ");
    return {
      id: c.id,
      label: `${c.username || "No username"}${where ? ` — ${where}` : ""}`,
      toolTip: `${c.origin}${c.source === "keychain" ? ", from your login keychain" : c.source === "imported" ? ", imported" : ""}`,
    };
  });
  return [...items, { type: "separator" }, { id: MANAGE_PASSWORDS_ID, label: "Manage passwords…" }];
}

type Context = { origin: string; name: string; frameId: string | null; isDefault: boolean };
type Pane = {
  cdp: AutofillCdp;
  mainFrameId: string | null;
  contexts: Map<number, Context>;
  /** A form that went out and is waiting for a sign of success before it is offered. */
  sent: { origin: string; username: string; value: string; at: number } | null;
  /** One menu at a time: a second click while one is up is not a second menu. */
  menuOpen: boolean;
};

export class PasswordAutofill {
  private panes = new Map<string, Pane>();
  /** Offers on screen, with the password each would save. Main's memory only, and only until answered. */
  private offers = new Map<string, { paneId: string; origin: string; username: string; value: string; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly d: AutofillDeps) {}

  /** Put the script and its binding in place for a pane — after passkeys.ts's install, which has
   *  already given the view a document so `Runtime.addBinding` answers. */
  async install(paneId: string, cdp: AutofillCdp): Promise<void> {
    const pane: Pane = { cdp, mainFrameId: null, contexts: new Map(), sent: null, menuOpen: false };
    this.panes.set(paneId, pane);
    cdp.onEvent((method, params) => this.onEvent(paneId, pane, method, params));
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Runtime.addBinding", { name: AUTOFILL_BINDING, executionContextName: AUTOFILL_WORLD });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: autofillScriptSource(), worldName: AUTOFILL_WORLD });
    const tree = (await cdp.send("Page.getFrameTree").catch(() => null)) as { frameTree?: { frame?: { id?: string } } } | null;
    pane.mainFrameId ??= tree?.frameTree?.frame?.id ?? null;
  }

  release(paneId: string): void {
    this.panes.delete(paneId);
    for (const [id, offer] of this.offers) if (offer.paneId === paneId) this.drop(id);
  }

  /** The person's answer on the pane's bar. Only main's IPC handler calls this, and only for a pane
   *  held by the window that asked. */
  answer(offerId: string, answer: PasswordSaveAnswer, paneId: string): boolean {
    const offer = this.offers.get(offerId);
    if (!offer || offer.paneId !== paneId) return false;
    this.drop(offerId);
    if (answer === "save") this.d.saveOffered(offer.paneId, { origin: offer.origin, username: offer.username, value: offer.value });
    else if (answer === "never") this.d.neverSave(offer.paneId, offer.origin);
    return true;
  }

  private drop(offerId: string): void {
    const offer = this.offers.get(offerId);
    if (!offer) return;
    clearTimeout(offer.timer);
    this.offers.delete(offerId);
    this.d.withdraw(offer.paneId, offerId);
  }

  private onEvent(paneId: string, pane: Pane, method: string, params: unknown): void {
    const p = params as Record<string, unknown> | null;
    switch (method) {
      case "Runtime.executionContextCreated": {
        const c = p?.context as { id?: number; origin?: string; name?: string; auxData?: { frameId?: string; isDefault?: boolean } } | undefined;
        if (typeof c?.id === "number") pane.contexts.set(c.id, { origin: c.origin ?? "", name: c.name ?? "", frameId: c.auxData?.frameId ?? null, isDefault: c.auxData?.isDefault === true });
        return;
      }
      case "Runtime.executionContextDestroyed":
        if (typeof p?.executionContextId === "number") pane.contexts.delete(p.executionContextId);
        return;
      case "Runtime.executionContextsCleared":
        pane.contexts.clear();
        return;
      case "Page.frameNavigated": {
        const frame = p?.frame as { id?: string; parentId?: string } | undefined;
        if (!frame?.id || frame.parentId) return;
        pane.mainFrameId = frame.id;
        void this.offerSent(paneId, pane);
        return;
      }
      case "Page.navigatedWithinDocument":
        if (p?.frameId === pane.mainFrameId) void this.offerSent(paneId, pane);
        return;
      case "Runtime.bindingCalled":
        if (p?.name !== AUTOFILL_BINDING || typeof p.payload !== "string" || typeof p.executionContextId !== "number") return;
        void this.onMessage(paneId, pane, p.payload, p.executionContextId);
        return;
    }
  }

  /** The origin a report may speak for: Realm's world, in the top frame, at the origin the pane's
   *  navigation committed — or null, and the report is ignored. An isolated world reports no origin
   *  of its own (measured, Electron 37), so it is the frame's page context that says which origin the
   *  frame holds — the browser's word, as every context's is. */
  private originOf(paneId: string, pane: Pane, contextId: number): string | null {
    const ctx = pane.contexts.get(contextId);
    if (!ctx || ctx.name !== AUTOFILL_WORLD || ctx.frameId === null || ctx.frameId !== pane.mainFrameId) return null;
    // The newest page context of that frame: an old document's, not yet reported destroyed, is not
    // the one on screen.
    const frame = [...pane.contexts.values()].reverse().find((c) => c.isDefault && c.frameId === ctx.frameId);
    const origin = normalizeOrigin(frame?.origin ?? "");
    const page = normalizeOrigin(this.d.pageUrl(paneId) ?? "");
    return origin && origin === page ? origin : null;
  }

  private async onMessage(paneId: string, pane: Pane, payload: string, contextId: number): Promise<void> {
    const msg = parseAutofillMessage(payload);
    if (!msg) return;
    if (msg.t === "gone") { await this.offerSent(paneId, pane); return; }
    const origin = this.originOf(paneId, pane, contextId);
    if (!origin) return;
    if (msg.t === "sent") {
      pane.sent = { origin, username: msg.username.trim(), value: msg.password, at: this.d.now() };
      return;
    }
    await this.openMenu(paneId, pane, origin, contextId, msg);
  }

  private async openMenu(paneId: string, pane: Pane, origin: string, contextId: number, field: FieldReport): Promise<void> {
    if (pane.menuOpen) return;
    // A username field with no password beside it can only take a username, so only rows that have one.
    const rows = (await this.d.credentialsFor(paneId, origin)).filter((c) => field.hasPass || c.username !== "");
    if (rows.length === 0) return;
    pane.menuOpen = true;
    let choice: string | null;
    try { choice = await this.d.popupMenu(paneId, autofillMenuItems(rows), field.rect); } finally { pane.menuOpen = false; }
    if (choice === MANAGE_PASSWORDS_ID) { this.d.openSettings(paneId); return; }
    const credential = rows.find((c) => c.id === choice);
    if (!credential) return;
    await this.fill(paneId, pane, contextId, field, credential);
  }

  private async fill(paneId: string, pane: Pane, contextId: number, field: FieldReport, credential: SiteCredential): Promise<void> {
    const target = async (which: "user" | "pass"): Promise<string | null> => {
      try {
        const r = (await pane.cdp.send("Runtime.evaluate", {
          expression: `${AUTOFILL_TARGET}(${field.id}, ${JSON.stringify(which)})`, contextId, silent: true,
        })) as { result?: { objectId?: string; subtype?: string } };
        return r?.result?.subtype === "null" ? null : r?.result?.objectId ?? null;
      } catch { return null; }
    };
    const user = field.hasUser && credential.username ? await target("user") : null;
    const pass = field.hasPass ? await target("pass") : null;
    const send: CdpSend = (method, params) => pane.cdp.send(method, params);
    const result = await performAutofill(send, { user, pass }, {
      origin: credential.origin,
      username: credential.username,
      reveal: (type) => this.d.withValue(paneId, credential.id, type),
    }).catch(() => ({ ok: false as const, error: "" }));
    // A username typed alone is not a fill of a secret, and leaves no line; anything that reached for
    // the password does, whatever became of it.
    if (pass) {
      const outcome: CredentialAuditEntry["outcome"] = result.ok ? "filled" : "refused" in result && result.refused === "origin_mismatch" ? "origin_mismatch"
        : "refused" in result && result.refused === "no_presence" ? "no_presence" : "refused" in result && result.refused === "no_credential" ? "no_credential" : "error";
      this.d.audit({ ts: this.d.now(), origin: credential.origin, credentialId: credential.id, outcome, by: "person" });
    }
  }

  /** A form went out and the page moved on: offer it, if there is anything to offer. */
  private async offerSent(paneId: string, pane: Pane): Promise<void> {
    const sent = pane.sent;
    pane.sent = null;
    if (!sent || this.d.now() - sent.at > SAVE_CAPTURE_WINDOW_MS) return;
    const kind = this.d.saveOfferFor(paneId, sent.origin, sent.username, sent.value);
    if (!kind) return;
    // One offer per pane: a newer form replaces the one the person has not answered.
    for (const [id, o] of this.offers) if (o.paneId === paneId) this.drop(id);
    const offerId = this.d.newId();
    const timer = setTimeout(() => this.drop(offerId), SAVE_OFFER_TTL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.offers.set(offerId, { paneId, origin: sent.origin, username: sent.username, value: sent.value, timer });
    this.d.offer({ browserId: paneId, offerId, origin: sent.origin, username: sent.username, kind: kind.kind });
  }
}
