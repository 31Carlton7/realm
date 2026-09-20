/**
 * Passkeys in Realm's browser panes (`navigator.credentials`), Electron-free.
 *
 * ## Why this file exists at all
 *
 * Electron ships Chromium's whole WebAuthn stack and none of the browser half that drives it.
 * Measured on Electron 37: `window.PublicKeyCredential` is present, `isConditionalMediationAvailable()`
 * answers true, and `isUserVerifyingPlatformAuthenticatorAvailable()` answers **false** — because the
 * macOS Touch ID authenticator is gated behind a delegate Chrome implements and Electron does not,
 * and the hybrid (phone) transport needs the QR sheet that lives in Chrome's UI layer. A site reads
 * that combination exactly as GitHub reports it: partial passkey support, and a sign-in button that
 * raises no system prompt and then times out with `NotAllowedError`.
 *
 * Neither missing half can be supplied from JavaScript. The macOS system passkey sheet — the one
 * that offers iCloud Keychain — needs `com.apple.developer.web-browser.public-key-credential`, an
 * entitlement Apple issues to browser vendors; Chromium's own Touch ID authenticator needs a
 * keychain-access-group entitlement AND the C++ delegate Electron never wires up. **So the passkeys
 * already in the user's iCloud Keychain are out of reach here, and saying so plainly is part of the
 * feature** — see `PASSKEY_STORAGE_NOTE`.
 *
 * What Realm can do is be the authenticator itself. Chromium's virtual authenticator is not a test
 * double bolted on from outside: it is a real CTAP2 implementation inside the same FIDO stack, doing
 * real P-256 signatures over real authenticator data, and a relying party cannot tell its assertions
 * from a security key's. Realm installs one per pane over in-process CDP, holds the private keys
 * sealed in the secret store, and puts a fingerprint in front of every use.
 *
 * ## The four facts this design is built on
 *
 * Each was measured against Electron 37 before a line of it was written, because three of them are
 * not what the CDP documentation suggests:
 *
 *  1. **A virtual authenticator can be installed before the pane has loaded anything.** That is what
 *     makes `isUserVerifyingPlatformAuthenticatorAvailable()` answer true on the FIRST paint of the
 *     first page, which is when a sign-in page decides whether to offer passkeys at all.
 *  2. **Presence cannot be granted after the fact.** Flipping `setAutomaticPresenceSimulation` on
 *     while a request is already in flight does nothing: the request waits out the page's own
 *     timeout and fails `NotAllowedError`. So the Touch ID prompt must happen BEFORE the request is
 *     dispatched, which is why the page shim below blocks rather than merely reporting.
 *  3. **A withheld request is a request that waits.** With presence simulation off, `create` and
 *     `get` hang until the page's timeout expires and then refuse. That is the resting state of every
 *     pane, and it is what stops an agent driving a pane from using a passkey unattended: there is no
 *     key loaded and no presence to simulate, and neither can be had without a fingerprint.
 *  4. **A pending conditional request poisons the modal one.** A `mediation: "conditional"` get left
 *     hanging at the authenticator makes the NEXT modal get fail with `OperationError` — and a
 *     conditional get is exactly what a sign-in page fires on load to offer passkey autofill. Realm
 *     has no autofill surface to offer (that is Chrome UI too), so the shim holds those requests
 *     unresolved and never dispatches them, which is both faithful to what a conditional get does
 *     when it has nothing to show and the only way the button beside it keeps working.
 *
 * ## The shape of one request
 *
 *     page calls navigator.credentials.get()
 *       → shim asks Realm over a CDP binding, and BLOCKS
 *       → Realm derives the rp id from the pane's own URL (never the page's claim)
 *       → Realm refuses outright, or asks for Touch ID
 *       → keys are unsealed into the authenticator, presence goes on, the shim is released
 *       → the page's request runs, signs, and settles
 *       → shim reports back; presence goes off, the counter is written back, the keys are cleared
 *
 * Between requests a pane holds no key material at all.
 */
import {
  PASSKEY_NAME_MAX, passkeyRpIdForPageUrl,
  type PasskeyNotice, type PasskeyRefusal,
} from "@realm/contracts";
import type { PasskeyAuditEntry, PasskeyInput, PasskeyKeyMaterial } from "./secret-store";

/** The binding the page shim calls to reach Realm, and the function Realm calls back on. Named like
 *  `PICK_BINDING` and for the same reason: one recognizable prefix for everything Realm injects. */
export const PASSKEY_BINDING = "__realmPasskeyAsk";
export const PASSKEY_REPLY = "__realmPasskeyReply";

/**
 * The authenticator every pane gets.
 *
 * `internal` transport is what makes a site treat it as a platform authenticator, which is the
 * "partial support" complaint answered. Presence and verification both start OFF and are turned on
 * only for a request the user has just approved.
 *
 * Backup flags are **false**, deliberately. A Realm passkey lives on this Mac, in this Mac's
 * Keychain-sealed store, and does not sync anywhere; claiming otherwise would put a "backed up" flag
 * in the authenticator data a relying party records and shows the user.
 */
export const PASSKEY_AUTHENTICATOR_OPTIONS = {
  protocol: "ctap2",
  ctap2Version: "ctap2_1",
  transport: "internal",
  hasResidentKey: true,
  hasUserVerification: true,
  hasPrf: true,
  automaticPresenceSimulation: false,
  isUserVerified: false,
  defaultBackupEligibility: false,
  defaultBackupState: false,
} as const;

/**
 * How long presence may stay enabled for one approved request before Realm takes it back unasked.
 *
 * The page's own WebAuthn timeout normally settles a request in well under a minute and the shim
 * reports back either way. This bounds the one case it cannot: a navigation that destroys the shim's
 * frame mid-request, which would otherwise leave presence on with no one left to turn it off.
 */
export const PASSKEY_REQUEST_TIMEOUT_MS = 120_000;

/** The CDP surface this needs, implemented over `webContents.debugger` in browser-pane.ts. */
export type PasskeyCdp = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(cb: (method: string, params: unknown) => void): void;
};

export type PasskeyBrokerDeps = {
  /** The pane's real URL, straight off the webContents. Trustworthy page identity is the whole
   *  anti-phishing gate here: every decision below is made on this and never on `rp.id`. */
  pageUrl(paneId: string): string | null;
  hasPasskeyFor(rpId: string): boolean;
  withPasskeysFor(
    rpId: string,
    kind: "create" | "get",
    use: (keys: PasskeyKeyMaterial[]) => Promise<void>,
  ): Promise<{ ok: true } | { ok: false; refused: "no_passkey" | "no_presence" }>;
  recordPasskey(input: PasskeyInput): void;
  notePasskeyUse(credentialId: string, signCount: number): void;
  /** Whether this Mac can run the presence check at all. False means no Touch ID sensor, and the
   *  user is told that instead of being shown a prompt that could only fail. */
  canPromptPresence(): boolean;
  /** Tell the pane why a request did not go through, so a refused sign-in is not a silent one. */
  notify(notice: PasskeyNotice): void;
  audit(entry: PasskeyAuditEntry): void;
  now(): number;
};

/** What the shim sends when a page asks for a passkey. Every string in it is page-authored and is
 *  treated as such: `rpId` is a claim to be checked against the pane's URL, and the two user strings
 *  are clipped and only ever shown beside an rp id Realm derived itself. */
export type PasskeyAsk = {
  t: "ask";
  id: string;
  kind: "create" | "get";
  rpId: string | null;
  mediation: string | null;
  userName: string;
  userDisplayName: string;
};

export type PasskeyDone = { t: "done"; id: string; ok: boolean };

/** Realm's answer. `hold` never settles the page's promise — the conditional-mediation case. */
export type PasskeyVerdict = "allow" | "deny" | "hold";

export function parsePasskeyMessage(payload: string): PasskeyAsk | PasskeyDone | null {
  let v: Record<string, unknown>;
  try { v = JSON.parse(payload) as Record<string, unknown>; } catch { return null; }
  if (typeof v?.id !== "string") return null;
  if (v.t === "done") return { t: "done", id: v.id, ok: v.ok === true };
  if (v.t !== "ask") return null;
  if (v.kind !== "create" && v.kind !== "get") return null;
  const str = (x: unknown): string => (typeof x === "string" ? x.slice(0, PASSKEY_NAME_MAX) : "");
  return {
    t: "ask",
    id: v.id,
    kind: v.kind,
    rpId: typeof v.rpId === "string" ? v.rpId.slice(0, 255) : null,
    mediation: typeof v.mediation === "string" ? v.mediation.slice(0, 32) : null,
    userName: str(v.userName),
    userDisplayName: str(v.userDisplayName),
  };
}

/**
 * The script every document in a pane runs before its own scripts do.
 *
 * It wraps `navigator.credentials.create/get` for public-key requests only, asks Realm, and waits.
 * Waiting is not politeness: fact 2 above means a request dispatched before the fingerprint is a
 * request that can only fail.
 *
 * The reply function is a global because a CDP `Runtime.evaluate` has no other way into a closure,
 * and a page calling it itself gains nothing — it can resolve its own request early, and the
 * request then meets an authenticator with no keys and no presence, which is the same wall it would
 * have met anyway. What a page cannot do from here is put a key in that authenticator.
 */
export function passkeyShimSource(): string {
  return `(() => {
  const creds = navigator.credentials;
  if (!creds || !window.PublicKeyCredential) return;
  const origGet = creds.get.bind(creds);
  const origCreate = creds.create.bind(creds);
  const pending = new Map();
  let seq = 0;
  Object.defineProperty(window, ${JSON.stringify(PASSKEY_REPLY)}, {
    value: (id, verdict) => { const r = pending.get(id); pending.delete(id); if (r) r(verdict); },
    writable: false, enumerable: false, configurable: false,
  });
  const ask = (kind, options) => {
    const pk = options.publicKey || {};
    const user = pk.user || {};
    const id = kind + ":" + (++seq);
    const verdict = new Promise((resolve) => {
      pending.set(id, resolve);
      try {
        window[${JSON.stringify(PASSKEY_BINDING)}](JSON.stringify({
          t: "ask", id, kind,
          rpId: kind === "create" ? ((pk.rp || {}).id || null) : (pk.rpId || null),
          mediation: options.mediation || null,
          userName: String(user.name || ""),
          userDisplayName: String(user.displayName || ""),
        }));
      } catch (e) {
        // Realm is not listening (detached mid-page). Fall through to the real call rather than
        // holding a request nobody will ever answer.
        pending.delete(id);
        resolve("allow");
      }
    });
    return { id, verdict };
  };
  const wrap = (kind, orig) => async function (options) {
    if (!options || !options.publicKey) return orig(options);
    const { id, verdict } = ask(kind, options);
    const decision = await verdict;
    // Conditional mediation: Realm has no autofill surface to offer it to, and dispatching it would
    // break the modal request the page's own button makes next. A promise that never settles is what
    // a conditional get does when it has nothing to show.
    if (decision === "hold") return new Promise(() => {});
    if (decision !== "allow") {
      throw new DOMException("The request was refused by Realm.", "NotAllowedError");
    }
    let ok = false;
    try {
      const result = await orig(options);
      ok = true;
      return result;
    } finally {
      // Reported before the page is resumed, so Realm takes presence away and clears the keys at the
      // moment the request settles rather than whenever the page gets round to its own handler.
      try { window[${JSON.stringify(PASSKEY_BINDING)}](JSON.stringify({ t: "done", id, ok })); } catch (e) {}
    }
  };
  creds.create = wrap("create", origCreate);
  creds.get = wrap("get", origGet);
})();`;
}

type PaneState = {
  cdp: PasskeyCdp;
  authenticatorId: string;
  /** Resolves when the shim reports the in-flight request settled. */
  awaitingDone: Map<string, () => void>;
  /** One request at a time per pane: the next `ask` queues behind the last one's teardown, so two
   *  frames racing cannot leave one request's keys loaded under the other's presence window. */
  queue: Promise<void>;
};

export class PasskeyBroker {
  private panes = new Map<string, PaneState>();

  constructor(private readonly d: PasskeyBrokerDeps) {}

  /**
   * Install the authenticator and the shim in a freshly created pane.
   *
   * ORDER IS LOAD-BEARING. `WebAuthn.enable` and `addVirtualAuthenticator` answer on a view that has
   * never loaded a document, which is what puts a platform authenticator in place before the first
   * page runs. `Page`/`Runtime` do NOT: on a view with no document `Runtime.addBinding` never
   * returns, which is why browser-pane.ts loads `about:blank` before calling this.
   */
  async install(paneId: string, cdp: PasskeyCdp): Promise<void> {
    await cdp.send("WebAuthn.enable", { enableUI: false });
    const added = (await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: PASSKEY_AUTHENTICATOR_OPTIONS,
    })) as { authenticatorId?: string };
    const authenticatorId = added?.authenticatorId;
    if (!authenticatorId) throw new Error("no authenticator id");
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Runtime.addBinding", { name: PASSKEY_BINDING });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: passkeyShimSource() });
    const state: PaneState = { cdp, authenticatorId, awaitingDone: new Map(), queue: Promise.resolve() };
    this.panes.set(paneId, state);
    cdp.onEvent((method, params) => {
      if (method !== "Runtime.bindingCalled") return;
      const p = params as { name?: string; payload?: string; executionContextId?: number };
      if (p?.name !== PASSKEY_BINDING || typeof p.payload !== "string") return;
      this.onMessage(paneId, p.payload, p.executionContextId);
    });
  }

  /** The pane's view is gone. Nothing to unwind at the authenticator — it died with the view — but
   *  any request still waiting must be let go rather than left holding the queue. */
  release(paneId: string): void {
    const state = this.panes.get(paneId);
    if (!state) return;
    for (const resolve of state.awaitingDone.values()) resolve();
    this.panes.delete(paneId);
  }

  private onMessage(paneId: string, payload: string, contextId: number | undefined): void {
    const state = this.panes.get(paneId);
    if (!state) return;
    const msg = parsePasskeyMessage(payload);
    if (!msg) return;
    if (msg.t === "done") {
      const resolve = state.awaitingDone.get(msg.id);
      if (resolve) { state.awaitingDone.delete(msg.id); resolve(); }
      return;
    }
    state.queue = state.queue.then(() => this.handleAsk(paneId, state, msg, contextId)).catch(() => {});
  }

  private async handleAsk(
    paneId: string, state: PaneState, ask: PasskeyAsk, contextId: number | undefined,
  ): Promise<void> {
    const reply = (verdict: PasskeyVerdict) => this.reply(state, ask.id, verdict, contextId);

    // Held, not refused, and deliberately not audited: a sign-in page fires one of these on every
    // load, and a log line per page view would bury the ones that mean something.
    if (ask.mediation === "conditional") { await reply("hold"); return; }

    const url = this.d.pageUrl(paneId);
    const rpId = url ? passkeyRpIdForPageUrl(ask.rpId, url) : null;
    if (!rpId) {
      // The page asked for a passkey belonging to some other site, or from somewhere a passkey has
      // no business being used. Refused without a prompt: a fingerprint prompt naming a site the
      // user is not on is the exact reflex this gate exists to protect.
      await this.refuse(paneId, ask, reply, ask.rpId ?? "another site", "rp_mismatch", "rp_mismatch");
      return;
    }
    if (ask.kind === "get" && !this.d.hasPasskeyFor(rpId)) {
      await this.refuse(paneId, ask, reply, rpId, "none", "no_passkey");
      return;
    }
    if (!this.d.canPromptPresence()) {
      await this.refuse(paneId, ask, reply, rpId, "unavailable", "no_presence");
      return;
    }

    const known = new Set<string>();
    let released = false;
    const result = await this.d.withPasskeysFor(rpId, ask.kind, async (keys) => {
      for (const key of keys) {
        known.add(key.credentialId);
        await state.cdp.send("WebAuthn.addCredential", {
          authenticatorId: state.authenticatorId,
          credential: {
            credentialId: key.credentialId,
            // Faithful to how the key was registered: restoring a non-discoverable credential as a
            // discoverable one would offer it to requests that named no allowlist, and CDP refuses a
            // resident credential with no user handle outright.
            isResidentCredential: key.userHandle !== null,
            rpId: key.rpId,
            privateKey: key.privateKey,
            ...(key.userHandle !== null ? { userHandle: key.userHandle } : {}),
            signCount: key.signCount,
            backupEligibility: false,
            backupState: false,
          },
        });
      }
      await state.cdp.send("WebAuthn.setUserVerified", { authenticatorId: state.authenticatorId, isUserVerified: true });
      await state.cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId: state.authenticatorId, enabled: true });
      released = true;
      await reply("allow");
      await this.awaitDone(state, ask.id);
    }).catch(() => ({ ok: false, refused: "no_presence" } as const));

    // Presence goes away first, before anything that could throw: it is the only part of this
    // teardown whose omission would leave a pane able to sign without a fingerprint.
    await this.disarm(state);
    // A request that was never released is one the page is still waiting on: settle it and say why.
    if (!result.ok && !released) {
      await this.refuse(paneId, ask, reply, rpId, result.refused === "no_presence" ? "no_presence" : "none",
        result.refused === "no_presence" ? "no_presence" : "no_passkey");
      return;
    }
    // Everything past release reconciles, INCLUDING a failure that happened after it — that branch is
    // the one where keys are already in the authenticator, so it is the one that most needs clearing.
    await this.reconcile(state, ask, rpId, known);
  }

  /** Let the page's promise settle, tell the pane why, and write the audit line — in that order, so
   *  a user staring at a sign-in button is never waiting on a log write. */
  private async refuse(
    paneId: string, ask: PasskeyAsk, reply: (v: PasskeyVerdict) => Promise<void>,
    rpId: string, refused: PasskeyRefusal, outcome: PasskeyAuditEntry["outcome"],
  ): Promise<void> {
    await reply("deny");
    this.d.notify({ browserId: paneId, rpId, kind: ask.kind, refused });
    this.d.audit({ ts: this.d.now(), rpId, kind: ask.kind, outcome });
  }

  /** What the authenticator keeps after a request: nothing. Presence off, verification off, and every
   *  key out of the pane — a pane sitting idle holds no key material. */
  private async disarm(state: PaneState): Promise<void> {
    const off = async (method: string, params: Record<string, unknown>) => {
      try { await state.cdp.send(method, { authenticatorId: state.authenticatorId, ...params }); } catch { /* view gone */ }
    };
    await off("WebAuthn.setAutomaticPresenceSimulation", { enabled: false });
    await off("WebAuthn.setUserVerified", { isUserVerified: false });
  }

  /** Read what the request left behind, persist it, then clear the authenticator out. */
  private async reconcile(state: PaneState, ask: PasskeyAsk, rpId: string, known: Set<string>): Promise<void> {
    let credentials: Array<Record<string, unknown>> = [];
    try {
      const got = (await state.cdp.send("WebAuthn.getCredentials", { authenticatorId: state.authenticatorId })) as
        { credentials?: Array<Record<string, unknown>> };
      credentials = got?.credentials ?? [];
    } catch { /* the view went away mid-request; nothing to persist and nothing to clear */ }

    for (const c of credentials) {
      const credentialId = typeof c.credentialId === "string" ? c.credentialId : null;
      if (!credentialId) continue;
      const signCount = typeof c.signCount === "number" ? c.signCount : 0;
      if (known.has(credentialId)) {
        // An assertion happened (or did not — the counter only moves when it did). Written back
        // because a relying party that sees a counter go backwards may treat the authenticator as
        // cloned, and the pane's copy dies with the pane.
        this.d.notePasskeyUse(credentialId, signCount);
        continue;
      }
      // Not one Realm loaded, so the page just registered it. The private key is only readable here,
      // between the authenticator minting it and this function clearing it out.
      const privateKey = typeof c.privateKey === "string" ? c.privateKey : null;
      if (!privateKey) continue;
      this.d.recordPasskey({
        rpId,
        userName: ask.userName,
        userDisplayName: ask.userDisplayName,
        credentialId,
        userHandle: typeof c.userHandle === "string" ? c.userHandle : null,
        signCount,
        privateKey,
      });
      this.d.audit({ ts: this.d.now(), rpId, kind: ask.kind, outcome: "created" });
    }
    if (ask.kind === "get") this.d.audit({ ts: this.d.now(), rpId, kind: ask.kind, outcome: "used" });
    try {
      await state.cdp.send("WebAuthn.clearCredentials", { authenticatorId: state.authenticatorId });
    } catch { /* view gone; the keys went with it */ }
  }

  private awaitDone(state: PaneState, id: string): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(timer); state.awaitingDone.delete(id); resolve(); };
      const timer = setTimeout(finish, PASSKEY_REQUEST_TIMEOUT_MS);
      // Unref so a pane waiting on a request cannot hold the app open at quit.
      (timer as unknown as { unref?: () => void }).unref?.();
      state.awaitingDone.set(id, finish);
    });
  }

  private async reply(state: PaneState, id: string, verdict: PasskeyVerdict, contextId: number | undefined): Promise<void> {
    const expression = `window[${JSON.stringify(PASSKEY_REPLY)}](${JSON.stringify(id)}, ${JSON.stringify(verdict)})`;
    try {
      await state.cdp.send("Runtime.evaluate", {
        expression, silent: true, returnByValue: true,
        // The frame the request came FROM, which may be an iframe: the shim's reply map lives in that
        // frame's context and nowhere else.
        ...(contextId !== undefined ? { contextId } : {}),
      });
    } catch { /* the frame navigated away; its promise died with it */ }
  }
}
