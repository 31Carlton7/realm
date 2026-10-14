import { expect } from "vitest";
import { challengeAnswer, makeDevice, randomId, type Device } from "./devices";
import type { TestSocket } from "./socket";

export const ID = /^[A-Za-z0-9_-]{22}$/;

/** A phone id no test lists or registers. */
export const NOBODY = "AAAAAAAAAAAAAAAAAAAAAA";

export type Clients = ReturnType<typeof relayClients>;

/**
 * Macs and phones that speak §3 to a relay, over whatever `open` connects with. Every socket opened
 * is remembered so `closeAll` can end a test cleanly.
 */
export function relayClients(open: (path: string) => Promise<TestSocket>) {
  const opened: TestSocket[] = [];
  let settles = 0;

  async function connect(path: string): Promise<TestSocket> {
    const socket = await open(path);
    opened.push(socket);
    return socket;
  }

  async function answerChallenge(socket: TestSocket, device: Device, role: "mac" | "phone", macId: string, phoneId = ""): Promise<void> {
    const challenge = await socket.json();
    expect(challenge).toEqual({ t: "challenge", nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    socket.sendJson({ t: "auth", key: device.key, sig: await device.sign(challengeAnswer(role, macId, phoneId, challenge.nonce)) });
  }

  async function connectMac(mac: Device): Promise<TestSocket> {
    const socket = await connect(`/v1/mac/${mac.id}`);
    await answerChallenge(socket, mac, "mac", mac.id);
    expect(await socket.json()).toEqual({ t: "ready" });
    return socket;
  }

  /**
   * Proves the relay has handled everything this Mac sent so far. A push to a phone with no token
   * is answered from inside the room's ordered event loop, so the answer comes after the effects of
   * every earlier message. Returns what arrived before it.
   */
  async function settle(macSocket: TestSocket): Promise<unknown[]> {
    const id = `settle-${++settles}`;
    macSocket.sendJson({ t: "push", id, phone: NOBODY, blob: "", urgent: false, collapse: null, badge: null });
    const before: unknown[] = [];
    for (;;) {
      const frame = await macSocket.next();
      if ("bytes" in frame) {
        before.push(frame.bytes);
        continue;
      }
      const message = JSON.parse(frame.text);
      if (message.t === "pushed" && message.id === id) return before;
      before.push(message);
    }
  }

  /** A connected Mac that has listed `count` phones. */
  async function macWithPhones(count: number): Promise<{ mac: Device; macSocket: TestSocket; phones: Device[] }> {
    const mac = await makeDevice();
    const phones = await Promise.all(Array.from({ length: count }, () => makeDevice()));
    const macSocket = await connectMac(mac);
    macSocket.sendJson({ t: "phones", list: phones.map(({ id, key }) => ({ id, key })) });
    expect(await settle(macSocket)).toEqual([]);
    return { mac, macSocket, phones };
  }

  /** Connects as `phone` and answers the challenge, reading nothing after. */
  async function answeredPhone(mac: Device, phone: Device): Promise<TestSocket> {
    const socket = await connect(`/v1/phone/${mac.id}/${phone.id}`);
    await answerChallenge(socket, phone, "phone", mac.id, phone.id);
    return socket;
  }

  /** A listed phone, admitted while the Mac is connected, with the channel the Mac was told about. */
  async function joinPhone(mac: Device, macSocket: TestSocket, phone: Device): Promise<{ socket: TestSocket; ch: string }> {
    const socket = await answeredPhone(mac, phone);
    expect(await socket.json()).toEqual({ t: "ready", mac: { online: true, lastSeen: expect.any(Number) } });
    const open = await macSocket.json();
    expect(open).toEqual({ t: "open", ch: expect.stringMatching(ID), phone: phone.id });
    return { socket, ch: open.ch };
  }

  /** Closes the Mac's socket and waits until the relay has told `observer` it is gone. */
  async function macLeaves(macSocket: TestSocket, observer: TestSocket): Promise<number> {
    macSocket.close();
    const gone = await observer.json();
    expect(gone).toEqual({ t: "mac", online: false, lastSeen: expect.any(Number) });
    return gone.lastSeen;
  }

  async function openWindow(macSocket: TestSocket, until = Date.now() + 60_000): Promise<string> {
    const window = randomId();
    macSocket.sendJson({ t: "pair", window, until });
    expect(await settle(macSocket)).toEqual([]);
    return window;
  }

  function closeAll(): void {
    for (const socket of opened.splice(0)) socket.close();
  }

  return { connect, answerChallenge, connectMac, settle, macWithPhones, answeredPhone, joinPhone, macLeaves, openWindow, closeAll };
}
