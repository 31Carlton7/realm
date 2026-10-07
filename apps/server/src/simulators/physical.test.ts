import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import type { SimulatorDevice, SimulatorState } from "@realm/contracts";
import { openDatabase, type Db } from "../db/database";
import { ItemsStore } from "../store/items";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { SimulatorsStore } from "../store/simulators";
import { RunnerError } from "./device-runner";
import { PhysicalDevices } from "./physical";
import type { VideoStop } from "./phone-video";
import { FakePhone, PHONE_DEVICE, PHONE_UDID } from "./phone.test-fakes";
import { SimulatorService } from "./service";
import type { Simctl } from "./simctl";
import type { ServeSim } from "./serve-sim";

/**
 * A real iPhone through the REAL simulator service and the REAL physical layer, with the phone
 * scripted (`phone.test-fakes.ts`): listed, started behind its lock check, read, driven in points,
 * stopped — and every simulator-only capability refused by name.
 */

const dbs: Db[] = [];
const phones: FakePhone[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  await Promise.all(phones.splice(0).map((p) => p.close()));
});

const SIM: SimulatorDevice = { udid: "SIM-17E", platform: "ios", name: "iPhone 17e", runtime: "iOS 27.0", state: "Shutdown", serial: null, physical: false };

async function setup(o: { locked?: boolean; ensure?: () => Promise<never>; rehearsal?: string[]; timing?: { readMs?: number; patientReadMs?: number }; video?: boolean } = {}) {
  const phone = await new FakePhone().listen();
  phones.push(phone);
  const home = tempDir("realm-phone-");
  const db = openDatabase(join(home, "realm.db"));
  dbs.push(db);
  const profiles = new ProfilesStore(db), spaces = new SpacesStore(db, home), items = new ItemsStore(db);
  const profile = profiles.create({ name: "Work", icon: "briefcase", color: "#fff" });
  const space = spaces.create({ profileId: profile.id, name: "Versed", icon: "folder" });
  const broadcasts: SimulatorState[] = [];
  const log: string[] = [];
  const dc = phone.devicectl({ locked: o.locked });
  const runners = phone.runners(log);
  if (o.ensure) (runners as unknown as { ensure: () => Promise<never> }).ensure = o.ensure;
  const bridges: string[] = [];
  /** What each bridge was handed for live video — the phone's name it was made for, or nothing. */
  const videos: (string | null)[] = [];
  const told: ((why: VideoStop | null) => void)[] = [];
  let late: SimulatorService | null = null;
  const simctl = {
    devices: async () => [SIM], boot: async (udid: string) => { log.push(`boot:${udid}`); return { ok: true, detail: "" }; },
    apps: async () => [{ bundleId: "com.apple.Preferences", name: "Settings" }],
    launch: async (udid: string, id: string, fresh?: boolean) => { log.push(`simctl-launch:${id}${fresh ? ":fresh" : ""}`); return { ok: true, detail: "" }; },
  } as unknown as Simctl;
  const physical = new PhysicalDevices({
    home, devicectl: dc, runners, simctl, rehearsal: o.rehearsal ?? [], ...(o.timing ? { timing: o.timing } : {}),
    ...(o.video ? { video: (name: string) => Object.assign(() => ({ ready: new Promise<void>(() => {}), ended: new Promise<VideoStop | null>(() => {}), stop: () => {} }), { madeFor: name }) } : {}),
    onPicture: (udid, stills) => late?.pictureChanged(udid, stills),
    bridge: async (b) => {
      bridges.push(`start:${b.screen.width}x${b.screen.height}`);
      videos.push((b.video as { madeFor?: string } | undefined)?.madeFor ?? null);
      if (b.onStills) told.push(b.onStills);
      return { streamUrl: "http://127.0.0.1:47001/stream.mjpeg", wsUrl: "ws://127.0.0.1:47001/ws", port: 47001, close: async () => { bridges.push("close"); } };
    },
  });
  const service = new SimulatorService({
    rpc: { broadcast: (event: string, payload: unknown) => { if (event === "simulator.status") broadcasts.push(payload as SimulatorState); } } as never,
    spaces, items, simulators: new SimulatorsStore(db),
    simctl: { ...simctl, available: async () => true } as unknown as Simctl,
    // A serve-sim that streams any simulator at once — for a row that showed one before the phone.
    serveSim: {
      find: async () => ({ running: false, device: null, url: null, streamUrl: null, wsUrl: null, port: null, pid: null }),
      start: async (udid: string) => ({ stream: { running: true, device: udid, url: "http://127.0.0.1:3100", streamUrl: `http://127.0.0.1:3100/helper/${udid}/stream.mjpeg`, wsUrl: "ws://127.0.0.1:3100/ws", port: 3100, pid: 1 }, detail: "" }),
      screen: async () => ({ width: 1170, height: 2532, orientation: "portrait" }),
      kill: async () => {}, claims: async () => [],
    } as unknown as ServeSim,
    watchScreen: () => ({ mark: () => ({ moved: 0, edges: 0, edgeBusy: false }), settle: async () => "none", rest: async () => true, close: () => {} }),
    android: { available: async () => false, devices: async () => [] } as never,
    physical,
  });
  late = service;
  const open = async (udid = PHONE_UDID) => {
    const { simulatorId } = service.create({ spaceId: space.id, name: PHONE_DEVICE.name, udid });
    service.start(simulatorId, udid, "ios", true);
    for (let i = 0; i < 400 && !["running", "failed"].includes(service.stateOf(simulatorId).status); i++) await new Promise((r) => setTimeout(r, 5));
    return simulatorId;
  };
  return { phone, service, physical, dc, log, bridges, broadcasts, open, space, videos, told };
}

describe("listing", () => {
  it("lists the phone beside the simulators, as a real device", async () => {
    const { service } = await setup();
    expect(await service.devices()).toEqual([SIM, PHONE_DEVICE]);
  });

  it("lists a rehearsal's simulator once, as the phone it stands in for, and reaches it the phone's way", async () => {
    const { service, log, open } = await setup({ rehearsal: ["SIM-17E"] });
    const devices = await service.devices();
    expect(devices.filter((d) => d.udid === "SIM-17E")).toEqual([{ ...SIM, physical: true, state: "Connected", name: "iPhone 17e (rehearsal)" }]);
    const id = await open("SIM-17E");
    expect(service.stateOf(id).status).toBe("running");
    // Booted by simctl, never asked about a lock, and its runner built for the simulator.
    expect(log).toEqual(["boot:SIM-17E", "ensure:SIM-17E:27.0:sim"]);
  });
});

describe("starting", () => {
  it("checks the lock, brings the runner up, and streams the phone at its own pixel size", async () => {
    const { service, dc, log, bridges, broadcasts, open } = await setup();
    const id = await open();
    expect(dc.calls).toEqual(["lockState"]);
    expect(log).toEqual([`ensure:${PHONE_UDID}:27.2`]);
    expect(bridges).toEqual(["start:402x874"]);
    expect(service.stateOf(id)).toEqual({
      simulatorId: id, status: "running", udid: PHONE_UDID, serial: null, physical: true,
      streamUrl: "http://127.0.0.1:47001/stream.mjpeg", wsUrl: "ws://127.0.0.1:47001/ws",
      screen: { width: 1206, height: 2622, orientation: "portrait" }, error: null, detail: null,
    });
    expect(broadcasts.map((b) => b.status)).toEqual(["booting", "running"]);
    // The row remembers what it is pointed at.
    expect(service.get(id)).toMatchObject({ udid: PHONE_UDID, platform: "ios", physical: true });
  });

  it("hands a real phone's bridge live video made for it by name, and a rehearsal's none", async () => {
    const real = await setup({ video: true });
    await real.open();
    // THE MUTANT: no video for anyone. A phone on a cable stays a screenshot a second.
    expect(real.videos).toEqual([PHONE_DEVICE.name]);
    const rehearsal = await setup({ video: true, rehearsal: ["SIM-17E"] });
    await rehearsal.open("SIM-17E");
    // THE MUTANT: video for the rehearsal too. A simulator is on no cable; it would only ever fail.
    expect(rehearsal.videos).toEqual([null]);
  });

  it("puts the picture's kind on every pane showing the phone, and on a pane opened after", async () => {
    const { service, told, open, broadcasts } = await setup({ video: true });
    const first = await open();
    expect(service.stateOf(first).stills ?? null).toBeNull();
    told[0]!("camera");
    expect(service.stateOf(first).stills).toBe("camera");
    expect(broadcasts.at(-1)).toMatchObject({ simulatorId: first, stills: "camera" });
    // The bridge tells a change once; a pane opened later must still know. THE MUTANT: no memory.
    const second = await open();
    expect(service.stateOf(second).stills).toBe("camera");
    told[0]!(null);
    expect([service.stateOf(first).stills, service.stateOf(second).stills]).toEqual([null, null]);
  });

  it("refuses a locked phone before anything is installed or run on it", async () => {
    const { service, log, open } = await setup({ locked: true });
    const id = await open();
    expect(service.stateOf(id)).toMatchObject({ status: "failed", error: "locked", physical: true, detail: null });
    expect(log).toEqual([]);
  });

  it("shows why the runner did not start, in its words and xcodebuild's", async () => {
    const { service, open } = await setup({ ensure: async () => { throw new RunnerError("sign_failed", "Realm could not sign its test runner.", "error: No signing certificate \"iOS Development\" found"); } });
    const id = await open();
    expect(service.stateOf(id)).toMatchObject({ status: "failed", error: "sign_failed", detail: "error: No signing certificate \"iOS Development\" found" });
  });

  it("says a phone that is not connected now is not connected", async () => {
    const { service, open } = await setup();
    const id = await open("00008150-NOT-HERE");
    expect(service.stateOf(id)).toMatchObject({ status: "failed", error: "not_connected" });
  });
});

describe("reading and driving it", () => {
  it("reads the foreground app's tree in points, containers left out", async () => {
    const { service, phone, open } = await setup();
    const id = await open();
    phone.screen = "root";
    const tree = await service.ax(id);
    expect(tree).toMatchObject({ units: "points", app: "Settings", screen: { width: 402, height: 874 } });
    expect(tree.elements.map((e) => `${e.role} ${e.label}`)).toEqual(["NavigationBar ", "StaticText Settings", "Button General", "Button Accessibility", "SearchField Search"]);
    expect(tree.elements.find((e) => e.label === "General")?.frame).toEqual({ x: 16, y: 160, width: 370, height: 52 });
  });

  it("gives a step's read of a slow app up at the step's timeout, and waits for it when asked to be patient", async () => {
    const { service, phone, open } = await setup({ timing: { readMs: 100, patientReadMs: 3_000 } });
    const id = await open();
    phone.screen = "root";
    phone.readDelayMs = 400;
    await expect(service.ax(id)).rejects.toMatchObject({ code: "UNAVAILABLE", message: expect.stringContaining("runner is not answering") });
    // THE MUTANT: the step's timeout for a recording too. A slow app is then never recorded at all.
    expect((await service.ax(id, { patient: true })).app).toBe("Settings");
  });

  it("takes each input in 0..1 of the screen and sends the runner points", async () => {
    const { service, phone, open } = await setup();
    const id = await open();
    phone.screen = "root";
    await service.input(id, { kind: "tap", at: { x: 0.5, y: 0.5 }, count: 1 });
    await service.input(id, { kind: "tap", at: { x: 0.25, y: 0.25 }, count: 2 });
    await service.input(id, { kind: "hold", at: { x: 0.5, y: 0.25 }, ms: 800 });
    await service.input(id, { kind: "swipe", from: { x: 0.5, y: 0.75 }, to: { x: 0.5, y: 0.25 }, ms: 300, holdMs: 0, stopMs: 120 });
    await service.input(id, { kind: "text", text: "About" });
    await service.input(id, { kind: "press", key: "return" });
    await service.input(id, { kind: "press", key: "volume-up" });
    await service.input(id, { kind: "press", key: "home" });
    expect(phone.acts()).toEqual(["tap 201,437", "tap 101,219 x2", "tap 201,219 hold 800", "swipe 201,656 → 201,219", "text About", "key return", "button volume-up", "button home"]);
    expect(phone.requests.find((r) => r.path === "/swipe")?.body).toMatchObject({ durationMs: 300, holdMs: 0, stopMs: 120 });
  });

  it("refuses the side button, the arrows, tab and escape on a phone, and sends nothing", async () => {
    const { service, phone, open } = await setup();
    const id = await open();
    for (const key of ["lock", "up", "tab", "escape", "back"] as const) {
      const r = await service.input(id, { kind: "press", key });
      expect(r.ok).toBe(false);
    }
    expect((await service.input(id, { kind: "press", key: "lock" })).detail).toMatch(/never presses a real iPhone's side button/);
    expect(phone.acts()).toEqual([]);
  });

  it("never watches a simulator's old stream for a pane now pointed at the phone", async () => {
    const { service, open, space } = await setup();
    const { simulatorId } = service.create({ spaceId: space.id, name: "Pane", udid: "SIM-17E" });
    service.start(simulatorId, "SIM-17E", "ios", false);
    for (let i = 0; i < 400 && service.stateOf(simulatorId).status !== "running"; i++) await new Promise((r) => setTimeout(r, 5));
    expect(service.motion(simulatorId)).not.toBeNull();
    void open;
    service.start(simulatorId, PHONE_UDID, "ios", true);
    for (let i = 0; i < 400 && !(service.stateOf(simulatorId).status === "running" && service.stateOf(simulatorId).physical); i++) await new Promise((r) => setTimeout(r, 5));
    // THE MUTANT: find the pane's last serve-sim stream and watch it — the simulator's, not the phone's.
    expect(service.motion(simulatorId)).toBeNull();
  });

  it("goes the phone's way again on a plain retry, with nothing but the row to say what it is", async () => {
    const { service, open, dc, log } = await setup({ locked: true });
    const id = await open();
    expect(service.stateOf(id).status).toBe("failed");
    // Unlocked, and "Try again": no udid, no platform, no flag — the row is the authority.
    (dc as unknown as { lockState: () => Promise<{ locked: boolean }> }).lockState = async () => ({ locked: false });
    service.start(id);
    for (let i = 0; i < 400 && !["running", "failed"].includes(service.stateOf(id).status); i++) await new Promise((r) => setTimeout(r, 5));
    expect(service.stateOf(id)).toMatchObject({ status: "running", physical: true });
    expect(service.get(id).physical).toBe(true);
    expect(log).toEqual([`ensure:${PHONE_UDID}:27.2`]);
  });

  it("launches and looks up apps with devicectl, one bundle id at a time, and captures the screen from the runner", async () => {
    const { service, dc, open, phone } = await setup();
    const id = await open();
    expect(await service.act(id, { kind: "launch", bundleId: "com.apple.Preferences", fresh: true })).toEqual({ ok: true, detail: "" });
    expect(phone.screen).toBe("root");
    expect(await service.app(id, "com.apple.Preferences")).toEqual({ bundleId: "com.apple.Preferences", name: "Settings" });
    expect(await service.apps(id)).toEqual([{ bundleId: "com.acme.debug", name: "Acme (Debug)" }]);
    expect(dc.calls).toEqual(["lockState", "launch:com.apple.Preferences:fresh", "app:com.apple.Preferences", "apps"]);
    const png = await service.capture(id);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  });

  it("refuses the simulator's own capabilities by name", async () => {
    const { service, open } = await setup();
    const id = await open();
    await expect(service.ui(id)).rejects.toThrow("Appearance and text size is an iOS simulator feature — this row is a real device.");
    await expect(service.setUi(id, "appearance", "dark")).rejects.toThrow(/real device/);
    await expect(service.poke(id, { kind: "memory-warning" })).rejects.toThrow(/real device/);
    expect(await service.act(id, { kind: "add-media", paths: ["/tmp/a.png"] })).toMatchObject({ ok: false });
    expect(await service.act(id, { kind: "permission", action: "grant", permission: "camera", bundleId: "x" })).toMatchObject({ ok: false });
    expect(await service.events(id, 5)).toEqual([]);
  });
});

describe("stopping", () => {
  it("takes the runner off the phone when the pane stops streaming", async () => {
    const { service, log, bridges, open } = await setup();
    const id = await open();
    expect(await service.stop(id)).toMatchObject({ status: "off", physical: true });
    expect(log).toContain(`stop:${PHONE_UDID}`);
    expect(bridges).toContain("close");
  });

  it("takes it off when the last pane showing the phone closes, and not before", async () => {
    const { service, log, open } = await setup();
    const a = await open();
    const b = await open();
    service.close(a);
    await new Promise((r) => setTimeout(r, 5));
    expect(log.filter((l) => l.startsWith("stop:"))).toEqual([]);
    service.close(b);
    await new Promise((r) => setTimeout(r, 5));
    expect(log.filter((l) => l.startsWith("stop:"))).toEqual([`stop:${PHONE_UDID}`]);
  });

  it("takes every runner off every phone when Realm goes", async () => {
    const { service, log, open } = await setup();
    await open();
    await service.closeAll();
    expect(log).toContain("stopAll");
  });

  it("marks the panes on a phone whose runner stopped by itself as failed, saying why", async () => {
    const { service, open } = await setup();
    const id = await open();
    service.runnerStopped(PHONE_UDID, new RunnerError("locked", "Test’s iPhone is locked.", "the device was locked"));
    expect(service.stateOf(id)).toMatchObject({ status: "failed", error: "locked", detail: "the device was locked" });
  });

  it("names the phone as the owner of its bridge's port, for the browser guard", async () => {
    const { service, open } = await setup();
    await open();
    expect(await service.streamedOn(47001)).toBe(PHONE_UDID);
  });
});
