import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { CodexConnection } from "./connection";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex-server.mjs", import.meta.url));
const open = () => CodexConnection.open({ bin: process.execPath, args: [FAKE], cwd: process.cwd() });
const startThread = (c: CodexConnection) => c.request<{ thread: { id: string } }>("thread/start", { cwd: "/tmp" });
const say = (c: CodexConnection, threadId: string, text: string) =>
  c.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
const silent = { onNotification: () => {}, onServerRequest: () => {}, onGone: () => {} };

describe("CodexConnection", () => {
  it("initializes and starts a thread", async () => {
    const c = await open();
    const r = await startThread(c);
    expect(r.thread.id).toMatch(/^th_/);
    await c.dispose();
  });

  it("routes notifications to the attached thread listener only", async () => {
    const c = await open();
    const a = await startThread(c);
    const b = await startThread(c);
    const seenA: string[] = []; const seenB: string[] = [];
    c.attach(a.thread.id, { ...silent, onNotification: (m) => seenA.push(m) });
    c.attach(b.thread.id, { ...silent, onNotification: (m) => seenB.push(m) });
    await say(c, a.thread.id, "hi");
    await vi.waitFor(() => expect(seenA).toContain("turn/completed"));
    expect(seenB).toEqual([]);
    await c.dispose();
  });

  it("buffers frames that arrive before attach and flushes them", async () => {
    const c = await open();
    const t = await startThread(c);
    await say(c, t.thread.id, "hi");
    await new Promise((r) => setTimeout(r, 50)); // let the whole turn stream out unattached
    const seen: string[] = [];
    c.attach(t.thread.id, { ...silent, onNotification: (m) => seen.push(m) });
    await vi.waitFor(() => expect(seen).toContain("turn/completed"));
    await c.dispose();
  });

  it("buffers a server request that arrives before any thread has attached", async () => {
    const c = await open();
    const rejected: unknown[] = [];
    c.onUnroutedReply = (id, code) => rejected.push({ id, code });
    const t = await startThread(c);
    await say(c, t.thread.id, "APPROVE");
    await new Promise((r) => setTimeout(r, 50)); // approval request arrives while nothing is attached
    expect(rejected).toEqual([]);
    const seen: string[] = [];
    c.attach(t.thread.id, {
      ...silent,
      onNotification: (m) => seen.push(m),
      onServerRequest: (id, method) => { seen.push(method); c.respond(id, { decision: "accept" }); },
    });
    await vi.waitFor(() => expect(seen).toContain("turn/completed"));
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
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({ code: -32601 });
    await c.dispose();
  });

  it("stops buffering once the per-thread cap is reached, and still answers requests it cannot queue", async () => {
    const c = await open();
    const rejected: number[] = [];
    c.onUnroutedReply = (_id, code) => rejected.push(code);
    const t = await startThread(c);
    // Each turn streams exactly 10 notifications, so 25 turns overrun the 200-frame cap.
    for (let i = 0; i < 25; i++) await say(c, t.thread.id, "hi");
    await new Promise((r) => setTimeout(r, 400));
    // The buffer is full, so this approval cannot be queued — dropping it would stall the turn forever.
    await say(c, t.thread.id, "APPROVE");
    await vi.waitFor(() => expect(rejected).toEqual([-32601]));
    const seen: string[] = [];
    c.attach(t.thread.id, { ...silent, onNotification: (m) => seen.push(m) });
    expect(seen).toHaveLength(200);
    await c.dispose();
  });

  it("drops a thread's buffer on detach", async () => {
    const c = await open();
    const t = await startThread(c);
    await say(c, t.thread.id, "hi");
    await new Promise((r) => setTimeout(r, 50));
    c.detach(t.thread.id);
    const seen: string[] = [];
    c.attach(t.thread.id, { ...silent, onNotification: (m) => seen.push(m) });
    expect(seen).toEqual([]);
    await c.dispose();
  });

  it("does not replay an already-flushed buffer to a later listener", async () => {
    const c = await open();
    const t = await startThread(c);
    await say(c, t.thread.id, "hi");
    await new Promise((r) => setTimeout(r, 50));
    const first: string[] = [];
    c.attach(t.thread.id, { ...silent, onNotification: (m) => first.push(m) });
    expect(first).toContain("turn/completed");
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
    await vi.waitFor(() => expect(gone).toHaveLength(1));
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
    await vi.waitFor(() => expect(gone).toHaveLength(1));
    expect(gone[0]).toMatchObject({ disposed: false, reason: expect.stringContaining("exited") });
    const late: boolean[] = [];
    c.attach(t.thread.id, { ...silent, onGone: (_reason, disposed) => late.push(disposed) });
    expect(late).toEqual([false]); // a crash stays a crash for listeners that arrive afterwards
    await c.dispose();
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
