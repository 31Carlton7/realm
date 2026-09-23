import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_MAX_RECHECKS, DEFAULT_FAILOVER_POLICY, failoverPolicyKey, handoffContextKey,
  type AgentKind, type Session, type SessionEvent } from "@realm/contracts";
import { FailoverService } from "./failover";
import type { SendMessage } from "./service";

/**
 * These tests are about the two expensive mistakes, not about the happy path.
 *
 * Retrying something that cannot succeed spends someone's quota in a loop. Handing a session to
 * another agent when it did not need handing over rewrites whose work it is — and who is billed for
 * it — behind their back. Every `expect(...).toBe("stop")` below is one of those not happening.
 */

const msg: SendMessage = { text: "do the thing", attachments: [] };

function harness(opts: {
  policy?: unknown; agentKind?: AgentKind; available?: boolean;
  /** What each agent's CLI says about being signed in. A function so a test can have one agent
   *  signed out and the next one signed in, which is the only way to tell a carried verdict from a
   *  fresh one. */
  loggedIn?: boolean | null | ((k: AgentKind) => boolean | null);
} = {}) {
  const settings = new Map<string, unknown>([["failover.policy:sp1", opts.policy]]);
  let session: Session = {
    id: "se1", spaceId: "sp1", projectId: null, agentKind: opts.agentKind ?? "claude",
    model: "claude-opus-5", effort: null, permissionMode: "default", fastMode: false,
    environmentId: "en1", cwd: "/tmp/x", status: "running", providerSessionId: "prov-1",
    title: "t", lastEventSeq: 0, seenSeq: 0, terminalItemId: null, dispatchedBy: null,
    createdAt: 0, updatedAt: 0,
  } as Session;

  const emitted: SessionEvent[] = [];
  const resent: string[] = [];
  const stopped: string[] = [];
  /** Every probe the re-auth path asked for, so a test can prove it forced past the cache. */
  const probes: { force: boolean }[] = [];
  // The timer is captured rather than run, so a test decides when the backoff elapses and the suite
  // never actually waits twelve seconds to prove a ladder.
  let pending: (() => void) | null = null;

  const svc = new FailoverService({
    sessions: {
      get: () => session,
      update: (u: Partial<Session> & { id: string }) => { session = { ...session, ...u } as Session; return session; },
    } as never,
    events: { transcript: () => [{ role: "user" as const, text: "do the thing" }] } as never,
    settings: {
      get: (k: string) => settings.get(k),
      set: (k: string, v: unknown) => { settings.set(k, v); },
    } as never,
    adapters: { claude: {}, codex: {}, "acp:gemini": {} } as never,
    emit: (_id, ev) => { emitted.push(ev); },
    resend: async (id, m) => { resent.push(`${id}:${m.text}`); },
    stop: async (id) => { stopped.push(id); },
    probe: async (o) => {
      probes.push(o);
      const answer = typeof opts.loggedIn === "function" ? opts.loggedIn(session.agentKind) : opts.loggedIn ?? null;
      return [{ kind: session.agentKind, available: opts.available ?? true, version: "1", loggedIn: answer, reason: null }];
    },
    setTimer: (fn) => { pending = fn; return 0 as never; },
    clearTimer: () => { pending = null; },
  });

  return {
    svc, emitted, resent, stopped, settings, probes,
    session: () => session,
    fire: () => { const f = pending; pending = null; f?.(); },
    hasTimer: () => pending !== null,
    /** Let the re-auth probe's promise chain finish. `onError` returns before it has run — that is
     *  the point of the fire-and-forget — so every assertion about what a probe decided has to wait
     *  for the microtasks it queued. */
    settled: () => new Promise<void>((r) => setTimeout(r, 0)),
  };
}

const RETRY_CHAIN = { retry: true, chain: ["codex"] };

describe("what failover does with an error", () => {
  it("does nothing at all for an ordinary failure", () => {
    // The overwhelmingly common case, and the one where doing something would be worst: an agent
    // that failed because the code is wrong fails identically on the next agent.
    const h = harness({ policy: RETRY_CHAIN });
    h.svc.turnStarted("se1", msg);
    expect(h.svc.onError(h.session(), "TypeError: undefined is not a function")).toBe("stop");
    expect(h.resent).toEqual([]);
    expect(h.stopped).toEqual([]);
    expect(h.emitted).toEqual([]);
  });

  it("retries the same agent on a dropped socket, and replays the turn when the wait elapses", () => {
    const h = harness({ policy: RETRY_CHAIN });
    h.svc.turnStarted("se1", msg);
    expect(h.svc.onError(h.session(), "read ECONNRESET")).toBe("retry");
    expect(h.emitted[0]).toMatchObject({ type: "retrying", payload: { attempt: 1, reason: "transient" } });
    // Nothing has been replayed yet — the backoff is the point.
    expect(h.resent).toEqual([]);
    h.fire();
    expect(h.resent).toEqual(["se1:do the thing"]);
    // And the agent did NOT change: a hiccup is not a reason to rewrite whose work this is.
    expect(h.session().agentKind).toBe("claude");
  });

  it("stops asking after the ladder runs out, then hands over", () => {
    const h = harness({ policy: RETRY_CHAIN });
    h.svc.turnStarted("se1", msg);
    for (let i = 1; i <= 3; i++) {
      expect(h.svc.onError(h.session(), "socket hang up"), `attempt ${i}`).toBe("retry");
      h.fire();
    }
    // A fourth transient failure is not a fourth wait. `transient` is not handoffable, so this
    // stops rather than moving the session — the wire being unreliable is not the agent's fault.
    expect(h.svc.onError(h.session(), "socket hang up")).toBe("stop");
    expect(h.session().agentKind).toBe("claude");
  });

  it("hands over immediately on a usage limit, without spending a single retry", () => {
    // Waiting does not help on any horizon a session cares about, and each wait is a wasted call
    // against a quota that is already gone.
    const h = harness({ policy: RETRY_CHAIN });
    h.svc.turnStarted("se1", msg);
    expect(h.svc.onError(h.session(), "Claude AI usage limit reached|1788555903")).toBe("handoff");
    expect(h.hasTimer()).toBe(false);
  });

  it("never hands over when the chain is empty, and says why", async () => {
    // The default. Moving work between agents changes who is billed for it, so it is a decision the
    // user makes once rather than one Realm makes silently — but a user who just lost an hour to a
    // usage limit should learn that a chain is the thing that would have helped.
    const h = harness({ policy: DEFAULT_FAILOVER_POLICY });
    h.svc.turnStarted("se1", msg);
    expect(h.svc.onError(h.session(), "usage limit reached")).toBe("stop");
    expect(h.session().agentKind).toBe("claude");
    expect(h.emitted[0]).toMatchObject({ type: "error" });
    expect((h.emitted[0] as { payload: { message: string } }).payload.message)
      .toContain("no fallback agent is configured");
  });

  it("refuses to resume a turn the user cancelled", async () => {
    // The rudest thing this service could do, and the one that would make people turn it off.
    const h = harness({ policy: RETRY_CHAIN });
    h.svc.turnStarted("se1", msg);
    h.svc.onError(h.session(), "fetch failed");
    h.svc.cancel("se1");
    h.fire();
    expect(h.resent).toEqual([]);
  });

  it("has nothing to replay for a failure outside a turn it saw start", () => {
    // A boot-time drain, or an error from a producer other than `send`. Reporting it is all that is
    // honest; replaying a message this service never held would replay the wrong one.
    const h = harness({ policy: RETRY_CHAIN });
    expect(h.svc.onError(h.session(), "usage limit reached")).toBe("stop");
    expect(h.resent).toEqual([]);
  });
});

describe("the handover itself", () => {
  const run = async (policy: unknown = RETRY_CHAIN) => {
    const h = harness({ policy });
    h.svc.turnStarted("se1", msg);
    h.svc.onError(h.session(), "usage limit reached");
    await vi.waitFor(() => expect(h.resent.length).toBe(1));
    return h;
  };

  it("tears the old adapter down BEFORE the row moves", async () => {
    // A handle outliving its own `agentKind` would keep pumping the old agent's events into a
    // session that now claims to be another one.
    const h = await run();
    expect(h.stopped).toEqual(["se1"]);
    expect(h.session().agentKind).toBe("codex");
  });

  it("clears every per-kind field, because none of them survives the move", async () => {
    const h = await run();
    // A stale providerSessionId would ask Codex to resume a thread it has never heard of; a stale
    // model id would ask it for a model from another vendor's catalogue.
    expect(h.session().providerSessionId).toBeNull();
    expect(h.session().model).toBeNull();
    expect(h.session().effort).toBeNull();
  });

  it("writes the briefing the incoming agent will read on start", async () => {
    const h = await run();
    const carried = h.settings.get(handoffContextKey("se1"));
    expect(typeof carried).toBe("string");
    expect(String(carried)).toContain("running on Claude");
    expect(h.svc.extraSystemContext("se1")).toBe(carried);
  });

  it("puts the seam on the transcript before replaying the turn", async () => {
    const h = await run();
    const handoff = h.emitted.find((e) => e.type === "handoff");
    expect(handoff).toMatchObject({ payload: { from: "claude", to: "codex", reason: "usage_limit" } });
    expect((handoff as { payload: { note: string } }).payload.note)
      .toBe("Claude hit its usage limit. Continuing on Codex.");
    expect(h.resent).toEqual(["se1:do the thing"]);
  });

  it("walks the chain rather than looping back onto an agent that already failed", async () => {
    const h = harness({ policy: { retry: false, chain: ["claude", "codex", "acp:gemini"] } });
    h.svc.turnStarted("se1", msg);
    // `claude` is first in the chain AND the agent that just failed. Picking it would hand the turn
    // straight back to the exhausted quota it just came from.
    h.svc.onError(h.session(), "usage limit reached");
    await vi.waitFor(() => expect(h.session().agentKind).toBe("codex"));
    h.svc.onError(h.session(), "usage limit reached");
    await vi.waitFor(() => expect(h.session().agentKind).toBe("acp:gemini"));
    // Chain exhausted: the third failure stops rather than starting over at the top.
    expect(h.svc.onError(h.session(), "usage limit reached")).toBe("stop");
    expect(h.session().agentKind).toBe("acp:gemini");
  });

  it("gives the incoming agent a full retry ladder of its own", async () => {
    // The reason the old agent was out of attempts says nothing about this one.
    const h = harness({ policy: { retry: true, chain: ["codex"] } });
    h.svc.turnStarted("se1", msg);
    for (let i = 0; i < 3; i++) { h.svc.onError(h.session(), "socket hang up"); h.fire(); }
    h.svc.onError(h.session(), "usage limit reached");
    await vi.waitFor(() => expect(h.session().agentKind).toBe("codex"));
    expect(h.svc.onError(h.session(), "socket hang up")).toBe("retry");
  });
});

describe("the policy row", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  it("degrades a malformed stored row to the default rather than throwing", () => {
    // A settings row nobody can parse must not be able to break `send`.
    const bad = harness({ policy: { retry: "yes", chain: "codex" } });
    expect(bad.svc.policy("sp1")).toEqual(DEFAULT_FAILOVER_POLICY);
  });

  it("drops kinds this build has no adapter for instead of refusing to save", () => {
    const saved = h.svc.setPolicy("sp1", { retry: true, chain: ["codex", "acp:qwen", "codex"] });
    expect(saved).toEqual({ retry: true, chain: ["codex"] });
    expect(h.settings.get(failoverPolicyKey("sp1"))).toEqual(saved);
  });
});

describe("shutdown and deletion", () => {
  it("drops a pending retry on close, and never schedules after it", () => {
    const h = harness({ policy: RETRY_CHAIN });
    h.svc.turnStarted("se1", msg);
    h.svc.onError(h.session(), "fetch failed");
    h.svc.close();
    expect(h.hasTimer()).toBe(false);
    // A late error arriving from a still-draining pump must not start anything new.
    h.svc.turnStarted("se1", msg);
    expect(h.svc.onError(h.session(), "fetch failed")).toBe("stop");
  });

  it("forgets a deleted session's carried briefing", async () => {
    const h = harness({ policy: RETRY_CHAIN });
    h.svc.turnStarted("se1", msg);
    h.svc.onError(h.session(), "usage limit reached");
    await vi.waitFor(() => expect(h.svc.extraSystemContext("se1")).toBeTruthy());
    h.svc.release("se1");
    expect(h.svc.extraSystemContext("se1")).toBeUndefined();
  });
});

/**
 * Re-authentication.
 *
 * The failure this exists for was watched happening: on 2026-09-16 four turns across four sessions
 * died to "OAuth session expired and could not be refreshed" inside two minutes, and the CLI's
 * keychain entry was rewritten six minutes later. Every one of them was a turn that would have
 * finished if anything had asked again — and none of them did, because the classifier did not know
 * the phrase and `auth` never retried in any case.
 *
 * So the tests below are about the difference between asking again and asking again FOR A REASON.
 * A blind auth retry is the mistake this must not make: it would loop a genuinely signed-out user
 * through three waits and tell them nothing.
 */
const AUTH_ERROR = "Failed to authenticate: OAuth session expired and could not be refreshed";

describe("an auth failure", () => {
  it("retries when the agent's own CLI says it is signed in", async () => {
    const h = harness({ policy: { retry: true, chain: [] }, loggedIn: true });
    h.svc.turnStarted("se1", msg);
    expect(h.svc.onError(h.session(), AUTH_ERROR)).toBe("reauth");
    await h.settled();
    // Forced, not cached: the thirty seconds the probe cache holds are the thirty seconds in which
    // the credential changed.
    expect(h.probes).toEqual([{ force: true }]);
    const retrying = h.emitted.find((e) => e.type === "retrying");
    expect(retrying?.payload).toMatchObject({ reason: "auth", attempt: 1 });
    h.fire();
    expect(h.resent).toEqual(["se1:do the thing"]);
  });

  it("stops at once when the CLI says it is signed out, and names the command that fixes it", async () => {
    // The whole point of asking: a signed-out user must not sit through a ladder that cannot work.
    const h = harness({ policy: { retry: true, chain: [] }, loggedIn: false });
    h.svc.turnStarted("se1", msg);
    h.svc.onError(h.session(), AUTH_ERROR);
    await h.settled();
    expect(h.emitted.some((e) => e.type === "retrying")).toBe(false);
    expect(h.hasTimer()).toBe(false);
    expect(h.resent).toEqual([]);
    const err = h.emitted.find((e) => e.type === "error");
    expect(err?.payload).toMatchObject({ failure: "auth", fix: { command: "claude auth login" } });
    expect((err?.payload as { fix: { title: string } }).fix.title).toBe("Claude is not signed in");
  });

  it("gives up after its own ladder, and says the credentials are the problem rather than the login", async () => {
    // The CLI insists it is signed in and the turn keeps failing to authenticate. A user told only
    // "sign in" would check, find themselves signed in, and conclude Realm was wrong — so the
    // sentence has to name the contradiction it actually found.
    const h = harness({ policy: { retry: true, chain: [] }, loggedIn: true });
    h.svc.turnStarted("se1", msg);
    for (let i = 0; i < 3; i++) {
      expect(h.svc.onError(h.session(), AUTH_ERROR)).toBe("reauth");
      await h.settled();
      h.fire();
    }
    expect(h.resent).toHaveLength(3);
    expect(h.svc.onError(h.session(), AUTH_ERROR)).toBe("stop");
    const err = h.emitted.filter((e) => e.type === "error").at(-1);
    expect((err?.payload as { fix: { title: string } }).fix.title).toBe("Claude could not authenticate");
    expect(err?.payload).toMatchObject({ fix: { command: "claude auth login" } });
  });

  it("tries anyway when the probe will not say, because most agents cannot answer at all", async () => {
    // `loggedIn: null` is every ACP agent and any CLI with no status command. Refusing to try there
    // would cost a turn that was going to succeed, and the ladder is bounded either way.
    const h = harness({ policy: { retry: true, chain: [] }, loggedIn: null });
    h.svc.turnStarted("se1", msg);
    expect(h.svc.onError(h.session(), AUTH_ERROR)).toBe("reauth");
    await h.settled();
    h.fire();
    expect(h.resent).toEqual(["se1:do the thing"]);
  });

  it("does not read a missing CLI as a signed-out one", async () => {
    // `available: false` sends the user to an install, not a login, and the install card already
    // says so. Answering `false` here would put a login command under a CLI that is not there.
    const h = harness({ policy: { retry: true, chain: [] }, loggedIn: false, available: false });
    h.svc.turnStarted("se1", msg);
    h.svc.onError(h.session(), AUTH_ERROR);
    await h.settled();
    expect(h.emitted.find((e) => e.type === "retrying")?.payload).toMatchObject({ reason: "auth" });
  });

  it("hands off to the chain when the agent really is signed out, rather than only complaining", async () => {
    const h = harness({ policy: { retry: true, chain: ["codex"] }, loggedIn: false });
    h.svc.turnStarted("se1", msg);
    h.svc.onError(h.session(), AUTH_ERROR);
    await vi.waitFor(() => expect(h.session().agentKind).toBe("codex"));
    expect(h.resent).toEqual(["se1:do the thing"]);
  });

  it("never re-auths when the space turned retries off", () => {
    // `retry: false` is the user saying Realm may not finish a turn on its own. A probe-and-resend
    // is still Realm finishing a turn on its own.
    const h = harness({ policy: { retry: false, chain: [] }, loggedIn: true });
    h.svc.turnStarted("se1", msg);
    expect(h.svc.onError(h.session(), AUTH_ERROR)).toBe("stop");
    expect(h.probes).toEqual([]);
  });

  it("does not report a probe it never ran", () => {
    // Same case as above, read for what it SAYS. With retries off nothing asked the CLI anything, so
    // neither "is not signed in" nor "reports that it is signed in" is Realm's to claim — both are
    // accounts of a check that did not happen.
    const h = harness({ policy: { retry: false, chain: [] }, loggedIn: false });
    h.svc.turnStarted("se1", msg);
    h.svc.onError(h.session(), AUTH_ERROR);
    const fix = (h.emitted.find((e) => e.type === "error")?.payload as { fix: { title: string; hint: string } }).fix;
    expect(fix.title).toBe("Claude could not authenticate");
    expect(fix.hint).toContain("did not check");
    expect(fix.hint).not.toContain("reports that it is signed in");
  });

  it("drops a re-auth the user cancelled while the probe was running", async () => {
    const h = harness({ policy: { retry: true, chain: [] }, loggedIn: true });
    h.svc.turnStarted("se1", msg);
    h.svc.onError(h.session(), AUTH_ERROR);
    h.svc.cancel("se1");
    await h.settled();
    expect(h.hasTimer()).toBe(false);
    expect(h.resent).toEqual([]);
  });

  it("keeps the two ladders apart, so a dropped socket does not spend the re-auth budget", async () => {
    const h = harness({ policy: { retry: true, chain: [] }, loggedIn: true });
    h.svc.turnStarted("se1", msg);
    for (let i = 0; i < 3; i++) { h.svc.onError(h.session(), "socket hang up"); h.fire(); }
    expect(h.svc.onError(h.session(), AUTH_ERROR)).toBe("reauth");
  });
});

describe("an auth failure that crosses a handoff", () => {
  /** Claude is signed out, Codex is not. The handoff happens because of the first, and everything
   *  after it has to be decided by the second. */
  const splitProbe = (k: AgentKind) => (k === "claude" ? false : true);

  it("judges the incoming agent on its own credentials, not the outgoing one's", async () => {
    // The mutant: carry `authWhy` across the handoff. Codex is signed in and failing anyway, but the
    // user is told "Codex is not signed in" — a sentence they will check, disprove, and disbelieve —
    // because that was Claude's verdict three minutes ago.
    const h = harness({ policy: { retry: true, chain: ["codex"] }, loggedIn: splitProbe });
    h.svc.turnStarted("se1", msg);
    h.svc.onError(h.session(), AUTH_ERROR);
    await vi.waitFor(() => expect(h.session().agentKind).toBe("codex"));

    for (let i = 0; i < AUTH_MAX_RECHECKS; i++) { h.svc.onError(h.session(), AUTH_ERROR); await h.settled(); h.fire(); }
    expect(h.svc.onError(h.session(), AUTH_ERROR)).toBe("stop");
    expect((h.emitted.filter((e) => e.type === "error").at(-1)?.payload as { fix: { title: string; command: string } }).fix)
      .toMatchObject({ title: "Codex could not authenticate", command: "codex login" });
  });

  it("gives the incoming agent a full re-auth ladder of its own", async () => {
    // The other half: carry `reauths` across, and the new agent inherits a budget it never spent.
    const h = harness({ policy: { retry: true, chain: ["codex"] }, loggedIn: splitProbe });
    h.svc.turnStarted("se1", msg);
    h.svc.onError(h.session(), AUTH_ERROR);
    await vi.waitFor(() => expect(h.session().agentKind).toBe("codex"));

    for (let i = 0; i < AUTH_MAX_RECHECKS + 1; i++) { h.svc.onError(h.session(), AUTH_ERROR); await h.settled(); h.fire(); }
    const waits = h.emitted.filter((e) => e.type === "retrying");
    expect(waits).toHaveLength(AUTH_MAX_RECHECKS);
    expect(waits.map((e) => (e.payload as { attempt: number }).attempt)).toEqual([1, 2, 3]);
  });
});
