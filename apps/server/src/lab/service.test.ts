import { describe, expect, it } from "vitest";
import type { SimulatorDevice } from "@realm/contracts";
import { tempDir } from "@realm/test-utils";
import { join } from "node:path";
import { openDatabase } from "../db/database";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { RpcError } from "../store/rows";
import { LabDevicesStore } from "./devices-store";
import { LabService } from "./service";

const phone = (udid: string, name: string): SimulatorDevice => ({ udid, platform: "ios", name, runtime: "iOS 27.0", state: "connected", serial: null, physical: true });
const sim = (udid: string, name: string, state: string): SimulatorDevice => ({ udid, platform: "ios", name, runtime: "iOS 27.0", state, serial: null, physical: false });

function harness() {
  const home = tempDir("lab-svc-");
  const db = openDatabase(join(home, "realm.db"));
  const profile = new ProfilesStore(db).create({ name: "P", icon: "x", color: "#000" });
  const spaces = new SpacesStore(db, home);
  const versed = spaces.create({ profileId: profile.id, name: "Versed", icon: "folder" });
  const kv = new Map<string, unknown>();
  const events: string[] = [];
  let pumps = 0;
  let now = 1_000;
  let onCable: SimulatorDevice[] = [];
  const lab = new LabService({
    store: new LabDevicesStore(db),
    settings: { get: (k) => kv.get(k) ?? null, set: (k, v) => { kv.set(k, v); } },
    rpc: { broadcast: (e, p) => events.push(`${e}${"version" in p ? `:${(p as { version: string }).version}` : ""}`) },
    spaceName: (id) => spaces.get(id)?.name ?? null,
    devices: async () => onCable,
    probe: async () => [],
    hostName: async () => "lab-mini.local",
    busy: () => ({ runs: 0, sessions: 0 }),
    pump: () => { pumps++; },
    now: () => now,
  });
  return {
    lab, db, spaces, versed, kv, events,
    get pumps() { return pumps; },
    plug(devices: SimulatorDevice[]) { onCable = devices; },
    set now(v: number) { now = v; },
  };
}

describe("lab devices", () => {
  it("adds a phone a scan found, for a team and its accounts, and marks it seen while it is on the cable", async () => {
    const h = harness();
    h.plug([phone("00008150-AAAA", "Lab iPhone 1"), sim("SIM-1", "iPhone 17", "Booted"), sim("SIM-2", "iPad", "Shutdown")]);
    const scanned = await h.lab.scan();
    // The phone and the running simulator are offered; the shut-down one is not attached to anything.
    expect(scanned.unregistered.map((d) => [d.udid, d.kind])).toEqual([["00008150-AAAA", "iphone"], ["SIM-1", "simulator"]]);
    const added = h.lab.addDevice({ kind: "iphone", udid: "00008150-AAAA", name: "Lab iPhone 1", spaceId: h.versed.id,
      accounts: [{ service: "TikTok", handle: "@versed.nathan" }, { service: "Instagram", handle: "@versed.nathan" }] });
    expect(added.devices).toHaveLength(1);
    expect(added.devices[0]).toMatchObject({ spaceName: "Versed", connected: true, lastSeenAt: 1_000, accounts: [{ service: "TikTok" }, { service: "Instagram" }] });
    expect(added.unregistered.map((d) => d.udid)).toEqual(["SIM-1"]);

    // Unplugged: still registered, no longer connected, last seen where it was.
    h.now = 5_000;
    h.plug([]);
    const later = await h.lab.scan();
    expect(later.devices[0]).toMatchObject({ connected: false, lastSeenAt: 1_000 });
    // Back on the cable: seen again.
    h.now = 9_000;
    h.plug([phone("00008150-AAAA", "Lab iPhone 1")]);
    expect((await h.lab.scan()).devices[0]).toMatchObject({ connected: true, lastSeenAt: 9_000 });
  });

  it("refuses a fourth account on one phone, and the same account twice counts once", () => {
    const h = harness();
    const acct = (n: number) => ({ service: "TikTok", handle: `@creator${n}` });
    expect(() => h.lab.addDevice({ kind: "iphone", udid: null, name: "P", spaceId: null, accounts: [acct(1), acct(2), acct(3), acct(4)] }))
      .toThrow(/at most 3 accounts/);
    const ok = h.lab.addDevice({ kind: "iphone", udid: null, name: "P", spaceId: null, accounts: [acct(1), acct(1), { service: "tiktok", handle: "@CREATOR1" }, acct(2)] });
    expect(ok.devices[0]!.accounts).toEqual([acct(1), acct(2)]);
  });

  it("refuses a device already in the lab, and a team that does not exist", () => {
    const h = harness();
    h.lab.addDevice({ kind: "iphone", udid: "U1", name: "P", spaceId: null, accounts: [] });
    expect(() => h.lab.addDevice({ kind: "iphone", udid: "U1", name: "P again", spaceId: null, accounts: [] })).toThrow(RpcError);
    expect(() => h.lab.addDevice({ kind: "iphone", udid: "U2", name: "P", spaceId: "01ARZ3NDEKTSV4RRFFQ69G5ZZZ", accounts: [] })).toThrow(/no longer exists/);
  });

  it("moves a phone to another team, and keeps it when its team's space is deleted", () => {
    const h = harness();
    const id = h.lab.addDevice({ kind: "iphone", udid: "U1", name: "P", spaceId: h.versed.id, accounts: [] }).devices[0]!.id;
    const other = h.spaces.create({ profileId: h.versed.profileId, name: "Haven", icon: "folder" });
    expect(h.lab.updateDevice(id, { spaceId: other.id, name: "Lab iPhone 2" }).devices[0]).toMatchObject({ spaceName: "Haven", name: "Lab iPhone 2" });
    h.db.prepare("DELETE FROM spaces WHERE id = ?").run(other.id);
    expect(h.lab.devices().devices[0]).toMatchObject({ spaceId: null, spaceName: null });
    expect(h.lab.removeDevice(id).devices).toEqual([]);
  });
});

describe("lab status and the update window", () => {
  it("ignores a ready update unless this Mac is a lab", async () => {
    const h = harness();
    expect((await h.lab.updateReady("2.1.0", "2.0.3")).update).toEqual({ kind: "idle" });
    await h.lab.setEnabled(true);
    expect((await h.lab.updateReady("2.1.0", "2.0.3")).update.kind).toBe("waiting");
  });

  it("broadcasts the install to main once the window drains, and releases on the new version", async () => {
    const h = harness();
    await h.lab.setEnabled(true);
    await h.lab.updateReady("2.1.0", "2.0.3");
    await h.lab.updateNow();
    expect(h.lab.holding).toBe(true);
    h.now = 1_000 + 10_000;
    h.lab.tick();
    expect(h.events).toContain("lab.install:2.1.0");
    const back = await h.lab.appVersion("2.1.0");
    expect(back.update).toMatchObject({ kind: "resumed", applied: true });
    expect(h.lab.holding).toBe(false);
    expect(h.pumps).toBe(1);
  });

  it("turning lab mode off lets held runs go", async () => {
    const h = harness();
    await h.lab.setEnabled(true);
    await h.lab.updateReady("2.1.0", "2.0.3");
    await h.lab.updateNow();
    await h.lab.setEnabled(false);
    expect(h.lab.holding).toBe(false);
    expect(h.pumps).toBe(1);
  });

  it("keeps its hour and cap, and says this Mac's name", async () => {
    const h = harness();
    expect(await h.lab.status()).toMatchObject({ enabled: false, updateHour: 4, updateCapMinutes: 30, hostName: "lab-mini.local" });
    expect(await h.lab.setUpdateWindow(2, 45)).toMatchObject({ updateHour: 2, updateCapMinutes: 45 });
  });
});
