/**
 * What only the local relay can show: its HTTP surface, its clock-driven rules (run here on a faked
 * clock rather than by waiting), its default of no APNs, and that close() lets go of everything.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startLocalRelay, type LocalRelay } from "../../src/node";
import { relayClients } from "../shared/clients";
import { concat, fromB64u, makeDevice, randomId, utf8 } from "../shared/devices";
import { connectWs } from "./connect";

let relay: LocalRelay;
beforeAll(async () => {
  relay = await startLocalRelay();
});
afterAll(() => relay.close());

const { connect: open, settle, macWithPhones, answeredPhone, joinPhone, openWindow, closeAll } = relayClients((path) =>
  connectWs(relay.url + path),
);
afterEach(() => {
  closeAll();
  vi.useRealTimers();
});

const http = (path: string): Promise<Response> => fetch(relay.url.replace(/^ws:/, "http:") + path);

describe("routes", () => {
  it("serves on a ws:// base with no trailing slash", () => {
    expect(relay.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
  });

  it("answers GET /health with ok", async () => {
    const res = await http("/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("answers 404 for anything that is not a route, upgrade or not", async () => {
    const id = randomId();
    for (const path of ["/", "/v1", `/v2/mac/${id}`, "/v1/mac/short", `/v1/mac/${id}/extra`, `/v1/phone/${id}`, `/v1/pair/${id}/not-an-id`]) {
      expect([path, (await http(path)).status]).toEqual([path, 404]);
      await expect(connectWs(relay.url + path)).rejects.toThrow();
    }
  });

  it("answers 426 to a relay route asked for without a WebSocket upgrade", async () => {
    expect((await http(`/v1/mac/${randomId()}`)).status).toBe(426);
  });
});

describe("the auth deadline (§3.1)", () => {
  it("closes a socket still unauthenticated 10 s after opening with 4408, and no other", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { mac, macSocket, phones } = await macWithPhones(1);
    const phone = await joinPhone(mac, macSocket, phones[0]!);
    const silent = await open(`/v1/phone/${mac.id}/${phones[0]!.id}`);
    await silent.json();

    await vi.advanceTimersByTimeAsync(9_999);
    expect(silent.isClosed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await silent.closeCode()).toBe(4408);

    phone.socket.send(utf8("unaffected"));
    expect(await macSocket.binary()).toEqual(concat(fromB64u(phone.ch), utf8("unaffected")));
  });
});

describe("liveness (§3.2)", () => {
  it("calls the Mac offline 60 s after its last message, and online again after a heartbeat", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { mac, macSocket, phones } = await macWithPhones(3);
    const seen = Date.now();

    vi.setSystemTime(seen + 59_999);
    const before = await answeredPhone(mac, phones[0]!);
    expect(await before.json()).toEqual({ t: "ready", mac: { online: true, lastSeen: seen } });
    expect(await macSocket.json()).toMatchObject({ t: "open" });

    vi.setSystemTime(seen + 60_000);
    const after = await answeredPhone(mac, phones[1]!);
    expect(await after.json()).toEqual({ t: "ready", mac: { online: false, lastSeen: seen } });
    expect(await macSocket.json()).toMatchObject({ t: "open" });

    // The heartbeat is answered before the room sees it, as workerd's auto-response is, and counts.
    macSocket.send("ping");
    expect(await macSocket.text()).toBe("pong");
    const late = await answeredPhone(mac, phones[2]!);
    expect(await late.json()).toEqual({ t: "ready", mac: { online: true, lastSeen: seen + 60_000 } });
  });
});

describe("a quiet Mac (§3.2)", () => {
  it("tells every phone once when the Mac goes quiet, and at once when it speaks again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { mac, macSocket, phones } = await macWithPhones(2);
    const a = await joinPhone(mac, macSocket, phones[0]!);
    const b = await joinPhone(mac, macSocket, phones[1]!);
    const seen = Date.now();

    await vi.advanceTimersByTimeAsync(59_999);
    await a.socket.quiet();
    await vi.advanceTimersByTimeAsync(1);
    for (const phone of [a, b]) expect(await phone.socket.json()).toEqual({ t: "mac", online: false, lastSeen: seen });

    // The room keeps looking, and says nothing more while the Mac stays quiet.
    await vi.advanceTimersByTimeAsync(60_000);
    await a.socket.quiet();
    await b.socket.quiet();

    // Its next message, of any kind, is news to every phone before it reaches any of them.
    macSocket.send(concat(fromB64u(a.ch), utf8("back")));
    expect(await a.socket.json()).toEqual({ t: "mac", online: true, lastSeen: seen + 120_000 });
    expect(await a.socket.binary()).toEqual(utf8("back"));
    expect(await b.socket.json()).toEqual({ t: "mac", online: true, lastSeen: seen + 120_000 });

    // And the watch starts over from that message.
    await vi.advanceTimersByTimeAsync(59_999);
    await b.socket.quiet();
    await vi.advanceTimersByTimeAsync(1);
    expect(await b.socket.json()).toEqual({ t: "mac", online: false, lastSeen: seen + 120_000 });
  });

  it("notices a Mac that wakes with only a heartbeat at its next look, within 10 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { mac, macSocket, phones } = await macWithPhones(1);
    const phone = await joinPhone(mac, macSocket, phones[0]!);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await phone.socket.json()).toMatchObject({ t: "mac", online: false });

    await vi.advanceTimersByTimeAsync(5_000);
    macSocket.send("ping");
    expect(await macSocket.text()).toBe("pong");
    const beat = Date.now();
    // The heartbeat never reaches the room, so nothing changes until it looks.
    await phone.socket.quiet();
    await vi.advanceTimersByTimeAsync(4_999);
    await phone.socket.quiet();
    await vi.advanceTimersByTimeAsync(1);
    expect(await phone.socket.json()).toEqual({ t: "mac", online: true, lastSeen: beat });
  });

  it("tells a phone that joins a quiet Mac in its ready, and not again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { mac, macSocket, phones } = await macWithPhones(2);
    const first = await joinPhone(mac, macSocket, phones[0]!);
    const seen = Date.now();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await first.socket.json()).toEqual({ t: "mac", online: false, lastSeen: seen });

    const late = await answeredPhone(mac, phones[1]!);
    expect(await late.json()).toEqual({ t: "ready", mac: { online: false, lastSeen: seen } });
    await vi.advanceTimersByTimeAsync(30_000);
    await late.quiet();
    await first.socket.quiet();

    macSocket.sendJson({ t: "something-newer" });
    for (const socket of [first.socket, late]) expect(await socket.json()).toEqual({ t: "mac", online: true, lastSeen: seen + 90_000 });
  });

  it("tells a pairing phone too", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { mac, macSocket } = await macWithPhones(0);
    const window = await openWindow(macSocket, Date.now() + 5 * 60_000);
    const seen = Date.now();
    const pairing = await open(`/v1/pair/${mac.id}/${window}`);
    expect(await pairing.json()).toEqual({ t: "ready", mac: { online: true, lastSeen: seen } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pairing.json()).toEqual({ t: "mac", online: false, lastSeen: seen });
  });

  it("settles what the phones already connected were told before admitting another", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { mac, macSocket, phones } = await macWithPhones(2);
    const first = await joinPhone(mac, macSocket, phones[0]!);
    const seen = Date.now();
    // The Mac goes quiet, and a phone arrives before the alarm has looked.
    vi.setSystemTime(seen + 60_000);
    const late = await answeredPhone(mac, phones[1]!);
    expect(await late.json()).toEqual({ t: "ready", mac: { online: false, lastSeen: seen } });
    expect(await first.socket.json()).toEqual({ t: "mac", online: false, lastSeen: seen });
    // When the alarm does look, there is nothing left to tell.
    await vi.advanceTimersByTimeAsync(10_000);
    await late.quiet();
    await first.socket.quiet();
  });
});

describe("the pairing window (§3.2)", () => {
  it("caps a window at 10 minutes from when it was opened", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { mac, macSocket } = await macWithPhones(0);
    const opened = Date.now();
    const window = await openWindow(macSocket, opened + 60 * 60_000);

    vi.setSystemTime(opened + 10 * 60_000 - 1);
    expect(await (await open(`/v1/pair/${mac.id}/${window}`)).json()).toMatchObject({ t: "ready" });
    vi.setSystemTime(opened + 10 * 60_000);
    expect(await (await open(`/v1/pair/${mac.id}/${window}`)).closeCode()).toBe(4403);
  });
});

describe("pushes (§7)", () => {
  it("answers apns-not-configured when started without an APNs sender", async () => {
    const { mac, macSocket, phones } = await macWithPhones(1);
    const { socket, ch } = await joinPhone(mac, macSocket, phones[0]!);
    socket.sendJson({ t: "apns", token: "ab".repeat(32), env: "sandbox" });
    socket.send(utf8("registered"));
    expect(await macSocket.binary()).toEqual(concat(fromB64u(ch), utf8("registered")));
    macSocket.sendJson({ t: "push", id: "p", phone: phones[0]!.id, blob: "AAAA", urgent: true, collapse: null, badge: null });
    expect(await macSocket.json()).toEqual({ t: "pushed", phone: phones[0]!.id, id: "p", ok: false, status: 0, reason: "apns-not-configured" });
  });
});

describe("close()", () => {
  it("closes every socket with 1001 and gives its port back", async () => {
    const own = await startLocalRelay();
    const clients = relayClients((path) => connectWs(own.url + path));
    const macSocket = await clients.connectMac(await makeDevice());
    await own.close();
    expect(await macSocket.closeCode()).toBe(1001);
    const again = await startLocalRelay({ port: Number(new URL(own.url).port) });
    expect(again.url).toBe(own.url);
    await again.close();
  });
});

describe("rooms", () => {
  it("keeps each Mac's room apart from every other's", async () => {
    const a = await macWithPhones(1);
    const b = await macWithPhones(1);
    const phone = await joinPhone(a.mac, a.macSocket, a.phones[0]!);
    phone.socket.send(utf8("for a only"));
    expect(await a.macSocket.binary()).toEqual(concat(fromB64u(phone.ch), utf8("for a only")));
    expect(await settle(b.macSocket)).toEqual([]);
    // And b's list does not admit a's phone.
    expect(await (await answeredPhone(b.mac, a.phones[0]!)).closeCode()).toBe(4403);
  });
});
