import { describe, expect, it, vi } from "vitest";
import { AskCardSchema, HIDDEN_ANSWER, type SessionEvent } from "@realm/contracts";
import { BrowserPermissionBroker } from "./permissions";

function setup(mode = "default") {
  const events: { sessionId: string; ev: SessionEvent }[] = [];
  let currentMode = mode;
  const broker = new BrowserPermissionBroker({
    permissionMode: () => currentMode,
    emit: (sessionId, ev) => events.push({ sessionId, ev }),
  });
  return { broker, events, setMode: (m: string) => { currentMode = m; } };
}

const requestIdOf = (events: { ev: SessionEvent }[]): string => {
  const req = events.find((e) => e.ev.type === "permission_request");
  if (!req || req.ev.type !== "permission_request") throw new Error("no permission_request emitted");
  return req.ev.payload.requestId;
};

describe("BrowserPermissionBroker.gate", () => {
  it("bypassPermissions allows without emitting any event", async () => {
    const { broker, events } = setup("bypassPermissions");
    expect(await broker.gate("s1", "browser_act", "Click X", {})).toEqual({ allowed: true });
    expect(events).toEqual([]);
  });

  it("plan mode refuses outright — no prompt, mutation named as refused", async () => {
    const { broker, events } = setup("plan");
    const r = await broker.gate("s1", "browser_act", "Click X", {});
    expect(r.allowed).toBe(false);
    expect(!r.allowed && r.reason).toMatch(/read-only/);
    expect(events).toEqual([]);
  });

  it("ask mode refuses the same way plan does, and says which mode it is", async () => {
    // The mutant: leaving the gate on `mode === "plan"`. An Ask session would then drive the browser
    // — clicking, typing, submitting — under a mode whose whole promise is that it changes nothing.
    const { broker, events } = setup("ask");
    const r = await broker.gate("s1", "browser_act", "Click X", {});
    expect(r.allowed).toBe(false);
    expect(!r.allowed && r.reason).toMatch(/read-only/);
    expect(!r.allowed && r.reason).toContain("Ask");
    expect(events).toEqual([]);
  });

  it("default mode emits permission_request + waiting status, then resolves on allow", async () => {
    const { broker, events } = setup();
    const gate = broker.gate("s1", "browser_act", "Click *Submit* on example.com", { ref: 7 });
    const requestId = requestIdOf(events);
    expect(requestId).toMatch(/^bperm_/);
    expect(events.map((e) => e.ev.type)).toEqual(["permission_request", "status"]);
    const req = events[0]!.ev;
    expect(req.type === "permission_request" && req.payload.title).toBe("Click *Submit* on example.com");
    broker.resolve(requestId, "allow");
    expect(await gate).toEqual({ allowed: true });
    // The answer round-trips onto the transcript, and the status returns to running.
    expect(events.map((e) => e.ev.type)).toEqual(["permission_request", "status", "permission_response", "status"]);
  });

  it("deny resolves the gate as refused", async () => {
    const { broker, events } = setup();
    const gate = broker.gate("s1", "browser_act", "t", {});
    broker.resolve(requestIdOf(events), "deny");
    const r = await gate;
    expect(r.allowed).toBe(false);
  });

  it("acceptEdits still prompts — accepting file edits is not accepting browser actions", async () => {
    const { broker, events } = setup("acceptEdits");
    const gate = broker.gate("s1", "browser_act", "t", {});
    expect(events.some((e) => e.ev.type === "permission_request")).toBe(true);
    broker.resolve(requestIdOf(events), "allow");
    await gate;
  });

  it("allow_always is remembered per session AND per tool", async () => {
    const { broker, events } = setup();
    const gate = broker.gate("s1", "browser_act", "t", {});
    broker.resolve(requestIdOf(events), "allow_always");
    await gate;
    events.length = 0;
    // Same session + tool: no new prompt.
    expect(await broker.gate("s1", "browser_act", "t2", {})).toEqual({ allowed: true });
    expect(events).toEqual([]);
    // A DIFFERENT tool in the same session still prompts.
    void broker.gate("s1", "browser_navigate", "t3", {});
    expect(events.some((e) => e.ev.type === "permission_request")).toBe(true);
    // A different session prompts too.
    const before = events.length;
    void broker.gate("s2", "browser_act", "t4", {});
    expect(events.length).toBeGreaterThan(before);
  });

  it("a mode change between calls counts — the mode is read fresh per gate", async () => {
    const { broker, events, setMode } = setup("bypassPermissions");
    await broker.gate("s1", "browser_act", "t", {});
    expect(events).toEqual([]);
    setMode("default");
    void broker.gate("s1", "browser_act", "t", {});
    expect(events.some((e) => e.ev.type === "permission_request")).toBe(true);
  });

  it("release denies a session's pending prompts and forgets its allow-always grants", async () => {
    const { broker, events } = setup();
    const gate = broker.gate("s1", "browser_act", "t", {});
    broker.release("s1");
    expect((await gate).allowed).toBe(false);
    // Grants die too: earn one, release, then the next gate prompts again.
    const gate2 = broker.gate("s1", "browser_act", "t", {});
    broker.resolve(requestIdOf(events.slice(1)), "allow_always");
    await gate2;
    broker.release("s1");
    events.length = 0;
    void broker.gate("s1", "browser_act", "t", {});
    expect(events.some((e) => e.ev.type === "permission_request")).toBe(true);
  });

  it("an unanswered prompt times out to deny", async () => {
    vi.useFakeTimers();
    try {
      const { broker, events } = setup();
      const gate = broker.gate("s1", "browser_act", "t", {});
      vi.advanceTimersByTime(15 * 60 * 1000 + 1);
      const r = await gate;
      expect(r.allowed).toBe(false);
      const responses = events.filter((e) => e.ev.type === "permission_response");
      expect(responses).toHaveLength(1);
      expect(responses[0]!.ev.type === "permission_response" && responses[0]!.ev.payload.decision).toBe("deny");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolve on an unknown/stale requestId is a no-op", () => {
    const { broker, events } = setup();
    broker.resolve("bperm_nope", "allow");
    expect(events).toEqual([]);
  });

  it("owns() recognizes only broker-minted ids", () => {
    const { broker } = setup();
    expect(broker.owns("bperm_abc")).toBe(true);
    expect(broker.owns("01J8ULID")).toBe(false);
  });
});

/**
 * `alwaysPrompt` — the narrowing `browser_fill_credential` relies on, and the one place a permission
 * mode's meaning is deliberately not honored. Its mutants: bypassPermissions skipping the card; a
 * prior allow_always satisfying it; answering "always" to a credential card licensing the next one.
 */
describe("BrowserPermissionBroker.gate — alwaysPrompt (credential fills)", () => {
  const opts = { alwaysPrompt: true };

  it("PROMPTS under bypassPermissions (mutant: mode parity applied to a credential fill)", async () => {
    const { broker, events } = setup("bypassPermissions");
    const gate = broker.gate("s1", "browser_fill_credential", "Fill the saved sign-in for https://example.com", {}, "browser_fill_credential", opts);
    const requestId = requestIdOf(events);
    broker.resolve(requestId, "allow");
    expect(await gate).toEqual({ allowed: true });
  });

  it("still refuses in plan mode — a read-only session fills nothing", async () => {
    const { broker, events } = setup("plan");
    const r = await broker.gate("s1", "browser_fill_credential", "Fill…", {}, "browser_fill_credential", opts);
    expect(r.allowed).toBe(false);
    expect(events).toEqual([]);
  });

  it("a prior allow_always on the SAME key does not satisfy it", async () => {
    const { broker, events } = setup();
    // An ordinary gate first, answered "always" — the grant that would otherwise carry over.
    const first = broker.gate("s1", "browser_fill_credential", "Fill…", {});
    broker.resolve(requestIdOf(events), "allow_always");
    await first;

    events.length = 0;
    const second = broker.gate("s1", "browser_fill_credential", "Fill…", {}, "browser_fill_credential", opts);
    const requestId = requestIdOf(events); // it prompted again
    broker.resolve(requestId, "allow");
    expect(await second).toEqual({ allowed: true });
  });

  it("answering allow_always TO a credential card records nothing (mutant: the grant remembered)", async () => {
    const { broker, events } = setup();
    const first = broker.gate("s1", "browser_fill_credential", "Fill…", {}, "browser_fill_credential", opts);
    broker.resolve(requestIdOf(events), "allow_always");
    expect(await first).toEqual({ allowed: true });

    // A LATER ordinary gate on the same key must still prompt: the credential card licensed nothing,
    // not even for tools that would normally honor allow_always.
    events.length = 0;
    const second = broker.gate("s1", "browser_fill_credential", "Fill…", {});
    const requestId = requestIdOf(events);
    broker.resolve(requestId, "allow");
    expect(await second).toEqual({ allowed: true });
  });

});

/**
 * `promptUnderBypass` — the computer-use narrowing. `bypassPermissions` does not skip the card, but
 * unlike `alwaysPrompt` an `allow_always` both satisfies and is recorded by it, so the user is asked
 * once per key and never again in that session. Its mutants: bypass skipping the card; allow_always
 * failing to stick; and the grant leaking across keys, which is what keys it per application.
 */
describe("gate({ promptUnderBypass })", () => {
  const opts = { promptUnderBypass: true } as const;

  it("PROMPTS under bypassPermissions, unlike an ordinary gate", async () => {
    const { broker, events } = setup("bypassPermissions");
    const gate = broker.gate("s1", "computer_act:com.apple.TextEdit", "Click in TextEdit", {}, "computer_act", opts);
    broker.resolve(requestIdOf(events), "allow");
    expect(await gate).toEqual({ allowed: true });
  });

  it("stops asking once the user answers always — even in bypassPermissions", async () => {
    const { broker, events } = setup("bypassPermissions");
    const first = broker.gate("s1", "computer_act:com.apple.TextEdit", "Click in TextEdit", {}, "computer_act", opts);
    broker.resolve(requestIdOf(events), "allow_always");
    expect(await first).toEqual({ allowed: true });

    events.length = 0;
    expect(await broker.gate("s1", "computer_act:com.apple.TextEdit", "Click again", {}, "computer_act", opts)).toEqual({ allowed: true });
    expect(events).toEqual([]);
  });

  it("does not let a grant for one app license another", async () => {
    const { broker, events } = setup("bypassPermissions");
    const first = broker.gate("s1", "computer_act:com.apple.TextEdit", "Click in TextEdit", {}, "computer_act", opts);
    broker.resolve(requestIdOf(events), "allow_always");
    await first;

    events.length = 0;
    const other = broker.gate("s1", "computer_act:com.apple.Mail", "Click in Mail", {}, "computer_act", opts);
    // A card, not a silent pass: this is the whole point of keying the grant per application.
    const requestId = requestIdOf(events);
    broker.resolve(requestId, "deny");
    expect((await other).allowed).toBe(false);
  });

});

/**
 * `preapproved` and `onAlwaysAllow`: the seam a durable, user-curated grant hangs off. The broker
 * still owns modes and prompting; where a standing approval is KEPT belongs to the caller, because
 * the shape of it — bundle ids, per space — is not something this class should know.
 *
 * Its mutants: a preapproved gate that still asks; one that is honoured in a read-only session; and
 * an "always" that is remembered for the session but never written down, which is the whole failure
 * this option exists to end.
 */
describe("gate({ preapproved, onAlwaysAllow })", () => {
  it("does not ask about something the user has already put on a list", async () => {
    const { broker, events } = setup("default");
    expect(await broker.gate("s1", "computer_act:com.apple.TextEdit", "Click", {}, "computer_act", { preapproved: true, promptUnderBypass: true }))
      .toEqual({ allowed: true });
    expect(events).toEqual([]);
  });

  it("still refuses a read-only session, list or no list", async () => {
    // A standing approval says which apps are eligible. It does not say a Plan session may act, and
    // the refusal has to outrank it or "always allow TextEdit" would quietly re-arm every mode.
    for (const mode of ["plan", "ask"]) {
      const { broker, events } = setup(mode);
      const gate = await broker.gate("s1", "computer_act:com.apple.TextEdit", "Click", {}, "computer_act", { preapproved: true });
      expect(gate).toMatchObject({ allowed: false });
      expect(gate).toMatchObject({ reason: expect.stringMatching(/read-only/) });
      expect(events).toEqual([]);
    }
  });

  it("still asks about an app that is NOT on the list", async () => {
    const { broker, events } = setup("bypassPermissions");
    const gate = broker.gate("s1", "computer_act:com.apple.Mail", "Click", {}, "computer_act", { preapproved: false, promptUnderBypass: true });
    broker.resolve(requestIdOf(events), "allow");
    expect(await gate).toEqual({ allowed: true });
  });

  it("hands the answer back to the caller to persist when the user says always", async () => {
    const { broker, events } = setup("default");
    const written: string[] = [];
    const gate = broker.gate("s1", "computer_act:com.apple.TextEdit", "Click", {}, "computer_act",
      { promptUnderBypass: true, onAlwaysAllow: () => written.push("com.apple.TextEdit") });
    broker.resolve(requestIdOf(events), "allow_always");
    expect(await gate).toEqual({ allowed: true });
    expect(written).toEqual(["com.apple.TextEdit"]);
  });

  it("persists nothing for a one-off allow or a denial", async () => {
    for (const decision of ["allow", "deny"] as const) {
      const { broker, events } = setup("default");
      const written: string[] = [];
      const gate = broker.gate("s1", "computer_act:com.apple.TextEdit", "Click", {}, "computer_act", { onAlwaysAllow: () => written.push("x") });
      broker.resolve(requestIdOf(events), decision);
      await gate;
      expect(written, decision).toEqual([]);
    }
  });

  it("persists nothing when the card is one that may never be remembered", async () => {
    // The credential-fill rule: an `alwaysPrompt` gate records nothing in the session set, and must
    // not find a back door to disk through this callback either.
    const { broker, events } = setup("default");
    const written: string[] = [];
    const gate = broker.gate("s1", "browser_fill_credential", "Fill", {}, "browser_fill_credential",
      { alwaysPrompt: true, onAlwaysAllow: () => written.push("x") });
    broker.resolve(requestIdOf(events), "allow_always");
    await gate;
    expect(written).toEqual([]);
  });
});

/**
 * `perSession` — the simulator input tools' card, which asks for the rest of the session rather than
 * for one call, keyed per device. Its mutants: a plain "Allow" that is not kept, which is a card per
 * tap; a grant that leaks to another device or another session; a plain "Allow" written down as if
 * it had been "always"; and a read-only session let through on the strength of a grant.
 */
describe("gate({ perSession })", () => {
  const opts = { perSession: true } as const;
  const ask = (broker: BrowserPermissionBroker, sessionId: string, key: string) =>
    broker.gate(sessionId, key, "Tap, swipe and type on iPhone Air for the rest of this session", {}, "simulator_tap", opts);

  it("keeps a plain Allow for the rest of the session", async () => {
    const { broker, events } = setup();
    const first = ask(broker, "s1", "simulator_input:UDID-A");
    broker.resolve(requestIdOf(events), "allow");
    expect(await first).toEqual({ allowed: true });
    events.length = 0;
    expect(await ask(broker, "s1", "simulator_input:UDID-A")).toEqual({ allowed: true });
    expect(events).toEqual([]);
  });

  it("does not let one device's grant license another device, or another session", async () => {
    const { broker, events } = setup();
    const first = ask(broker, "s1", "simulator_input:UDID-A");
    broker.resolve(requestIdOf(events), "allow");
    await first;
    for (const [sessionId, key] of [["s1", "simulator_input:UDID-B"], ["s2", "simulator_input:UDID-A"]] as const) {
      events.length = 0;
      const again = ask(broker, sessionId, key);
      broker.resolve(requestIdOf(events), "deny");
      expect((await again).allowed, `${sessionId} ${key}`).toBe(false);
    }
  });

  it("leaves an ordinary gate's Allow at the one call it answered", async () => {
    // The other side of the option: without it, "Allow" is still "this once" for every other tool.
    const { broker, events } = setup();
    const first = broker.gate("s1", "browser_act", "Click", {});
    broker.resolve(requestIdOf(events), "allow");
    await first;
    events.length = 0;
    void broker.gate("s1", "browser_act", "Click again", {});
    expect(events.some((e) => e.ev.type === "permission_request")).toBe(true);
  });

  it("writes nothing durable for a plain Allow, and still hands on an Always", async () => {
    for (const [decision, wanted] of [["allow", []], ["allow_always", ["kept"]]] as const) {
      const { broker, events } = setup();
      const written: string[] = [];
      const gate = broker.gate("s1", "simulator_input:UDID-A", "Tap", {}, "simulator_tap", { ...opts, onAlwaysAllow: () => written.push("kept") });
      broker.resolve(requestIdOf(events), decision);
      await gate;
      expect(written, decision).toEqual(wanted);
    }
  });

  it("gives way to alwaysPrompt, which keeps nothing", async () => {
    const { broker, events } = setup();
    const first = broker.gate("s1", "simulator_input:UDID-A", "Tap", {}, "simulator_tap", { ...opts, alwaysPrompt: true });
    broker.resolve(requestIdOf(events), "allow");
    await first;
    events.length = 0;
    void broker.gate("s1", "simulator_input:UDID-A", "Tap again", {}, "simulator_tap", opts);
    expect(events.some((e) => e.ev.type === "permission_request")).toBe(true);
  });

  it("is refused outright once the session turns read-only, grant or no grant", async () => {
    const { broker, events, setMode } = setup();
    const first = ask(broker, "s1", "simulator_input:UDID-A");
    broker.resolve(requestIdOf(events), "allow");
    await first;
    for (const mode of ["plan", "ask"]) {
      setMode(mode);
      const r = await ask(broker, "s1", "simulator_input:UDID-A");
      expect(r, mode).toMatchObject({ allowed: false, reason: expect.stringMatching(/read-only/) });
    }
  });

});

describe("BrowserPermissionBroker.revoke", () => {
  it("makes a session that already answered always ask again", async () => {
    // Taking an app off the durable list is not a revocation while a live session still holds its
    // own grant for it — that session would keep driving the app until it ended.
    const { broker, events } = setup("default");
    const first = broker.gate("s1", "computer_act:com.apple.TextEdit", "Click", {}, "computer_act", { promptUnderBypass: true });
    broker.resolve(requestIdOf(events), "allow_always");
    await first;

    events.length = 0;
    broker.revoke("computer_act:com.apple.TextEdit");
    const second = broker.gate("s1", "computer_act:com.apple.TextEdit", "Click again", {}, "computer_act", { promptUnderBypass: true });
    broker.resolve(requestIdOf(events), "allow");
    expect(await second).toEqual({ allowed: true });
  });

  it("leaves other apps' grants alone", async () => {
    const { broker, events } = setup("default");
    const first = broker.gate("s1", "computer_act:com.apple.Mail", "Click", {}, "computer_act", { promptUnderBypass: true });
    broker.resolve(requestIdOf(events), "allow_always");
    await first;

    events.length = 0;
    broker.revoke("computer_act:com.apple.TextEdit");
    expect(await broker.gate("s1", "computer_act:com.apple.Mail", "Click again", {}, "computer_act", { promptUnderBypass: true })).toEqual({ allowed: true });
    expect(events).toEqual([]);
  });

  it("reaches every session, since the broker is never told which space one belongs to", async () => {
    const { broker, events } = setup("default");
    for (const sessionId of ["s1", "s2"]) {
      const gate = broker.gate(sessionId, "computer_act:com.apple.TextEdit", "Click", {}, "computer_act", { promptUnderBypass: true });
      broker.resolve(requestIdOf(events), "allow_always");
      await gate;
      events.length = 0;
    }
    broker.revoke("computer_act:com.apple.TextEdit");
    const gate = broker.gate("s2", "computer_act:com.apple.TextEdit", "Click again", {}, "computer_act", { promptUnderBypass: true });
    broker.resolve(requestIdOf(events), "allow");
    expect(await gate).toEqual({ allowed: true });
  });
});

describe("BrowserPermissionBroker.ask — a question, on the same card and the same round trip", () => {
  const card = (over: Record<string, unknown> = {}) => AskCardSchema.parse({
    asker: { kind: "agent", name: "Claude", agent: "claude" }, mode: "question",
    questions: [
      { id: "db", prompt: "Which database?", kind: "choice", options: [{ value: "pg", label: "Postgres" }, { value: "sqlite", label: "SQLite" }] },
      { id: "key", prompt: "Deploy token?", kind: "text", secret: true },
    ],
    ...over,
  });
  const ask = (broker: BrowserPermissionBroker, c = card(), signal?: AbortSignal) => broker.ask("s1", c, { toolName: "ui_ask", title: "Which database?", input: { q: 1 }, signal });

  it("raises one request carrying the card, and resolves with the answers held to it", async () => {
    const { broker, events } = setup();
    const asked = ask(broker);
    expect(events.map((e) => e.ev.type)).toEqual(["permission_request", "status"]);
    const req = events[0]!.ev;
    expect(req.type === "permission_request" && req.payload.ask?.asker.name).toBe("Claude");
    // An answer the card never offered, and a question it never asked, go nowhere.
    broker.resolve(requestIdOf(events), "allow", { db: "mysql", key: "sk-live-1234", ghost: "x" });
    expect(await asked).toEqual({ outcome: "answered", answers: { key: "sk-live-1234" } });
    const res = events.find((e) => e.ev.type === "permission_response")!.ev;
    // THE MUTANT: persist `given` rather than `loggableAnswers(...)`. The token lands in the database.
    expect(res.type === "permission_response" && res.payload).toMatchObject({ decision: "allow", answers: { key: HIDDEN_ANSWER } });
    expect(JSON.stringify(events)).not.toContain("sk-live-1234");
  });

  it.each(["plan", "ask", "bypassPermissions"])("asks in %s mode too — a question changes nothing", async (mode) => {
    const { broker, events } = setup(mode);
    const asked = ask(broker);
    expect(events.some((e) => e.ev.type === "permission_request")).toBe(true);
    broker.resolve(requestIdOf(events), "allow", { db: "pg" });
    expect(await asked).toEqual({ outcome: "answered", answers: { db: "pg" } });
  });

  it("calls a deny a skip, and an answer that leaves a required field empty one too", async () => {
    const { broker, events } = setup();
    const skipped = ask(broker);
    broker.resolve(requestIdOf(events), "deny");
    expect(await skipped).toEqual({ outcome: "skipped" });
    events.length = 0;
    const required = card({ questions: [{ id: "db", prompt: "Which?", kind: "choice", required: true, options: [{ value: "pg", label: "Postgres" }] }, { id: "note", prompt: "Note?", kind: "text" }] });
    const partial = ask(broker, required);
    broker.resolve(requestIdOf(events), "allow", { note: "hi" });
    expect(await partial).toEqual({ outcome: "skipped" });
  });

  it("ignores an answer that names another session than the one asked", async () => {
    const { broker, events } = setup();
    const asked = ask(broker);
    broker.resolve(requestIdOf(events), "allow", { db: "pg" }, "s2");
    expect(events.some((e) => e.ev.type === "permission_response")).toBe(false);
    broker.resolve(requestIdOf(events), "allow", { db: "pg" }, "s1");
    expect(await asked).toMatchObject({ outcome: "answered" });
  });

  it("times out on the broker's own limit, and takes the card down when the asker withdraws it", async () => {
    vi.useFakeTimers();
    try {
      const { broker, events } = setup();
      const late = ask(broker);
      vi.advanceTimersByTime(15 * 60 * 1000 + 1);
      expect(await late).toEqual({ outcome: "timeout" });
      expect(events.filter((e) => e.ev.type === "permission_response")).toHaveLength(1);
    } finally { vi.useRealTimers(); }
    const { broker, events } = setup();
    const ac = new AbortController();
    const withdrawn = ask(broker, card(), ac.signal);
    ac.abort();
    expect(await withdrawn).toEqual({ outcome: "cancelled" });
    expect(events.map((e) => e.ev.type)).toEqual(["permission_request", "status", "permission_response", "status"]);
  });

  it("records a card Realm declined and answers it at once, without ever waiting on the user", async () => {
    const { broker, events } = setup();
    expect(await ask(broker, card({ mode: "form", refused: "It asked for a password." }))).toEqual({ outcome: "refused" });
    expect(events.map((e) => e.ev.type)).toEqual(["permission_request", "permission_response"]);
  });

  it("keeps the session waiting while any card is still open", async () => {
    // THE MUTANT: emit `running` on every answer. The second card would then stop being drawn, since
    // the transcript draws requests only while its session is waiting.
    const { broker, events } = setup();
    const a = ask(broker);
    const b = broker.gate("s1", "browser_act", "Click", {});
    const [first, second] = events.filter((e) => e.ev.type === "permission_request").map((e) => e.ev.type === "permission_request" ? e.ev.payload.requestId : "");
    broker.resolve(first!, "allow", { db: "pg" });
    expect(events.at(-1)!.ev.type).toBe("permission_response");
    broker.resolve(second!, "allow");
    expect(events.at(-1)!.ev).toMatchObject({ type: "status", payload: { status: "running" } });
    await Promise.all([a, b]);
  });

  it("a released session's open question is cancelled, not answered", async () => {
    const { broker } = setup();
    const asked = ask(broker);
    broker.release("s1");
    expect(await asked).toEqual({ outcome: "cancelled" });
  });
});
