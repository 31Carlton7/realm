import { describe, expect, it, vi } from "vitest";
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
