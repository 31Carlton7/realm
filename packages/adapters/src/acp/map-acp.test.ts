import { describe, it, expect } from "vitest";
import { createAcpMapper } from "./map-acp";
import type { SessionEvent } from "@realm/contracts";

const types = (evs: SessionEvent[]) => evs.map((e) => e.type);
const payload = <T>(e: SessionEvent | undefined) => (e as unknown as { payload: T }).payload;
const msgId = (e: SessionEvent | undefined) => payload<{ messageId: string }>(e).messageId;
const body = (e: SessionEvent | undefined) => payload<{ content: string }>(e).content;

/** A completed tool call whose result content is the only thing under test. */
function resultFor(update: Record<string, unknown>): string {
  const m = createAcpMapper();
  m.map({ sessionUpdate: "tool_call", toolCallId: "t", title: "T" });
  return body(m.map({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed", ...update })[0]);
}

describe("createAcpMapper", () => {
  it("groups a contiguous message run under one id and flushes it as assistant_text", () => {
    const m = createAcpMapper();
    const a = m.map({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
    const b = m.map({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
    expect(types(a)).toEqual(["assistant_delta"]);
    const idA = (a[0] as { payload: { messageId: string } }).payload.messageId;
    expect((b[0] as { payload: { messageId: string } }).payload.messageId).toBe(idA);
    const flushed = m.flush();
    expect(flushed[0]).toMatchObject({ type: "assistant_text", payload: { messageId: idA, text: "Hello" } });
    expect(m.flush()).toEqual([]); // idempotent
  });

  it("flushes the message run before an interleaved tool call", () => {
    const m = createAcpMapper();
    m.map({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading " } });
    const out = m.map({ sessionUpdate: "tool_call", toolCallId: "call_1", title: "Read NOTES.txt", kind: "read", status: "pending", rawInput: { path: "/tmp/NOTES.txt" } });
    expect(types(out)).toEqual(["assistant_text", "tool_call"]);
    expect(out[1]).toMatchObject({ payload: { toolUseId: "call_1", name: "Read NOTES.txt", input: { path: "/tmp/NOTES.txt" }, parentToolUseId: null } });
  });

  it("emits thinking from a thought run", () => {
    const m = createAcpMapper();
    m.map({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "I should " } });
    m.map({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "read it." } });
    expect(m.flush()[0]).toMatchObject({ type: "thinking", payload: { text: "I should read it." } });
  });

  it("treats tool_call_update as a sparse patch and only completes once", () => {
    const m = createAcpMapper();
    m.map({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Read", kind: "read", status: "pending" });
    expect(m.map({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" })).toEqual([]);
    const done = m.map({
      sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed",
      content: [{ type: "content", content: { type: "text", text: "hello from realm\n" } }],
    });
    expect(done[0]).toMatchObject({ type: "tool_result", payload: { toolUseId: "c1", content: "hello from realm\n", isError: false } });
    // A trailing patch must not emit a second result.
    expect(m.map({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" })).toEqual([]);
  });

  it("marks a failed tool call as an error result", () => {
    const m = createAcpMapper();
    m.map({ sessionUpdate: "tool_call", toolCallId: "c2", title: "Run", kind: "execute" });
    expect(m.map({ sessionUpdate: "tool_call_update", toolCallId: "c2", status: "failed" })[0])
      .toMatchObject({ type: "tool_result", payload: { isError: true } });
  });

  it("renders diff and terminal tool content", () => {
    const m = createAcpMapper();
    m.map({ sessionUpdate: "tool_call", toolCallId: "c3", title: "Edit", kind: "edit" });
    const out = m.map({
      sessionUpdate: "tool_call_update", toolCallId: "c3", status: "completed",
      content: [{ type: "diff", path: "/tmp/a.txt", oldText: "a\n", newText: "b\n" }, { type: "terminal", terminalId: "t1" }],
    });
    const content = (out[0] as { payload: { content: string } }).payload.content;
    expect(content).toContain("/tmp/a.txt");
    expect(content).toContain("[terminal t1]");
  });

  it("does not clear a title when a patch omits it", () => {
    const m = createAcpMapper();
    m.map({ sessionUpdate: "tool_call", toolCallId: "c4", title: "Original", kind: "read" });
    m.map({ sessionUpdate: "tool_call_update", toolCallId: "c4", status: "in_progress" });
    expect(m.titleOf("c4")).toBe("Original");
  });

  it("drops plan, command-list, mode and user-echo updates", () => {
    const m = createAcpMapper();
    for (const u of [
      { sessionUpdate: "plan", entries: [] },
      { sessionUpdate: "available_commands_update", availableCommands: [] },
      { sessionUpdate: "current_mode_update", currentModeId: "agent" },
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "echo" } },
    ]) expect(m.map(u)).toEqual([]);
  });
  // ---- run grouping ----------------------------------------------------------------------------------------

  it("emits each chunk as its own delta, not the run so far", () => {
    const m = createAcpMapper();
    const a = m.map({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
    const b = m.map({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
    expect(payload<{ delta: string }>(a[0]).delta).toBe("Hel");
    expect(payload<{ delta: string }>(b[0]).delta).toBe("lo");
  });

  it("gives every run a fresh id", () => {
    const m = createAcpMapper();
    m.map({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one" } });
    const first = m.flush();
    m.map({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "two" } });
    const second = m.flush();
    m.map({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "three" } });
    const third = m.flush();
    expect(msgId(first[0])).not.toBe(msgId(second[0]));
    expect(msgId(third[0])).not.toBe(msgId(second[0]));
  });

  it("closes an open thought run when a message chunk interrupts it", () => {
    const m = createAcpMapper();
    m.map({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
    const out = m.map({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } });
    expect(types(out)).toEqual(["thinking", "assistant_delta"]);
    expect(out[0]).toMatchObject({ payload: { text: "hmm" } });
    expect(msgId(out[0])).not.toBe(msgId(out[1]));
  });

  it("closes an open message run when a thought chunk interrupts it", () => {
    const m = createAcpMapper();
    m.map({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } });
    const out = m.map({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
    expect(types(out)).toEqual(["assistant_text"]);
    expect(out[0]).toMatchObject({ payload: { text: "Hi" } });
  });

  it("flushes a thought run only once", () => {
    const m = createAcpMapper();
    m.map({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
    expect(types(m.flush())).toEqual(["thinking"]);
    expect(m.flush()).toEqual([]);
  });

  it("never persists an empty run", () => {
    // An unrecognised block contributes no text, so the run has nothing worth persisting. Separate mappers, so
    // each run is flushed by flush() itself rather than by the other chunk kind's cross-flush.
    const a = createAcpMapper();
    expect(types(a.map({ sessionUpdate: "agent_message_chunk", content: { type: "video", data: "…" } }))).toEqual(["assistant_delta"]);
    expect(a.flush()).toEqual([]);
    const b = createAcpMapper();
    expect(b.map({ sessionUpdate: "agent_thought_chunk", content: { type: "video", data: "…" } })).toEqual([]);
    expect(b.flush()).toEqual([]);
  });

  it("flushes an open run before a dropped update too", () => {
    const m = createAcpMapper();
    m.map({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } });
    expect(types(m.map({ sessionUpdate: "plan", entries: [] }))).toEqual(["assistant_text"]);
  });

  // ---- content blocks --------------------------------------------------------------------------------------

  it("renders every ACP content-block variant", () => {
    expect(resultFor({ content: [
      { type: "content", content: { type: "text", text: "plain" } },
      { type: "content", content: { type: "image", data: "…", mimeType: "image/png" } },
      { type: "content", content: { type: "audio", data: "…", mimeType: "audio/wav" } },
      { type: "content", content: { type: "resource_link", uri: "file:///u", name: "NOTES.txt" } },
      { type: "content", content: { type: "resource_link", uri: "file:///only" } },
      { type: "content", content: { type: "resource", resource: { uri: "file:///r", text: "x" } } },
      { type: "content", content: { type: "video", data: "…" } },
      { type: "bogus" },
    ] })).toBe("plain\n[image]\n[audio]\n[NOTES.txt]\n[file:///only]\n[resource file:///r]");
  });

  it("renders a diff with and without a prior version", () => {
    expect(resultFor({ content: [{ type: "diff", path: "/tmp/a.txt", oldText: "a\n", newText: "b\n" }] }))
      .toBe("--- /tmp/a.txt\n- a\n+ b");
    // `oldText: null` means the file is new — there is no previous line to show.
    expect(resultFor({ content: [{ type: "diff", path: "/tmp/new.txt", oldText: null, newText: "b\n" }] }))
      .toBe("--- /tmp/new.txt\n+ b");
  });

  it("falls back to rawOutput only when the content array yields nothing", () => {
    expect(resultFor({ rawOutput: { bytes: 23 } })).toBe('{"bytes":23}');
    expect(resultFor({ content: "not-an-array", rawOutput: { bytes: 23 } })).toBe('{"bytes":23}');
    expect(resultFor({ content: [{ type: "content", content: { type: "text", text: "real" } }], rawOutput: { bytes: 23 } })).toBe("real");
    expect(resultFor({ rawOutput: null })).toBe("");
    expect(resultFor({})).toBe("");
  });

  // ---- sparse-patch merge ----------------------------------------------------------------------------------

  it("keeps kind and rawInput when a patch omits them", () => {
    const m = createAcpMapper();
    m.map({ sessionUpdate: "tool_call", toolCallId: "k1", title: "Read", kind: "read", rawInput: { path: "/tmp/x" } });
    m.map({ sessionUpdate: "tool_call_update", toolCallId: "k1", status: "in_progress" });
    expect(m.callOf("k1")).toMatchObject({ title: "Read", kind: "read", input: { path: "/tmp/x" } });
    // A patch that does carry them still wins.
    m.map({ sessionUpdate: "tool_call_update", toolCallId: "k1", title: "Read more", kind: "search", rawInput: { path: "/tmp/y" } });
    expect(m.callOf("k1")).toMatchObject({ title: "Read more", kind: "search", input: { path: "/tmp/y" } });
  });

  it("records a patch for a call it never saw created", () => {
    const m = createAcpMapper();
    m.map({ sessionUpdate: "tool_call_update", toolCallId: "ghost", title: "Ghost", status: "in_progress" });
    expect(m.titleOf("ghost")).toBe("Ghost");
    m.map({ sessionUpdate: "tool_call_update", toolCallId: "orphan", status: "in_progress" });
    expect(m.titleOf("orphan")).toBe("orphan"); // the id is the only label available
  });

  it("defaults a tool call's name and kind when the agent omits them", () => {
    const m = createAcpMapper();
    const out = m.map({ sessionUpdate: "tool_call", toolCallId: "d1" });
    expect(out[0]).toMatchObject({ payload: { toolUseId: "d1", name: "d1", input: {} } });
    expect(m.callOf("d1")).toMatchObject({ kind: "other" });
  });

  it("emits no result while a call is only pending or in progress", () => {
    const m = createAcpMapper();
    m.map({ sessionUpdate: "tool_call", toolCallId: "p1", title: "Read" });
    expect(m.map({ sessionUpdate: "tool_call_update", toolCallId: "p1", status: "pending" })).toEqual([]);
    expect(m.map({ sessionUpdate: "tool_call_update", toolCallId: "p1" })).toEqual([]);
  });

  // ---- closeOpenCalls --------------------------------------------------------------------------------------

  it("closes only the calls still open, once", () => {
    const m = createAcpMapper();
    m.map({ sessionUpdate: "tool_call", toolCallId: "done1", title: "Done" });
    m.map({ sessionUpdate: "tool_call_update", toolCallId: "done1", status: "completed" });
    m.map({ sessionUpdate: "tool_call", toolCallId: "open1", title: "Open" });
    const out = m.closeOpenCalls("agent exited mid-turn");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "tool_result", payload: { toolUseId: "open1", content: "agent exited mid-turn", isError: true } });
    expect(m.closeOpenCalls("again")).toEqual([]);
    // A late patch for a force-closed call must not produce a second result.
    expect(m.map({ sessionUpdate: "tool_call_update", toolCallId: "open1", status: "completed" })).toEqual([]);
  });

  // ---- defensive parsing -----------------------------------------------------------------------------------

  it("ignores malformed updates instead of throwing", () => {
    const m = createAcpMapper();
    expect(m.map(null)).toEqual([]);
    expect(m.map(undefined)).toEqual([]);
    expect(m.map("nonsense")).toEqual([]);
    expect(m.map({})).toEqual([]);
  });

  it("ignores non-string fields rather than coercing them", () => {
    const m = createAcpMapper();
    const out = m.map({ sessionUpdate: "tool_call", toolCallId: "n1", title: 42, kind: 7 });
    expect(out[0]).toMatchObject({ payload: { name: "n1" } });
    expect(m.callOf("n1")).toMatchObject({ kind: "other" });
  });
});
