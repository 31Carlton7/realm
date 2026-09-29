import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@realm/test-utils";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDatabase, type Db } from "../db/database";
import { ItemsStore } from "../store/items";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { SimulatorsStore } from "../store/simulators";
import { SimulatorService, toolchainAvailable } from "./service";
import type { Simctl } from "./simctl";
import type { ServeSim, ServeSimStream } from "./serve-sim";
import { iosSteps, type InputChannel, type InputStep } from "./device-input";
import type { ScreenMotion } from "./screen-motion";
import type { SimulatorState } from "@realm/contracts";

/* The service, with the two CLIs faked. Both seams exist so a suite never depends on this Mac having
   Xcode — and so the walk's failures, which on a real Mac take a cold boot to reach, are one line. */

const STREAM: ServeSimStream = {
  running: true, device: "UDID-1", url: "http://127.0.0.1:3100",
  streamUrl: "http://127.0.0.1:3100/helper/UDID-1/stream.mjpeg",
  wsUrl: "ws://127.0.0.1:3100/helper/UDID-1/ws", port: 3100, pid: 99,
};
const NOTHING: ServeSimStream = { running: false, device: null, url: null, streamUrl: null, wsUrl: null, port: null, pid: null };
const SCREEN = { width: 1206, height: 2622, orientation: "portrait" };

const dbs: Db[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); vi.restoreAllMocks(); });

function bring(over: { simctl?: Partial<Simctl>; serveSim?: Partial<ServeSim>; inputChannel?: InputChannel; watchScreen?: (url: string) => ScreenMotion } = {}) {
  const home = tempDir("realm-sim-");
  const db = openDatabase(join(home, "realm.db"));
  dbs.push(db);
  const profiles = new ProfilesStore(db), spaces = new SpacesStore(db, home), items = new ItemsStore(db);
  const profile = profiles.create({ name: "Work", icon: "briefcase", color: "#fff" });
  const space = spaces.create({ profileId: profile.id, name: "Versed", icon: "folder" });
  const events: SimulatorState[] = [];
  const calls: string[] = [];
  const cli: Simctl = {
    devices: async () => { calls.push("devices"); return [{ udid: "UDID-1", platform: "ios", name: "iPhone 17 Pro", runtime: "iOS 27.0", state: "Shutdown", serial: null, physical: false }]; },
    boot: async (udid) => { calls.push(`boot:${udid}`); return { ok: true, detail: "" }; },
    available: async () => true,
    apps: async (udid) => { calls.push(`apps:${udid}`); return [{ bundleId: "com.acme.app", name: "Acme" }]; },
    screenshot: async (udid, path) => { calls.push(`screenshot:${udid}:${path}`); return { ok: true, detail: "" }; },
    openUrl: async (udid, url) => { calls.push(`openUrl:${udid}:${url}`); return { ok: true, detail: "" }; },
    install: async (udid, path) => { calls.push(`install:${udid}:${path}`); return { ok: true, detail: "" }; },
    launch: async (udid, bundleId, fresh) => { calls.push(`launch:${udid}:${bundleId}${fresh ? ":fresh" : ""}`); return { ok: true, detail: "" }; },
    addMedia: async (udid, paths) => { calls.push(`addMedia:${udid}:${paths.join(",")}`); return { ok: true, detail: "" }; },
    pasteTo: async (udid, text) => { calls.push(`pasteTo:${udid}:${text}`); return { ok: true, detail: "" }; },
    copyFrom: async (udid) => { calls.push(`copyFrom:${udid}`); return { ok: true, text: "from the device", detail: "" }; },
    ...over.simctl,
  };
  const stream: ServeSim = {
    find: async () => { calls.push("find"); return NOTHING; },
    claims: async () => { calls.push("claims"); return []; },
    start: async (udid) => { calls.push(`start:${udid}`); return { stream: STREAM, detail: "" }; },
    kill: async (udid) => { calls.push(`kill:${udid}`); },
    screen: async () => { calls.push("screen"); return SCREEN; },
    ui: async (udid) => { calls.push(`ui:${udid}`); return { appearance: "light", "text-size": "large" }; },
    setUi: async (udid, option, value) => {
      calls.push(`setUi:${udid}:${option}:${value}`);
      return { ok: true, state: { appearance: value }, detail: "" };
    },
    memoryWarning: async (udid) => { calls.push(`memoryWarning:${udid}`); return { ok: true, detail: "" }; },
    caDebug: async (udid, option, on) => { calls.push(`caDebug:${udid}:${option}:${on}`); return { ok: true, detail: "" }; },
    ax: async (_stream, udid) => {
      calls.push(`ax:${udid}`);
      return { screen: { width: 440, height: 956 }, units: "points", app: "Safari", elements: [
        { path: "0.0", label: "Back", value: "", role: "Button", id: "BackButton", enabled: false, frame: { x: 34, y: 874, width: 48, height: 48 }, depth: 1 },
      ] };
    },
    permission: async (udid, action, permission, bundleId) => { calls.push(`permission:${udid}:${action}:${permission}:${bundleId}`); return { ok: true, detail: "" }; },
    camera: async (udid, bundleId, source) => { calls.push(`camera:${udid}:${bundleId}:${source.kind}`); return { ok: true, detail: "" }; },
    cameraSwitch: async (udid, source) => { calls.push(`cameraSwitch:${udid}:${source.kind}`); return { ok: true, detail: "" }; },
    cameraStop: async (udid) => { calls.push(`cameraStop:${udid}`); return { ok: true, detail: "" }; },
    webcams: async () => { calls.push("webcams"); return ["FaceTime HD Camera"]; },
    eventLog: async (udid, limit) => { calls.push(`eventLog:${udid}:${limit}`); return [{ source: "hid", kind: "tap", summary: "Tap 0.5,0.1", at: null }]; },
    ...over.serveSim,
  };
  const service = new SimulatorService({
    rpc: { broadcast: (name: string, payload: unknown) => { if (name === "simulator.status") events.push(payload as SimulatorState); } } as never,
    spaces, items, simulators: new SimulatorsStore(db), simctl: cli, serveSim: stream, inputChannel: over.inputChannel,
    ...(over.watchScreen ? { watchScreen: over.watchScreen } : {}),
  });
  return { service, spaceId: space.id, folder: space.folderPath, items, events, calls, db };
}

/** The walk is async and the call that starts it is not. */
const settle = async (until: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (until()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("state never settled");
};

describe("whether this Mac can run a simulator", () => {
  const says = (v: boolean | "throws") => ({ available: async () => { if (v === "throws") throw new Error("ENOENT"); return v; } });

  it("is either toolchain, not only Apple's", async () => {
    /* The production probe behind the simulator tools, so this is the answer that decides whether a
       session is offered them at all. THE MUTANT: `return ios` — an Android developer with no Xcode
       then never sees a tool that would run their emulator. */
    expect(await toolchainAvailable(says(false), says(true))).toBe(true);
    expect(await toolchainAvailable(says(true), says(false))).toBe(true);
    expect(await toolchainAvailable(says(false), says(false))).toBe(false);
  });

  it("counts a toolchain that cannot even be asked as absent, rather than failing the question", async () => {
    // `xcrun` missing entirely is ENOENT, which is the most ordinary "no" there is.
    expect(await toolchainAvailable(says("throws"), says(false))).toBe(false);
    expect(await toolchainAvailable(says("throws"), says(true))).toBe(true);
  });
});

describe("a simulator pane's row", () => {
  it("is a row and a sidebar item made together, with no device chosen yet", () => {
    // The button in the session bar makes this: the picker is the pane's own body, so the pane —
    // and therefore the item — has to exist before there is a device to put in it.
    const { service, spaceId, items } = bring();
    const { simulatorId, itemId } = service.create({ spaceId, name: "Simulator" });
    expect(service.get(simulatorId).udid).toBeNull();
    expect(items.get(itemId)).toMatchObject({ kind: "simulator", refId: simulatorId });
    expect(service.stateOf(simulatorId)).toMatchObject({ status: "off", udid: null, streamUrl: null });
  });

  it("refuses to start with no device rather than starting something arbitrary", () => {
    const { service, spaceId } = bring();
    const { simulatorId } = service.create({ spaceId, name: "Simulator" });
    expect(() => service.start(simulatorId)).toThrow(/choose a simulator/i);
  });

  it("remembers the device, so reopening the pane comes back to the same phone", () => {
    const { service, spaceId } = bring();
    const { simulatorId } = service.create({ spaceId, name: "Simulator" });
    service.start(simulatorId, "UDID-1");
    expect(service.get(simulatorId).udid).toBe("UDID-1");
    // …and the state a fresh pane reads before any event carries the device too.
    expect(service.stateOf(simulatorId).udid).toBe("UDID-1");
  });
});

describe("bringing a simulator up", () => {
  it("boots it, serves it, and publishes the stream once it has a size", async () => {
    const { service, spaceId, events, calls } = bring();
    const { simulatorId } = service.create({ spaceId, name: "Simulator" });
    expect(service.start(simulatorId, "UDID-1").status).toBe("booting");
    await settle(() => service.stateOf(simulatorId).status === "running");
    expect(calls).toEqual(["boot:UDID-1", "find", "start:UDID-1", "screen"]);
    expect(service.stateOf(simulatorId)).toMatchObject({
      status: "running", udid: "UDID-1", streamUrl: STREAM.streamUrl, wsUrl: STREAM.wsUrl, screen: SCREEN,
    });
    // Every step is broadcast, because the pane's whole job while this runs is to say where it is.
    expect(events.map((e) => e.status)).toEqual(["booting", "serving", "running"]);
  });

  it("adopts a stream somebody else already started rather than starting a second one", async () => {
    // A device served from a terminal, or by the ios-simulator skill, is one this pane can just
    // show. THE always-start mutant spawns a second daemon for a device that already has one.
    const { service, spaceId, calls } = bring({ serveSim: { find: async () => STREAM } });
    const { simulatorId } = service.create({ spaceId, name: "Simulator" });
    service.start(simulatorId, "UDID-1");
    await settle(() => service.stateOf(simulatorId).status === "running");
    expect(calls).not.toContain("start:UDID-1");
  });

  it("waits for a frame rather than showing a 0×0 screen", async () => {
    // serve-sim answers {"width":0} until the capture engine has one, and `parseScreen` turns that
    // into null. The walk polls; the pane stays on `serving` in the meantime.
    let frames = 0;
    const { service, spaceId } = bring({ serveSim: { screen: async () => (++frames < 3 ? null : SCREEN) } });
    const { simulatorId } = service.create({ spaceId, name: "Simulator" });
    service.start(simulatorId, "UDID-1");
    await settle(() => service.stateOf(simulatorId).status === "running");
    expect(frames).toBeGreaterThanOrEqual(3);
    expect(service.stateOf(simulatorId).screen).toEqual(SCREEN);
  });

  it("says which step failed, and what the command said", async () => {
    const boot = bring({ simctl: { boot: async () => ({ ok: false, detail: "Unable to boot device: no runtime" }) } });
    const a = boot.service.create({ spaceId: boot.spaceId, name: "Simulator" });
    boot.service.start(a.simulatorId, "UDID-1");
    await settle(() => boot.service.stateOf(a.simulatorId).status === "failed");
    expect(boot.service.stateOf(a.simulatorId)).toMatchObject({ error: "boot_failed", detail: "Unable to boot device: no runtime" });

    const serve = bring({ serveSim: { start: async () => ({ stream: NOTHING, detail: "npm ERR! network" }) } });
    const b = serve.service.create({ spaceId: serve.spaceId, name: "Simulator" });
    serve.service.start(b.simulatorId, "UDID-1");
    await settle(() => serve.service.stateOf(b.simulatorId).status === "failed");
    // The detail is kept verbatim: an npx that cannot reach the registry says so better than a
    // sentence of ours would paraphrase it.
    expect(serve.service.stateOf(b.simulatorId)).toMatchObject({ error: "serve_failed", detail: "npm ERR! network" });
  });

  it("a second start wins, and the first one's answer cannot land on top of it", async () => {
    // THE no-token mutant: let every walk publish. A slow first boot that fails after the user has
    // picked a different device would put a failure on screen for a device that is streaming fine.
    let first = true;
    const { service, spaceId } = bring({
      simctl: {
        boot: async () => {
          if (!first) return { ok: true, detail: "" };
          first = false;
          await new Promise((r) => setTimeout(r, 80));
          return { ok: false, detail: "too slow" };
        },
      },
    });
    const { simulatorId } = service.create({ spaceId, name: "Simulator" });
    service.start(simulatorId, "UDID-1");
    service.start(simulatorId, "UDID-2");
    await settle(() => service.stateOf(simulatorId).status === "running");
    await new Promise((r) => setTimeout(r, 150)); // long enough for the abandoned walk to finish
    expect(service.stateOf(simulatorId)).toMatchObject({ status: "running", udid: "UDID-2" });
  });
});

describe("putting one down", () => {
  it("stop kills the stream and leaves the device booted", async () => {
    // Shutting the simulator down is not this pane's business: it is usually somebody's Xcode
    // session, and `simctl shutdown` would take it away from them.
    const { service, spaceId, calls } = bring();
    const { simulatorId } = service.create({ spaceId, name: "Simulator" });
    service.start(simulatorId, "UDID-1");
    await settle(() => service.stateOf(simulatorId).status === "running");
    await service.stop(simulatorId);
    expect(calls).toContain("kill:UDID-1");
    expect(calls.some((c) => c.startsWith("shutdown"))).toBe(false);
    expect(service.stateOf(simulatorId)).toMatchObject({ status: "off", streamUrl: null });
  });

  it("closing the pane drops the row and the item — and does NOT kill the stream", async () => {
    // A second pane may be watching the same device: the daemon is keyed by device, not by pane.
    const { service, spaceId, items, calls } = bring();
    const { simulatorId, itemId } = service.create({ spaceId, name: "Simulator" });
    service.start(simulatorId, "UDID-1");
    await settle(() => service.stateOf(simulatorId).status === "running");
    service.close(simulatorId);
    expect(items.get(itemId)).toBeNull();
    expect(() => service.get(simulatorId)).toThrow();
    expect(calls).not.toContain("kill:UDID-1");
  });

  it("an identical state is not an event", async () => {
    // The sidebar's dot and the pane bar both read this broadcast; a poll that says the same thing
    // twice must not repaint them.
    const { service, spaceId, events } = bring();
    const { simulatorId } = service.create({ spaceId, name: "Simulator" });
    service.start(simulatorId, "UDID-1");
    await settle(() => service.stateOf(simulatorId).status === "running");
    const before = events.length;
    await service.stop(simulatorId);
    await service.stop(simulatorId);
    expect(events.length).toBe(before + 1);
  });
});

describe("the device's own settings", () => {
  it("reads them off the DEVICE every time, never off a copy taken when the pane opened", async () => {
    /* They are simulator-wide and anyone can change them — Xcode's Features menu, `simctl ui`, the
       app under test. THE MUTANT: cache the first read. The menu then shows Light while the phone in
       front of you is in Dark, which is worse than showing nothing. */
    const { service, spaceId, calls } = bring();
    const { simulatorId } = service.create({ spaceId, name: "Simulator", udid: "UDID-1" });
    expect(await service.ui(simulatorId)).toMatchObject({ appearance: "light" });
    await service.ui(simulatorId);
    expect(calls.filter((c) => c === "ui:UDID-1")).toHaveLength(2);
  });

  it("a change answers with what the device says AFTERWARDS, not with what was asked for", async () => {
    // `serve-sim ui <option> <value>` prints nothing on success, so the only honest answer to "what
    // is it now" is a fresh read — and a runtime that refused the value must not be reported as
    // having taken it.
    const { service, spaceId, calls } = bring({
      serveSim: { setUi: async () => ({ ok: false, state: { appearance: "light" }, detail: "invalid value for appearance: mauve" }) },
    });
    const { simulatorId } = service.create({ spaceId, name: "Simulator", udid: "UDID-1" });
    const r = await service.setUi(simulatorId, "appearance", "mauve");
    expect(r.ok).toBe(false);
    expect(r.ui).toEqual({ appearance: "light" });
    expect(r.detail).toContain("invalid value");
    expect(calls).not.toContain("ui:UDID-1"); // the CLI's own post-read is inside setUi, not a second trip
  });

  it("a poke reaches the right command, and a device that was never chosen is refused rather than guessed at", async () => {
    const { service, spaceId, calls } = bring();
    const { simulatorId } = service.create({ spaceId, name: "Simulator", udid: "UDID-1" });
    await service.poke(simulatorId, { kind: "memory-warning" });
    await service.poke(simulatorId, { kind: "ca-debug", option: "blended", on: true });
    expect(calls).toContain("memoryWarning:UDID-1");
    expect(calls).toContain("caDebug:UDID-1:blended:true");

    const { simulatorId: blank } = service.create({ spaceId, name: "Nothing chosen" });
    await expect(service.ui(blank)).rejects.toThrow(/choose a simulator/);
    await expect(service.setUi(blank, "appearance", "dark")).rejects.toThrow(/choose a simulator/);
    await expect(service.poke(blank, { kind: "memory-warning" })).rejects.toThrow(/choose a simulator/);
  });
});

describe("everything else a device can be told to do", () => {
  it("reads the accessibility tree, and says 'not yet' rather than 'no elements' while it warms up", async () => {
    /* A 503 after a boot means the device's AX framework is still coming up. Reporting that as an
       empty tree would tell the user their screen has nothing on it, which is a different and much
       more confusing claim than "ask again in a second". */
    const { service, spaceId } = bring();
    const { simulatorId } = service.create({ spaceId, name: "Simulator", udid: "UDID-1" });
    service.start(simulatorId, "UDID-1");
    await settle(() => service.stateOf(simulatorId).status === "running");
    const tree = await service.ax(simulatorId);
    expect(tree.app).toBe("Safari");
    expect(tree.elements[0]).toMatchObject({ label: "Back", role: "Button", enabled: false });

    const quiet = bring({ serveSim: { ax: async () => null } });
    const { simulatorId: id2 } = quiet.service.create({ spaceId: quiet.spaceId, name: "Simulator", udid: "UDID-1" });
    quiet.service.start(id2, "UDID-1");
    await settle(() => quiet.service.stateOf(id2).status === "running");
    await expect(quiet.service.ax(id2)).rejects.toThrow(/accessibility tree/);
  });

  it("refuses the tree before there is a stream to ask — the route is the daemon's, not the device's", async () => {
    const { service, spaceId } = bring();
    const { simulatorId } = service.create({ spaceId, name: "Simulator", udid: "UDID-1" });
    await expect(service.ax(simulatorId)).rejects.toThrow(/stream/);
  });

  it("writes a screenshot into the space's own folder, under `simulator/`", async () => {
    /* Not loose in the space root: the folder is the user's, and a feature that drops files into the
       top of it makes a mess of somebody's project. The path comes back relative so the caller can
       hand it straight to the documents pane. */
    const { service, spaceId, calls } = bring();
    const { simulatorId } = service.create({ spaceId, name: "Carlton's iPhone", udid: "UDID-1" });
    const shot = await service.screenshot(simulatorId);
    expect(shot.path.startsWith("simulator/")).toBe(true);
    expect(shot.path.endsWith(".png")).toBe(true);
    // The row's name becomes a filename anyone can type at a shell.
    expect(shot.path).toContain("carlton-s-iphone");
    expect(calls.some((c) => c.startsWith(`screenshot:UDID-1:${shot.absolute}`))).toBe(true);
  });

  it("a failed screenshot is an error with what the command said, not a path to a file that is not there", async () => {
    const { service, spaceId } = bring({ simctl: { screenshot: async () => ({ ok: false, detail: "device not booted" }) } });
    const { simulatorId } = service.create({ spaceId, name: "Simulator", udid: "UDID-1" });
    await expect(service.screenshot(simulatorId)).rejects.toThrow(/device not booted/);
  });

  it("routes every act to its own command, and the camera's two forms to the right one", async () => {
    const { service, spaceId, calls } = bring();
    const { simulatorId } = service.create({ spaceId, name: "Simulator", udid: "UDID-1" });
    await service.act(simulatorId, { kind: "open-url", url: "https://example.test" });
    await service.act(simulatorId, { kind: "launch", bundleId: "com.acme.app" });
    await service.act(simulatorId, { kind: "launch", bundleId: "com.acme.app", fresh: true });
    await service.act(simulatorId, { kind: "install", path: "/tmp/Acme.app" });
    await service.act(simulatorId, { kind: "add-media", paths: ["/tmp/a.png", "/tmp/b.mov"] });
    await service.act(simulatorId, { kind: "permission", action: "grant", permission: "camera", bundleId: "com.acme.app" });
    expect(calls).toContain("openUrl:UDID-1:https://example.test");
    expect(calls).toContain("launch:UDID-1:com.acme.app");
    expect(calls).toContain("launch:UDID-1:com.acme.app:fresh");
    expect(calls).toContain("install:UDID-1:/tmp/Acme.app");
    expect(calls).toContain("addMedia:UDID-1:/tmp/a.png,/tmp/b.mov");
    expect(calls).toContain("permission:UDID-1:grant:camera:com.acme.app");

    /* The camera's two forms. WITH a bundle id the app is launched with the feed injected; WITHOUT
       one the helper already attached hot-swaps its source. Sending `switch` to an app that was
       never launched does nothing at all, so the distinction is the feature rather than a detail. */
    await service.act(simulatorId, { kind: "camera", bundleId: "com.acme.app", source: { kind: "file", path: "/tmp/face.png" } });
    await service.act(simulatorId, { kind: "camera", bundleId: null, source: { kind: "placeholder" } });
    expect(calls).toContain("camera:UDID-1:com.acme.app:file");
    expect(calls).toContain("cameraSwitch:UDID-1:placeholder");
  });

  it("the pasteboard goes both ways, and the read brings text back", async () => {
    const { service, spaceId, calls } = bring();
    const { simulatorId } = service.create({ spaceId, name: "Simulator", udid: "UDID-1" });
    await service.act(simulatorId, { kind: "paste", text: "hello device" });
    const read = await service.act(simulatorId, { kind: "copy" });
    expect(calls).toContain("pasteTo:UDID-1:hello device");
    expect(read.text).toBe("from the device");
  });

  it("every one of them refuses a row with no device chosen, rather than guessing at a booted one", async () => {
    // `serve-sim` and `simctl` both default to "the booted device" when none is named, which on a
    // Mac with three simulators up is a command landing on whichever one answers first.
    const { service, spaceId } = bring();
    const { simulatorId } = service.create({ spaceId, name: "Nothing chosen" });
    await expect(service.apps(simulatorId)).rejects.toThrow(/choose a simulator/);
    await expect(service.screenshot(simulatorId)).rejects.toThrow(/choose a simulator/);
    await expect(service.capture(simulatorId)).rejects.toThrow(/choose a simulator/);
    await expect(service.events(simulatorId, 10)).rejects.toThrow(/choose a simulator/);
    await expect(service.act(simulatorId, { kind: "camera-stop" })).rejects.toThrow(/choose a simulator/);
  });
});

describe("the agent's screenshot", () => {
  /** A `simctl` that really writes the file it was asked for, so the read-back and the cleanup are
   *  about a file that existed. */
  const writing = (bytes: Buffer, seen: string[]) => ({
    screenshot: async (_udid: string, path: string) => { seen.push(path); writeFileSync(path, bytes); return { ok: true, detail: "" }; },
  });

  it("hands back the capture's bytes and leaves no file behind — least of all in the space's folder", async () => {
    const seen: string[] = [];
    const png = Buffer.from("not really a png, but bytes all the same");
    const { service, spaceId, folder } = bring({ simctl: writing(png, seen) });
    const { simulatorId } = service.create({ spaceId, name: "Simulator", udid: "UDID-1" });
    const got = await service.capture(simulatorId);
    expect(got.equals(png)).toBe(true);
    /* THE MUTANT: capture through `screenshot`, which is the user's keeper. An agent looks after
       every step, and each look would then leave a 3 MB PNG in somebody's project. */
    expect(seen).toHaveLength(1);
    expect(seen[0]!.startsWith(tmpdir())).toBe(true);
    expect(existsSync(join(folder, "simulator"))).toBe(false);
    // THE MUTANT: drop the unlink. A temp file per look is the same mess, one folder over.
    expect(existsSync(seen[0]!)).toBe(false);
  });

  it("a failed capture says what the command said, and still leaves nothing behind", async () => {
    const seen: string[] = [];
    const { service, spaceId } = bring({ simctl: { screenshot: async (_u: string, path: string) => { seen.push(path); writeFileSync(path, "half"); return { ok: false, detail: "device not booted" }; } } });
    const { simulatorId } = service.create({ spaceId, name: "Simulator", udid: "UDID-1" });
    await expect(service.capture(simulatorId)).rejects.toThrow(/device not booted/);
    expect(existsSync(seen[0]!)).toBe(false);
  });
});

describe("an agent's input on an iOS device", () => {
  /** The socket, recorded: which URL the steps were sent down, and the steps. */
  const recording = () => {
    const sent: { url: string; steps: readonly InputStep[] }[] = [];
    const channel: InputChannel = async (url, steps) => { sent.push({ url, steps }); return { ok: true, detail: "" }; };
    return { sent, channel };
  };

  it("goes down the stream's own socket — the pane's channel — as the frames the gesture is", async () => {
    const { sent, channel } = recording();
    const { service, spaceId } = bring({ inputChannel: channel });
    const { simulatorId } = service.create({ spaceId, name: "Simulator" });
    service.start(simulatorId, "UDID-1");
    await settle(() => service.stateOf(simulatorId).status === "running");
    const tap = { kind: "tap", at: { x: 0.5, y: 0.5 }, count: 1 } as const;
    expect(await service.input(simulatorId, tap)).toEqual({ ok: true, detail: "" });
    // THE MUTANT: a socket of its own, or serve-sim's CLI. The pane's socket is the one the device
    // listens on, and the one whose reach the pane already proves.
    expect(sent).toEqual([{ url: STREAM.wsUrl, steps: iosSteps(tap) }]);
  });

  it("refuses a device Realm is not streaming, rather than guessing at a socket", async () => {
    const { sent, channel } = recording();
    const { service, spaceId } = bring({ inputChannel: channel });
    const { simulatorId } = service.create({ spaceId, name: "Simulator", udid: "UDID-1" });
    await expect(service.input(simulatorId, { kind: "press", key: "home" })).rejects.toThrow(/start the simulator's stream/);
    expect(sent).toEqual([]);
  });

  it("refuses what the device cannot do before sending any of it", async () => {
    const { sent, channel } = recording();
    const { service, spaceId } = bring({ inputChannel: channel });
    const { simulatorId } = service.create({ spaceId, name: "Simulator" });
    service.start(simulatorId, "UDID-1");
    await settle(() => service.stateOf(simulatorId).status === "running");
    expect((await service.input(simulatorId, { kind: "text", text: "Zürich" })).detail).toContain('"ü"');
    expect((await service.input(simulatorId, { kind: "press", key: "back" })).ok).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("the motion of an iOS device's screen", () => {
  it("is watched on the stream the pane is shown, and only once there is one", async () => {
    const watched: string[] = [];
    const motion: ScreenMotion = { mark: () => ({ moved: 0, edges: 0, edgeBusy: false }), settle: async () => "still", rest: async () => true, close: () => {} };
    const { service, spaceId } = bring({ watchScreen: (url) => { watched.push(url); return motion; } });
    const { simulatorId } = service.create({ spaceId, name: "Simulator" });
    // THE MUTANT: build a URL from the udid. A pane Realm is not streaming has no picture to watch.
    expect(service.motion(simulatorId)).toBeNull();
    service.start(simulatorId, "UDID-1");
    await settle(() => service.stateOf(simulatorId).status === "running");
    expect(service.motion(simulatorId)).toBe(motion);
    expect(watched).toEqual([STREAM.streamUrl]);
  });
});

describe("which simulator a loopback port is streaming", () => {
  const claimed = (claims: { device: string; port: number }[], live: ServeSimStream) => ({
    claims: async () => claims,
    find: async (udid: string) => (udid === live.device ? live : NOTHING),
  });

  it("names the device serve-sim records AND confirms on that port", async () => {
    const { service } = bring({ serveSim: claimed([{ device: "UDID-1", port: 3100 }], STREAM) });
    expect(await service.streamedOn(3100)).toBe("UDID-1");
  });

  it("answers a port no record names without asking serve-sim anything", async () => {
    /* The cost this whole shape exists to avoid: every `browser_open` of a loopback URL asks this, and
       almost none of them are a simulator. THE MUTANT: match any record (`c.port === port` → true) —
       the answer is still null, but only after an npx spawn per dev-server URL an agent opens. */
    const asked: string[] = [];
    const { service } = bring({ serveSim: { claims: async () => [{ device: "UDID-1", port: 3100 }], find: async (u) => { asked.push(u); return STREAM; } } });
    expect(await service.streamedOn(3000)).toBe(null);
    expect(asked).toEqual([]);
  });

  it("does not believe a record whose daemon has moved on — `--list` has the last word", async () => {
    // A record outlives its daemon; a restarted daemon can be on another port with the old file
    // still claiming this one. THE MUTANT: trust the record's port without comparing the live one.
    const moved = { ...STREAM, port: 3101, url: "http://127.0.0.1:3101" };
    const { service } = bring({ serveSim: claimed([{ device: "UDID-1", port: 3100 }], moved) });
    expect(await service.streamedOn(3100)).toBe(null);
    // …and a record whose daemon is gone entirely is no stream at all.
    const { service: dead } = bring({ serveSim: claimed([{ device: "UDID-1", port: 3100 }], { ...NOTHING, device: "UDID-1" }) });
    expect(await dead.streamedOn(3100)).toBe(null);
  });

  it("asks every record on the port, since a dead daemon's file can sit beside the live one that took it", async () => {
    // THE MUTANT: confirm only the first record naming the port. The stale one says no, and the
    // stream that really is on that port walks past the guard.
    const { service } = bring({ serveSim: claimed([{ device: "UDID-GONE", port: 3100 }, { device: "UDID-1", port: 3100 }], STREAM) });
    expect(await service.streamedOn(3100)).toBe("UDID-1");
  });
});
