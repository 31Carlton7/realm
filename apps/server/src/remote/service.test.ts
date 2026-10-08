import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { REMOTE_RELAY_KEY, type RemoteStatus } from "@realm/contracts";
import { newSecretKey } from "@realm/contracts/src/secret-box";
import { generateDeviceKeys } from "@realm/remote";
import { openDatabase } from "../db/database";
import { RpcServer } from "../rpc/server";
import { RemoteDevicesStore } from "../store/remote-devices";
import { SettingsStore } from "../store/settings";
import { MacKeys, REMOTE_IDENTITY_KEY } from "./keys";
import { remoteSecretBox } from "./secret";
import { RemoteService, type RemoteServiceOptions } from "./service";

const services: RemoteService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.close();
  remoteSecretBox.setKey(null);
});

function rig(over: Partial<RemoteServiceOptions> = {}) {
  const db = openDatabase(join(tempDir("realm-remote-svc-"), "realm.db"));
  const settings = new SettingsStore(db);
  const phones = new RemoteDevicesStore(db);
  const rpc = new RpcServer();
  const changes: RemoteStatus[] = [];
  rpc.onBroadcast((event, payload) => { if (event === "remote.changed") changes.push(payload as RemoteStatus); });
  const make = (o: Partial<RemoteServiceOptions> = {}) => {
    const s = new RemoteService({ rpc, settings, phones, macName: "Test Mac", version: "test", reportsDir: join(tempDir("realm-reports-"), "r"), ...over, ...o });
    services.push(s);
    return s;
  };
  return { db, settings, phones, rpc, changes, make };
}

const key = () => newSecretKey().toString("base64");

describe("RemoteService", () => {
  it("is locked with no key, off once it has one, and dials nothing with no phone and no window", () => {
    const r = rig({ defaultRelay: "wss://relay.example" });
    const svc = r.make();
    svc.start();
    expect(svc.status()).toEqual({ state: "locked", relay: "wss://relay.example", macName: "Test Mac", phones: [], pairing: null });
    remoteSecretBox.setKey(key());
    svc.keyChanged();
    expect(svc.status().state).toBe("off");
    // Settings heard both, and nothing else: no window, no phone, so no socket to anyone.
    expect(r.changes.map((c) => c.state)).toEqual(["locked", "off"]);
  });

  it("will not open a window without a relay to open it at — an app nobody configured dials nothing", async () => {
    const r = rig();
    remoteSecretBox.setKey(key());
    const svc = r.make();
    svc.start();
    await expect(svc.pairStart()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(svc.status()).toMatchObject({ state: "off", relay: "" });
  });

  it("reads the relay from Settings, and ignores one that is not a ws:// or wss:// URL", () => {
    const r = rig({ defaultRelay: "wss://relay.example" });
    const svc = r.make();
    r.settings.set(REMOTE_RELAY_KEY, "wss://staging.example/");
    expect(svc.status().relay).toBe("wss://staging.example");
    r.settings.set(REMOTE_RELAY_KEY, "https://not-a-socket.example");
    expect(svc.status().relay).toBe("wss://relay.example");
  });

  it("says the relay cannot be reached rather than drawing a code nobody can use, and hangs up again", async () => {
    // A port that was free a moment ago: nothing answers there.
    const port = await new Promise<number>((ok) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => ok(p)); }); });
    const r = rig({ defaultRelay: `ws://127.0.0.1:${port}`, relayWaitMs: 300 });
    remoteSecretBox.setKey(key());
    const svc = r.make();
    svc.start();
    await expect(svc.pairStart()).rejects.toMatchObject({ code: "RELAY_UNREACHABLE" });
    expect(svc.status()).toMatchObject({ state: "off", pairing: null });
  });

  it("forgets the phones of an identity its key no longer opens, rather than keeping rows that can never connect", () => {
    const r = rig({ defaultRelay: "wss://relay.example" });
    remoteSecretBox.setKey(key());
    expect(new MacKeys(r.settings).mint()).not.toBeNull();
    const k = generateDeviceKeys();
    r.phones.add({ phoneId: "phoneA", name: "iPhone", model: "iPhone18,1", dh: k.dh.pub, sign: k.sign.pub, addedAt: 1, lastSeen: null });
    // The keyring was reset under it: a different key arrives.
    remoteSecretBox.setKey(key());
    const svc = r.make();
    svc.start();
    expect(svc.status()).toMatchObject({ state: "off", phones: [] });
    expect(r.settings.get(REMOTE_IDENTITY_KEY)).toBeNull();
  });

  it("keeps an identity it can open: the same Mac, by the same keys, on every start", () => {
    const r = rig();
    remoteSecretBox.setKey(key());
    const minted = new MacKeys(r.settings).mint()!;
    const loaded = new MacKeys(r.settings).load();
    expect(loaded.kind).toBe("ok");
    if (loaded.kind !== "ok") return;
    expect(loaded.identity.macId).toBe(minted.macId);
    expect(loaded.identity.keys.dh.pub.equals(minted.keys.dh.pub)).toBe(true);
    expect(loaded.identity.keys.sign.priv.equals(minted.keys.sign.priv)).toBe(true);
    // Without the key there is nothing to open it with — and nothing is minted in the clear instead.
    remoteSecretBox.setKey(null);
    expect(new MacKeys(r.settings).load().kind).toBe("locked");
    expect(new MacKeys(r.settings).mint()).toBeNull();
  });
});
