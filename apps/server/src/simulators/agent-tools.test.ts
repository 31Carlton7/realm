import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import type { SimulatorAxTree, SimulatorDevice } from "@realm/contracts";
import type { McpServerConfig } from "@realm/adapters";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { openDatabase, type Db } from "../db/database";
import { ItemsStore } from "../store/items";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { SimulatorsStore } from "../store/simulators";
import { encodePng } from "../machines/framebuffer";
import { pngSize } from "../machines/qmp-driver";
import { SCREENSHOT_MAX_EDGE } from "../machines/driver";
import type { GateResult } from "../browsers/permissions";
import { createApp, type App } from "../app";
import { SimulatorService } from "./service";
import type { Simctl } from "./simctl";
import type { ServeSim, ServeSimStream } from "./serve-sim";
import type { Android } from "./android";
import type { AndroidStream } from "./android-stream";
import { createSimulatorAgentProvider, loopbackPort, shrinkForModel, SIMULATOR_PROVIDER_NAME } from "./agent-tools";

/**
 * The simulator tools against the REAL `SimulatorService` with its CLIs faked — so `simulator_open`
 * runs the service's own create-and-walk, and a pane's state is the state the pane would show. What
 * must die here: a mutating tool that acts before the card; a tool that reaches a pane in another
 * space; an open that makes a second pane for a device it already has; a screenshot that leaves a
 * file in the user's folder; and every way the switch or the toolchain can be ignored.
 */

const dbs: Db[] = [];
let app: App | null = null;
afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  await app?.close(); app = null;
  vi.unstubAllEnvs();
});

const IOS: SimulatorDevice[] = [
  { udid: "UDID-OFF", platform: "ios", name: "iPhone 17 Pro", runtime: "iOS 27.0", state: "Shutdown", serial: null },
  { udid: "UDID-UP", platform: "ios", name: "iPhone Air", runtime: "iOS 27.0", state: "Booted", serial: null },
];
const STREAM = (udid: string): ServeSimStream => ({
  running: true, device: udid, url: "http://127.0.0.1:3100",
  streamUrl: `http://127.0.0.1:3100/helper/${udid}/stream.mjpeg`, wsUrl: `ws://127.0.0.1:3100/helper/${udid}/ws`, port: 3100, pid: 99,
});
const NOTHING: ServeSimStream = { running: false, device: null, url: null, streamUrl: null, wsUrl: null, port: null, pid: null };
const TREE: SimulatorAxTree = {
  screen: { width: 402, height: 874 }, units: "points", app: "Settings",
  elements: [
    { path: "0.1", label: "General", value: "", role: "Button", id: "com.apple.settings.general", enabled: true, frame: { x: 16, y: 293.3, width: 370, height: 44 }, depth: 1 },
    { path: "0.2", label: "Wi-Fi", value: "Off", role: "Button", id: null, enabled: false, frame: { x: 16, y: 337.6, width: 370, height: 44 }, depth: 1 },
  ],
};

/** A phone-shaped PNG taller than the model budget, with something on it: a gradient, so a box
 *  filter has values to average rather than a flat field that any scaler gets right by accident. */
const PHONE_PNG = (() => {
  const width = 600, height = 1400;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    rgba[i] = x % 256; rgba[i + 1] = y % 256; rgba[i + 2] = 128; rgba[i + 3] = 255;
  }
  return encodePng({ width, height, rgba });
})();

const fakeStream = { start: async () => ({ streamUrl: "", wsUrl: "" }), stop: () => {}, close: async () => {} } as unknown as AndroidStream;

function fakeClis(over: { simctl?: Partial<Simctl>; serveSim?: Partial<ServeSim>; android?: Partial<Android> } = {}) {
  const cli: string[] = [];
  const simctl: Simctl = {
    devices: async () => IOS,
    boot: async (udid) => { cli.push(`boot:${udid}`); return { ok: true, detail: "" }; },
    available: async () => true,
    apps: async () => [{ bundleId: "com.acme.app", name: "Acme" }, { bundleId: "com.apple.Preferences", name: "Settings" }],
    screenshot: async (udid, path) => { cli.push(`screenshot:${udid}:${path}`); writeFileSync(path, PHONE_PNG); return { ok: true, detail: "" }; },
    openUrl: async (udid, url) => { cli.push(`openUrl:${udid}:${url}`); return { ok: true, detail: "" }; },
    install: async (udid, path) => { cli.push(`install:${udid}:${path}`); return { ok: true, detail: "" }; },
    launch: async (udid, bundleId) => { cli.push(`launch:${udid}:${bundleId}`); return { ok: true, detail: "" }; },
    addMedia: async () => ({ ok: true, detail: "" }),
    pasteTo: async () => ({ ok: true, detail: "" }),
    copyFrom: async () => ({ ok: true, text: "", detail: "" }),
    ...over.simctl,
  };
  const serveSim: ServeSim = {
    find: async () => NOTHING,
    claims: async () => [],
    start: async (udid) => { cli.push(`serve:${udid}`); return { stream: STREAM(udid), detail: "" }; },
    kill: async () => {},
    screen: async () => ({ width: 1206, height: 2622, orientation: "portrait" }),
    ui: async () => ({}), setUi: async () => ({ ok: true, state: {}, detail: "" }),
    memoryWarning: async () => ({ ok: true, detail: "" }), caDebug: async () => ({ ok: true, detail: "" }),
    ax: async () => TREE,
    permission: async () => ({ ok: true, detail: "" }), camera: async () => ({ ok: true, detail: "" }),
    cameraSwitch: async () => ({ ok: true, detail: "" }), cameraStop: async () => ({ ok: true, detail: "" }),
    webcams: async () => [], eventLog: async () => [],
    ...over.serveSim,
  };
  // No Android SDK unless a test says so: the real driver would look at this Mac's own SDK.
  const android = { available: async () => false, devices: async () => [], ...over.android } as unknown as Android;
  return { simctl, serveSim, android, cli };
}

function setup(opts: {
  gate?: GateResult;
  simctl?: Partial<Simctl>; serveSim?: Partial<ServeSim>; android?: Partial<Android>;
  wait?: { timeoutMs: number; pollMs: number };
} = {}) {
  const home = tempDir("realm-sim-tools-");
  const db = openDatabase(join(home, "realm.db"));
  dbs.push(db);
  const profiles = new ProfilesStore(db), spaces = new SpacesStore(db, home), items = new ItemsStore(db);
  const profile = profiles.create({ name: "Work", icon: "briefcase", color: "#fff" });
  const space = spaces.create({ profileId: profile.id, name: "Versed", icon: "folder" });
  const other = spaces.create({ profileId: profile.id, name: "Elsewhere", icon: "folder" });
  const clis = fakeClis(opts);
  const calls = {
    gates: [] as { toolKey: string; title: string; input: Record<string, unknown> }[],
    broadcasts: [] as { event: string; payload: Record<string, unknown> }[],
    cli: clis.cli,
  };
  const rpc = { broadcast: (event: string, payload: unknown) => { calls.broadcasts.push({ event, payload: payload as Record<string, unknown> }); } } as never;
  const service = new SimulatorService({ rpc, spaces, items, simulators: new SimulatorsStore(db), simctl: clis.simctl, serveSim: clis.serveSim, android: clis.android, androidStream: fakeStream });
  const switchedOff = new Set<string>();
  const provider = createSimulatorAgentProvider({
    mcp: { providerEnabled: (spaceId, name) => name === SIMULATOR_PROVIDER_NAME && !switchedOff.has(spaceId) },
    simulators: service, items, rpc,
    broker: {
      gate: async (_sessionId, toolKey, title, input) => {
        calls.gates.push({ toolKey, title, input });
        return opts.gate ?? { allowed: true };
      },
    },
    wait: opts.wait ?? { timeoutMs: 2_000, pollMs: 5 },
  });
  const ctx = { sessionId: "sess1", spaceId: space.id };
  const call = (tool: string, args: unknown = {}): Promise<CallToolResult> => provider.call(ctx, tool, args);
  /** A running pane in a space, the way `simulator_open` leaves one — for the tools that need one. */
  const running = async (spaceId = space.id, udid = "UDID-UP") => {
    const { simulatorId } = service.create({ spaceId, name: IOS.find((d) => d.udid === udid)!.name, udid });
    service.start(simulatorId, udid, "ios");
    for (let i = 0; i < 400 && service.stateOf(simulatorId).status !== "running"; i++) await new Promise((r) => setTimeout(r, 5));
    return simulatorId;
  };
  return { provider, service, items, ctx, call, calls, running, switchedOff, spaceId: space.id, otherSpaceId: other.id, folder: space.folderPath };
}

const text = (r: CallToolResult): string =>
  r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");

describe("offering the tools", () => {
  it("lists all eight where there are simulators and the space has them on", async () => {
    const { provider, ctx } = setup();
    expect((await provider.tools(ctx)).map((t) => t.name)).toEqual([
      "simulator_list", "simulator_open", "simulator_screenshot", "simulator_elements",
      "simulator_apps", "simulator_install", "simulator_launch", "simulator_open_url",
    ]);
  });

  it("goes with the space's switch — listed, called, and preamble'd, all three", async () => {
    const { provider, ctx, call, switchedOff } = setup();
    switchedOff.add(ctx.spaceId);
    expect(await provider.tools(ctx)).toEqual([]);
    // THE MUTANT: check the switch in `tools` only. An agent told about the tools before the space
    // turned them off still holds the names, and a call is how it would reach a device anyway.
    const r = await call("simulator_list");
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("disabled for this space");
  });

  it("offers nothing on a Mac with neither Xcode nor an Android SDK, and refuses a call that guessed", async () => {
    const { provider, ctx, call } = setup({ simctl: { available: async () => false } });
    // THE MUTANT: list the tools whatever the toolchain says. Every one of them then answers
    // "install Xcode", which is eight tools of noise in every session's list on a web developer's Mac.
    expect(await provider.tools(ctx)).toEqual([]);
    expect(provider.offered?.()).toBe(false);
    const r = await call("simulator_list");
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("no simulators on this Mac");
  });

  it("answers `offered` from a probe that ran at construction, and says no while it has no answer", async () => {
    const ready = setup();
    await ready.provider.tools(ready.ctx); // the probe has certainly answered once this has
    expect(ready.provider.offered?.()).toBe(true);
    // A probe that has not answered yet: nothing is known, so nothing is claimed. THE MUTANT:
    // `known !== false` — the session composed in that moment is told about simulators on a Mac that
    // may have none.
    const pending = setup({ simctl: { available: () => new Promise<boolean>(() => {}) } });
    expect(pending.provider.offered?.()).toBe(false);
  });
});

describe("simulator_list", () => {
  it("names every device with its udid and state, and the panes THIS space has open on them", async () => {
    const { call, running, otherSpaceId } = setup();
    const mine = await running();
    const theirs = await running(otherSpaceId, "UDID-OFF");
    const out = text(await call("simulator_list"));
    // Anchored to the line's end: a device with no pane here carries no pane annotation at all.
    expect(out).toMatch(/UDID-OFF — iPhone 17 Pro · iOS 27\.0 · not running$/m);
    expect(out).toMatch(/UDID-UP — iPhone Air · iOS 27\.0 · booted · in pane \w+ \(running\)/);
    expect(out).toContain(`in pane ${mine}`);
    // THE MUTANT: list panes from every space. A simulatorId from another space is refused by every
    // other tool here, so offering one is offering a handle that cannot be used — and it says what
    // the user has open in a space this session is not in.
    expect(out).not.toContain(theirs);
  });

  it("says what to install when the tools are there and the devices are not", async () => {
    const { call } = setup({ simctl: { devices: async () => [] } });
    expect(text(await call("simulator_list"))).toContain("Xcode ▸ Settings ▸ Components");
  });
});

describe("simulator_open", () => {
  it("refuses a udid this Mac does not have before asking anyone anything", async () => {
    const { call, calls, service, spaceId } = setup();
    const r = await call("simulator_open", { udid: "NOT-A-DEVICE" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("simulator_list");
    // THE MUTANT: create the pane, then find out. A card for a device that does not exist teaches the
    // user the card is noise, and the row it leaves behind is a pane with nothing in it.
    expect(calls.gates).toEqual([]);
    expect(service.list(spaceId)).toEqual([]);
  });

  it("asks BEFORE it makes a pane or boots anything, and a no leaves nothing behind", async () => {
    const { call, calls, service, spaceId } = setup({ gate: { allowed: false, reason: "the user denied this action" } });
    const r = await call("simulator_open", { udid: "UDID-OFF" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("denied");
    expect(calls.gates.map((g) => g.toolKey)).toEqual(["simulator_open"]);
    // THE MUTANT: gate after `create`/`start`. The device boots whatever the user answered.
    expect(service.list(spaceId)).toEqual([]);
    expect(calls.cli).toEqual([]);
    expect(calls.broadcasts.filter((b) => b.event === "simulator.agentOpened")).toEqual([]);
  });

  it("names the consequence on the card — a shut-down device is booted, a booted one is not", async () => {
    const { call, calls } = setup();
    await call("simulator_open", { udid: "UDID-OFF" });
    await call("simulator_open", { udid: "UDID-UP" });
    expect(calls.gates[0]!.title).toBe("Open iPhone 17 Pro (iOS 27.0) in a simulator pane — boots it");
    expect(calls.gates[1]!.title).toBe("Open iPhone Air (iOS 27.0) in a simulator pane");
  });

  it("opens the device in a pane beside the session and waits until it is streaming", async () => {
    const { call, calls, service, items, spaceId } = setup();
    const r = await call("simulator_open", { udid: "UDID-OFF" });
    expect(r.isError).toBe(false);
    const [row] = service.list(spaceId);
    expect(row).toMatchObject({ udid: "UDID-OFF", name: "iPhone 17 Pro", platform: "ios" });
    expect(service.stateOf(row!.id).status).toBe("running");
    expect(text(r)).toContain(`simulator pane ${row!.id}`);
    expect(text(r)).toContain("1206×2622");
    expect(calls.cli).toEqual(["boot:UDID-OFF", "serve:UDID-OFF"]);
    /* THE MUTANT: no `simulator.agentOpened`. The row and the sidebar item exist, the device boots —
       and the pane never comes into the layout, so the user watches nothing while an agent drives a
       phone. The item id is the one the renderer opens, so it has to be THIS row's item. */
    const opened = calls.broadcasts.filter((b) => b.event === "simulator.agentOpened");
    expect(opened).toEqual([{ event: "simulator.agentOpened", payload: { spaceId, simulatorId: row!.id, itemId: items.findByRefId(row!.id)!.id } }]);
  });

  it("brings back the pane it already has for a device, and leaves a running stream alone", async () => {
    const { call, calls, service, spaceId } = setup();
    await call("simulator_open", { udid: "UDID-UP" });
    const [first] = service.list(spaceId);
    const again = await call("simulator_open", { udid: "UDID-UP" });
    expect(again.isError).toBe(false);
    // THE MUTANT: create every time. The sidebar grows a row per call for one phone.
    expect(service.list(spaceId)).toHaveLength(1);
    expect(text(again)).toContain(`simulator pane ${first!.id}`);
    // THE MUTANT: start every time. The walk re-runs from the top and the pane flashes "Booting".
    expect(calls.cli.filter((c) => c.startsWith("boot:"))).toHaveLength(1);
    // Brought into the layout both times — the pane may have been closed from it in between.
    expect(calls.broadcasts.filter((b) => b.event === "simulator.agentOpened")).toHaveLength(2);
  });

  it("does not reach behind the user for a pane they archived", async () => {
    const { call, service, items, spaceId } = setup();
    await call("simulator_open", { udid: "UDID-UP" });
    const [first] = service.list(spaceId);
    items.update({ id: items.findByRefId(first!.id)!.id, archived: true });
    await call("simulator_open", { udid: "UDID-UP" });
    const rows = service.list(spaceId);
    expect(rows).toHaveLength(2);
    expect(rows.map((s) => s.id)).toContain(first!.id);
  });

  it("says why when the device will not come up, with what the command said", async () => {
    const { call } = setup({ simctl: { boot: async () => ({ ok: false, detail: "Unable to boot device: runtime unavailable" }) } });
    const r = await call("simulator_open", { udid: "UDID-OFF" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("the device would not boot");
    expect(text(r)).toContain("runtime unavailable");
  });

  it("comes back with a sentence, not a timeout, when a cold boot outlasts the wait", async () => {
    const { call, calls } = setup({ simctl: { boot: () => new Promise(() => {}) }, wait: { timeoutMs: 40, pollMs: 5 } });
    const r = await call("simulator_open", { udid: "UDID-OFF" });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain("still booting");
    // The pane is already in the layout, showing the boot — that is what the user watches meanwhile.
    expect(calls.broadcasts.some((b) => b.event === "simulator.agentOpened")).toBe(true);
  });
});

describe("the tools that act on an open pane", () => {
  it("refuse a pane from another space exactly as they refuse one that does not exist", async () => {
    const { call, calls, running, otherSpaceId } = setup();
    const theirs = await running(otherSpaceId);
    for (const [tool, args] of [
      ["simulator_screenshot", {}], ["simulator_elements", {}], ["simulator_apps", {}],
      ["simulator_install", { path: "/tmp/App.app" }], ["simulator_launch", { bundleId: "com.acme.app" }], ["simulator_open_url", { url: "myapp://x" }],
    ] as const) {
      const r = await call(tool, { simulatorId: theirs, ...args });
      // THE MUTANT: look the row up by id alone. A simulatorId that leaked into a transcript then
      // reaches a device another space has open.
      expect(r.isError, tool).toBe(true);
      expect(text(r), tool).toContain("this space has no simulator panes");
    }
    expect(calls.gates).toEqual([]);
  });

  it("point a pane that is not streaming back at simulator_open, with its own udid", async () => {
    const { call, calls, service, spaceId } = setup();
    const { simulatorId } = service.create({ spaceId, name: "iPhone Air", udid: "UDID-UP" });
    const r = await call("simulator_screenshot", { simulatorId });
    // THE MUTANT: skip the running check. `simctl` then answers about a device in the wrong state,
    // and the agent is told something about the device rather than what to call next.
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('simulator_open with udid "UDID-UP"');
    expect(calls.cli.filter((c) => c.startsWith("screenshot:"))).toEqual([]);
  });
});

describe("simulator_screenshot", () => {
  it("hands the model a picture it can read, and writes nothing in the space's folder", async () => {
    const { call, running, folder } = setup();
    const simulatorId = await running();
    const r = await call("simulator_screenshot", { simulatorId });
    expect(r.isError).toBe(false);
    const image = r.content.find((c) => c.type === "image") as { data: string; mimeType: string };
    expect(image.mimeType).toBe("image/png");
    const dims = pngSize(Buffer.from(image.data, "base64"))!;
    expect(Math.max(dims.width, dims.height)).toBe(SCREENSHOT_MAX_EDGE);
    // The DEVICE's size, and the picture's, both said — a model reading a smaller picture is told so.
    expect(text(r)).toContain("600×1400 pixels");
    expect(text(r)).toContain(`shown at ${dims.width}×${dims.height}`);
    // THE MUTANT: capture through the user's Screenshot, which keeps a file. One per look.
    expect(existsSync(join(folder, "simulator"))).toBe(false);
  });

  it("keeps the full-size file only when asked to, and says where", async () => {
    const { call, running, folder } = setup();
    const simulatorId = await running();
    const r = await call("simulator_screenshot", { simulatorId, save: true });
    const kept = readdirSync(join(folder, "simulator"));
    expect(kept).toHaveLength(1);
    expect(text(r)).toContain(`simulator/${kept[0]}`);
    expect(r.content.some((c) => c.type === "image")).toBe(true);
  });
});

describe("shrinkForModel", () => {
  it("passes a picture already inside the budget through untouched", () => {
    const small = encodePng({ width: 4, height: 8, rgba: Buffer.alloc(4 * 8 * 4, 200) });
    expect(shrinkForModel(small)!.data).toBe(small);
  });

  it("scales a phone screen down to the budget on its long side and keeps its proportions", () => {
    const out = shrinkForModel(PHONE_PNG)!;
    expect({ w: out.width, h: out.height }).toEqual({ w: 600, h: 1400 });
    expect(out.imageHeight).toBe(SCREENSHOT_MAX_EDGE);
    expect(out.imageWidth).toBe(Math.round(600 * (SCREENSHOT_MAX_EDGE / 1400)));
    expect(pngSize(out.data)).toEqual({ width: out.imageWidth, height: out.imageHeight });
  });

  it("refuses a picture it can neither read nor send, rather than breaking the agent's turn", () => {
    // A PNG header claiming a huge screen, over a body this decoder cannot read (interlaced).
    const head = Buffer.from(PHONE_PNG.subarray(0, 33));
    head.writeUInt32BE(3000, 16); head[28] = 1;
    const big = Buffer.concat([head, Buffer.alloc(3_600_000)]);
    expect(shrinkForModel(big)).toBe(null);
    // …while the same unreadable picture, small enough to arrive whole, is sent as it is.
    const fits = Buffer.concat([head, Buffer.alloc(1_000)]);
    expect(shrinkForModel(fits)!.data).toBe(fits);
  });
});

describe("simulator_elements and simulator_apps", () => {
  it("lists the tree by the labels the app gives it, inside the untrusted fence", async () => {
    const { call, running } = setup();
    const simulatorId = await running();
    const out = text(await call("simulator_elements", { simulatorId }));
    expect(out).toContain('2 element(s) on iPhone Air. Frames are "(x,y width×height)" in points, on a 402×874 screen');
    expect(out).toContain('[0.1] Button "General" id=com.apple.settings.general (16,293 370×44)');
    expect(out).toContain('[0.2] Button "Wi-Fi" value="Off" (16,338 370×44) disabled');
    /* THE MUTANT: drop `fenceUntrusted`. A simulator's Safari can show any page on the web, and every
       label on it arrives here as text in the model's context, reading as Realm's own. */
    const fenceAt = out.indexOf("<<<"), labelAt = out.indexOf('"General"'), appAt = out.indexOf("app: Settings");
    expect(fenceAt).toBeGreaterThan(-1);
    expect(labelAt).toBeGreaterThan(fenceAt);
    expect(appAt).toBeGreaterThan(fenceAt);
  });

  it("lists the apps with the bundle ids simulator_launch takes, fenced like the tree", async () => {
    const { call, running } = setup();
    const simulatorId = await running();
    const out = text(await call("simulator_apps", { simulatorId }));
    expect(out).toContain("com.acme.app — Acme");
    expect(out.indexOf("<<<")).toBeGreaterThan(-1);
    expect(out.indexOf("com.acme.app")).toBeGreaterThan(out.indexOf("<<<"));
  });
});

describe("install, launch and open_url", () => {
  it("each asks first, names the device and the target on the card, and does nothing on a no", async () => {
    const { call, calls, running } = setup({ gate: { allowed: false, reason: "the user denied this action" } });
    const simulatorId = await running();
    const before = calls.cli.length;
    await call("simulator_install", { simulatorId, path: "/Users/me/Build/Products/Debug-iphonesimulator/Acme.app" });
    await call("simulator_launch", { simulatorId, bundleId: "com.acme.app" });
    await call("simulator_open_url", { simulatorId, url: "acme://settings/profile" });
    expect(calls.gates.map((g) => [g.toolKey, g.title])).toEqual([
      ["simulator_install", "Install Acme.app on iPhone Air"],
      ["simulator_launch", "Launch com.acme.app on iPhone Air"],
      ["simulator_open_url", "Open acme://settings/profile on iPhone Air"],
    ]);
    // THE MUTANT: act, then ask. A denied install is an installed app.
    expect(calls.cli.slice(before)).toEqual([]);
  });

  it("reach the device's own command once allowed", async () => {
    const { call, calls, running } = setup();
    const simulatorId = await running();
    expect((await call("simulator_install", { simulatorId, path: "/tmp/Acme.app" })).isError).toBe(false);
    expect((await call("simulator_launch", { simulatorId, bundleId: "com.acme.app" })).isError).toBe(false);
    expect((await call("simulator_open_url", { simulatorId, url: "https://example.test/" })).isError).toBe(false);
    expect(calls.cli).toEqual(expect.arrayContaining([
      "install:UDID-UP:/tmp/Acme.app", "launch:UDID-UP:com.acme.app", "openUrl:UDID-UP:https://example.test/",
    ]));
  });

  it("refuses a relative path and a URL with no scheme before raising a card for them", async () => {
    const { call, calls, running } = setup();
    const simulatorId = await running();
    // THE MUTANT: pass a relative path through. `simctl` resolves it against realm-server's own cwd,
    // which is nowhere the agent has been, after the user has already approved it.
    const rel = await call("simulator_install", { simulatorId, path: "build/Acme.app" });
    expect(text(rel)).toContain("not an absolute path");
    const bare = await call("simulator_open_url", { simulatorId, url: "settings/profile" });
    expect(text(bare)).toContain("needs a scheme");
    expect(calls.gates).toEqual([]);
  });

  it("reports what the command said when it fails", async () => {
    const { call, running } = setup({ simctl: { launch: async () => ({ ok: false, detail: "FBSOpenApplicationServiceErrorDomain: not installed" }) } });
    const simulatorId = await running();
    const r = await call("simulator_launch", { simulatorId, bundleId: "com.nope" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("not installed");
  });
});

describe("the browser guard's question", () => {
  it("names the device serve-sim streams at a loopback URL, in a space with the tools on", async () => {
    const { provider, spaceId } = setup({ serveSim: {
      claims: async () => [{ device: "UDID-UP", port: 3100 }],
      find: async (udid) => (udid === "UDID-UP" ? STREAM("UDID-UP") : NOTHING),
    } });
    expect(await provider.streamAt(spaceId, "http://127.0.0.1:3100/")).toBe("UDID-UP");
    expect(await provider.streamAt(spaceId, "http://localhost:3100/helper/UDID-UP/stream.mjpeg")).toBe("UDID-UP");
    expect(await provider.streamAt(spaceId, "http://127.0.0.1:3000/")).toBe(null);
  });

  it("does not answer for a space that switched the tools off — its refusal would name a tool it lacks", async () => {
    const { provider, spaceId, switchedOff } = setup({ serveSim: {
      claims: async () => [{ device: "UDID-UP", port: 3100 }], find: async () => STREAM("UDID-UP"),
    } });
    switchedOff.add(spaceId);
    expect(await provider.streamAt(spaceId, "http://127.0.0.1:3100/")).toBe(null);
  });

  it("never reads serve-sim's records for a URL that is not on this Mac", async () => {
    let read = 0;
    const { provider, spaceId } = setup({ serveSim: { claims: async () => { read++; return [{ device: "UDID-UP", port: 443 }]; }, find: async () => STREAM("UDID-UP") } });
    // THE MUTANT: drop the loopback check. Every public URL then costs a directory read, and one on
    // port 443 is refused as a simulator.
    expect(await provider.streamAt(spaceId, "https://example.com/")).toBe(null);
    expect(read).toBe(0);
  });
});

describe("loopbackPort", () => {
  it("treats every spelling of this Mac as one host, and says which port", () => {
    expect(loopbackPort("http://127.0.0.1:3100/")).toBe(3100);
    expect(loopbackPort("http://localhost:3100/x")).toBe(3100);
    expect(loopbackPort("http://[::1]:3100/")).toBe(3100);
    expect(loopbackPort("http://0.0.0.0:3100/")).toBe(3100);
    expect(loopbackPort("http://127.4.5.6:8080/")).toBe(8080);
    expect(loopbackPort("http://localhost/")).toBe(80);
    expect(loopbackPort("https://localhost/")).toBe(443);
  });

  it("is null for anywhere else, and for anything that is not a web URL", () => {
    expect(loopbackPort("http://192.168.1.5:3100/")).toBe(null);
    expect(loopbackPort("https://example.com:3100/")).toBe(null);
    expect(loopbackPort("ws://127.0.0.1:3100/")).toBe(null);
    expect(loopbackPort("not a url")).toBe(null);
  });
});

describe("through the real gateway", () => {
  /** One RPC call over the app's own socket — the switch below is flipped the way the settings row
   *  flips it, which is also what tells a connected session to re-list. */
  async function rpcCall(port: number, method: string, params: unknown): Promise<{ result?: unknown; error?: { code: string } }> {
    const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
    try {
      return await new Promise((res) => {
        ws.on("message", (raw) => { const m = JSON.parse(raw.toString()) as { id?: string }; if (m.id === "1") res(m as never); });
        ws.send(JSON.stringify({ id: "1", method, params }));
      });
    } finally { ws.close(); }
  }

  /** A real app, with the simulator CLIs faked through `createApp`'s seam — the gateway, the provider
   *  registry and the space's switch are all production wiring. */
  async function boot(simctl?: Partial<Simctl>, serveSim?: Partial<ServeSim>) {
    const home = tempDir("realm-sim-gw-");
    vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
    const clis = fakeClis({ simctl, serveSim });
    app = await createApp({ home, port: 0, simulator: { simctl: clis.simctl, serveSim: clis.serveSim, android: clis.android } });
    const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
    const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "S", icon: "folder" });
    const { session } = app.sessions.create({ spaceId: space.id, agentKind: "claude", projectId: null, model: null, effort: null, permissionMode: "bypassPermissions" });
    const cfg = app.gateway.register(session.id, space.id) as Extract<McpServerConfig, { url: string }>;
    const client = new Client({ name: "t", version: "1.0.0" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
    return { client, spaceId: space.id };
  }

  it("serves the tools under realm-simulator__, and takes them away with the space's switch", async () => {
    const { client, spaceId } = await boot();
    const names = (await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith(`${SIMULATOR_PROVIDER_NAME}__`));
    expect(names).toContain("realm-simulator__simulator_open");
    expect(names).toHaveLength(8);
    const listed = (await client.callTool({ name: "realm-simulator__simulator_list", arguments: {} })) as CallToolResult;
    expect(text(listed)).toContain("UDID-OFF — iPhone 17 Pro");

    expect((await rpcCall(app!.port, "mcp.setProviderEnabled", { spaceId, name: SIMULATOR_PROVIDER_NAME, enabled: false })).error).toBeUndefined();
    expect((await client.listTools()).tools.some((t) => t.name.startsWith(`${SIMULATOR_PROVIDER_NAME}__`))).toBe(false);
    const refused = (await client.callTool({ name: "realm-simulator__simulator_list", arguments: {} })) as CallToolResult;
    expect(refused.isError).toBe(true);
    await client.close();
  });

  it("refuses browser_open on serve-sim's stream through the real wiring, naming simulator_open", async () => {
    // app.ts has to hand the browser provider the simulator provider's question; the unit tests on
    // either side build their providers by hand and would pass with that line gone.
    const { client } = await boot(undefined, {
      claims: async () => [{ device: "UDID-UP", port: 3100 }],
      find: async (udid) => (udid === "UDID-UP" ? STREAM("UDID-UP") : NOTHING),
    });
    const r = (await client.callTool({ name: "realm-browser__browser_open", arguments: { url: "http://127.0.0.1:3100/" } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('simulator_open with udid "UDID-UP"');
    await client.close();
  });

  it("lists nothing on a Mac with no simulators, where the switch alone would have said yes", async () => {
    const { client } = await boot({ available: async () => false });
    expect((await client.listTools()).tools.some((t) => t.name.startsWith(`${SIMULATOR_PROVIDER_NAME}__`))).toBe(false);
    await client.close();
  });
});
