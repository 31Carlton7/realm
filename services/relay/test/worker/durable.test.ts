/**
 * What only the Worker can show: its routes, the alarm that enforces deadlines while the object
 * hibernates, liveness read from the runtime's own heartbeat timestamps, and state that survives the
 * object being evicted or restarted.
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { STORE, type Attachment } from "../../src/core";
import { apnsLog } from "../shared/apns";
import { relayClients } from "../shared/clients";
import { concat, fromB64u, makeDevice, randomId, randomToken, utf8 } from "../shared/devices";
import { connect } from "./connect";

const { connect: open, connectMac, macWithPhones, answeredPhone, joinPhone, openWindow, closeAll } = relayClients(connect);
afterEach(closeAll);

const room = (macId: string) => env.MAC_ROOM.get(env.MAC_ROOM.idFromName(macId));

/** Rewrites the attachments in a Mac's room, as time passing would have left them. */
async function age(macId: string, change: (a: Attachment) => void): Promise<void> {
  await runInDurableObject(room(macId), (_, state) => {
    for (const ws of state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a) continue;
      change(a);
      ws.serializeAttachment(a);
    }
  });
}

async function alarmAndOpenedAt(macId: string): Promise<{ alarm: number | null; openedAt: number[] }> {
  return runInDurableObject(room(macId), async (_, state) => ({
    alarm: await state.storage.getAlarm(),
    openedAt: state.getWebSockets().map((ws) => (ws.deserializeAttachment() as Attachment).openedAt),
  }));
}

describe("routes", () => {
  it("answers GET /health with ok", async () => {
    const res = await SELF.fetch("https://relay.test/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("answers 404 for anything that is not a route", async () => {
    const id = randomId();
    const paths = ["/", "/v1", `/v2/mac/${id}`, "/v1/mac/short", `/v1/mac/${id}/extra`, `/v1/phone/${id}`, `/v1/pair/${id}/not-an-id`, `/v1/desk/${id}`];
    for (const path of paths) {
      const res = await SELF.fetch(`https://relay.test${path}`, { headers: { Upgrade: "websocket" } });
      expect([path, res.status]).toEqual([path, 404]);
    }
  });

  it("answers 426 to a relay route asked for without a WebSocket upgrade", async () => {
    expect((await SELF.fetch(`https://relay.test/v1/mac/${randomId()}`)).status).toBe(426);
  });
});

describe("closing", () => {
  it("finishes a close the client starts, whatever code it gives", async () => {
    for (const code of [undefined, 1000, 1001, 4000]) {
      const socket = await open(`/v1/mac/${(await makeDevice()).id}`);
      await socket.json();
      socket.close(code);
      expect([code, await socket.closeCode()]).toEqual([code, expect.any(Number)]);
    }
  });
});

describe("the auth deadline (§3.1)", () => {
  it("arms the room's alarm for 10 s after the socket opened", async () => {
    const mac = await makeDevice();
    await (await open(`/v1/mac/${mac.id}`)).json();
    const { alarm, openedAt } = await alarmAndOpenedAt(mac.id);
    expect(alarm).toBe(openedAt[0]! + 10_000);
  });

  it("closes sockets still unauthenticated 10 s after opening with 4408, and no others", async () => {
    const { mac, macSocket, phones } = await macWithPhones(1);
    const phone = await joinPhone(mac, macSocket, phones[0]!);
    const silentMac = await open(`/v1/mac/${mac.id}`);
    const silentPhone = await open(`/v1/phone/${mac.id}/${phones[0]!.id}`);
    await silentMac.json();
    await silentPhone.json();

    await age(mac.id, (a) => {
      a.openedAt -= 10_000;
    });
    expect(await runDurableObjectAlarm(room(mac.id))).toBe(true);
    expect(await silentMac.closeCode()).toBe(4408);
    expect(await silentPhone.closeCode()).toBe(4408);

    phone.socket.send(utf8("unaffected"));
    expect(await macSocket.binary()).toEqual(concat(fromB64u(phone.ch), utf8("unaffected")));
    // Nothing is left waiting, so nothing needs the alarm.
    expect((await alarmAndOpenedAt(mac.id)).alarm).toBeNull();
  });

  it("leaves a socket alone when the alarm runs before its 10 s are up, and re-arms for them", async () => {
    const mac = await makeDevice();
    const silent = await open(`/v1/mac/${mac.id}`);
    await silent.json();
    await age(mac.id, (a) => {
      a.openedAt -= 5_000;
    });
    expect(await runDurableObjectAlarm(room(mac.id))).toBe(true);
    await silent.quiet();
    expect(silent.isClosed).toBe(false);
    const { alarm, openedAt } = await alarmAndOpenedAt(mac.id);
    expect(alarm).toBe(openedAt[0]! + 10_000);
  });

  it("fires on its own: a silent socket is closed 4408 about 10 s after it opened", { timeout: 20_000 }, async () => {
    const mac = await makeDevice();
    const silent = await open(`/v1/mac/${mac.id}`);
    const opened = Date.now();
    await silent.json();
    expect(await silent.closeCode(15_000)).toBe(4408);
    expect(Date.now() - opened).toBeGreaterThanOrEqual(9_000);
  });
});

describe("liveness (§3.2)", () => {
  it("reads the Mac's heartbeat from the runtime's auto-response, which never wakes the room", async () => {
    const { mac, macSocket, phones } = await macWithPhones(2);
    // A minute and a bit with no message from the Mac.
    await age(mac.id, (a) => {
      if (a.role === "mac") a.lastSeen -= 61_000;
    });
    const early = await answeredPhone(mac, phones[0]!);
    const asleep = await early.json();
    expect(asleep).toEqual({ t: "ready", mac: { online: false, lastSeen: expect.any(Number) } });
    expect(await macSocket.json()).toMatchObject({ t: "open", phone: phones[0]!.id });

    // The heartbeat: answered by setWebSocketAutoResponse, so the only trace is its timestamp.
    macSocket.send("ping");
    expect(await macSocket.text()).toBe("pong");
    const late = await answeredPhone(mac, phones[1]!);
    const awake = await late.json();
    expect(awake).toEqual({ t: "ready", mac: { online: true, lastSeen: expect.any(Number) } });
    expect(awake.mac.lastSeen - asleep.mac.lastSeen).toBeGreaterThanOrEqual(60_000);
  });

  it("counts any message from the Mac as seeing it", async () => {
    const { mac, macSocket, phones } = await macWithPhones(1);
    await age(mac.id, (a) => {
      if (a.role === "mac") a.lastSeen -= 61_000;
    });
    macSocket.sendJson({ t: "something-newer" });
    const phone = await answeredPhone(mac, phones[0]!);
    expect(await phone.json()).toEqual({ t: "ready", mac: { online: true, lastSeen: expect.any(Number) } });
  });
});

describe("state that outlives the object", () => {
  it("keeps channels, the phones list and push tokens across hibernation", async () => {
    const token = randomToken();
    const { mac, macSocket, phones } = await macWithPhones(2);
    const phone = await joinPhone(mac, macSocket, phones[0]!);
    phone.socket.sendJson({ t: "apns", token, env: "sandbox" });
    phone.socket.send(utf8("registered"));
    expect(await macSocket.binary()).toEqual(concat(fromB64u(phone.ch), utf8("registered")));

    // The object goes away; its sockets stay connected, hibernated.
    await evictDurableObject(room(mac.id));

    phone.socket.send(utf8("after"));
    expect(await macSocket.binary()).toEqual(concat(fromB64u(phone.ch), utf8("after")));
    macSocket.send(concat(fromB64u(phone.ch), utf8("back")));
    expect(await phone.socket.binary()).toEqual(utf8("back"));
    await joinPhone(mac, macSocket, phones[1]!);
    macSocket.sendJson({ t: "push", id: "after", phone: phones[0]!.id, blob: "AAAA", urgent: true, collapse: null, badge: null });
    expect(await macSocket.json()).toEqual({ t: "pushed", phone: phones[0]!.id, id: "after", ok: true, status: 200, reason: null });
    expect(await apnsLog(env.APNS_ORIGIN!, token)).toHaveLength(1);
  });

  it("keeps the phones list when the object restarts and every socket is lost", async () => {
    const { mac, phones } = await macWithPhones(1);
    await evictDurableObject(room(mac.id), { webSockets: "close" });

    const phone = await answeredPhone(mac, phones[0]!);
    expect(await phone.json()).toEqual({ t: "ready", mac: { online: false, lastSeen: expect.any(Number) } });
    // The Mac comes back and its phone is already known, before it sends a list.
    const back = await connectMac(mac);
    expect(await back.json()).toEqual({ t: "open", ch: expect.any(String), phone: phones[0]!.id });
  });
});

describe("the pairing window (§3.2)", () => {
  it("caps a window at 10 minutes, and the alarm closes it when it runs out", async () => {
    const { mac, macSocket } = await macWithPhones(0);
    const asked = Date.now() + 60 * 60_000;
    const window = await openWindow(macSocket, asked);
    const stored = await runInDurableObject(room(mac.id), async (_, state) => ({
      pair: await state.storage.get<{ until: number }>(STORE.pair),
      alarm: await state.storage.getAlarm(),
    }));
    expect(stored.pair!.until).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
    expect(stored.pair!.until).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(stored.alarm).toBe(stored.pair!.until);

    // Its time runs out while the room sleeps; the alarm is what notices.
    await runInDurableObject(room(mac.id), async (_, state) => {
      const pair = await state.storage.get<{ until: number }>(STORE.pair);
      await state.storage.put(STORE.pair, { ...pair, until: Date.now() - 1 });
    });
    expect(await runDurableObjectAlarm(room(mac.id))).toBe(true);
    expect(await runInDurableObject(room(mac.id), (_, state) => state.storage.get(STORE.pair))).toBeUndefined();
    expect(await (await open(`/v1/pair/${mac.id}/${window}`)).closeCode()).toBe(4403);
  });
});
