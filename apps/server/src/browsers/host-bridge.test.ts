import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { RpcServer } from "../rpc/server";
import { BrowserHostBridge, HOST_HUNG_ERROR, PANE_GONE_ERROR, PANE_RESTARTED_ERROR } from "./host-bridge";

/** A stand-in for the registered host's socket: records sendTo payloads and can "close". */
function fakeHost() {
  const emitter = new EventEmitter();
  const sent: { event: string; payload: { callId: string; op: string; params: Record<string, unknown> } }[] = [];
  const ws = Object.assign(emitter, { readyState: 1 }) as unknown as WebSocket;
  const rpc = {
    sendTo: (client: unknown, event: string, payload: unknown) => {
      if (client !== ws) throw new Error("sent to the wrong client");
      sent.push({ event, payload: payload as (typeof sent)[number]["payload"] });
      return true;
    },
  } as unknown as RpcServer;
  return { ws, rpc, sent, close: () => emitter.emit("close") };
}

describe("BrowserHostBridge", () => {
  it("rejects immediately when no host has registered — never hangs", async () => {
    const { rpc } = fakeHost();
    const bridge = new BrowserHostBridge({ rpc });
    // The words matter: with the daemon, "nothing registered" means Realm is not running at all,
    // which is a different problem from a closed window and has a different fix. Main answers the
    // closed-window case itself and never reaches this line.
    await expect(bridge.call("snapshot", {})).rejects.toThrow("Realm is not running — open Realm on this Mac, then try again");
  });

  it("reports which of the three levels we are at, and when the window went away", () => {
    let clock = 1_000;
    const { rpc, ws } = fakeHost();
    const bridge = new BrowserHostBridge({ rpc, now: () => clock });
    expect(bridge.level).toBe("headless");
    // Null, not the boot time: a daemon nobody has attached to yet has had no window to lose, and
    // "while you were away" over a span in which nothing happened is a heading with nothing under it.
    expect(bridge.detachedSince).toBeNull();

    bridge.register(ws, { hasWindow: true });
    expect(bridge.level).toBe("window");
    expect(bridge.detachedSince).toBeNull();

    // The window closed. Main re-registers on the same socket — an ordinary re-register, not a drop —
    // and this timestamp is what the notifications page draws its "While you were away" line from.
    clock = 2_000;
    bridge.register(ws, { hasWindow: false });
    expect(bridge.level).toBe("no-window");
    expect(bridge.detachedSince).toBe(2_000);

    clock = 3_000;
    bridge.register(ws, { hasWindow: true });
    expect(bridge.level).toBe("window");
    expect(bridge.detachedSince).toBeNull();
  });

  it("round-trips: call sends a targeted op, handleResult settles it", async () => {
    const { ws, rpc, sent } = fakeHost();
    const bridge = new BrowserHostBridge({ rpc });
    bridge.register(ws);
    const p = bridge.call("snapshot", { browserId: "b1" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.op).toBe("snapshot");
    bridge.handleResult({ callId: sent[0]!.payload.callId, ok: true, result: { text: "snap" } });
    expect(await p).toEqual({ text: "snap" });
  });

  it("a host-reported failure rejects with its message", async () => {
    const { ws, rpc, sent } = fakeHost();
    const bridge = new BrowserHostBridge({ rpc });
    bridge.register(ws);
    const p = bridge.call("act", {});
    bridge.handleResult({ callId: sent[0]!.payload.callId, ok: false, error: "view is gone" });
    await expect(p).rejects.toThrow("view is gone");
  });

  it("host disconnect fails every pending op", async () => {
    const { ws, rpc, close } = fakeHost();
    const bridge = new BrowserHostBridge({ rpc });
    bridge.register(ws);
    const p1 = bridge.call("snapshot", {});
    const p2 = bridge.call("read", {});
    close();
    await expect(p1).rejects.toThrow(/disconnected/);
    await expect(p2).rejects.toThrow(/disconnected/);
    expect(bridge.connected).toBe(false);
  });

  it("a second register supersedes the first and fails its pending ops", async () => {
    const a = fakeHost();
    const bridge = new BrowserHostBridge({ rpc: a.rpc });
    bridge.register(a.ws);
    const stale = bridge.call("snapshot", {});
    const b = fakeHost();
    // The bridge sends through the rpc it was built with; re-register only swaps the socket. Reuse
    // a's rpc but b's socket — sendTo would throw on the wrong client, proving targeting.
    bridge.register(b.ws as never);
    await expect(stale).rejects.toThrow(/replaced/);
    // The OLD socket's close must not clear the new registration.
    a.close();
    expect(bridge.connected).toBe(true);
  });

  it("a reconnect is a detach and then an attach, never a silent swap of sockets", () => {
    // What the headless keep-awake decides on: with main gone the server holds the Mac awake itself,
    // and with main back it lets go. A new socket that replaced the old one unannounced would leave
    // it holding (or not) on the strength of a host that is no longer there.
    const first = fakeHost();
    const second = fakeHost();
    const bridge = new BrowserHostBridge({ rpc: first.rpc });
    const seen: boolean[] = [];
    bridge.onHostChange(() => seen.push(bridge.connected));
    bridge.register(first.ws, { hasWindow: true });
    first.close();
    bridge.register(second.ws, { hasWindow: true });
    expect(seen).toEqual([true, false, true]);
  });

  it("late results for unknown callIds are ignored", () => {
    const { ws, rpc } = fakeHost();
    const bridge = new BrowserHostBridge({ rpc });
    bridge.register(ws);
    expect(() => bridge.handleResult({ callId: "gone", ok: true })).not.toThrow();
  });

  it("an unanswered op times out", async () => {
    vi.useFakeTimers();
    try {
      const { ws, rpc } = fakeHost();
      const bridge = new BrowserHostBridge({ rpc });
      bridge.register(ws);
      const p = bridge.call("snapshot", {});
      const assertion = expect(p).rejects.toThrow(/timed out/);
      vi.advanceTimersByTime(60_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an op name outside the protocol", async () => {
    const { ws, rpc } = fakeHost();
    const bridge = new BrowserHostBridge({ rpc });
    bridge.register(ws);
    await expect(bridge.call("format-disk" as never, {})).rejects.toThrow(/unknown host op/);
  });
});

/**
 * A pane whose renderer stopped answering. Each op on it used to wait out its own minute, so a batch
 * of N steps, and every call after it, cost N minutes; now the first minute is the only one.
 */
describe("BrowserHostBridge — a pane that stopped answering", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** Answer the last op of this name the host was sent. */
  function answer(h: ReturnType<typeof fakeHost>, bridge: BrowserHostBridge, op: string, result: unknown): void {
    const sent = [...h.sent].reverse().find((s) => s.payload.op === op);
    if (!sent) throw new Error(`no ${op} was sent`);
    bridge.handleResult({ callId: sent.payload.callId, ok: true, result });
  }
  const opsSent = (h: ReturnType<typeof fakeHost>) => h.sent.map((s) => s.payload.op);

  /** Settles within a microtask-and-timer flush, or reports that it did not. */
  async function settlesAtOnce(p: Promise<unknown>): Promise<{ error: string } | { value: unknown } | "pending"> {
    let out: { error: string } | { value: unknown } | "pending" = "pending";
    p.then((value) => { out = { value }; }, (e: Error) => { out = { error: e.message }; });
    await vi.advanceTimersByTimeAsync(0);
    return out;
  }

  function timedOutOn(op: "act" | "snapshot" | "fillCredential" = "act") {
    const h = fakeHost();
    const bridge = new BrowserHostBridge({ rpc: h.rpc });
    bridge.register(h.ws);
    const first = bridge.call(op, { browserId: "b1" });
    first.catch(() => {});
    return { h, bridge, first };
  }

  it("checks the pane after its first minute, and a restarted pane fails the calls after it at once", async () => {
    const { h, bridge, first } = timedOutOn();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(opsSent(h)).toEqual(["act", "paneHealth"]);
    expect(h.sent[1]!.payload.params).toEqual({ browserId: "b1" });
    answer(h, bridge, "paneHealth", { state: "restarted" });
    await expect(first).rejects.toThrow(PANE_RESTARTED_ERROR);

    // THE MUTANT: no verdict kept. Each of these would be sent and wait out a minute of its own.
    expect(await settlesAtOnce(bridge.call("act", { browserId: "b1" }))).toEqual({ error: PANE_RESTARTED_ERROR });
    expect(await settlesAtOnce(bridge.call("screenshot", { browserId: "b1" }))).toEqual({ error: PANE_RESTARTED_ERROR });
    expect(opsSent(h)).toEqual(["act", "paneHealth"]);

    // Another pane is no part of it.
    void bridge.call("read", { browserId: "b2" });
    expect(opsSent(h)).toEqual(["act", "paneHealth", "read"]);

    // A snapshot opens the page again, and lifts the verdict.
    const snap = bridge.call("snapshot", { browserId: "b1" });
    await vi.advanceTimersByTimeAsync(0);
    answer(h, bridge, "snapshot", { text: "fresh" });
    expect(await snap).toEqual({ text: "fresh" });
    void bridge.call("act", { browserId: "b1" });
    expect(opsSent(h).at(-1)).toBe("act");
  });

  it("a gone pane is checked again before each call, which takes a moment rather than a minute", async () => {
    const { h, bridge, first } = timedOutOn();
    await vi.advanceTimersByTimeAsync(60_000);
    answer(h, bridge, "paneHealth", { state: "gone" });
    await expect(first).rejects.toThrow(PANE_GONE_ERROR);

    const next = bridge.call("act", { browserId: "b1" });
    await vi.advanceTimersByTimeAsync(0);
    // THE MUTANT: sent straight to the host, to wait its minute.
    expect(opsSent(h)).toEqual(["act", "paneHealth", "paneHealth"]);
    answer(h, bridge, "paneHealth", { state: "gone" });
    expect(await settlesAtOnce(next)).toEqual({ error: PANE_GONE_ERROR });

    // The user brought the pane back: the check says so and the call goes through.
    const back = bridge.call("act", { browserId: "b1" });
    await vi.advanceTimersByTimeAsync(0);
    answer(h, bridge, "paneHealth", { state: "ok" });
    await vi.advanceTimersByTimeAsync(0);
    expect(opsSent(h).at(-1)).toBe("act");
    answer(h, bridge, "act", { ok: true });
    expect(await back).toEqual({ ok: true });
  });

  it("a main that does not answer the check is reported in seconds, and so is every call after it", async () => {
    const { h, bridge, first } = timedOutOn();
    await vi.advanceTimersByTimeAsync(60_000 + 5_000);
    await expect(first).rejects.toThrow(HOST_HUNG_ERROR);

    const next = bridge.call("snapshot", { browserId: "b1" });
    next.catch(() => {});
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(next).rejects.toThrow(HOST_HUNG_ERROR);
    expect(opsSent(h)).toEqual(["act", "paneHealth", "paneHealth"]);
  });

  it("a pane that answers the check keeps the old timeout and nothing after it changes", async () => {
    const { h, bridge, first } = timedOutOn();
    await vi.advanceTimersByTimeAsync(60_000);
    answer(h, bridge, "paneHealth", { state: "ok" });
    await expect(first).rejects.toThrow(/timed out after 60s/);
    void bridge.call("act", { browserId: "b1" });
    expect(opsSent(h)).toEqual(["act", "paneHealth", "act"]);
  });

  it("a main older than the check is taken as ok", async () => {
    const { h, bridge, first } = timedOutOn();
    await vi.advanceTimersByTimeAsync(60_000);
    const check = h.sent.find((s) => s.payload.op === "paneHealth")!;
    bridge.handleResult({ callId: check.payload.callId, ok: false, error: 'unknown browser host op "paneHealth"' });
    await expect(first).rejects.toThrow(/timed out after 60s/);
  });

  it("a fill that waits on the person is never taken for a pane that stopped", async () => {
    // A Touch ID prompt the person has not answered is a minute of silence with a healthy pane behind it.
    const { h, first } = timedOutOn("fillCredential");
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(first).rejects.toThrow(/timed out after 60s/);
    expect(opsSent(h)).toEqual(["fillCredential"]);
  });

  it("ops that time out together share one check", async () => {
    const { h, bridge, first } = timedOutOn();
    const second = bridge.call("read", { browserId: "b1" });
    second.catch(() => {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(opsSent(h)).toEqual(["act", "read", "paneHealth"]);
    answer(h, bridge, "paneHealth", { state: "restarted" });
    await expect(first).rejects.toThrow(PANE_RESTARTED_ERROR);
    await expect(second).rejects.toThrow(PANE_RESTARTED_ERROR);
  });
});
