import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { RpcClient } from "./client";

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null; onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null; sent: string[] = []; readyState = 1;
  constructor(public url: string) { FakeSocket.instances.push(this); queueMicrotask(() => this.onopen?.()); }
  send(s: string) { this.sent.push(s); }
  close() { this.onclose?.(); }
}

describe("RpcClient", () => {
  it("sends requests and resolves matching responses; dispatches events", async () => {
    const c = new RpcClient("ws://x", FakeSocket as unknown as typeof WebSocket);
    await c.ready();
    const sock = FakeSocket.instances.at(-1)!;
    const p = c.call("profiles.list", {});
    const req = JSON.parse(sock.sent[0]!);
    expect(req.method).toBe("profiles.list");
    sock.onmessage!({ data: JSON.stringify({ id: req.id, ok: true, result: [] }) });
    expect(await p).toEqual([]);
    const spy = vi.fn(); c.on("terminal.data", spy);
    sock.onmessage!({ data: JSON.stringify({ event: "terminal.data", payload: { terminalId: "t", data: "x" } }) });
    expect(spy).toHaveBeenCalledWith({ terminalId: "t", data: "x" });
  });
  it("rejects on error response", async () => {
    const c = new RpcClient("ws://x", FakeSocket as unknown as typeof WebSocket);
    await c.ready();
    const sock = FakeSocket.instances.at(-1)!;
    const p = c.call("spaces.delete", { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
    const req = JSON.parse(sock.sent[0]!);
    sock.onmessage!({ data: JSON.stringify({ id: req.id, ok: false, error: { code: "NOT_FOUND", message: "nope" } }) });
    await expect(p).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

class ManualSocket {
  static instances: ManualSocket[] = [];
  onopen: (() => void) | null = null; onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null; sent: string[] = []; readyState = 0;
  constructor(public url: string) { ManualSocket.instances.push(this); }
  send(s: string) { if (this.readyState !== 1) throw new Error("not open"); this.sent.push(s); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
}
const Manual = ManualSocket as unknown as typeof WebSocket;

describe("RpcClient failure modes", () => {
  it("queues a call made before open and sends it after open", async () => {
    const c = new RpcClient("ws://x", Manual);
    const sock = ManualSocket.instances.at(-1)!;
    const p = c.call("profiles.list", {});
    expect(sock.sent).toHaveLength(0);
    sock.open();
    await c.ready();
    await Promise.resolve();
    expect(sock.sent).toHaveLength(1);
    const req = JSON.parse(sock.sent[0]!);
    sock.onmessage!({ data: JSON.stringify({ id: req.id, ok: true, result: [] }) });
    expect(await p).toEqual([]);
  });
  it("rejects in-flight calls with DISCONNECTED when the socket closes", async () => {
    const c = new RpcClient("ws://x", Manual);
    const sock = ManualSocket.instances.at(-1)!;
    sock.open();
    const p = c.call("profiles.list", {});
    sock.close();
    await expect(p).rejects.toMatchObject({ name: "RpcError", code: "DISCONNECTED" });
  });
  it("rejects immediately when calling after close", async () => {
    const c = new RpcClient("ws://x", Manual);
    const sock = ManualSocket.instances.at(-1)!;
    sock.open(); sock.close();
    await expect(c.call("profiles.list", {})).rejects.toMatchObject({ code: "DISCONNECTED" });
    expect(sock.sent).toHaveLength(0);
  });
  it("unsubscribe stops event delivery", () => {
    const c = new RpcClient("ws://x", Manual);
    const sock = ManualSocket.instances.at(-1)!;
    sock.open();
    const spy = vi.fn();
    const off = c.on("terminal.data", spy);
    const frame = { data: JSON.stringify({ event: "terminal.data", payload: { terminalId: "t", data: "x" } }) };
    sock.onmessage!(frame);
    off();
    sock.onmessage!(frame);
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("a garbage frame is ignored and later calls still work", async () => {
    const c = new RpcClient("ws://x", Manual);
    const sock = ManualSocket.instances.at(-1)!;
    sock.open();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => sock.onmessage!({ data: "{not json" })).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    const p = c.call("profiles.list", {});
    const req = JSON.parse(sock.sent[0]!);
    sock.onmessage!({ data: JSON.stringify({ id: req.id, ok: true, result: [] }) });
    expect(await p).toEqual([]);
  });
});

/** Fully manual socket for reconnect tests: nothing happens until the test opens/fails it. */
class ReconnSocket {
  static instances: ReconnSocket[] = [];
  onopen: (() => void) | null = null; onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null; sent: string[] = []; readyState = 0;
  constructor(public url: string) { ReconnSocket.instances.push(this); }
  send(s: string) { if (this.readyState !== 1) throw new Error("not open"); this.sent.push(s); }
  open() { this.readyState = 1; this.onopen?.(); }
  fail() { this.readyState = 3; this.onclose?.(); }
  /** What the client's own dispose/abort calls: like a real socket, closing fires onclose (if attached). */
  close() { this.readyState = 3; this.onclose?.(); }
}
const Reconn = ReconnSocket as unknown as typeof WebSocket;

describe("RpcClient reconnect", () => {
  beforeEach(() => { ReconnSocket.instances = []; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("reconnects with 1s/2s/4s/8s backoff, caps at 15s, and keeps trying forever", () => {
    const c = new RpcClient("ws://x", Reconn);
    const statuses: string[] = [];
    c.onStatusChange((s) => statuses.push(s));
    const sockets = ReconnSocket.instances;
    sockets[0]!.open();
    sockets[0]!.fail();
    expect(statuses).toEqual(["reconnecting"]);
    // 1s: nothing at 999ms, a fresh dial at 1000ms.
    vi.advanceTimersByTime(999); expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1); expect(sockets).toHaveLength(2);
    sockets[1]!.fail();
    // 2s
    vi.advanceTimersByTime(1999); expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1); expect(sockets).toHaveLength(3);
    sockets[2]!.fail();
    // 4s
    vi.advanceTimersByTime(3999); expect(sockets).toHaveLength(3);
    vi.advanceTimersByTime(1); expect(sockets).toHaveLength(4);
    sockets[3]!.fail();
    // 8s
    vi.advanceTimersByTime(7999); expect(sockets).toHaveLength(4);
    vi.advanceTimersByTime(1); expect(sockets).toHaveLength(5);
    sockets[4]!.fail();
    // would be 16s — capped at 15s
    vi.advanceTimersByTime(14999); expect(sockets).toHaveLength(5);
    vi.advanceTimersByTime(1); expect(sockets).toHaveLength(6);
    sockets[5]!.fail();
    // and forever: still 15s, not growing, not stopping
    vi.advanceTimersByTime(15000); expect(sockets).toHaveLength(7);
    // failed dials never emitted extra status changes
    expect(statuses).toEqual(["reconnecting"]);
  });

  it("on reopen: emits connected, event handlers survive onto the new socket, and calls flow again", async () => {
    const c = new RpcClient("ws://x", Reconn);
    const sockets = ReconnSocket.instances;
    sockets[0]!.open();
    const events = vi.fn();
    c.on("terminal.data", events);
    const statuses: string[] = [];
    c.onStatusChange((s) => statuses.push(s));
    sockets[0]!.fail();
    vi.advanceTimersByTime(1000);
    const s2 = sockets[1]!;
    s2.open();
    expect(statuses).toEqual(["reconnecting", "connected"]);
    // Handlers registered before the drop still fire for frames on the NEW socket.
    s2.onmessage!({ data: JSON.stringify({ event: "terminal.data", payload: { terminalId: "t", data: "x" } }) });
    expect(events).toHaveBeenCalledWith({ terminalId: "t", data: "x" });
    // And calls use the new socket.
    const p = c.call("profiles.list", {});
    expect(s2.sent).toHaveLength(1);
    const req = JSON.parse(s2.sent[0]!);
    s2.onmessage!({ data: JSON.stringify({ id: req.id, ok: true, result: [] }) });
    expect(await p).toEqual([]);
    // Backoff reset by the successful open: the next drop dials again after 1s, not 2s.
    s2.fail();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(3);
    expect(statuses).toEqual(["reconnecting", "connected", "reconnecting"]);
  });

  it("retryNow forces an immediate dial, aborts an in-flight dial in favour of a fresh one, and unsubscribing onStatusChange stops notifications", () => {
    const c = new RpcClient("ws://x", Reconn);
    const sockets = ReconnSocket.instances;
    sockets[0]!.open();
    const statuses: string[] = [];
    const off = c.onStatusChange((s) => statuses.push(s));
    c.retryNow(); // connected: no-op
    expect(sockets).toHaveLength(1);
    sockets[0]!.fail();
    expect(sockets).toHaveLength(1); // timer pending, no dial yet
    c.retryNow();
    expect(sockets).toHaveLength(2); // immediate, no timer wait
    c.retryNow();
    expect(sockets).toHaveLength(3); // Retry is honest mid-dial: the stale dial is aborted, a fresh one starts
    expect(sockets[1]!.readyState).toBe(3); // the superseded socket was actually closed
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(3); // no timer ever fires a duplicate dial
    off();
    sockets[2]!.open();
    expect(statuses).toEqual(["reconnecting"]); // "connected" arrived after unsubscribe
  });

  it("retryNow's abort rejects calls queued on the aborted dial with DISCONNECTED", async () => {
    const c = new RpcClient("ws://x", Reconn);
    const sockets = ReconnSocket.instances;
    sockets[0]!.open();
    sockets[0]!.fail();
    vi.advanceTimersByTime(1000); // dial #2 in flight
    const p = c.call("profiles.list", {}); // queued on the in-flight dial
    c.retryNow(); // aborts dial #2, starts dial #3
    await expect(p).rejects.toMatchObject({ name: "RpcError", code: "DISCONNECTED" });
    // The fresh dial still works end to end.
    const s3 = sockets[2]!;
    s3.open();
    const p2 = c.call("profiles.list", {});
    await Promise.resolve(); await Promise.resolve();
    const req = JSON.parse(s3.sent[0]!);
    s3.onmessage!({ data: JSON.stringify({ id: req.id, ok: true, result: [] }) });
    expect(await p2).toEqual([]);
  });

  it("dispose closes the socket, rejects pending calls, and stops reconnecting for good", async () => {
    const c = new RpcClient("ws://x", Reconn);
    const sockets = ReconnSocket.instances;
    sockets[0]!.open();
    const statuses: string[] = [];
    c.onStatusChange((s) => statuses.push(s));
    const p = c.call("profiles.list", {});
    c.dispose();
    await expect(p).rejects.toMatchObject({ name: "RpcError", code: "DISCONNECTED" });
    expect(sockets[0]!.readyState).toBe(3); // actually closed
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1); // never dials again
    expect(statuses).toEqual([]); // a deliberate teardown is not a "reconnecting" event
    await expect(c.call("profiles.list", {})).rejects.toMatchObject({ code: "DISCONNECTED" });
  });

  it("dispose while reconnecting clears the retry timer — no dial ever fires afterwards", () => {
    const c = new RpcClient("ws://x", Reconn);
    const sockets = ReconnSocket.instances;
    sockets[0]!.open();
    sockets[0]!.fail(); // timer pending
    c.dispose();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    c.retryNow(); // after dispose even an explicit retry is a no-op
    expect(sockets).toHaveLength(1);
  });

  it("calls made while a reconnect dial is in flight are queued and sent once it opens", async () => {
    const c = new RpcClient("ws://x", Reconn);
    const sockets = ReconnSocket.instances;
    sockets[0]!.open();
    sockets[0]!.fail();
    vi.advanceTimersByTime(1000);
    const s2 = sockets[1]!;
    const p = c.call("profiles.list", {});
    expect(s2.sent).toHaveLength(0);
    s2.open();
    await Promise.resolve(); await Promise.resolve();
    expect(s2.sent).toHaveLength(1);
    const req = JSON.parse(s2.sent[0]!);
    s2.onmessage!({ data: JSON.stringify({ id: req.id, ok: true, result: [] }) });
    expect(await p).toEqual([]);
  });
});
