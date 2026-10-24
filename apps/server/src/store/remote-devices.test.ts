import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { generateDeviceKeys } from "@realm/remote";
import { openDatabase } from "../db/database";
import type { PairedPhone } from "../remote/store";
import { RemoteDevicesStore } from "./remote-devices";

const store = () => new RemoteDevicesStore(openDatabase(join(tempDir("realm-devices-"), "realm.db")));

const phone = (phoneId: string, addedAt: number, over: Partial<PairedPhone> = {}): PairedPhone => {
  const k = generateDeviceKeys();
  return { phoneId, name: "Carlton's iPhone", model: "iPhone18,1", dh: k.dh.pub, sign: k.sign.pub, addedAt, lastSeen: null, relay: "wss://relay.example", ...over };
};

describe("RemoteDevicesStore", () => {
  it("keeps a phone's keys exactly, and lists phones oldest first", () => {
    const s = store();
    const a = phone("phoneA", 20);
    const b = phone("phoneB", 10);
    s.add(a);
    s.add(b);
    expect(s.list().map((p) => p.phoneId)).toEqual(["phoneB", "phoneA"]);
    const back = s.get("phoneA")!;
    // The keys a handshake and the relay check against come back byte for byte.
    expect(back.dh.equals(a.dh)).toBe(true);
    expect(back.sign.equals(a.sign)).toBe(true);
    expect(s.get("nobody")).toBeUndefined();
  });

  it("pairing the same phone again replaces its row, keys and all, rather than adding a second", () => {
    const s = store();
    s.add(phone("phoneA", 1, { lastSeen: 5 }));
    const again = phone("phoneA", 9, { name: "Renamed iPhone" });
    s.add(again);
    expect(s.list()).toHaveLength(1);
    expect(s.get("phoneA")).toMatchObject({ name: "Renamed iPhone", addedAt: 9, lastSeen: null });
    expect(s.get("phoneA")!.dh.equals(again.dh)).toBe(true);
  });

  it("removes one phone and says whether there was one", () => {
    const s = store();
    s.add(phone("phoneA", 1));
    s.add(phone("phoneB", 2));
    expect(s.remove("phoneA")).toBe(true);
    expect(s.remove("phoneA")).toBe(false);
    expect(s.list().map((p) => p.phoneId)).toEqual(["phoneB"]);
    s.clear();
    expect(s.list()).toEqual([]);
  });

  it("keeps the relay each phone dials: where it paired, then where it was seen", () => {
    const s = store();
    s.add(phone("phoneA", 1, { relay: "wss://staging.example" }));
    expect(s.get("phoneA")!.relay).toBe("wss://staging.example");
    s.setRelay("phoneA", "wss://production.example");
    expect(s.get("phoneA")!.relay).toBe("wss://production.example");
    // Pairing again names the relay that pairing was made on.
    s.add(phone("phoneA", 2, { relay: "wss://elsewhere.example" }));
    expect(s.get("phoneA")!.relay).toBe("wss://elsewhere.example");
    expect(() => s.setRelay("nobody", "wss://x.example")).not.toThrow();
  });

  it("writes a relay in only for phones that have none, and counts them", () => {
    const s = store();
    s.add(phone("phoneA", 1, { relay: null }));
    s.add(phone("phoneB", 2, { relay: "wss://production.example" }));
    expect(s.adoptRelay("wss://staging.example")).toBe(1);
    expect(s.list().map((p) => [p.phoneId, p.relay])).toEqual([["phoneA", "wss://staging.example"], ["phoneB", "wss://production.example"]]);
    expect(s.adoptRelay("wss://staging.example")).toBe(0);
  });

  it("moves last seen forward only, so a late write from a closing channel cannot undo a fresher one", () => {
    const s = store();
    s.add(phone("phoneA", 1));
    s.touch("phoneA", 100);
    s.touch("phoneA", 50);
    expect(s.get("phoneA")!.lastSeen).toBe(100);
    s.touch("phoneA", 150);
    expect(s.get("phoneA")!.lastSeen).toBe(150);
    expect(() => s.touch("nobody", 1)).not.toThrow();
  });
});
