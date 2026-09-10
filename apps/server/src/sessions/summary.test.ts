import { describe, expect, it, vi } from "vitest";
import { sessionEvent, type SessionEvent, type StoredSessionEvent } from "@realm/contracts";
import { SessionSummaryService, transcriptForSummary } from "./summary";

let seq = 0;
const stored = (event: SessionEvent): StoredSessionEvent => ({ seq: ++seq, sessionId: "s1", event });
const user = (text: string) => stored(sessionEvent("user_message", { text, attachments: [] }));
const assistant = (text: string) => stored(sessionEvent("assistant_text", { messageId: `m${seq}`, text }));
const call = (id: string, name: string, input: Record<string, unknown> = {}) =>
  stored(sessionEvent("tool_call", { toolUseId: id, name, input, parentToolUseId: null }));
const result = (id: string, isError = false) => stored(sessionEvent("tool_result", { toolUseId: id, content: "ok", isError }));
const status = (s: "idle" | "running") => stored(sessionEvent("status", { status: s }));

/** A session that did enough to be worth summarizing. */
const worked = (): StoredSessionEvent[] => [
  user("fix the login flow"),
  call("t1", "Edit", { file_path: "/a/login.ts" }), result("t1"),
  call("t2", "Bash"), result("t2"),
  assistant("Done — the redirect was the problem."),
  status("idle"),
];

function build(events: StoredSessionEvent[], over: Partial<Parameters<typeof makeDeps>[0]> = {}) {
  const published: SessionEvent[] = [];
  const generate = over.generate ?? vi.fn(async () => "You asked for the login flow to be fixed; the redirect was wrong and is now corrected.");
  const deps = makeDeps({ events, published, generate, ...over });
  return { service: new SessionSummaryService(deps), published, generate: generate as ReturnType<typeof vi.fn>, deps };
}

function makeDeps(o: {
  events: StoredSessionEvent[]; published: SessionEvent[];
  generate?: (i: { asked: string; transcript: string; facts: string }) => Promise<string>;
  available?: () => boolean | Promise<boolean>;
}) {
  return {
    listEvents: () => o.events,
    lastSummary: () => o.published.filter((e) => e.type === "summary").at(-1) ?? null,
    publish: (_id: string, ev: SessionEvent) => { o.published.push(ev); },
    generate: o.generate,
    available: o.available,
    onError: () => {},
  };
}

describe("the session summary writer", () => {
  it("writes one summary for a settled turn, anchored to the last event that could change it", async () => {
    const events = worked();
    const { service, published } = build(events);
    await service.onSettled("s1");
    expect(published).toHaveLength(1);
    expect(published[0]!.type).toBe("summary");
    // The `status: idle` row is the LAST event, and it is not the anchor: the assistant's message is.
    const assistantSeq = events.at(-2)!.seq;
    expect(published[0]!.payload).toMatchObject({ throughSeq: assistantSeq });
  });

  it("does not pay twice for a transcript nothing has been added to", async () => {
    // THE mutant: anchor `throughSeq` to the newest event of ANY type. A settle writes its own
    // status row, so every reconnect and status flap would look new and buy a call to say the same
    // sentence again — the cost this feature lives or dies on.
    const events = worked();
    const { service, generate } = build(events);
    await service.onSettled("s1");
    events.push(status("running"), status("idle"));
    await service.onSettled("s1");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("summarizes again once the transcript has actually moved on", async () => {
    const events = worked();
    const { service, generate } = build(events);
    await service.onSettled("s1");
    events.push(user("now do the logout too"), assistant("Done."), status("idle"));
    await service.onSettled("s1");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("hands the model the counts rather than asking it for them", async () => {
    // A model reading a transcript miscounts; a summary that miscounts reads like it was checked.
    const { service, generate } = build(worked());
    await service.onSettled("s1");
    const input = generate.mock.calls[0]![0] as { asked: string; facts: string; transcript: string };
    expect(input.asked).toBe("fix the login flow");
    expect(input.facts).toContain("edited 1 file: login.ts");
    expect(input.facts).toContain("ran 1 command");
    expect(input.transcript).toContain("User: fix the login flow");
  });

  it("says nothing about a session that did nothing — a greeting is not worth a call", async () => {
    const { service, generate, published } = build([user("hi"), assistant("Hello!"), status("idle")]);
    await service.onSettled("s1");
    expect(generate).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it("never calls a model the machine cannot run, and stops asking after the first no", async () => {
    const available = vi.fn(async () => false);
    const { service, generate } = build(worked(), { available });
    await service.onSettled("s1");
    await service.onSettled("s1");
    expect(generate).not.toHaveBeenCalled();
    expect(available).toHaveBeenCalledTimes(1); // latched off, not re-asked per settled turn
  });

  it("swallows a failed call — a summary is a nicety and never fails a turn", async () => {
    const { service, published } = build(worked(), { generate: async () => { throw new Error("no CLI"); } });
    await expect(service.onSettled("s1")).resolves.toBeUndefined();
    expect(published).toEqual([]);
  });

  it("does not run two calls for one session at once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const generate = vi.fn(async () => { await gate; return "done"; });
    const { service, generate: g } = build(worked(), { generate });
    const first = service.onSettled("s1");
    await service.onSettled("s1"); // a second settle under a slow model
    expect(g).toHaveBeenCalledTimes(1);
    release(); await first;
  });

  it("does nothing at all when no generator is configured — the tests' and live checks' path", async () => {
    const published: SessionEvent[] = [];
    const service = new SessionSummaryService(makeDeps({ events: worked(), published, generate: undefined }));
    await service.onSettled("s1");
    expect(published).toEqual([]);
  });
});

describe("what the model is shown", () => {
  it("names tool calls instead of dumping their results", async () => {
    const text = transcriptForSummary([
      user("read it"),
      call("t1", "Read", { file_path: "/big.ts" }),
      stored(sessionEvent("tool_result", { toolUseId: "t1", content: "x".repeat(50_000), isError: false })),
      assistant("It is a config file."),
    ]);
    expect(text).toContain("[tool: Read]");
    expect(text).not.toContain("xxxx");
    expect(text.length).toBeLessThan(200);
  });

  it("leaves out a message another session delivered — those are not the user's words", () => {
    const peer = stored(sessionEvent("user_message", { text: "peer asked this", attachments: [], from: { sessionId: "s2", title: "Other" } }));
    expect(transcriptForSummary([user("mine"), peer])).toBe("User: mine");
  });
});
