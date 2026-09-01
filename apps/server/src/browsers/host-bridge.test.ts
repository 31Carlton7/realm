import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { RpcServer } from "../rpc/server";
import { BrowserHostBridge } from "./host-bridge";

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
    await expect(bridge.call("snapshot", {})).rejects.toThrow(/desktop app running/);
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
    await expect(bridge.call("format-disk" as never, {})).rejects.toThrow(/unknown browser host op/);
  });
});
