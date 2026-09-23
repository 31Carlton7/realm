import { describe, expect, it, vi } from "vitest";
import {
  PASSKEY_BINDING, PASSKEY_REPLY, PasskeyBroker, parsePasskeyMessage, passkeyShimSource,
  type PasskeyBrokerDeps, type PasskeyCdp,
} from "./passkeys";
import type { PasskeyAuditEntry, PasskeyKeyMaterial } from "./secret-store";
import type { PasskeyNotice } from "@realm/contracts";

/**
 * The broker's mutants, each of which is a working sign-in that should not be one:
 *   - presence enabled before the fingerprint, or left enabled after the request;
 *   - the rp id taken from the page's claim instead of the pane's URL;
 *   - a conditional-mediation get dispatched (which silently breaks the modal one after it);
 *   - a Touch ID prompt raised for a site Realm holds no passkey for;
 *   - keys left loaded in the authenticator once the request has settled;
 *   - the signature counter not written back;
 *   - a refusal that never settles the page's promise, so the button spins forever.
 */

const KEY: PasskeyKeyMaterial = {
  credentialId: "Y3JlZC0x", rpId: "github.com", userHandle: "dXNlcg==",
  privateKey: "cGstMQ==", signCount: 3,
};

type Sent = { method: string; params: Record<string, unknown> };

function harness(over: Partial<PasskeyBrokerDeps> = {}, keys: PasskeyKeyMaterial[] = [KEY]) {
  const sent: Sent[] = [];
  const notices: PasskeyNotice[] = [];
  const audits: PasskeyAuditEntry[] = [];
  const prompted: string[] = [];
  const recorded: unknown[] = [];
  const counters: { credentialId: string; signCount: number }[] = [];
  let listener: ((method: string, params: unknown) => void) | null = null;
  /** What `WebAuthn.getCredentials` answers after the request — the test's stand-in for what the
   *  authenticator actually did. */
  let credentials: Array<Record<string, unknown>> = [];
  let presenceGranted = true;

  const cdp: PasskeyCdp = {
    send: async (method, params = {}) => {
      sent.push({ method, params });
      if (method === "WebAuthn.addVirtualAuthenticator") return { authenticatorId: "auth-1" };
      if (method === "WebAuthn.getCredentials") return { credentials };
      return {};
    },
    onEvent: (cb) => { listener = cb; },
  };

  const deps: PasskeyBrokerDeps = {
    pageUrl: () => "https://github.com/login",
    hasPasskeyFor: (rpId) => keys.some((k) => k.rpId === rpId),
    withPasskeysFor: async (rpId, kind, use) => {
      prompted.push(`${kind}:${rpId}`);
      if (kind === "get" && !keys.some((k) => k.rpId === rpId)) return { ok: false, refused: "no_passkey" };
      if (!presenceGranted) return { ok: false, refused: "no_presence" };
      await use(keys.filter((k) => k.rpId === rpId));
      return { ok: true };
    },
    recordPasskey: (input) => { recorded.push(input); },
    notePasskeyUse: (credentialId, signCount) => { counters.push({ credentialId, signCount }); },
    canPromptPresence: () => true,
    notify: (n) => { notices.push(n); },
    audit: (e) => { audits.push(e); },
    now: () => 1_000,
    ...over,
  };

  const broker = new PasskeyBroker(deps);
  return {
    broker, cdp, sent, notices, audits, prompted, recorded, counters,
    setCredentials: (c: Array<Record<string, unknown>>) => { credentials = c; },
    denyPresence: () => { presenceGranted = false; },
    fire: (payload: Record<string, unknown>) => {
      listener?.("Runtime.bindingCalled", { name: PASSKEY_BINDING, payload: JSON.stringify(payload), executionContextId: 7 });
    },
    /** What the shim was told. `Runtime.evaluate` is the only channel back into the page. */
    verdicts: () => sent.filter((s) => s.method === "Runtime.evaluate").map((s) => String(s.params.expression)),
    methods: () => sent.map((s) => s.method),
  };
}

const ask = (over: Record<string, unknown> = {}) => ({
  t: "ask", id: "get:1", kind: "get", rpId: "github.com", mediation: null,
  userName: "ada", userDisplayName: "Ada", ...over,
});

/** The broker queues work on promise chains an await cannot see the end of. Poll instead. */
async function until(check: () => boolean): Promise<void> {
  await vi.waitFor(() => { if (!check()) throw new Error("not yet"); }, { timeout: 1000, interval: 1 });
}

describe("PasskeyBroker — install", () => {
  it("puts a platform authenticator in place with presence and verification OFF", async () => {
    const h = harness();
    await h.broker.install("b1", h.cdp);
    const added = h.sent.find((s) => s.method === "WebAuthn.addVirtualAuthenticator")!;
    const options = added.params.options as Record<string, unknown>;
    // `internal` is what makes a site treat it as a platform authenticator — the whole "partial
    // passkey support" complaint.
    expect(options.transport).toBe("internal");
    expect(options.hasUserVerification).toBe(true);
    // The resting state: nothing an agent driving this pane can sign with.
    expect(options.automaticPresenceSimulation).toBe(false);
    expect(options.isUserVerified).toBe(false);
  });

  it("registers the shim and the binding, in an order that works on a view with no page yet", async () => {
    const h = harness();
    await h.broker.install("b1", h.cdp);
    const methods = h.methods();
    // Page/Runtime must come AFTER WebAuthn: on a document-less view they never return, which is
    // why browser-pane.ts loads about:blank first and why the authenticator goes in before them.
    expect(methods.indexOf("WebAuthn.addVirtualAuthenticator")).toBeLessThan(methods.indexOf("Page.enable"));
    expect(methods).toContain("Runtime.addBinding");
    const script = h.sent.find((s) => s.method === "Page.addScriptToEvaluateOnNewDocument")!;
    expect(String(script.params.source)).toContain(PASSKEY_BINDING);
  });
});

describe("PasskeyBroker — refusals", () => {
  it("HOLDS a conditional-mediation get instead of dispatching it (a pending one breaks the modal request after it)", async () => {
    const h = harness();
    await h.broker.install("b1", h.cdp);
    h.fire(ask({ mediation: "conditional" }));
    await until(() => h.verdicts().length > 0);
    expect(h.verdicts()[0]).toContain('"hold"');
    // No prompt, no notice, no audit line: this fires on every page load of every sign-in page.
    expect(h.prompted).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it("derives the rp id from the PANE'S URL and refuses a page claiming to be another site", async () => {
    const h = harness({ pageUrl: () => "https://github.com.evil.example/login" });
    await h.broker.install("b1", h.cdp);
    h.fire(ask({ rpId: "github.com" }));
    await until(() => h.notices.length > 0);
    expect(h.verdicts().some((v) => v.includes('"deny"'))).toBe(true);
    // The mutant that matters: a fingerprint prompt naming a site the user is not on.
    expect(h.prompted).toEqual([]);
    expect(h.notices[0]).toMatchObject({ refused: "rp_mismatch", rpId: "github.com" });
    expect(h.audits[0]).toMatchObject({ outcome: "rp_mismatch" });
  });

  it("allows a subdomain to use its parent's passkey, which is what WebAuthn scoping is for", async () => {
    const h = harness({ pageUrl: () => "https://gist.github.com/x" });
    await h.broker.install("b1", h.cdp);
    h.fire(ask({ rpId: "github.com" }));
    await until(() => h.prompted.length > 0);
    expect(h.prompted).toEqual(["get:github.com"]);
  });

  it("refuses a get for a site it holds no passkey for WITHOUT raising a prompt that could only fail", async () => {
    const h = harness({}, []);
    await h.broker.install("b1", h.cdp);
    h.fire(ask());
    await until(() => h.notices.length > 0);
    expect(h.prompted).toEqual([]);
    expect(h.notices[0]).toMatchObject({ refused: "none", rpId: "github.com", kind: "get" });
    expect(h.verdicts().some((v) => v.includes('"deny"'))).toBe(true);
  });

  it("says so plainly on a Mac that cannot run the check at all", async () => {
    const h = harness({ canPromptPresence: () => false });
    await h.broker.install("b1", h.cdp);
    h.fire(ask());
    await until(() => h.notices.length > 0);
    expect(h.notices[0]).toMatchObject({ refused: "unavailable" });
    expect(h.prompted).toEqual([]);
  });

  it("a refused fingerprint settles the page's promise rather than leaving the button spinning", async () => {
    const h = harness();
    h.denyPresence();
    await h.broker.install("b1", h.cdp);
    h.fire(ask());
    await until(() => h.notices.length > 0);
    expect(h.notices[0]).toMatchObject({ refused: "no_presence" });
    expect(h.verdicts().some((v) => v.includes('"deny"'))).toBe(true);
    // And nothing was ever armed.
    expect(h.methods()).not.toContain("WebAuthn.addCredential");
    const presenceOn = h.sent.filter((s) => s.method === "WebAuthn.setAutomaticPresenceSimulation" && s.params.enabled === true);
    expect(presenceOn).toEqual([]);
  });
});

describe("PasskeyBroker — an approved assertion", () => {
  async function approvedGet(h: ReturnType<typeof harness>) {
    await h.broker.install("b1", h.cdp);
    h.setCredentials([{ credentialId: KEY.credentialId, rpId: "github.com", signCount: 9, privateKey: "cGstMQ==", userHandle: KEY.userHandle }]);
    h.fire(ask());
    await until(() => h.verdicts().some((v) => v.includes('"allow"')));
    h.fire({ t: "done", id: "get:1", ok: true });
    await until(() => h.methods().includes("WebAuthn.clearCredentials"));
  }

  it("loads the key, turns presence on, and only THEN releases the page", async () => {
    const h = harness();
    await approvedGet(h);
    const order = h.methods();
    const addCredential = order.indexOf("WebAuthn.addCredential");
    const presenceOn = h.sent.findIndex((s) => s.method === "WebAuthn.setAutomaticPresenceSimulation" && s.params.enabled === true);
    const allow = h.sent.findIndex((s) => s.method === "Runtime.evaluate" && String(s.params.expression).includes('"allow"'));
    expect(addCredential).toBeGreaterThan(-1);
    expect(addCredential).toBeLessThan(presenceOn);
    // Presence cannot be granted after a request is in flight (measured) — so it must precede the
    // release, not follow it.
    expect(presenceOn).toBeLessThan(allow);
  });

  it("takes presence away and clears every key once the request has settled", async () => {
    const h = harness();
    await approvedGet(h);
    const presenceOff = h.sent.findIndex((s) => s.method === "WebAuthn.setAutomaticPresenceSimulation" && s.params.enabled === false);
    const verifiedOff = h.sent.findIndex((s) => s.method === "WebAuthn.setUserVerified" && s.params.isUserVerified === false);
    expect(presenceOff).toBeGreaterThan(-1);
    expect(verifiedOff).toBeGreaterThan(-1);
    // A pane sitting idle holds no key material at all.
    expect(h.methods()).toContain("WebAuthn.clearCredentials");
    // …and presence goes away BEFORE anything that could throw on the way out.
    expect(presenceOff).toBeLessThan(h.methods().lastIndexOf("WebAuthn.clearCredentials"));
  });

  it("writes the signature counter back from what the authenticator actually reported", async () => {
    const h = harness();
    await approvedGet(h);
    expect(h.counters).toEqual([{ credentialId: KEY.credentialId, signCount: 9 }]);
    expect(h.recorded).toEqual([]);
    expect(h.audits.some((a) => a.outcome === "used")).toBe(true);
  });

  it("restores a non-discoverable credential as one, rather than making it discoverable", async () => {
    const h = harness({}, [{ ...KEY, userHandle: null }]);
    await h.broker.install("b1", h.cdp);
    h.fire(ask());
    await until(() => h.methods().includes("WebAuthn.addCredential"));
    const added = h.sent.find((s) => s.method === "WebAuthn.addCredential")!;
    const credential = added.params.credential as Record<string, unknown>;
    expect(credential.isResidentCredential).toBe(false);
    // CDP refuses a resident credential with no user handle outright, so the field must be absent.
    expect(credential).not.toHaveProperty("userHandle");
  });

  it("clears the keys even when the request blows up AFTER the page was released", async () => {
    const h = harness({
      withPasskeysFor: async (_rpId, _kind, use) => {
        await use([KEY]);
        throw new Error("the view went away mid-request");
      },
    });
    await h.broker.install("b1", h.cdp);
    h.fire(ask());
    await until(() => h.verdicts().some((v) => v.includes('"allow"')));
    h.fire({ t: "done", id: "get:1", ok: false });
    // The branch that most needs clearing is the one where keys are already loaded.
    await until(() => h.methods().includes("WebAuthn.clearCredentials"));
    expect(h.sent.some((s) => s.method === "WebAuthn.setAutomaticPresenceSimulation" && s.params.enabled === false)).toBe(true);
  });
});

describe("PasskeyBroker — a registration", () => {
  it("stores the new key under the rp id REALM derived, not the one the page asked for", async () => {
    const h = harness({ pageUrl: () => "https://gist.github.com/settings" }, []);
    await h.broker.install("b1", h.cdp);
    h.setCredentials([{ credentialId: "bmV3", rpId: "github.com", signCount: 1, privateKey: "bmV3LWtleQ==", userHandle: "dQ==" }]);
    h.fire(ask({ id: "create:1", kind: "create", rpId: "github.com", userName: "ada@example.com" }));
    await until(() => h.verdicts().some((v) => v.includes('"allow"')));
    h.fire({ t: "done", id: "create:1", ok: true });
    await until(() => h.recorded.length > 0);
    expect(h.recorded[0]).toMatchObject({
      rpId: "github.com", credentialId: "bmV3", privateKey: "bmV3LWtleQ==",
      userName: "ada@example.com", signCount: 1,
    });
    expect(h.audits.some((a) => a.outcome === "created")).toBe(true);
  });
});

describe("the page shim", () => {
  /** Run the injected source against a stub `navigator.credentials`, the way a real document does. */
  function runShim() {
    const calls: { kind: string; options: unknown }[] = [];
    const asks: Array<Record<string, unknown>> = [];
    const win = {
      PublicKeyCredential: function () {},
      DOMException: class extends Error { constructor(msg: string, public name: string) { super(msg); } },
      navigator: {
        credentials: {
          create: async (options: unknown) => { calls.push({ kind: "create", options }); return { id: "made" }; },
          get: async (options: unknown) => { calls.push({ kind: "get", options }); return { id: "asserted" }; },
        },
      },
      [PASSKEY_BINDING]: (payload: string) => { asks.push(JSON.parse(payload) as Record<string, unknown>); },
    } as unknown as Record<string, unknown> & { navigator: { credentials: { create: (o: unknown) => Promise<unknown>; get: (o: unknown) => Promise<unknown> } } };
    const fn = new Function("window", "navigator", "DOMException", `${passkeyShimSource()}`);
    fn(win, win.navigator, (win as Record<string, unknown>).DOMException);
    const reply = win[PASSKEY_REPLY] as (id: string, verdict: string) => void;
    return { win, calls, asks, reply };
  }

  const options = { publicKey: { rpId: "github.com" } };

  it("asks Realm and does NOT dispatch until it is told to", async () => {
    const s = runShim();
    const promise = s.win.navigator.credentials.get(options);
    await Promise.resolve();
    expect(s.asks[0]).toMatchObject({ t: "ask", kind: "get", rpId: "github.com" });
    // The whole reason the shim blocks: a request dispatched before the fingerprint can only fail.
    expect(s.calls).toEqual([]);
    s.reply(String(s.asks[0]!.id), "allow");
    await expect(promise).resolves.toMatchObject({ id: "asserted" });
    expect(s.calls).toHaveLength(1);
  });

  it("reports back when the request settles, so Realm can take presence away", async () => {
    const s = runShim();
    const promise = s.win.navigator.credentials.get(options);
    await Promise.resolve();
    s.reply(String(s.asks[0]!.id), "allow");
    await promise;
    expect(s.asks[1]).toMatchObject({ t: "done", ok: true });
  });

  it("a refusal throws NotAllowedError, which is what a dismissed browser sheet does", async () => {
    const s = runShim();
    const promise = s.win.navigator.credentials.get(options);
    await Promise.resolve();
    s.reply(String(s.asks[0]!.id), "deny");
    await expect(promise).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(s.calls).toEqual([]);
  });

  it("a held request never settles and never reaches the authenticator", async () => {
    const s = runShim();
    let settled = false;
    void s.win.navigator.credentials.get(options).then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    s.reply(String(s.asks[0]!.id), "hold");
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);
    expect(s.calls).toEqual([]);
  });

  it("leaves a non-WebAuthn credential request alone", async () => {
    const s = runShim();
    await s.win.navigator.credentials.get({ password: true });
    expect(s.asks).toEqual([]);
    expect(s.calls).toHaveLength(1);
  });
});

describe("parsePasskeyMessage", () => {
  it("clips the two relying-party-authored strings and keeps nothing else the page sent", () => {
    const parsed = parsePasskeyMessage(JSON.stringify({
      t: "ask", id: "1", kind: "create", rpId: "github.com",
      userName: "x".repeat(400), userDisplayName: "y".repeat(400), extra: "ignored",
    }));
    expect(parsed).toEqual({
      t: "ask", id: "1", kind: "create", rpId: "github.com", mediation: null,
      userName: "x".repeat(128), userDisplayName: "y".repeat(128),
    });
  });

  it("refuses anything that is not one of the two shapes rather than half-parsing it", () => {
    expect(parsePasskeyMessage("not json")).toBeNull();
    expect(parsePasskeyMessage(JSON.stringify({ t: "ask", id: "1", kind: "sign" }))).toBeNull();
    expect(parsePasskeyMessage(JSON.stringify({ t: "ask", kind: "get" }))).toBeNull();
  });
});
