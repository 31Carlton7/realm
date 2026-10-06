/**
 * PROTOCOL.md §3 and §7 as one suite, run against both hosts: the Worker and its Durable Object in
 * workerd (test/worker), and startLocalRelay in Node (test/node). Running the same cases against both
 * is what lets the Mac-side tests trust the local relay to behave like the deployed one.
 *
 * Anything that needs a host's clock or lifecycle (the 10 s deadline, liveness, hibernation) lives in
 * that host's own file.
 */
import { afterEach, describe, expect, it } from "vitest";
import { apnsLog, readJwt, TEST_APNS } from "./apns";
import { ID, NOBODY, relayClients } from "./clients";
import { b64u, challengeAnswer, concat, fromB64u, makeDevice, randomId, randomToken, utf8 } from "./devices";
import type { TestSocket } from "./socket";

export type RelayHarness = {
  /** Opens a WebSocket to `path` on the relay under test. */
  connect(path: string): Promise<TestSocket>;
  /** The fake APNs this relay's pushes go to. */
  apnsOrigin: string;
};

const MiB = 1 << 20;

export function relayContract(harness: () => RelayHarness): void {
  const { connect, answerChallenge, connectMac, settle, macWithPhones, answeredPhone, joinPhone, macLeaves, openWindow, closeAll } = relayClients(
    (path) => harness().connect(path),
  );
  afterEach(closeAll);

  describe("Mac authentication (§3.1)", () => {
    it("answers a correct signature with ready", async () => {
      await connectMac(await makeDevice());
    });

    it("closes 4401 on a signature the key did not make", async () => {
      const mac = await makeDevice();
      const impostor = await makeDevice();
      const socket = await connect(`/v1/mac/${mac.id}`);
      const { nonce } = await socket.json();
      socket.sendJson({ t: "auth", key: mac.key, sig: await impostor.sign(challengeAnswer("mac", mac.id, "", nonce)) });
      expect(await socket.closeCode()).toBe(4401);
    });

    it("closes 4401 on a signature over something other than this challenge", async () => {
      const mac = await makeDevice();
      const socket = await connect(`/v1/mac/${mac.id}`);
      await socket.json();
      socket.sendJson({ t: "auth", key: mac.key, sig: await mac.sign(challengeAnswer("mac", mac.id, "", "an-old-nonce")) });
      expect(await socket.closeCode()).toBe(4401);
    });

    it("closes 4401 when the key is not the one the macId was made from", async () => {
      const mac = await makeDevice();
      const other = await makeDevice();
      const socket = await connect(`/v1/mac/${mac.id}`);
      // A valid signature over this socket's challenge, by a key whose id is not this Mac's.
      await answerChallenge(socket, other, "mac", mac.id);
      expect(await socket.closeCode()).toBe(4401);
    });

    it("closes 4401 when data comes before auth", async () => {
      const mac = await makeDevice();
      const socket = await connect(`/v1/mac/${mac.id}`);
      await socket.json();
      socket.send(new Uint8Array(32));
      expect(await socket.closeCode()).toBe(4401);
    });

    it("closes 4400 on an auth missing its signature", async () => {
      const mac = await makeDevice();
      const socket = await connect(`/v1/mac/${mac.id}`);
      await socket.json();
      socket.sendJson({ t: "auth", key: mac.key });
      expect(await socket.closeCode()).toBe(4400);
    });

    it("lets a second authenticated Mac socket close the first with 4409 and take over its channels", async () => {
      const { mac, macSocket: first, phones } = await macWithPhones(1);
      const { socket: phone, ch } = await joinPhone(mac, first, phones[0]!);
      const second = await connectMac(mac);
      expect(await first.closeCode()).toBe(4409);
      expect(await second.json()).toEqual({ t: "open", ch, phone: phones[0]!.id });
      // The old socket's end, then the new one's start: the phone redoes its handshake (§4.2).
      expect(await phone.json()).toEqual({ t: "mac", online: false, lastSeen: expect.any(Number) });
      expect(await phone.json()).toEqual({ t: "mac", online: true, lastSeen: expect.any(Number) });
      phone.send(utf8("after"));
      expect(await second.binary()).toEqual(concat(fromB64u(ch), utf8("after")));
    });
  });

  describe("phone authentication (§3.1)", () => {
    it("closes 4403 when the Mac's list does not have the phone", async () => {
      const { mac } = await macWithPhones(1);
      const socket = await answeredPhone(mac, await makeDevice());
      expect(await socket.closeCode()).toBe(4403);
    });

    it("closes 4403 when the list has the phoneId with a different key", async () => {
      const mac = await makeDevice();
      const phone = await makeDevice();
      const other = await makeDevice();
      const macSocket = await connectMac(mac);
      macSocket.sendJson({ t: "phones", list: [{ id: phone.id, key: other.key }] });
      await settle(macSocket);
      const socket = await answeredPhone(mac, phone);
      expect(await socket.closeCode()).toBe(4403);
    });

    it("closes 4401 when a phone's key is not the one its phoneId was made from, even if the list pairs them", async () => {
      const mac = await makeDevice();
      const phone = await makeDevice();
      const other = await makeDevice();
      const macSocket = await connectMac(mac);
      macSocket.sendJson({ t: "phones", list: [{ id: phone.id, key: other.key }] });
      await settle(macSocket);
      // `other` signs this socket's challenge correctly, but its key does not hash to phone.id.
      const socket = await connect(`/v1/phone/${mac.id}/${phone.id}`);
      await answerChallenge(socket, other, "phone", mac.id, phone.id);
      expect(await socket.closeCode()).toBe(4401);
    });

    it("closes 4401 on a bad signature, even from a listed phone", async () => {
      const { mac, phones } = await macWithPhones(1);
      const phone = phones[0]!;
      const socket = await connect(`/v1/phone/${mac.id}/${phone.id}`);
      const { nonce } = await socket.json();
      // Signed for the Mac's role: a different message from the one a phone must sign.
      socket.sendJson({ t: "auth", key: phone.key, sig: await phone.sign(challengeAnswer("mac", mac.id, phone.id, nonce)) });
      expect(await socket.closeCode()).toBe(4401);
    });

    it("admits a listed phone: ready carries the Mac's state, and the Mac hears open", async () => {
      const { mac, macSocket, phones } = await macWithPhones(1);
      await joinPhone(mac, macSocket, phones[0]!);
    });

    it("tells a phone that connects while the Mac is away when it was last seen", async () => {
      const { mac, macSocket, phones } = await macWithPhones(2);
      const observer = await joinPhone(mac, macSocket, phones[0]!);
      const lastSeen = await macLeaves(macSocket, observer.socket);
      const late = await answeredPhone(mac, phones[1]!);
      expect(await late.json()).toEqual({ t: "ready", mac: { online: false, lastSeen } });
    });

    it("delivers binary pipelined behind auth, in order, once auth passes", async () => {
      const { mac, macSocket, phones } = await macWithPhones(1);
      const phone = phones[0]!;
      const socket = await connect(`/v1/phone/${mac.id}/${phone.id}`);
      const { nonce } = await socket.json();
      socket.sendJson({ t: "auth", key: phone.key, sig: await phone.sign(challengeAnswer("phone", mac.id, phone.id, nonce)) });
      socket.send(utf8("one"));
      socket.send(utf8("two"));
      socket.send(utf8("three"));
      expect(await socket.json()).toMatchObject({ t: "ready" });
      const open = await macSocket.json();
      expect(open).toMatchObject({ t: "open", phone: phone.id });
      const ch = fromB64u(open.ch);
      expect(await macSocket.binary()).toEqual(concat(ch, utf8("one")));
      expect(await macSocket.binary()).toEqual(concat(ch, utf8("two")));
      expect(await macSocket.binary()).toEqual(concat(ch, utf8("three")));
    });

    it("drops what was pipelined behind an auth that fails", async () => {
      const { mac, macSocket } = await macWithPhones(0);
      const stranger = await makeDevice();
      const socket = await connect(`/v1/phone/${mac.id}/${stranger.id}`);
      const { nonce } = await socket.json();
      socket.sendJson({ t: "auth", key: stranger.key, sig: await stranger.sign(challengeAnswer("phone", mac.id, stranger.id, nonce)) });
      socket.send(utf8("smuggled"));
      expect(await socket.closeCode()).toBe(4403);
      expect(await settle(macSocket)).toEqual([]);
    });

    it("lets a newer socket for the same phone replace the older with 4409", async () => {
      const { mac, macSocket, phones } = await macWithPhones(1);
      const first = await joinPhone(mac, macSocket, phones[0]!);
      const second = await answeredPhone(mac, phones[0]!);
      expect(await second.json()).toMatchObject({ t: "ready" });
      expect(await first.socket.closeCode()).toBe(4409);
      expect(await macSocket.json()).toEqual({ t: "close", ch: first.ch });
      const open = await macSocket.json();
      expect(open).toEqual({ t: "open", ch: expect.stringMatching(ID), phone: phones[0]!.id });
      expect(open.ch).not.toBe(first.ch);
    });
  });

  describe("channels (§3.2)", () => {
    it("carries phone binary to the Mac as ch||bytes, and Mac binary to the phone as bytes", async () => {
      const { mac, macSocket, phones } = await macWithPhones(1);
      const { socket: phone, ch } = await joinPhone(mac, macSocket, phones[0]!);
      phone.send(utf8("hello mac"));
      expect(await macSocket.binary()).toEqual(concat(fromB64u(ch), utf8("hello mac")));
      macSocket.send(concat(fromB64u(ch), utf8("hello phone")));
      expect(await phone.binary()).toEqual(utf8("hello phone"));
    });

    it("gives every phone socket its own channel", async () => {
      const { mac, macSocket, phones } = await macWithPhones(2);
      const a = await joinPhone(mac, macSocket, phones[0]!);
      const b = await joinPhone(mac, macSocket, phones[1]!);
      expect(a.ch).not.toBe(b.ch);
      macSocket.send(concat(fromB64u(b.ch), utf8("for b")));
      macSocket.send(concat(fromB64u(a.ch), utf8("for a")));
      expect(await b.socket.binary()).toEqual(utf8("for b"));
      expect(await a.socket.binary()).toEqual(utf8("for a"));
      await a.socket.quiet();
      await b.socket.quiet();
    });

    it("tells the Mac when a phone's socket closes", async () => {
      const { mac, macSocket, phones } = await macWithPhones(1);
      const { socket, ch } = await joinPhone(mac, macSocket, phones[0]!);
      socket.close();
      expect(await macSocket.json()).toEqual({ t: "close", ch });
    });

    it("closes a channel's socket with 4000 when the Mac says close", async () => {
      const { mac, macSocket, phones } = await macWithPhones(1);
      const { socket, ch } = await joinPhone(mac, macSocket, phones[0]!);
      macSocket.sendJson({ t: "close", ch });
      expect(await socket.closeCode()).toBe(4000);
      // Every channel that ends is reported once, including one the Mac ended itself.
      expect(await macSocket.json()).toEqual({ t: "close", ch });
    });

    it("gives a reconnecting Mac an open for every connected phone, and tells the phones it is back", async () => {
      const { mac, macSocket, phones } = await macWithPhones(1);
      const paired = await joinPhone(mac, macSocket, phones[0]!);
      const window = await openWindow(macSocket);
      const pairing = await connect(`/v1/pair/${mac.id}/${window}`);
      expect(await pairing.json()).toMatchObject({ t: "ready" });
      const pairOpen = await macSocket.json();
      expect(pairOpen).toEqual({ t: "open", ch: expect.stringMatching(ID), pair: window });

      await macLeaves(macSocket, paired.socket);
      expect(await pairing.json()).toEqual({ t: "mac", online: false, lastSeen: expect.any(Number) });

      const back = await connectMac(mac);
      const opens = [await back.json(), await back.json()];
      expect(opens).toHaveLength(2);
      expect(opens).toEqual(
        expect.arrayContaining([
          { t: "open", ch: paired.ch, phone: phones[0]!.id },
          { t: "open", ch: pairOpen.ch, pair: window },
        ]),
      );
      expect(await paired.socket.json()).toEqual({ t: "mac", online: true, lastSeen: expect.any(Number) });
      expect(await pairing.json()).toEqual({ t: "mac", online: true, lastSeen: expect.any(Number) });
    });

    it("drops phone binary while the Mac is away, and tells the phone so", async () => {
      const { mac, macSocket, phones } = await macWithPhones(1);
      const { socket: phone, ch } = await joinPhone(mac, macSocket, phones[0]!);
      const lastSeen = await macLeaves(macSocket, phone);

      phone.send(utf8("into the void"));
      expect(await phone.json()).toEqual({ t: "mac", online: false, lastSeen });

      const back = await connectMac(mac);
      expect(await back.json()).toEqual({ t: "open", ch, phone: phones[0]!.id });
      expect(await phone.json()).toMatchObject({ t: "mac", online: true });
      phone.send(utf8("arrives"));
      // Only what was sent while the Mac was there: the dropped frame is not replayed.
      expect(await back.binary()).toEqual(concat(fromB64u(ch), utf8("arrives")));
    });

    it("never looks past the channel prefix: JSON-looking and arbitrary bytes pass byte for byte", async () => {
      const { mac, macSocket, phones } = await macWithPhones(1);
      const { socket: phone, ch } = await joinPhone(mac, macSocket, phones[0]!);
      const prefix = fromB64u(ch);
      const everyByte = Uint8Array.from({ length: 256 }, (_, i) => i);
      // Frames that would mean something if the relay read them as control messages.
      const fromPhone = [utf8(JSON.stringify({ t: "apns", token: "00", env: "sandbox" })), utf8("ping"), everyByte, new Uint8Array(0)];
      const fromMac = [utf8(JSON.stringify({ t: "phones", list: [] })), utf8(JSON.stringify({ t: "close", ch })), everyByte, new Uint8Array(0)];

      for (const frame of fromPhone) phone.send(frame);
      for (const frame of fromPhone) expect(await macSocket.binary()).toEqual(concat(prefix, frame));
      for (const frame of fromMac) macSocket.send(concat(prefix, frame));
      for (const frame of fromMac) expect(await phone.binary()).toEqual(frame);

      // Had the relay acted on the Mac's JSON-looking frames, this phone would be closed or delisted.
      expect(phone.isClosed).toBe(false);
      phone.send(utf8("still here"));
      expect(await macSocket.binary()).toEqual(concat(prefix, utf8("still here")));
      expect(await settle(macSocket)).toEqual([]);
    });
  });

  describe("the phones list (§3.2)", () => {
    it("replaces the list, closing every connected phone it drops with 4410", async () => {
      const { mac, macSocket, phones } = await macWithPhones(2);
      const kept = await joinPhone(mac, macSocket, phones[0]!);
      const removed = await joinPhone(mac, macSocket, phones[1]!);

      macSocket.sendJson({ t: "phones", list: [{ id: phones[0]!.id, key: phones[0]!.key }] });
      expect(await removed.socket.closeCode()).toBe(4410);
      expect(await settle(macSocket)).toEqual([{ t: "close", ch: removed.ch }]);

      kept.socket.send(utf8("kept"));
      expect(await macSocket.binary()).toEqual(concat(fromB64u(kept.ch), utf8("kept")));
      expect(await (await answeredPhone(mac, phones[1]!)).closeCode()).toBe(4403);
    });
  });

  describe("pairing (§3.1)", () => {
    it("admits a pairing socket while a window is open: ready at once, open with pair to the Mac", async () => {
      const { mac, macSocket } = await macWithPhones(0);
      const window = await openWindow(macSocket);
      const pairing = await connect(`/v1/pair/${mac.id}/${window}`);
      expect(await pairing.json()).toEqual({ t: "ready", mac: { online: true, lastSeen: expect.any(Number) } });
      const open = await macSocket.json();
      expect(open).toEqual({ t: "open", ch: expect.stringMatching(ID), pair: window });

      pairing.send(utf8("noise message 1"));
      expect(await macSocket.binary()).toEqual(concat(fromB64u(open.ch), utf8("noise message 1")));
      macSocket.send(concat(fromB64u(open.ch), utf8("noise message 2")));
      expect(await pairing.binary()).toEqual(utf8("noise message 2"));
    });

    it("refuses a window id that is not the open one with 4403", async () => {
      const { mac, macSocket } = await macWithPhones(0);
      await openWindow(macSocket);
      expect(await (await connect(`/v1/pair/${mac.id}/${randomId()}`)).closeCode()).toBe(4403);
    });

    it("refuses with 4403 when no window was ever opened", async () => {
      const { mac } = await macWithPhones(0);
      expect(await (await connect(`/v1/pair/${mac.id}/${randomId()}`)).closeCode()).toBe(4403);
    });

    it("allows five attempts per window", async () => {
      const { mac, macSocket } = await macWithPhones(0);
      const window = await openWindow(macSocket);
      for (let attempt = 1; attempt <= 5; attempt++) {
        const pairing = await connect(`/v1/pair/${mac.id}/${window}`);
        expect(await pairing.json()).toMatchObject({ t: "ready" });
        const open = await macSocket.json();
        expect(open).toMatchObject({ t: "open", pair: window });
        pairing.close();
        expect(await macSocket.json()).toEqual({ t: "close", ch: open.ch });
      }
      expect(await (await connect(`/v1/pair/${mac.id}/${window}`)).closeCode()).toBe(4403);
    });

    it("closes the window on {window: null}", async () => {
      const { mac, macSocket } = await macWithPhones(0);
      const window = await openWindow(macSocket);
      macSocket.sendJson({ t: "pair", window: null });
      await settle(macSocket);
      expect(await (await connect(`/v1/pair/${mac.id}/${window}`)).closeCode()).toBe(4403);
    });

    it("refuses a window whose time is up", async () => {
      const { mac, macSocket } = await macWithPhones(0);
      const window = await openWindow(macSocket, Date.now() - 1);
      expect(await (await connect(`/v1/pair/${mac.id}/${window}`)).closeCode()).toBe(4403);
    });

    it("closes the window when the Mac's socket closes", async () => {
      const { mac, macSocket } = await macWithPhones(0);
      const window = await openWindow(macSocket);
      macSocket.close();
      await macSocket.closed;
      // Back, but the window was the old socket's.
      await connectMac(mac);
      expect(await (await connect(`/v1/pair/${mac.id}/${window}`)).closeCode()).toBe(4403);
    });
  });

  describe("limits and malformed input (§3.1)", () => {
    it("passes a 1 MiB frame from a phone and closes 4413 on a larger one", async () => {
      const { mac, macSocket, phones } = await macWithPhones(1);
      const { socket: phone, ch } = await joinPhone(mac, macSocket, phones[0]!);
      phone.send(new Uint8Array(MiB).fill(7));
      expect(await macSocket.binary()).toEqual(concat(fromB64u(ch), new Uint8Array(MiB).fill(7)));
      phone.send(new Uint8Array(MiB + 1));
      expect(await phone.closeCode()).toBe(4413);
      expect(await macSocket.json()).toEqual({ t: "close", ch });
    });

    it("passes a 1 MiB frame from the Mac and closes 4413 on a larger one", async () => {
      const { mac, macSocket, phones } = await macWithPhones(1);
      const { socket: phone, ch } = await joinPhone(mac, macSocket, phones[0]!);
      macSocket.send(concat(fromB64u(ch), new Uint8Array(MiB - 16).fill(9)));
      expect(await phone.binary()).toEqual(new Uint8Array(MiB - 16).fill(9));
      macSocket.send(concat(fromB64u(ch), new Uint8Array(MiB - 15)));
      expect(await macSocket.closeCode()).toBe(4413);
    });

    it("closes 4413 on an oversized text frame too", async () => {
      const { macSocket } = await macWithPhones(0);
      macSocket.send(JSON.stringify({ t: "future", pad: "x".repeat(MiB) }));
      expect(await macSocket.closeCode()).toBe(4413);
    });

    for (const [what, text] of [
      ["text that is not JSON", "{not json"],
      ["JSON that is not an object", "[1,2,3]"],
      ["an object without a type", '{"list":[]}'],
      ["a phones list that is not a list", '{"t":"phones","list":"everyone"}'],
      ["a phones entry whose key is not 32 bytes", '{"t":"phones","list":[{"id":"AAAAAAAAAAAAAAAAAAAAAA","key":"AAAA"}]}'],
      ["a push without a phone", '{"t":"push","id":"x","blob":""}'],
      ["a pair window with no expiry", `{"t":"pair","window":"${NOBODY}"}`],
    ] as const) {
      it(`closes the Mac 4400 on ${what}`, async () => {
        const { macSocket } = await macWithPhones(0);
        macSocket.send(text);
        expect(await macSocket.closeCode()).toBe(4400);
      });
    }

    it("closes the Mac 4400 on binary too short to name a channel", async () => {
      const { macSocket } = await macWithPhones(0);
      macSocket.send(new Uint8Array(15));
      expect(await macSocket.closeCode()).toBe(4400);
    });

    it("closes a phone 4400 on malformed control JSON", async () => {
      const { mac, macSocket, phones } = await macWithPhones(1);
      const { socket, ch } = await joinPhone(mac, macSocket, phones[0]!);
      socket.send("{oops");
      expect(await socket.closeCode()).toBe(4400);
      expect(await macSocket.json()).toEqual({ t: "close", ch });
    });

    it("closes a phone 4400 on an apns registration whose token is not hex", async () => {
      const { mac, macSocket, phones } = await macWithPhones(1);
      const { socket } = await joinPhone(mac, macSocket, phones[0]!);
      socket.sendJson({ t: "apns", token: "not hex", env: "sandbox" });
      expect(await socket.closeCode()).toBe(4400);
    });

    it("ignores a control message type it does not know", async () => {
      const { macSocket } = await macWithPhones(0);
      macSocket.sendJson({ t: "something-newer", x: 1 });
      expect(await settle(macSocket)).toEqual([]);
      expect(macSocket.isClosed).toBe(false);
    });
  });

  describe("pushes (§7)", () => {
    /** A phone that has registered `token`, once the relay has stored it. */
    async function registered(token: string, env: "sandbox" | "production" = "sandbox") {
      const { mac, macSocket, phones } = await macWithPhones(1);
      const { socket, ch } = await joinPhone(mac, macSocket, phones[0]!);
      socket.sendJson({ t: "apns", token, env });
      // The room handles one event at a time, so once this frame reaches the Mac the token is stored.
      socket.send(utf8("registered"));
      expect(await macSocket.binary()).toEqual(concat(fromB64u(ch), utf8("registered")));
      return { mac, macSocket, phone: phones[0]!, ch };
    }

    it("answers no-token for a phone that never registered", async () => {
      const { macSocket, phones } = await macWithPhones(1);
      macSocket.sendJson({ t: "push", id: "p-1", phone: phones[0]!.id, blob: "AAAA", urgent: true, collapse: null, badge: null });
      expect(await macSocket.json()).toEqual({ t: "pushed", phone: phones[0]!.id, id: "p-1", ok: false, status: 0, reason: "no-token" });
    });

    it("sends one APNs alert with exactly §7's headers and body, and tells the Mac it went", async () => {
      const token = randomToken();
      const { mac, macSocket, phone } = await registered(token);
      const blob = b64u(crypto.getRandomValues(new Uint8Array(120)));
      const before = Math.floor(Date.now() / 1000);
      macSocket.sendJson({ t: "push", id: "p-2", phone: phone.id, blob, urgent: true, collapse: "c-1", badge: 3 });
      expect(await macSocket.json()).toEqual({ t: "pushed", phone: phone.id, id: "p-2", ok: true, status: 200, reason: null });

      const requests = await apnsLog(harness().apnsOrigin, token);
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request).toMatchObject({ method: "POST", path: `/3/device/${token}` });
      expect(request.headers).toMatchObject({
        "apns-topic": TEST_APNS.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-collapse-id": "c-1",
        authorization: expect.stringMatching(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/),
      });
      expect(JSON.parse(request.body)).toEqual({
        aps: {
          alert: { title: "Realm", body: "Something on your Mac needs you" },
          "mutable-content": 1,
          sound: "default",
          badge: 3,
          "interruption-level": "time-sensitive",
        },
        m: mac.id,
        r: blob,
      });

      const jwt = await readJwt(harness().apnsOrigin, request.headers.authorization!.slice("bearer ".length));
      expect(jwt.verified).toBe(true);
      expect(jwt.header).toEqual({ alg: "ES256", kid: TEST_APNS.keyId });
      expect(jwt.claims).toEqual({ iss: TEST_APNS.teamId, iat: expect.any(Number) });
      const { iat } = jwt.claims as { iat: number };
      expect(iat).toBeGreaterThanOrEqual(before - 1);
      expect(iat).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000) + 1);
    });

    it("sends a non-urgent push at priority 5 and active, with no badge or collapse id", async () => {
      const token = randomToken();
      const { macSocket, phone } = await registered(token, "production");
      macSocket.sendJson({ t: "push", id: "p-3", phone: phone.id, blob: "AAAA", urgent: false, collapse: null, badge: null });
      expect(await macSocket.json()).toMatchObject({ t: "pushed", id: "p-3", ok: true });
      const [request] = await apnsLog(harness().apnsOrigin, token);
      expect(request!.headers["apns-priority"]).toBe("5");
      expect(request!.headers).not.toHaveProperty("apns-collapse-id");
      const { aps } = JSON.parse(request!.body);
      expect(aps).not.toHaveProperty("badge");
      expect(aps["interruption-level"]).toBe("active");
    });

    it("passes APNs's refusal to the Mac with its status and reason", async () => {
      const token = randomToken("410");
      const { macSocket, phone } = await registered(token);
      macSocket.sendJson({ t: "push", id: "p-4", phone: phone.id, blob: "AAAA", urgent: true, collapse: null, badge: null });
      expect(await macSocket.json()).toEqual({ t: "pushed", phone: phone.id, id: "p-4", ok: false, status: 410, reason: "Unregistered" });
    });

    it("forgets a phone's token when the Mac removes the phone", async () => {
      const token = randomToken();
      const { macSocket, phone, ch } = await registered(token);
      macSocket.sendJson({ t: "phones", list: [] });
      macSocket.sendJson({ t: "push", id: "p-5", phone: phone.id, blob: "AAAA", urgent: true, collapse: null, badge: null });
      expect(await macSocket.json()).toEqual({ t: "close", ch });
      expect(await macSocket.json()).toEqual({ t: "pushed", phone: phone.id, id: "p-5", ok: false, status: 0, reason: "no-token" });
      expect(await apnsLog(harness().apnsOrigin, token)).toEqual([]);
    });
  });
}
