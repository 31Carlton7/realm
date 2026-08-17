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
