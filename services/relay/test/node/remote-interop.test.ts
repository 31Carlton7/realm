/**
 * The relay against the Mac side's own reading of PROTOCOL.md §1 and §3.1: device ids, the signed
 * challenge answer and the close codes, all taken from packages/remote rather than from this
 * package's tests. Two implementations agreeing is what catches a misread spec; one agreeing with
 * itself cannot.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { b64u } from "../../../../packages/remote/src/bytes";
import { deviceId, ed25519Sign, generateDeviceKeys } from "../../../../packages/remote/src/keys";
import { CLOSE as REMOTE_CLOSE, CHANNEL_ID_BYTES, relayAuthMessage } from "../../../../packages/remote/src/protocol";
import { CLOSE } from "../../src/core";
import { startLocalRelay, type LocalRelay } from "../../src/node";
import { connectWs } from "./connect";

let relay: LocalRelay;
beforeAll(async () => {
  relay = await startLocalRelay();
});
afterAll(() => relay.close());

it("admits a Mac and a phone whose keys, ids and signatures come from packages/remote", async () => {
  const macKeys = generateDeviceKeys();
  const phoneKeys = generateDeviceKeys();
  const macId = deviceId(macKeys.sign.pub);
  const phoneId = deviceId(phoneKeys.sign.pub);

  const mac = await connectWs(`${relay.url}/v1/mac/${macId}`);
  const macChallenge = await mac.json();
  mac.sendJson({ t: "auth", key: b64u(macKeys.sign.pub), sig: b64u(ed25519Sign(macKeys.sign.priv, relayAuthMessage("mac", macId, null, macChallenge.nonce))) });
  expect(await mac.json()).toEqual({ t: "ready" });
  mac.sendJson({ t: "phones", list: [{ id: phoneId, key: b64u(phoneKeys.sign.pub) }] });

  const phone = await connectWs(`${relay.url}/v1/phone/${macId}/${phoneId}`);
  const phoneChallenge = await phone.json();
  phone.sendJson({
    t: "auth",
    key: b64u(phoneKeys.sign.pub),
    sig: b64u(ed25519Sign(phoneKeys.sign.priv, relayAuthMessage("phone", macId, phoneId, phoneChallenge.nonce))),
  });
  expect(await phone.json()).toMatchObject({ t: "ready", mac: { online: true } });
  const open = await mac.json();
  expect(open).toMatchObject({ t: "open", phone: phoneId });
  expect(Buffer.from(open.ch, "base64url")).toHaveLength(CHANNEL_ID_BYTES);

  mac.close();
  phone.close();
});

it("closes with the codes packages/remote names", () => {
  expect(CLOSE).toEqual(REMOTE_CLOSE);
});
