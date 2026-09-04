import { describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "@realm/contracts";
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

  it("refuses a credential fill in ask mode too", async () => {
    const { broker, events } = setup("ask");
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

  it("a denial refuses the fill", async () => {
    const { broker, events } = setup("bypassPermissions");
    const gate = broker.gate("s1", "browser_fill_credential", "Fill…", {}, "browser_fill_credential", opts);
    broker.resolve(requestIdOf(events), "deny");
    const r = await gate;
    expect(r.allowed).toBe(false);
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

  it("is still refused outright in plan mode", async () => {
    const { broker, events } = setup("plan");
    const r = await broker.gate("s1", "computer_act:com.apple.TextEdit", "Click", {}, "computer_act", opts);
    expect(r.allowed).toBe(false);
    expect(!r.allowed && r.reason).toMatch(/read-only/);
    expect(events).toEqual([]);
  });

  it("forgets its grants when the session is released", async () => {
    const { broker, events } = setup("bypassPermissions");
    const first = broker.gate("s1", "computer_act:com.apple.TextEdit", "Click", {}, "computer_act", opts);
    broker.resolve(requestIdOf(events), "allow_always");
    await first;

    broker.release("s1");
    events.length = 0;
    const again = broker.gate("s1", "computer_act:com.apple.TextEdit", "Click", {}, "computer_act", opts);
    broker.resolve(requestIdOf(events), "allow");
    expect(await again).toEqual({ allowed: true });
  });
});
