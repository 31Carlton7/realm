import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBrowserAgentBridge } from "./browser-agent-bridge";

/** The slice of Node's global WebSocket the bridge uses, opened and dropped by hand. */
class FakeSocket {
  static readonly OPEN = 1;
  static made: FakeSocket[] = [];
  readyState = 0;
  sent: { method: string; params: unknown }[] = [];
  private readonly listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>();
  constructor(public url: string, public protocols: string[]) { FakeSocket.made.push(this); }
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(json: string): void { this.sent.push(JSON.parse(json)); }
  close(): void { this.drop(); }
  open(): void { this.readyState = 1; for (const fn of this.listeners.get("open") ?? []) fn({}); }
  drop(): void { this.readyState = 3; for (const fn of this.listeners.get("close") ?? []) fn({}); }
}

beforeEach(() => {
  FakeSocket.made = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("startBrowserAgentBridge", () => {
  it("dials wherever the server is now on every reconnect, and registers again on the new socket", () => {
    let where = { port: 1111, token: "old" };
    const connected = vi.fn();
    const disconnected = vi.fn();
    const bridge = startBrowserAgentBridge({
      endpoint: () => where, handleOp: async () => ({}), hasWindow: () => true,
      onConnected: connected, onDisconnected: disconnected,
    });
    const first = FakeSocket.made[0]!;
    expect(first).toMatchObject({ url: "ws://127.0.0.1:1111", protocols: ["realm.old"] });
    first.open();
    expect(first.sent[0]).toMatchObject({ method: "browserHost.register", params: { hasWindow: true } });

    // The server crashed, and the one started in its place minted its own port and token.
    first.drop();
    expect(disconnected).toHaveBeenCalledTimes(1);
    where = { port: 2222, token: "new" };
    vi.advanceTimersByTime(2_000);
    const second = FakeSocket.made[1]!;
    // MUTANT: read the endpoint once, outside `connect`, and this dials 1111 with the dead token forever.
    expect(second).toMatchObject({ url: "ws://127.0.0.1:2222", protocols: ["realm.new"] });
    second.open();
    // A fresh registration on the new socket: it is what makes the new server ask main for its keys,
    // and what tells it a host has attached.
    expect(second.sent[0]).toMatchObject({ method: "browserHost.register", params: { hasWindow: true } });
    expect(connected).toHaveBeenCalledTimes(2);
    bridge.stop();
  });
});
