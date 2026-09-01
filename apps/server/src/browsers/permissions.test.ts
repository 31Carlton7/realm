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
