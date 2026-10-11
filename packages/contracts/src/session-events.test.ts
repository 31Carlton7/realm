import { describe, expect, it } from "vitest";
import { SessionEventSchema, sessionEvent, turnSettled, type SessionEvent } from "./session-events";
import { Methods } from "./rpc";

/** An event as a stored row gives it back: parsed, which drops any key the schema does not declare.
 *  A field the schema forgot would survive in memory and be gone from every replayed transcript. */
const stored = (type: string, payload: Record<string, unknown>): SessionEvent => SessionEventSchema.parse({ type, ts: 1, payload });

describe("turnSettled — the one definition of a turn ending", () => {
  it.each(["idle", "ended", "error"] as const)("reads a step out of running into %s as a settle", (status) => {
    expect(turnSettled("running", { status })).toBe(true);
  });

  it.each(["idle", "ended", "error"] as const)("reads a step out of waiting_permission into %s as a settle, since a turn can end under a card", (status) => {
    expect(turnSettled("waiting_permission", { status })).toBe(true);
  });

  it("does not read the idle that only closes a card raised between turns as a settle", () => {
    expect(turnSettled("waiting_permission", { status: "idle", betweenTurns: true })).toBe(false);
  });

  it("still reads a stopped turn's idle as a settle", () => {
    expect(turnSettled("running", { status: "idle", interrupted: true })).toBe(true);
  });

  it.each(["idle", "ended", "error"] as const)("reads no settle in a step that starts from %s, where no turn was in flight", (previous) => {
    expect(turnSettled(previous, { status: "idle" })).toBe(false);
  });

  it("reads no settle in a step between the two live statuses", () => {
    expect(turnSettled("running", { status: "waiting_permission" })).toBe(false);
    expect(turnSettled("waiting_permission", { status: "running" })).toBe(false);
  });

  it("reads no settle in a wait raised between turns", () => {
    expect(turnSettled("idle", { status: "waiting_permission", betweenTurns: true })).toBe(false);
  });
});

describe("the fields that follow a workflow run", () => {
  it("keeps betweenTurns on a status that is read back from the log", () => {
    expect(stored("status", { status: "idle", betweenTurns: true }).payload).toEqual({ status: "idle", betweenTurns: true });
  });

  it("still reads a status written before betweenTurns existed", () => {
    expect(stored("status", { status: "idle", interrupted: true }).payload).toEqual({ status: "idle", interrupted: true });
  });

  it.each(["completed", "failed", "stopped"] as const)("keeps a background run's outcome of %s", (outcome) => {
    expect(stored("background_task", { toolUseId: "t1", status: "stopped", outcome }).payload).toEqual({ toolUseId: "t1", status: "stopped", outcome });
  });

  it("reads a stop with no outcome, which is every stop written before it existed", () => {
    expect(stored("background_task", { toolUseId: "t1", status: "stopped" }).payload).toEqual({ toolUseId: "t1", status: "stopped" });
  });

  it("refuses an outcome that is none of the harness's three words", () => {
    expect(SessionEventSchema.safeParse({ type: "background_task", ts: 1, payload: { toolUseId: "t1", status: "stopped", outcome: "killed" } }).success).toBe(false);
  });

  it("keeps once on a permission request that is read back from the log", () => {
    const request = { requestId: "r1", toolName: "Workflow", input: {}, title: "Allow Workflow?", suggestions: [], once: true };
    expect(stored("permission_request", request).payload).toMatchObject({ once: true });
  });

  it("adds no once to a permission request that came without it, where an always answer is on offer", () => {
    const request = { requestId: "r1", toolName: "Workflow", input: {}, title: "Allow Workflow?", suggestions: [] };
    expect(stored("permission_request", request).payload).not.toHaveProperty("once");
  });

  it("refuses once: false, so that absent stays the only way to say an always answer is offered", () => {
    const request = { requestId: "r1", toolName: "Workflow", input: {}, title: "Allow Workflow?", suggestions: [], once: false };
    expect(SessionEventSchema.safeParse({ type: "permission_request", ts: 1, payload: request }).success).toBe(false);
  });

  it("keeps unprompted on an error that is read back from the log", () => {
    expect(stored("error", { message: "API Error: 400", unprompted: true }).payload).toEqual({ message: "API Error: 400", unprompted: true });
  });

  it("adds no unprompted to an error that came without it", () => {
    expect(stored("error", { message: "boom" }).payload).toEqual({ message: "boom" });
  });

  it("keeps unprompted on the settle of a turn the harness started, read back from the log", () => {
    expect(stored("status", { status: "idle", unprompted: true }).payload).toEqual({ status: "idle", unprompted: true });
  });

  it("refuses unprompted: false on a status, so that absent stays the only way to say a turn was sent", () => {
    expect(SessionEventSchema.safeParse({ type: "status", ts: 1, payload: { status: "idle", unprompted: false } }).success).toBe(false);
  });

  it("builds an event whose payload is exactly what it was given", () => {
    expect(sessionEvent("background_task", { toolUseId: "t1", status: "stopped", outcome: "failed" }, 7)).toEqual({ type: "background_task", ts: 7, payload: { toolUseId: "t1", status: "stopped", outcome: "failed" } });
  });
});

describe("human — the mark on a message a person sent", () => {
  it("keeps human on a user message that is read back from the log", () => {
    expect(stored("user_message", { text: "hi", attachments: [], human: true }).payload).toEqual({ text: "hi", attachments: [], human: true });
  });

  it("adds no human to a user message that came without it, which is every one written before it existed", () => {
    expect(stored("user_message", { text: "hi", attachments: [] }).payload).toEqual({ text: "hi", attachments: [] });
  });

  it("refuses human: false, so that absent stays the only way to say a message is not a person's", () => {
    expect(SessionEventSchema.safeParse({ type: "user_message", ts: 1, payload: { text: "hi", attachments: [], human: false } }).success).toBe(false);
  });
});

describe("ultracodeAvailable — what the harness says of Ultracode on a handshake", () => {
  const init = { providerSessionId: "p1", model: "claude-opus-5-5", tools: [], cwd: "/tmp" };

  it.each([true, false])("keeps an answer of %s on an init that is read back from the log", (ultracodeAvailable) => {
    expect(stored("init", { ...init, ultracodeAvailable }).payload).toEqual({ ...init, ultracodeAvailable });
  });

  it("adds no answer to an init that came without one, where the harness did not say", () => {
    expect(stored("init", init).payload).toEqual(init);
  });
});

describe("sessions.stopTask", () => {
  it("names the run by the session and the call that launched it", () => {
    const params = { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", toolUseId: "toolu_01" };
    expect(Methods["sessions.stopTask"].params.parse(params)).toEqual(params);
  });

  it("refuses an empty call id, which names no run", () => {
    expect(Methods["sessions.stopTask"].params.safeParse({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", toolUseId: "" }).success).toBe(false);
  });
});
