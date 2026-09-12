import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  const generate = over.generate ?? vi.fn(async () => ({
    summary: "You asked for the login flow to be fixed; the redirect was wrong and is now corrected.",
    hint: "Add a test for the redirect.",
  }));
  const deps = makeDeps({ events, published, generate, ...over });
  return { service: new SessionSummaryService(deps), published, generate: generate as ReturnType<typeof vi.fn>, deps };
}

function makeDeps(o: {
  events: StoredSessionEvent[]; published: SessionEvent[];
  generate?: (i: { asked: string; transcript: string; facts: string }) => Promise<{ summary: string; hint: string | null }>;
  available?: () => boolean | Promise<boolean>;
  debounceMs?: number;
  isIdle?: (sessionId: string) => boolean;
}) {
  return {
    listEvents: () => o.events,
    lastSummary: () => o.published.filter((e) => e.type === "summary").at(-1) ?? null,
    publish: (_id: string, ev: SessionEvent) => { o.published.push(ev); },
    generate: o.generate,
    available: o.available,
    debounceMs: o.debounceMs,
    isIdle: o.isIdle,
    onError: () => {},
  };
}

describe("the session summary writer", () => {
  /* ONE call, TWO events. The summary and the prompter's hint are both answers to the same reading of
     the same transcript, so they are fetched together and published separately — they are consumed in
     different places and have different lifetimes (a hint dies when the user sends anything). */
  it("writes the summary AND the prompter's hint from one call, on the same anchor", async () => {
    const events = worked();
    const { service, published, generate } = build(events);
    await service.onSettled("s1");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(published.map((e) => e.type)).toEqual(["summary", "prompt_hint"]);
    // The `status: idle` row is the LAST event, and it is not the anchor: the assistant's message is.
    const assistantSeq = events.at(-2)!.seq;
    for (const ev of published) expect(ev.payload).toMatchObject({ throughSeq: assistantSeq });
    expect(published[1]!.payload).toMatchObject({ text: "Add a test for the redirect." });
  });

  /* A declined hint is the common answer and must not cost the summary beside it — the whole risk of
     folding two calls into one is that a weak second field takes a good first one with it. */
  it("writes the summary alone when the hint declined", async () => {
    const { service, published } = build(worked(), {
      generate: async () => ({ summary: "You asked and it answered.", hint: null }),
    });
    await service.onSettled("s1");
    expect(published.map((e) => e.type)).toEqual(["summary"]);
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
    const generate = vi.fn(async () => { await gate; return { summary: "done", hint: null }; });
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

/**
 * The debounce: the gate that stops a back-and-forth paying for a recap per turn.
 *
 * Fake timers throughout — the point is which settles buy a call, and sleeping for real would only
 * make the suite slower at answering the same question.
 */
describe("the recap's debounce", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const debounced = (over: Parameters<typeof build>[1] = {}) =>
    build(worked(), { debounceMs: 1_000, ...over });

  it("writes nothing until the session has been quiet for the whole window", async () => {
    const { service, published } = debounced();
    await service.onSettled("s1");
    expect(published).toEqual([]);                 // armed, not written
    await vi.advanceTimersByTimeAsync(999);
    expect(published).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(published.map((e) => e.type)).toEqual(["summary", "prompt_hint"]);
  });

  /* The whole point. Six turns in quick succession used to buy six recaps, five of them superseded
     before anybody read them. The mutant: queueing instead of re-arming. */
  it("re-arms rather than queues, so an exchange buys ONE recap and not one per turn", async () => {
    const { service, published, generate } = debounced();
    for (let i = 0; i < 6; i++) {
      await service.onSettled("s1");
      await vi.advanceTimersByTimeAsync(400); // each reply lands inside the window
    }
    expect(generate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(published.map((e) => e.type)).toEqual(["summary", "prompt_hint"]);
  });

  /* A turn that started during the wait will settle on its own and re-arm. Writing now would pay for
     a recap of a transcript that is still being added to — and it would be wrong by the time it
     landed, which is worse than late. */
  it("skips the write when a new turn started during the wait", async () => {
    let idle = true;
    const { service, generate } = debounced({ isIdle: () => idle });
    await service.onSettled("s1");
    idle = false; // the user sent again; a turn is running
    await vi.advanceTimersByTimeAsync(1_500);
    expect(generate).not.toHaveBeenCalled();
  });

  it("runs inline with no window configured — every test's and live check's path", async () => {
    const { service, published } = build(worked());
    await service.onSettled("s1");
    expect(published.map((e) => e.type)).toEqual(["summary", "prompt_hint"]);
  });

  /* A pending timer that fires after shutdown writes onto a closing handle, and one that is merely
     un-`unref`'d holds the process open. Both are how a suite stops exiting. */
  it("drops a pending write on close", async () => {
    const { service, generate } = debounced();
    await service.onSettled("s1");
    service.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(generate).not.toHaveBeenCalled();
  });
});
