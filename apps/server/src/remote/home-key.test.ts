import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "@realm/test-utils";
import type { PairRequest } from "@realm/contracts";
import { newSecretKey } from "@realm/contracts/src/secret-box";
import { generateDeviceKeys } from "@realm/remote";
import { startLocalRelay, type LocalRelay } from "@realm/relay/src/node";
import { openDatabase } from "../db/database";
import { RpcServer } from "../rpc/server";
import { RemoteDevicesStore } from "../store/remote-devices";
import { SettingsStore } from "../store/settings";
import { homeKeyFile, makeHomeKey, readHomeKey } from "./home-key";
import { MacKeys, REMOTE_IDENTITY_KEY, REMOTE_IDENTITY_SOURCE_KEY } from "./keys";
import { remoteSecretBox } from "./secret";
import { RemoteService, type RemoteServiceOptions } from "./service";
import { TestPhone } from "./test-phone";

const services: RemoteService[] = [];
const relays: LocalRelay[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) s.close();
  for (const r of relays.splice(0)) await r.close();
  remoteSecretBox.setKey(null);
  remoteSecretBox.setHomeKey(null);
});

/** One home's database, and a way to start its Realm Mobile the way a server boot does — over and
 *  over, as restarts do. The box is module-wide, so each start begins without keys, as a fresh
 *  process would. */
function home() {
  const dir = tempDir("realm-home-key-");
  const db = openDatabase(join(dir, "realm.db"));
  const settings = new SettingsStore(db);
  const phones = new RemoteDevicesStore(db);
  const rpc = new RpcServer();
  const boot = (o: Partial<RemoteServiceOptions> & { appKey?: string | null; create?: boolean } = {}) => {
    remoteSecretBox.setKey(o.appKey ?? null);
    remoteSecretBox.setHomeKey(null);
    const svc = new RemoteService({ rpc, settings, phones, macName: "vps-1", version: "test", reportsDir: join(dir, "reports"),
      homeKey: { file: homeKeyFile(dir), create: o.create ?? false }, ...o });
    services.push(svc);
    svc.start();
    return svc;
  };
  return { dir, settings, phones, rpc, boot, keyFile: homeKeyFile(dir) };
}

const paired = (phones: RemoteDevicesStore) => phones.list().map((p) => p.name);
const anotherPhone = (phones: RemoteDevicesStore) => {
  const k = generateDeviceKeys();
  phones.add({ phoneId: "phoneA", name: "Old iPhone", model: "iPhone18,1", dh: k.dh.pub, sign: k.sign.pub, addedAt: 1, lastSeen: null });
};

/** Pairs a TestPhone with whatever window `svc` opens, answering yes for the owner. */
async function pairThrough(h: ReturnType<typeof home>, svc: RemoteService): Promise<void> {
  const answered = new Promise<void>((resolve) => {
    const off = h.rpc.onBroadcast((event, payload) => {
      if (event !== "remote.pairRequest") return;
      off(); svc.pairAnswer((payload as PairRequest).requestId, true); resolve();
    });
  });
  const win = await svc.pairStart();
  expect(await new TestPhone().pair(win.url, { name: "Carlton's iPhone" })).toEqual({ ok: true });
  await answered;
}

describe("a headless server's Realm Mobile key", () => {
  it("is made the first time a headless server pairs a phone, 0600 in a 0700 folder, and seals the identity", async () => {
    const h = home();
    const relay = await startLocalRelay({ port: 0 }); relays.push(relay);
    const svc = h.boot({ create: true, defaultRelay: relay.url });
    expect(svc.status().state).toBe("off"); // not locked: this server can make its own key
    expect(existsSync(h.keyFile)).toBe(false); // …and makes none until a phone is paired
    await pairThrough(h, svc);
    expect(paired(h.phones)).toEqual(["Carlton's iPhone"]);
    expect(statSync(h.keyFile).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(h.keyFile)).mode & 0o777).toBe(0o700);
    expect(h.settings.get(REMOTE_IDENTITY_SOURCE_KEY)).toBe("home");
    // Sealed: the private keys are nowhere in the clear, and the key is not in the database.
    const stored = String(h.settings.get(REMOTE_IDENTITY_KEY));
    expect(stored).not.toContain(readFileSync(h.keyFile, "utf8").trim());
    expect(() => JSON.parse(stored)).toThrow();
  });

  it("opens the same identity after a restart with nobody to hand it a key, and dials for its phone", async () => {
    const h = home();
    const relay = await startLocalRelay({ port: 0 }); relays.push(relay);
    const first = h.boot({ create: true, defaultRelay: relay.url });
    await pairThrough(h, first);
    const macId = new MacKeys(h.settings).load();
    first.close();
    const again = h.boot({ create: true, defaultRelay: relay.url });
    expect(again.status().state).not.toBe("locked");
    expect(again.status().phones.map((p) => p.name)).toEqual(["Carlton's iPhone"]);
    expect(new MacKeys(h.settings).load()).toEqual(macId);
  });

  it("is read by a server the app started, so the app keeps the phones a headless server paired", async () => {
    const h = home();
    const relay = await startLocalRelay({ port: 0 }); relays.push(relay);
    await pairThrough(h, h.boot({ create: true, defaultRelay: relay.url }));
    // The app's server: its own keychain key arrives too, and it may make no key file of its own.
    const app = h.boot({ create: false, appKey: newSecretKey().toString("base64"), defaultRelay: relay.url });
    expect(app.status().state).not.toBe("locked");
    expect(paired(h.phones)).toEqual(["Carlton's iPhone"]);
  });

  it("never mints over an identity the app sealed: a headless server says to open Realm, and keeps the phones", async () => {
    const h = home();
    remoteSecretBox.setKey(newSecretKey().toString("base64"));
    new MacKeys(h.settings).mint(); // paired through Settings ▸ Devices, under the app's key
    const before = h.settings.get(REMOTE_IDENTITY_KEY);
    anotherPhone(h.phones);
    const svc = h.boot({ create: true, defaultRelay: "ws://127.0.0.1:9" });
    expect(svc.status().state).toBe("locked");
    await expect(svc.pairStart()).rejects.toMatchObject({ code: "REMOTE_LOCKED", message: expect.stringMatching(/Open Realm on this Mac once/) });
    expect(h.settings.get(REMOTE_IDENTITY_KEY)).toBe(before);
    expect(paired(h.phones)).toEqual(["Old iPhone"]);
    expect(existsSync(h.keyFile)).toBe(false);
  });

  it("is no stand-in for the app's key, nor the app's for it: each identity waits for its own", () => {
    // Headless first, then the app: an identity sealed with the app's key, on a home that has a key file.
    const h = home();
    remoteSecretBox.setHomeKey(makeHomeKey(h.keyFile));
    remoteSecretBox.setKey(newSecretKey().toString("base64"));
    new MacKeys(h.settings).mint();
    expect(h.settings.get(REMOTE_IDENTITY_SOURCE_KEY)).toBe("app");
    anotherPhone(h.phones);
    const headless = h.boot({ create: true }); // the key file is here, the app's key is not
    expect(headless.status().state).toBe("locked");
    expect(paired(h.phones)).toEqual(["Old iPhone"]);
    headless.close();
    // …and the other way round: sealed with the key file, which is gone, while the app's key is here.
    const g = home();
    remoteSecretBox.setHomeKey(makeHomeKey(g.keyFile));
    remoteSecretBox.setKey(null);
    new MacKeys(g.settings).mint();
    anotherPhone(g.phones);
    rmSync(g.keyFile);
    const app = g.boot({ create: false, appKey: newSecretKey().toString("base64") });
    expect(app.status().state).toBe("locked");
    expect(paired(g.phones)).toEqual(["Old iPhone"]);
    expect(g.settings.get(REMOTE_IDENTITY_KEY)).not.toBeNull();
  });

  it("is never made by a server the app started: with no key from the app it stays locked", async () => {
    const h = home();
    const svc = h.boot({ create: false, defaultRelay: "ws://127.0.0.1:9" });
    expect(svc.status().state).toBe("locked");
    await expect(svc.pairStart()).rejects.toMatchObject({ code: "REMOTE_LOCKED" });
    expect(existsSync(h.keyFile)).toBe(false);
  });

  it("missing, leaves its identity locked rather than forgotten, and says where the key was", async () => {
    const h = home();
    remoteSecretBox.setHomeKey(makeHomeKey(h.keyFile));
    new MacKeys(h.settings).mint();
    anotherPhone(h.phones);
    rmSync(h.keyFile);
    const svc = h.boot({ create: true, defaultRelay: "ws://127.0.0.1:9" });
    expect(svc.status().state).toBe("locked");
    await expect(svc.pairStart()).rejects.toMatchObject({ code: "REMOTE_LOCKED", message: expect.stringContaining(h.keyFile) });
    expect(paired(h.phones)).toEqual(["Old iPhone"]);
    expect(existsSync(h.keyFile)).toBe(false); // not quietly replaced by a new one
  });

  it("readable by other users, is refused rather than used", async () => {
    const h = home();
    remoteSecretBox.setHomeKey(makeHomeKey(h.keyFile));
    new MacKeys(h.settings).mint();
    chmodSync(h.keyFile, 0o644);
    expect(() => readHomeKey(h.keyFile)).toThrow(/can be read by other users/);
    const svc = h.boot({ create: true, defaultRelay: "ws://127.0.0.1:9" });
    expect(svc.status().state).toBe("locked");
    await expect(svc.pairStart()).rejects.toMatchObject({ code: "REMOTE_LOCKED", message: expect.stringMatching(/chmod 600/) });
  });

  it("is refused when it is not a key", () => {
    const h = home();
    makeHomeKey(h.keyFile);
    writeFileSync(h.keyFile, "not a key\n", { mode: 0o600 });
    expect(() => readHomeKey(h.keyFile)).toThrow(/not a Realm key/);
    expect(() => makeHomeKey(h.keyFile)).toThrow(/EEXIST/); // and is never written over
  });

  it("replaced by another key, forgets what it can no longer open — as the app's keychain being reset does", () => {
    const h = home();
    remoteSecretBox.setHomeKey(makeHomeKey(h.keyFile));
    new MacKeys(h.settings).mint();
    anotherPhone(h.phones);
    writeFileSync(h.keyFile, `${newSecretKey().toString("base64")}\n`, { mode: 0o600 });
    const svc = h.boot({ create: true, defaultRelay: "ws://127.0.0.1:9" });
    expect(svc.status().state).toBe("off");
    expect(paired(h.phones)).toEqual([]);
    expect(h.settings.get(REMOTE_IDENTITY_KEY)).toBeNull();
  });
});
