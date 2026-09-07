import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FAILOVER_POLICY, failoverPolicyKey, handoffContextKey,
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

function harness(opts: { policy?: unknown; agentKind?: AgentKind } = {}) {
  const settings = new Map<string, unknown>([["failover.policy:sp1", opts.policy]]);
  let session: Session = {
    id: "se1", spaceId: "sp1", projectId: null, agentKind: opts.agentKind ?? "claude",
    model: "claude-opus-5", effort: null, permissionMode: "default", fastMode: false,
    environmentId: "en1", cwd: "/tmp/x", status: "running", providerSessionId: "prov-1",
    title: "t", lastEventSeq: 0, terminalItemId: null, dispatchedBy: null,
    createdAt: 0, updatedAt: 0,
  } as Session;

  const emitted: SessionEvent[] = [];
  const resent: string[] = [];
  const stopped: string[] = [];
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
    setTimer: (fn) => { pending = fn; return 0 as never; },
    clearTimer: () => { pending = null; },
  });

  return {
    svc, emitted, resent, stopped, settings,
    session: () => session,
    fire: () => { const f = pending; pending = null; f?.(); },
    hasTimer: () => pending !== null,
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
