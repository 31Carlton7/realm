import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { CodexConnection, type CodexConnectionOptions } from "./connection";

/**
 * Every assertion in this file is gated on a real child process: node cold start, module load and at least one
 * round trip. vitest's 1000 ms default is routinely too tight for that on a loaded two-core CI runner, and a
 * longer bound costs nothing when the assertion passes.
 */
const waitFor = <T>(fn: () => T | Promise<T>) => vi.waitFor(fn, { timeout: 10_000, interval: 25 });

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex-server.mjs", import.meta.url));
const open = (extra: Partial<CodexConnectionOptions> = {}) =>
  CodexConnection.open({ bin: process.execPath, args: [FAKE], cwd: process.cwd(), ...extra });
const startThread = (c: CodexConnection) => c.request<{ thread: { id: string } }>("thread/start", { cwd: "/tmp" });
const say = (c: CodexConnection, threadId: string, text: string) =>
  c.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
const silent = { onNotification: () => {}, onServerRequest: () => {}, onGone: () => {} };

/** The fixture's plain turn, in order. Buffer flushes must preserve it: the mapper needs deltas before item/completed. */
const MESSAGE_TURN = [
  "thread/status/changed", "turn/started", "item/started", "item/started",
  "item/agentMessage/delta", "item/agentMessage/delta", "item/completed",
  "thread/tokenUsage/updated", "thread/status/changed", "turn/completed",
];
/** The approval turn buffers 4 notifications plus the approval request before it blocks. */
const APPROVAL_PREFIX = 5;

describe("CodexConnection", () => {
  it("initializes and starts a thread", async () => {
    const c = await open();
    const r = await startThread(c);
    expect(r.thread.id).toMatch(/^th_/);
    await c.dispose();
  });

  it("rejects instead of hanging when the server never answers initialize", async () => {
    await expect(
      open({ env: { FAKE_CODEX_MUTE_INITIALIZE: "1" }, initializeTimeoutMs: 150 }),
    ).rejects.toThrow(/did not answer initialize/);
  });

  it("routes notifications to the attached thread listener only", async () => {
    const c = await open();
    const a = await startThread(c);
    const b = await startThread(c);
    const seenA: string[] = []; const seenB: string[] = [];
    c.attach(a.thread.id, { ...silent, onNotification: (m) => seenA.push(m) });
    c.attach(b.thread.id, { ...silent, onNotification: (m) => seenB.push(m) });
    await say(c, a.thread.id, "hi");
    await waitFor(() => expect(seenA).toContain("turn/completed"));
    expect(seenB).toEqual([]);
    await c.dispose();
  });

  it("delivers an approval to its attached thread and answers nothing itself", async () => {
    const c = await open();
    const unrouted: number[] = [];
    c.onUnroutedReply = (_id, code) => unrouted.push(code);
    const t = await startThread(c);
    const seen: string[] = [];
    const completed: { exitCode?: number; status?: string }[] = [];
    c.attach(t.thread.id, {
      ...silent,
      onNotification: (m, p) => {
        seen.push(m);
        if (m === "item/completed") completed.push((p as { item: { exitCode?: number; status?: string } }).item);
      },
      onServerRequest: (id, method) => { seen.push(method); c.respond(id, { decision: "accept" }); },
    });
    await say(c, t.thread.id, "APPROVE");
    await waitFor(() => expect(seen).toContain("turn/completed"));
    expect(seen).toContain("item/commandExecution/requestApproval");
    // exitCode 0 only happens if the listener's "accept" actually reached the child.
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ status: "completed", exitCode: 0 });
    expect(unrouted).toEqual([]); // the connection must not also refuse a request it delivered
    await c.dispose();
  });

  it("buffers frames that arrive before attach and flushes them in order", async () => {
    const c = await open();
    const t = await startThread(c);
    await say(c, t.thread.id, "hi");
    await waitFor(() => expect(c.bufferedCount(t.thread.id)).toBe(MESSAGE_TURN.length));
    const seen: string[] = [];
    c.attach(t.thread.id, { ...silent, onNotification: (m) => seen.push(m) });
    expect(seen).toEqual(MESSAGE_TURN);
    await c.dispose();
  });

  it("buffers a server request that arrives before any thread has attached", async () => {
    const c = await open();
    const rejected: unknown[] = [];
    c.onUnroutedReply = (id, code) => rejected.push({ id, code });
    const t = await startThread(c);
    await say(c, t.thread.id, "APPROVE");
    await waitFor(() => expect(c.bufferedCount(t.thread.id)).toBe(APPROVAL_PREFIX));
    expect(rejected).toEqual([]);
    const seen: string[] = [];
    c.attach(t.thread.id, {
      ...silent,
      onNotification: (m) => seen.push(m),
      onServerRequest: (id, method) => { seen.push(method); c.respond(id, { decision: "accept" }); },
    });
    await waitFor(() => expect(seen).toContain("turn/completed"));
    expect(seen).toContain("item/commandExecution/requestApproval");
    await c.dispose();
  });

  it("answers unroutable server requests with -32601 so turns never stall", async () => {
    const c = await open();
    const replies: unknown[] = [];
    c.onUnroutedReply = (id, code) => replies.push({ id, code });
    // A decoy thread is attached, so the buffering path (which only applies before ANY thread attaches) is off
    // and an approval for a second, unattached thread must be rejected rather than queued.
    const decoy = await startThread(c);
    c.attach(decoy.thread.id, { ...silent });
    const orphan = await startThread(c);
    await say(c, orphan.thread.id, "APPROVE");
    await waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({ code: -32601 });
    // The reply must reach the child, not just the spy: the fixture unblocks, fails the command and ends
    // the turn. 4 opening frames + 4 more once the refusal lands.
    await waitFor(() => expect(c.bufferedCount(orphan.thread.id)).toBe(8));
    const seen: string[] = [];
    c.attach(orphan.thread.id, { ...silent, onNotification: (m) => seen.push(m) });
    expect(seen.slice(4)).toEqual(["serverRequest/resolved", "item/completed", "thread/status/changed", "turn/completed"]);
    await c.dispose();
  });

  it("stops buffering once the per-thread cap is reached, and still answers requests it cannot queue", async () => {
    const c = await open();
    const rejected: number[] = [];
    c.onUnroutedReply = (_id, code) => rejected.push(code);
    const t = await startThread(c);
    // Each turn streams exactly 10 notifications, so 25 turns overrun the 200-frame cap.
    for (let i = 0; i < 25; i++) await say(c, t.thread.id, "hi");
    await waitFor(() => expect(c.bufferedCount(t.thread.id)).toBe(200));
    // The buffer is full, so this approval cannot be queued — dropping it would stall the turn forever.
    await say(c, t.thread.id, "APPROVE");
    await waitFor(() => expect(rejected).toEqual([-32601]));
    const seen: string[] = [];
    c.attach(t.thread.id, { ...silent, onNotification: (m) => seen.push(m) });
    expect(seen).toHaveLength(200);
    await c.dispose();
  });

  it("stops delivering to a detached listener and drops its buffer", async () => {
    const c = await open();
    const t = await startThread(c);
    const seen: string[] = [];
    c.attach(t.thread.id, { ...silent, onNotification: (m) => seen.push(m) });
    c.detach(t.thread.id);
    await say(c, t.thread.id, "hi");
    await waitFor(() => expect(c.bufferedCount(t.thread.id)).toBe(MESSAGE_TURN.length));
    expect(seen).toEqual([]);
    c.detach(t.thread.id);
    const later: string[] = [];
    c.attach(t.thread.id, { ...silent, onNotification: (m) => later.push(m) });
    expect(later).toEqual([]); // detach dropped the queue rather than leaving it for the next listener
    await c.dispose();
  });

  it("answers buffered server requests when their thread detaches", async () => {
    const c = await open();
    const replies: number[] = [];
    c.onUnroutedReply = (_id, code) => replies.push(code);
    const t = await startThread(c);
    await say(c, t.thread.id, "APPROVE");
    await waitFor(() => expect(c.bufferedCount(t.thread.id)).toBe(APPROVAL_PREFIX));
    c.detach(t.thread.id);
    expect(replies).toEqual([-32601]);
    // The child is still alive; abandoning the request silently would wedge its turn forever.
    await waitFor(() => expect(c.bufferedCount(t.thread.id)).toBe(4));
    await c.dispose();
  });

  it("survives a listener that throws on a notification", async () => {
    const logs: string[] = [];
    const c = await open({ onLog: (l) => logs.push(l) });
    const t = await startThread(c);
    const seen: string[] = [];
    c.attach(t.thread.id, { ...silent, onNotification: (m) => { seen.push(m); throw new Error("listener boom"); } });
    await say(c, t.thread.id, "hi");
    await waitFor(() => expect(seen).toEqual(MESSAGE_TURN)); // every later frame still lands
    expect(logs.some((l) => l.includes("listener boom"))).toBe(true);
    expect(c.alive).toBe(true);
    await c.dispose();
  });

  it("answers -32603 when a listener throws on a server request", async () => {
    const logs: string[] = [];
    const c = await open({ onLog: (l) => logs.push(l) });
    const replies: number[] = [];
    c.onUnroutedReply = (_id, code) => replies.push(code);
    const t = await startThread(c);
    const seen: string[] = [];
    c.attach(t.thread.id, {
      ...silent,
      onNotification: (m) => seen.push(m),
      onServerRequest: () => { throw new Error("approval boom"); },
    });
    await say(c, t.thread.id, "APPROVE");
    await waitFor(() => expect(seen).toContain("turn/completed")); // the turn is not wedged
    expect(replies).toEqual([-32603]);
    expect(logs.some((l) => l.includes("approval boom"))).toBe(true);
    await c.dispose();
  });

  it("does not replay an already-flushed buffer to a later listener", async () => {
    const c = await open();
    const t = await startThread(c);
    await say(c, t.thread.id, "hi");
    await waitFor(() => expect(c.bufferedCount(t.thread.id)).toBe(MESSAGE_TURN.length));
    const first: string[] = [];
    c.attach(t.thread.id, { ...silent, onNotification: (m) => first.push(m) });
    expect(first).toEqual(MESSAGE_TURN);
    const second: string[] = [];
    c.attach(t.thread.id, { ...silent, onNotification: (m) => second.push(m) });
    expect(second).toEqual([]);
    await c.dispose();
  });

  it("tells every attached thread when the process dies, flagging an intentional dispose", async () => {
    const c = await open();
    const t = await startThread(c);
    const gone: { reason: string; disposed: boolean }[] = [];
    c.attach(t.thread.id, { ...silent, onGone: (reason, disposed) => gone.push({ reason, disposed }) });
    await c.dispose();
    await waitFor(() => expect(gone).toHaveLength(1));
    expect(gone[0]).toMatchObject({ disposed: true });
    expect(c.threadCount).toBe(0);
    expect(c.alive).toBe(false);
  });

  it("reports an unexpected death as not disposed", async () => {
    const c = await open();
    const t = await startThread(c);
    const gone: { reason: string; disposed: boolean }[] = [];
    c.attach(t.thread.id, { ...silent, onGone: (reason, disposed) => gone.push({ reason, disposed }) });
    void c.request("$test/exit").catch(() => {}); // the fixture exits without replying
    await waitFor(() => expect(gone).toHaveLength(1));
    expect(gone[0]).toMatchObject({ disposed: false, reason: expect.stringContaining("exited") });
    const late: boolean[] = [];
    c.attach(t.thread.id, { ...silent, onGone: (_reason, disposed) => late.push(disposed) });
    expect(late).toEqual([false]); // a crash stays a crash for listeners that arrive afterwards
    await c.dispose();
  });

  it("keeps fanning out when a listener throws on gone", async () => {
    const logs: string[] = [];
    const c = await open({ onLog: (l) => logs.push(l) });
    const a = await startThread(c);
    const b = await startThread(c);
    c.attach(a.thread.id, { ...silent, onGone: () => { throw new Error("gone boom"); } });
    const second: boolean[] = [];
    c.attach(b.thread.id, { ...silent, onGone: (_reason, disposed) => second.push(disposed) });
    await c.dispose();
    expect(second).toEqual([true]); // one session's broken teardown must not strand its neighbours
    expect(logs.some((l) => l.includes("gone boom"))).toBe(true);
  });

  it("tells a listener that attaches after the process is already gone", async () => {
    const c = await open();
    const t = await startThread(c);
    await c.dispose();
    const gone: boolean[] = [];
    c.attach(t.thread.id, { ...silent, onGone: (_reason, disposed) => gone.push(disposed) });
    expect(gone).toEqual([true]);
    expect(c.threadCount).toBe(0);
  });
});
