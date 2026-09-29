import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import type { SimulatorAxTree, SimulatorDevice } from "@realm/contracts";
import type { McpServerConfig, PermissionDecision } from "@realm/adapters";
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
import { BrowserPermissionBroker, type GateOptions, type GateResult } from "../browsers/permissions";
import type { ActObservation, ActObserver } from "../mcp/act-observer";
import type { AssistOutcome, LayaAssist } from "../laya/assist";
import type { InputChannel, InputStep } from "./device-input";
import { createApp, type App } from "../app";
import { SimulatorService, toolchainAvailable } from "./service";
import type { Simctl } from "./simctl";
import type { ServeSim, ServeSimStream } from "./serve-sim";
import type { Android } from "./android";
import type { AndroidStream } from "./android-stream";
import { createSimulatorAgentProvider, loopbackPort, shrinkForModel, SIMULATOR_PROVIDER_NAME } from "./agent-tools";
import type { ScreenMotion } from "./screen-motion";
import { PhysicalDevices } from "./physical";
import { FakePhone, PHONE_UDID } from "./phone.test-fakes";

/** A picture watcher whose stream is already gone: every walk falls back to reading the tree. */
const GONE: ScreenMotion = { mark: () => ({ moved: 0, edges: 0, edgeBusy: false }), settle: async () => "lost", rest: async () => false, close: () => {} };

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
  { udid: "UDID-OFF", platform: "ios", name: "iPhone 17 Pro", runtime: "iOS 27.0", state: "Shutdown", serial: null, physical: false },
  { udid: "UDID-UP", platform: "ios", name: "iPhone Air", runtime: "iOS 27.0", state: "Booted", serial: null, physical: false },
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
    launch: async (udid, bundleId, fresh) => { cli.push(`launch:${udid}:${bundleId}${fresh ? ":fresh" : ""}`); return { ok: true, detail: "" }; },
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
  /** Build the provider with no toolchain probe at all — what `createApp` does unless it is given one. */
  noProbe?: boolean;
  /** The REAL broker, in this mode, answering every card it raises with `answer` — for the rules that
   *  live in the broker (one card per device per session, Plan refusing). Without it, a stub gate. */
  broker?: { mode: string; answer?: PermissionDecision };
  observe?: ActObserver;
  /** Laya's Assist, scripted: whether it is on, and what it answers for a described target. */
  assist?: LayaAssist;
  /** What the device's input socket answers. */
  input?: { ok: boolean; detail: string };
  /** Something that happens while the stub's card is up — the user taking their time. */
  onCard?: () => void;
  /** Told each input as the device's socket receives it — how a scripted device reacts to a tap. */
  onInput?: (steps: readonly InputStep[]) => void;
  /** How the device's picture is watched. Unset, a watcher whose stream is gone at once, so a walk
   *  falls back to reading the tree — and no test opens a socket to whatever is on port 3100. */
  watchScreen?: (url: string) => ScreenMotion;
  /** A real iPhone on the cable, scripted: listed by devicectl and driven through its runner. */
  phone?: FakePhone;
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
    gates: [] as { toolKey: string; title: string; input: Record<string, unknown>; toolName?: string; opts?: GateOptions }[],
    broadcasts: [] as { event: string; payload: Record<string, unknown> }[],
    cli: clis.cli,
    /** What reached the device's input socket: which socket, and the steps. */
    sent: [] as { url: string; steps: readonly InputStep[] }[],
    /** Gate, observer and socket, in the order they happened. */
    order: [] as string[],
  };
  const rpc = { broadcast: (event: string, payload: unknown) => { calls.broadcasts.push({ event, payload: payload as Record<string, unknown> }); } } as never;
  const inputChannel: InputChannel = async (url, steps) => {
    calls.order.push("act");
    calls.sent.push({ url, steps });
    opts.onInput?.(steps);
    return opts.input ?? { ok: true, detail: "" };
  };
  const watchScreen = opts.watchScreen ?? (() => GONE);
  const dc = opts.phone?.devicectl();
  const physical = opts.phone ? new PhysicalDevices({
    home, devicectl: dc, runners: opts.phone.runners(),
    bridge: async () => ({ streamUrl: "http://127.0.0.1:47001/stream.mjpeg", wsUrl: "ws://127.0.0.1:47001/ws", port: 47001, close: async () => {} }),
  }) : undefined;
  const service = new SimulatorService({ rpc, spaces, items, simulators: new SimulatorsStore(db), simctl: clis.simctl, serveSim: clis.serveSim, android: clis.android, androidStream: fakeStream, inputChannel, watchScreen, physical });
  let mode = opts.broker?.mode ?? "default";
  const real: BrowserPermissionBroker | null = opts.broker ? new BrowserPermissionBroker({
    permissionMode: () => mode,
    emit: (_sessionId, ev) => {
      if (ev.type !== "permission_request") return;
      calls.order.push("card");
      calls.gates.push({ toolKey: "", title: ev.payload.title, input: ev.payload.input, toolName: ev.payload.toolName });
      // Answered the way a user would, once the card is up.
      queueMicrotask(() => real!.resolve(ev.payload.requestId, opts.broker!.answer ?? "allow"));
    },
  }) : null;
  const switchedOff = new Set<string>();
  const changes: number[] = [];
  const provider = createSimulatorAgentProvider({
    mcp: { providerEnabled: (spaceId, name) => name === SIMULATOR_PROVIDER_NAME && !switchedOff.has(spaceId) },
    simulators: service, items, rpc,
    // The service's own question, over the faked CLIs — the same one `main.ts` hands the real server.
    probe: opts.noProbe ? undefined : () => service.available(),
    onOfferedChange: () => changes.push(Date.now()),
    broker: real ?? {
      gate: async (_sessionId, toolKey, title, input, toolName, gateOpts) => {
        calls.order.push("card");
        opts.onCard?.();
        calls.gates.push({ toolKey, title, input, toolName, opts: gateOpts });
        return opts.gate ?? { allowed: true };
      },
    },
    wait: opts.wait ?? { timeoutMs: 2_000, pollMs: 5 },
    observe: opts.observe,
    assist: opts.assist,
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
  return {
    provider, service, items, ctx, call, calls, running, switchedOff, changes, spaceId: space.id, otherSpaceId: other.id, folder: space.folderPath, devicectl: dc,
    /** Change the session's mode under the real broker, the way a mid-session switch does. */
    setMode: (m: string) => { mode = m; },
  };
}

const text = (r: CallToolResult): string =>
  r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");

describe("offering the tools", () => {
  it("lists all fifteen where there are simulators and the space has them on", async () => {
    const { provider, ctx } = setup();
    expect((await provider.tools(ctx)).map((t) => t.name)).toEqual([
      "simulator_list", "simulator_open", "simulator_screenshot", "simulator_elements",
      "simulator_apps", "simulator_install", "simulator_launch", "simulator_open_url",
      "simulator_do", "simulator_tap", "simulator_double_tap", "simulator_long_press", "simulator_swipe", "simulator_type", "simulator_press",
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

  it("answers `offered` from a probe that ran at construction, and says it does not know yet until it has", async () => {
    const ready = setup();
    await ready.provider.tools(ready.ctx); // the probe has certainly answered once this has
    expect(ready.provider.offered?.()).toBe(true);
    // A probe that has not answered yet: nothing is known, and that is its own answer — not a yes
    // (the preamble would promise simulators on a Mac that may have none) and not a no (the settings
    // row would say "Needs Xcode" on a Mac that has it). THE MUTANT: fold `null` into either.
    const pending = setup({ simctl: { available: () => new Promise<boolean>(() => {}) } });
    expect(pending.provider.offered?.()).toBe(null);
    expect(pending.provider.needs).toBe("Xcode or Android Studio");
  });

  it("asks nothing at all when it was given no probe, and offers nothing", async () => {
    // What `createApp` builds unless `main.ts` (or a test) hands it an answer. THE MUTANT: fall back to
    // the service's own question — which, in a suite, is `xcrun` spawned by every app a test builds.
    let asked = 0;
    const { provider, ctx } = setup({ noProbe: true, simctl: { available: async () => { asked++; return true; } } });
    expect(await provider.tools(ctx)).toEqual([]);
    expect(provider.offered?.()).toBe(null);
    expect(asked).toBe(0);
  });

  it("says when its answer changes — once when it first knows, and again only if it moves", async () => {
    let installed = false;
    const { provider, ctx, changes } = setup({ simctl: { available: async () => installed } });
    await provider.tools(ctx);
    expect(changes).toHaveLength(1); // unknown → no
    await provider.tools(ctx);
    // THE MUTANT: tell on every probe. Each connected session is then told to re-list its tools
    // every minute, for nothing.
    expect(changes).toHaveLength(1);
    // The same answer, cached, is not news; a changed one arrives once the cache has aged, which the
    // switch below stands in for.
    installed = true;
    expect(changes).toHaveLength(1);
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
      ["simulator_tap", { intent: "x", x: 10, y: 10 }], ["simulator_swipe", { intent: "x", direction: "up" }],
      ["simulator_type", { intent: "x", text: "hi" }], ["simulator_press", { intent: "x", key: "home" }],
      ["simulator_do", { intent: "x", path: ["General"] }],
    ] as const) {
      const r = await call(tool, { simulatorId: theirs, ...args });
      // THE MUTANT: look the row up by id alone. A simulatorId that leaked into a transcript then
      // reaches a device another space has open.
      expect(r.isError, tool).toBe(true);
      expect(text(r), tool).toContain("this space has no simulator panes");
    }
    expect(calls.gates).toEqual([]);
    expect(calls.sent).toEqual([]);
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
    expect(out).toContain('[1] Button "General" id=com.apple.settings.general (16,293 370×44)');
    expect(out).toContain('[2] Button "Wi-Fi" value="Off" (16,338 370×44) disabled');
    /* THE MUTANT: drop `fenceUntrusted`. A simulator's Safari can show any page on the web, and every
       label on it arrives here as text in the model's context, reading as Realm's own. */
    const fenceAt = out.indexOf("<<<"), labelAt = out.indexOf('"General"'), appAt = out.indexOf("app: Settings");
    expect(fenceAt).toBeGreaterThan(-1);
    expect(labelAt).toBeGreaterThan(fenceAt);
    expect(appAt).toBeGreaterThan(fenceAt);
  });

  it("says so when the foreground app names itself nothing, as the home screen does", async () => {
    // MEASURED: SpringBoard's root node arrives with a blank label, which printed as `app:  `.
    const { call, running } = setup({ serveSim: { ax: async () => ({ ...TREE, app: " " }) } });
    const simulatorId = await running();
    expect(text(await call("simulator_elements", { simulatorId }))).toContain("app: (no name)\n");
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

/* ---------------------------------- input ---------------------------------- */

const INPUT_TOOLS = ["simulator_tap", "simulator_double_tap", "simulator_long_press", "simulator_swipe", "simulator_type", "simulator_press"] as const;

/** One of each input tool, with an intent and whatever else it needs — a point for the touches. */
const ONE_OF_EACH: [string, Record<string, unknown>][] = [
  ["simulator_tap", { x: 201, y: 437 }], ["simulator_double_tap", { x: 201, y: 437 }], ["simulator_long_press", { x: 201, y: 437 }],
  ["simulator_swipe", { direction: "up" }], ["simulator_type", { text: "hi" }], ["simulator_press", { key: "home" }],
];

/** A frame as the device reads it. */
const decode = (f: Uint8Array): Record<string, unknown> & { op: number } =>
  ({ op: f[0]!, ...(JSON.parse(new TextDecoder().decode(f.slice(1))) as Record<string, unknown>) });
/** Everything the device was sent, frame by frame, across every step. */
const frames = (sent: { steps: readonly InputStep[] }[]) => sent.flatMap((x) => x.steps.map((st) => decode(st.frame)));

/** Settings' root, re-drawn: the same two rows, and whatever the test changes about them. */
const redraw = (change: (els: SimulatorAxTree["elements"]) => SimulatorAxTree["elements"]): SimulatorAxTree =>
  ({ ...TREE, elements: change(TREE.elements.map((e) => ({ ...e, frame: { ...e.frame } }))) });

/**
 * A device whose screen the test can change between the agent's read and the act — the whole
 * question element addressing has to answer. `reads` counts the trees asked for.
 */
function device(over: Parameters<typeof setup>[0] = {}) {
  let screen: SimulatorAxTree = TREE;
  let reads = 0;
  const s = setup({ ...over, serveSim: { ...over.serveSim, ax: async () => { reads++; return screen; } } });
  return { ...s, show: (t: SimulatorAxTree) => { screen = t; }, treeReads: () => reads };
}

describe("the input tools' arguments", () => {
  it("each one says it needs an intent, in the schema the agent reads", async () => {
    const { provider, ctx } = setup();
    const tools = await provider.tools(ctx);
    for (const name of INPUT_TOOLS) {
      const schema = tools.find((t) => t.name === name)!.inputSchema as { required: string[] };
      expect(schema.required, name).toContain("intent");
    }
  });

  it("refuses a step with no intent, a blank one or an essay — before any card, and sends nothing", async () => {
    const { call, calls, running } = setup();
    const simulatorId = await running();
    for (const [tool, args] of ONE_OF_EACH) {
      // THE MUTANT: make intent optional, or let whitespace through. The step then reaches the user's
      // card and the observer with nothing saying what it is for.
      for (const intent of [undefined, "   ", "x".repeat(201)]) {
        const r = await call(tool, { simulatorId, ...args, ...(intent === undefined ? {} : { intent }) });
        expect(r.isError, `${tool} ${JSON.stringify(intent)?.slice(0, 12)}`).toBe(true);
        expect(text(r)).toContain("intent");
      }
    }
    expect(text(await call("simulator_tap", { simulatorId, x: 1, y: 1 }))).toContain('what this step is for, such as "open the Wi-Fi settings"');
    expect(calls.gates).toEqual([]);
    expect(calls.sent).toEqual([]);
  });

  it("takes an element or a point, never both and never half a point", async () => {
    const { call, calls, running } = setup();
    const simulatorId = await running();
    for (const args of [{ element: 1, x: 5, y: 5 }, { x: 5 }, {}]) {
      const r = await call("simulator_tap", { simulatorId, intent: "tap it", ...args });
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(text(r)).toContain("give exactly one of: an element's [number], a point as both x and y");
    }
    for (const args of [{ direction: "up", from: { x: 1, y: 1 }, to: { x: 2, y: 2 } }, { from: { x: 1, y: 1 } }]) {
      expect((await call("simulator_swipe", { simulatorId, intent: "scroll", ...args })).isError, JSON.stringify(args)).toBe(true);
    }
    /* THE MUTANT: let an element ride along with from and to. The swipe then goes between the points
       and the element is silently ignored — refused here by name, and before anything is looked up. */
    const both = await call("simulator_swipe", { simulatorId, intent: "scroll", element: 1, from: { x: 1, y: 1 }, to: { x: 2, y: 2 } });
    expect(text(both)).toContain("an element is swiped across in a direction");
    expect(calls.gates).toEqual([]);
    expect(calls.sent).toEqual([]);
  });
});

describe("acting on an element", () => {
  it("looks for it on the LIVE screen and taps the centre of its frame there, not where it was read", async () => {
    const dev = device();
    const simulatorId = await dev.running();
    await dev.call("simulator_elements", { simulatorId });
    // The list scrolled a little between the read and the tap: same row, lower down.
    dev.show(redraw((els) => { els[0]!.frame.y = 400; return els; }));
    const r = await dev.call("simulator_tap", { simulatorId, intent: "open General", element: 1 });
    expect(r.isError).toBe(false);
    const [begin, end] = frames(dev.calls.sent);
    /* THE MUTANT: tap the frame the agent READ. That is (201,315) — which after the scroll is the
       row above General, and the picture would show nothing wrong. */
    expect(begin).toMatchObject({ op: 3, type: "begin", x: 201 / 402 });
    expect(begin!.y).toBeCloseTo(422 / 874, 10);
    expect(end).toMatchObject({ type: "end", x: 201 / 402 });
    expect(text(r)).toContain("Tapped [1] on iPhone Air, at the centre of its frame (201,422).");
    expect(text(r)).toContain("Read simulator_elements");
  });

  it("refuses an element that is not the one the agent was shown any more, and says to read again", async () => {
    const changes: [string, (els: SimulatorAxTree["elements"]) => SimulatorAxTree["elements"]][] = [
      ["another label", (els) => { els[0]!.label = "Bluetooth"; return els; }],
      ["another role", (els) => { els[0]!.role = "StaticText"; return els; }],
      ["another id", (els) => { els[0]!.id = "com.apple.settings.bluetooth"; return els; }],
      ["another size", (els) => { els[0]!.frame.height = 88; return els; }],
      ["gone", (els) => els.slice(1)],
    ];
    for (const [what, change] of changes) {
      const observed: ActObservation[] = [];
      const dev = device({ observe: (o) => { observed.push(o); } });
      const simulatorId = await dev.running();
      await dev.call("simulator_elements", { simulatorId });
      dev.show(redraw(change));
      const r = await dev.call("simulator_tap", { simulatorId, intent: "open General", element: 1 });
      // THE MUTANT: trust the path. After a screen changes, the same position holds something else.
      expect(r.isError, what).toBe(true);
      expect(text(r), what).toContain("Read simulator_elements again");
      expect(dev.calls.sent, what).toEqual([]);
      expect(observed, what).toEqual([]);
    }
  });

  it("does not call a changed value a changed element — a switch that flipped is the same switch", async () => {
    const dev = device();
    const simulatorId = await dev.running();
    await dev.call("simulator_elements", { simulatorId });
    dev.show(redraw((els) => { els[1]!.value = "On"; els[1]!.enabled = true; return els; }));
    // THE MUTANT: compare the value too. Every toggle would be refused the second time it is touched.
    expect((await dev.call("simulator_tap", { simulatorId, intent: "turn Wi-Fi off", element: 2 })).isError).toBe(false);
    expect(dev.calls.sent).toHaveLength(1);
  });

  it("refuses an id this session was never shown, before any card", async () => {
    const dev = device();
    const simulatorId = await dev.running();
    // Never read at all: a path from a transcript, a guess, another session's read.
    const unread = await dev.call("simulator_tap", { simulatorId, intent: "open General", element: 1 });
    expect(text(unread)).toContain("read simulator_elements for iPhone Air first");
    // Read, but not this one.
    await dev.call("simulator_elements", { simulatorId });
    const unseen = await dev.call("simulator_tap", { simulatorId, intent: "open it", element: 9 });
    expect(text(unseen)).toContain("there is no [9]");
    // Another session's read means nothing to this one.
    const theirs = await dev.provider.call({ ...dev.ctx, sessionId: "sess2" }, "simulator_tap", { simulatorId, intent: "open General", element: 1 });
    expect(theirs.isError).toBe(true);
    expect(dev.calls.gates).toEqual([]);
    expect(dev.calls.sent).toEqual([]);
  });

  it("forgets the oldest lists rather than every session's last list for the life of the server", async () => {
    const dev = device();
    const simulatorId = await dev.running();
    await dev.call("simulator_elements", { simulatorId });
    for (let i = 0; i < 256; i++) await dev.provider.call({ ...dev.ctx, sessionId: `other-${i}` }, "simulator_elements", { simulatorId });
    // THE MUTANT: never evict. A server that stays up for weeks keeps every list every session read.
    expect(text(await dev.call("simulator_tap", { simulatorId, intent: "open General", element: 1 }))).toContain("read simulator_elements for iPhone Air first");
  });

  it("takes the number as the list prints it, brackets and all, and nothing that is not one", async () => {
    const dev = device();
    const simulatorId = await dev.running();
    await dev.call("simulator_elements", { simulatorId });
    expect((await dev.call("simulator_tap", { simulatorId, intent: "open General", element: "[1]" })).isError).toBe(false);
    expect((await dev.call("simulator_tap", { simulatorId, intent: "open General", element: "1" })).isError).toBe(false);
    const path = await dev.call("simulator_tap", { simulatorId, intent: "open General", element: "0.1" });
    expect(text(path)).toContain("an element is its [number] from simulator_elements");
    expect(dev.calls.sent).toHaveLength(2);
  });

  it("refuses a number from an earlier list as old, rather than as whatever the latest list has there", async () => {
    /* MEASURED on a real device, with tree paths as the handle: a path from the list before last named
       a different element in the latest one — the same position in another screen's tree — and the
       tap landed on that. Numbers are never reused, so an old one is recognisably old. */
    const dev = device();
    const simulatorId = await dev.running();
    await dev.call("simulator_elements", { simulatorId });
    const again = text(await dev.call("simulator_elements", { simulatorId }));
    // The same two rows, numbered on from the first list: nothing it said is reused.
    expect(again).toContain('[3] Button "General"');
    expect(again).toContain('[4] Button "Wi-Fi"');
    const old = await dev.call("simulator_tap", { simulatorId, intent: "open General", element: 1 });
    expect(old.isError).toBe(true);
    expect(text(old)).toContain("[1] is from an earlier simulator_elements of iPhone Air, and only the latest list can be acted on — its numbers start at 3.");
    expect(dev.calls.sent).toEqual([]);
    expect((await dev.call("simulator_tap", { simulatorId, intent: "open General", element: 3 })).isError).toBe(false);
    expect(frames(dev.calls.sent)[0]!.y).toBeCloseTo((293.3 + 22) / 874, 10);
  });

  it("refuses an element whose centre is off the screen rather than touching the edge instead", async () => {
    const dev = device();
    const simulatorId = await dev.running();
    await dev.call("simulator_elements", { simulatorId });
    dev.show(redraw((els) => { els[0]!.frame.y = 860; return els; }));
    const r = await dev.call("simulator_tap", { simulatorId, intent: "open General", element: 1 });
    // THE MUTANT: send it anyway. The frame clamps to the screen's edge — the home indicator.
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("off the screen");
    expect(dev.calls.sent).toEqual([]);
  });

  it("asks again, briefly, when the device says its tree is not ready — the moment right after a step", async () => {
    // MEASURED live: the read straight after a tap that pushed Settings ▸ General answered "not yet".
    let notYet = 0, asked = 0;
    const dev = setup({ serveSim: { ax: async () => { asked++; return notYet-- > 0 ? null : TREE; } } });
    const simulatorId = await dev.running();
    await dev.call("simulator_elements", { simulatorId });
    notYet = 1; asked = 0;
    const r = await dev.call("simulator_tap", { simulatorId, intent: "open General", element: 1 });
    // THE MUTANT: one read and done. The tap fails on a screen that was a beat from ready.
    expect(r.isError).toBe(false);
    expect(asked).toBe(2);
    expect(dev.calls.sent).toHaveLength(1);

    // …but only briefly, and with the device's own words when it never comes.
    notYet = 99; asked = 0;
    const never = await dev.call("simulator_tap", { simulatorId, intent: "open General", element: 1 });
    expect(text(never)).toContain("has not published its accessibility tree yet");
    expect(asked).toBe(3);
    expect(dev.calls.sent).toHaveLength(1);
  });

  it("does not ask again when the read failed for any other reason", async () => {
    let asked = 0, broken = false;
    const dev = setup({ serveSim: { ax: async () => { asked++; if (broken) throw new Error("socket hang up"); return TREE; } } });
    const simulatorId = await dev.running();
    await dev.call("simulator_elements", { simulatorId });
    broken = true; asked = 0;
    const r = await dev.call("simulator_tap", { simulatorId, intent: "open General", element: 1 });
    // THE MUTANT: retry everything. An answer that will not change costs every step the retry budget.
    expect(text(r)).toContain("socket hang up");
    expect(asked).toBe(1);
  });

  it("looks for the element on the screen as it is once the card is answered — a card can wait minutes", async () => {
    let meanwhile = () => {};
    const dev = device({ onCard: () => meanwhile() });
    const simulatorId = await dev.running();
    await dev.call("simulator_elements", { simulatorId });
    // While the card is up, the list scrolls: the same row, lower down.
    meanwhile = () => dev.show(redraw((els) => { els[0]!.frame.y = 500; return els; }));
    const before = dev.treeReads();
    await dev.call("simulator_tap", { simulatorId, intent: "open General", element: 1 });
    /* THE MUTANT: read the screen, then raise the card. The tap lands where General was before the
       scroll — on whatever scrolled into its place. */
    expect(frames(dev.calls.sent)[0]!.y).toBeCloseTo(522 / 874, 10);
    expect(dev.treeReads()).toBe(before + 1); // one look, the one that counts
  });
});

describe("acting on a point", () => {
  it("takes points on iOS and sends the device 0..1 of the screen the live tree states", async () => {
    const dev = device();
    const simulatorId = await dev.running();
    const r = await dev.call("simulator_tap", { simulatorId, intent: "tap the middle", x: 201, y: 437 });
    expect(r.isError).toBe(false);
    // THE MUTANT: divide by the stream's size in PIXELS (1206×2622). The tap lands a third of the way.
    expect(frames(dev.calls.sent).map((f) => [f.type, f.x, f.y])).toEqual([["begin", 0.5, 0.5], ["end", 0.5, 0.5]]);
    expect(text(r)).toContain("Tapped (201,437) on iPhone Air.");
  });

  it("refuses a point off the screen, with the screen's size to aim by", async () => {
    const dev = device();
    const simulatorId = await dev.running();
    for (const [x, y] of [[402, 10], [10, 874], [-1, 10]]) {
      const r = await dev.call("simulator_tap", { simulatorId, intent: "tap", x, y });
      expect(r.isError, `${x},${y}`).toBe(true);
      expect(text(r)).toContain("402×874 points");
    }
    expect(dev.calls.sent).toEqual([]);
  });
});

describe("each input tool", () => {
  const ready = async (over: Parameters<typeof setup>[0] = {}) => {
    const dev = device(over);
    const simulatorId = await dev.running();
    await dev.call("simulator_elements", { simulatorId });
    return { ...dev, simulatorId };
  };

  it("double-taps as two taps at one point", async () => {
    const { call, calls, simulatorId } = await ready();
    await call("simulator_double_tap", { simulatorId, intent: "zoom in", x: 201, y: 437 });
    expect(frames(calls.sent).map((f) => f.type)).toEqual(["begin", "end", "begin", "end"]);
  });

  it("long-presses for the duration asked, a second when not told", async () => {
    const { call, calls, simulatorId } = await ready();
    await call("simulator_long_press", { simulatorId, intent: "open the menu", element: 1, durationMs: 1500 });
    await call("simulator_long_press", { simulatorId, intent: "open the menu", element: 1 });
    expect(calls.sent.map((x) => x.steps[0]!.waitMs)).toEqual([1500, 1000]);
  });

  it("swipes a direction across the middle of the screen without reading the tree", async () => {
    const { call, calls, simulatorId, treeReads } = await ready();
    const before = treeReads();
    const r = await call("simulator_swipe", { simulatorId, intent: "scroll down the list", direction: "up" });
    const sent = frames(calls.sent);
    expect(sent[0]).toMatchObject({ type: "begin", x: 0.5, y: 0.75 });
    expect(sent.at(-1)).toMatchObject({ type: "end", x: 0.5, y: 0.25 });
    expect(treeReads()).toBe(before);
    expect(text(r)).toContain("Swiped up across the screen of iPhone Air in 300 ms.");
  });

  it("swipes a direction across one element, found live, the way the finger moves", async () => {
    const { call, calls, simulatorId } = await ready();
    await call("simulator_swipe", { simulatorId, intent: "show the row's actions", direction: "left", element: 1 });
    const sent = frames(calls.sent);
    // General is (16,293.3 370×44): from three quarters of the way across to a quarter, through its middle.
    expect(sent[0]!.x).toBeCloseTo((16 + 370 * 0.75) / 402, 10);
    expect(sent.at(-1)!.x).toBeCloseTo((16 + 370 * 0.25) / 402, 10);
    expect(sent[0]!.y).toBeCloseTo((293.3 + 22) / 874, 10);
  });

  it("swipes from one point to another, and holds first when asked", async () => {
    const { call, calls, simulatorId } = await ready();
    const r = await call("simulator_swipe", { simulatorId, intent: "move the row", from: { x: 201, y: 700 }, to: { x: 201, y: 175 }, durationMs: 800, holdMs: 600 });
    const sent = frames(calls.sent);
    expect(sent[0]).toMatchObject({ type: "begin", x: 0.5 });
    expect(sent[0]!.y).toBeCloseTo(700 / 874, 10);
    expect(sent.at(-1)!.y).toBeCloseTo(175 / 874, 10);
    expect(calls.sent[0]!.steps[0]!.waitMs).toBeGreaterThanOrEqual(600);
    expect(text(r)).toContain("from (201,700) to (201,175)");
    expect(text(r)).toContain("after holding still for 600 ms");
    // A point off the screen is refused like a tap's.
    expect((await call("simulator_swipe", { simulatorId, intent: "x", from: { x: 10, y: 10 }, to: { x: 10, y: 900 } })).isError).toBe(true);
  });

  it("types into whatever has focus, and refuses what it cannot type before any card", async () => {
    const { call, calls, simulatorId } = await ready();
    const r = await call("simulator_type", { simulatorId, intent: "search for Wallpaper", text: "Wi\n" });
    expect(frames(calls.sent).filter((f) => f.type === "down").map((f) => f.usage)).toEqual([225, 26, 12, 40]);
    expect(text(r)).toContain("Typed 3 character(s) on iPhone Air");
    calls.gates.length = 0;
    const refused = await call("simulator_type", { simulatorId, intent: "type a name", text: "José" });
    expect(text(refused)).toContain('"é"');
    expect(calls.gates).toEqual([]);
    expect(calls.sent).toHaveLength(1);
  });

  it("presses buttons and keys, and refuses back on iOS before any card", async () => {
    const { call, calls, simulatorId } = await ready();
    await call("simulator_press", { simulatorId, intent: "go home", key: "home" });
    await call("simulator_press", { simulatorId, intent: "lock it", key: "lock" });
    expect(frames(calls.sent)).toEqual([{ op: 4, button: "home" }, { op: 4, button: "power", page: 12, usage: 48 }]);
    calls.gates.length = 0;
    const back = await call("simulator_press", { simulatorId, intent: "go back", key: "back" });
    expect(text(back)).toContain("iOS has no back button");
    expect(calls.gates).toEqual([]);
    expect(calls.sent).toHaveLength(2);
  });

  it("says what the device said when a step does not reach it", async () => {
    const { call, simulatorId } = await ready({ input: { ok: false, detail: "connect ECONNREFUSED 127.0.0.1:3100" } });
    const r = await call("simulator_tap", { simulatorId, intent: "tap", x: 10, y: 10 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("that did not reach iPhone Air: connect ECONNREFUSED");
  });
});

describe("the input card", () => {
  it("names the device and the whole session, and carries the step's intent", async () => {
    const { call, calls, running } = setup();
    const simulatorId = await running();
    await call("simulator_tap", { simulatorId, intent: "open the Wi-Fi settings", x: 201, y: 437 });
    const [card] = calls.gates;
    expect(card).toMatchObject({
      toolKey: "simulator_input:UDID-UP", toolName: "simulator_tap",
      title: "Tap, swipe and type on iPhone Air for the rest of this session",
      input: { intent: "open the Wi-Fi settings", device: "iPhone Air", x: 201, y: 437 },
      opts: { perSession: true, promptUnderBypass: false },
    });
  });

  it("is asked ONCE per device per session, whichever tool asks — and again for another device or session", async () => {
    const dev = setup({ broker: { mode: "default", answer: "allow" } });
    const up = await dev.running();
    for (const [tool, args] of ONE_OF_EACH) {
      expect((await dev.call(tool, { simulatorId: up, intent: "use it", ...args })).isError, tool).toBe(false);
    }
    /* THE MUTANTS: key the card per tool (one per tool), drop `perSession` (a plain Allow is not kept,
       so one per step), or key it per session alone (one device's Allow drives every device). */
    expect(dev.calls.gates).toHaveLength(1);
    const other = await dev.running(dev.spaceId, "UDID-OFF");
    await dev.call("simulator_tap", { simulatorId: other, intent: "use it", x: 10, y: 10 });
    expect(dev.calls.gates).toHaveLength(2);
    await dev.provider.call({ ...dev.ctx, sessionId: "sess2" }, "simulator_tap", { simulatorId: up, intent: "use it", x: 10, y: 10 });
    expect(dev.calls.gates).toHaveLength(3);
    expect(dev.calls.sent).toHaveLength(ONE_OF_EACH.length + 2);
  });

  it("a denial sends nothing, and asks again next time", async () => {
    const dev = setup({ broker: { mode: "default", answer: "deny" } });
    const simulatorId = await dev.running();
    const r = await dev.call("simulator_tap", { simulatorId, intent: "tap", x: 10, y: 10 });
    expect(text(r)).toContain("denied");
    await dev.call("simulator_tap", { simulatorId, intent: "tap", x: 10, y: 10 });
    expect(dev.calls.gates).toHaveLength(2);
    expect(dev.calls.sent).toEqual([]);
  });

  it("Plan and Ask refuse every input step, and send nothing", async () => {
    for (const mode of ["plan", "ask"]) {
      const observed: ActObservation[] = [];
      const dev = setup({ broker: { mode }, observe: (o) => { observed.push(o); } });
      const simulatorId = await dev.running();
      for (const [tool, args] of ONE_OF_EACH) {
        const r = await dev.call(tool, { simulatorId, intent: "use it", ...args });
        // THE MUTANT: let the input tools skip the gate, as the read-only tools do.
        expect(r.isError, `${mode} ${tool}`).toBe(true);
        expect(text(r)).toContain("read-only");
      }
      expect(dev.calls.sent, mode).toEqual([]);
      expect(observed, mode).toEqual([]);
    }
  });

  it("stops at Plan the moment the session switches, whatever it allowed before", async () => {
    const dev = setup({ broker: { mode: "default" } });
    const simulatorId = await dev.running();
    await dev.call("simulator_tap", { simulatorId, intent: "tap", x: 10, y: 10 });
    dev.setMode("plan");
    expect((await dev.call("simulator_tap", { simulatorId, intent: "tap", x: 10, y: 10 })).isError).toBe(true);
    expect(dev.calls.sent).toHaveLength(1);
  });
});

describe("the observer", () => {
  it("hears each step after its card and before it acts, with what was read and what was chosen", async () => {
    const heard: ActObservation[] = [];
    const dev = device({ observe: (o) => { dev.calls.order.push("observe"); heard.push(o); } });
    const simulatorId = await dev.running();
    await dev.call("simulator_elements", { simulatorId });
    dev.calls.order.length = 0;
    await dev.call("simulator_tap", { simulatorId, intent: "open General", element: 1 });
    // THE MUTANT: observe before the card (a denied step is reported as taken), or after the act.
    expect(dev.calls.order).toEqual(["card", "observe", "act"]);
    const general = { id: "0.1", role: "Button", label: "General" };
    const wifi = { id: "0.2", role: "Button", label: "Wi-Fi", value: "Off" };
    expect(heard).toEqual([{
      surface: "simulator", spaceId: dev.spaceId, sessionId: "sess1", tool: "simulator_tap", intent: "open General",
      elements: [general, wifi], chosen: { element: general },
    }]);
  });

  it("is told a point as a point, and a step that touches nothing as nothing", async () => {
    const heard: ActObservation[] = [];
    const dev = device({ observe: (o) => { heard.push(o); } });
    const simulatorId = await dev.running();
    await dev.call("simulator_tap", { simulatorId, intent: "tap the middle", x: 201, y: 437 });
    await dev.call("simulator_elements", { simulatorId });
    await dev.call("simulator_type", { simulatorId, intent: "search", text: "wifi" });
    await dev.call("simulator_swipe", { simulatorId, intent: "scroll", direction: "up" });
    expect(heard.map((o) => [o.tool, o.chosen])).toEqual([
      ["simulator_tap", { point: { x: 201, y: 437 } }], ["simulator_type", null], ["simulator_swipe", null],
    ]);
    // A step that reads no tree of its own is told the one the agent last read, which is what it chose from.
    expect(heard[1]!.elements.map((e) => e.id)).toEqual(["0.1", "0.2"]);
  });

  it("gets the screen as the step left it from the next read, once", async () => {
    const afters: string[][] = [];
    const dev = device({ observe: () => (after) => { afters.push(after.map((e) => e.label)); } });
    const simulatorId = await dev.running();
    await dev.call("simulator_tap", { simulatorId, intent: "open Wi-Fi", x: 201, y: 350 });
    expect(afters).toEqual([]); // nothing reads the screen just to feed it
    dev.show({ ...TREE, elements: [{ ...TREE.elements[1]!, path: "0.0", label: "Wi-Fi", role: "Heading" }] });
    await dev.call("simulator_elements", { simulatorId });
    await dev.call("simulator_elements", { simulatorId });
    expect(afters).toEqual([["Wi-Fi"]]);
  });

  it("hands a step its after once, even when the read that did it belonged to a step that went nowhere", async () => {
    const afters: string[][] = [];
    const dev = device({ observe: () => (after) => { afters.push(after.map((e) => e.label)); } });
    const simulatorId = await dev.running();
    await dev.call("simulator_elements", { simulatorId });
    await dev.call("simulator_tap", { simulatorId, intent: "tap", x: 10, y: 10 }); // step A, owed a screen
    dev.show(redraw((els) => { els[0]!.label = "Bluetooth"; return els; }));
    // Its live read settles A, then it is refused as stale: no step, nothing owed.
    expect((await dev.call("simulator_tap", { simulatorId, intent: "open General", element: 1 })).isError).toBe(true);
    await dev.call("simulator_tap", { simulatorId, intent: "tap", x: 10, y: 10 });
    // THE MUTANT: keep the function once it is called. A is told a second, later screen as its after.
    expect(afters).toEqual([["Bluetooth", "Wi-Fi"]]);
  });

  it("never holds the step up, and one that throws — or rejects — changes nothing", async () => {
    const observers: [string, ActObserver][] = [
      ["waits forever", () => (new Promise(() => {}) as unknown as void)],
      ["throws", () => { throw new Error("observer broke"); }],
      ["rejects", () => (Promise.reject(new Error("observer broke later")) as unknown as void)],
      ["hands back one that throws", () => () => { throw new Error("after broke"); }],
    ];
    for (const [what, observe] of observers) {
      const dev = device({ observe });
      const simulatorId = await dev.running();
      const r = await Promise.race([
        dev.call("simulator_tap", { simulatorId, intent: "tap", x: 10, y: 10 }),
        new Promise<"held">((res) => setTimeout(() => res("held"), 1_000)),
      ]);
      // THE MUTANT: await what the observer returns. The first one holds the tap forever.
      expect(r, what).not.toBe("held");
      expect((r as CallToolResult).isError, what).toBe(false);
      expect(dev.calls.sent, what).toHaveLength(1);
      // …and the read that settles it still answers.
      expect((await dev.call("simulator_elements", { simulatorId })).isError, what).toBe(false);
    }
  });

  it("is not told about a step that never happened", async () => {
    const heard: ActObservation[] = [];
    const dev = device({ gate: { allowed: false, reason: "the user denied this action" }, observe: (o) => { heard.push(o); } });
    const simulatorId = await dev.running();
    await dev.call("simulator_tap", { simulatorId, intent: "tap", x: 10, y: 10 });
    await dev.call("simulator_type", { simulatorId, intent: "type", text: "José" });
    expect(heard).toEqual([]);
  });
});

describe("input on Android", () => {
  const AVD = "Realm_Pixel";
  const DROID_TREE: SimulatorAxTree = {
    screen: { width: 1080, height: 2400 }, units: "pixels", app: "com.android.settings",
    elements: [{ path: "0.0", label: "Network & internet", value: "", role: "android.widget.TextView", id: null, enabled: true, frame: { x: 100, y: 200, width: 300, height: 100 }, depth: 1 }],
  };

  async function droid(serial = "emulator-5554", over: Parameters<typeof setup>[0] = {}) {
    const adb: string[] = [];
    let trees = 0;
    const dev = setup({
      ...over,
      android: {
        available: async () => true,
        devices: async () => [{ udid: AVD, platform: "android", name: "Realm Pixel", runtime: "Android 16", state: "device", serial, physical: false }],
        serialFor: async () => serial, waitForBoot: async () => true,
        size: async () => ({ width: 1080, height: 2400 }),
        ax: async () => { trees++; return DROID_TREE; },
        tap: async (_s, x, y, times) => { adb.push(`tap ${x},${y}×${times ?? 1}`); return { ok: true, detail: "" }; },
        swipe: async (_s, a, b, c, d, ms) => { adb.push(`swipe ${a},${b}->${c},${d} ${ms}`); return { ok: true, detail: "" }; },
        key: async (_s, k) => { adb.push(`key ${k}`); return { ok: true, detail: "" }; },
        text: async (_s, t) => { adb.push(`text ${t}`); return { ok: true, detail: "" }; },
      },
    });
    const { simulatorId } = dev.service.create({ spaceId: dev.spaceId, name: "Realm Pixel", udid: AVD });
    dev.service.start(simulatorId, AVD, "android");
    for (let i = 0; i < 400 && dev.service.stateOf(simulatorId).status !== "running"; i++) await new Promise((r) => setTimeout(r, 5));
    return { ...dev, simulatorId, adb, trees: () => trees };
  }

  it("taps an element at the pixel the tree put its centre on", async () => {
    const { call, simulatorId, adb } = await droid();
    await call("simulator_elements", { simulatorId });
    await call("simulator_tap", { simulatorId, intent: "open network settings", element: 1 });
    expect(adb).toEqual(["tap 250,250×1"]);
  });

  it("takes a point in pixels, and spends no tree dump on one", async () => {
    // A uiautomator dump costs seconds; a point on Android is already what adb takes.
    const { call, simulatorId, adb, trees } = await droid();
    await call("simulator_tap", { simulatorId, intent: "tap", x: 540, y: 1200 });
    await call("simulator_long_press", { simulatorId, intent: "hold", x: 540, y: 1200, durationMs: 800 });
    expect(adb).toEqual(["tap 540,1200×1", "swipe 540,1200->540,1200 800"]);
    expect(trees()).toBe(0);
    expect(text(await call("simulator_tap", { simulatorId, intent: "tap", x: 1080, y: 5 }))).toContain("1080×2400 pixels");
  });

  it("presses back, which Android has", async () => {
    const { call, simulatorId, adb } = await droid();
    expect((await call("simulator_press", { simulatorId, intent: "go back", key: "back" })).isError).toBe(false);
    expect(adb).toEqual(["key KEYCODE_BACK"]);
  });

  it("skips the card under bypassPermissions for an emulator, and asks for a phone on a cable", async () => {
    const emulator = await droid("emulator-5554", { broker: { mode: "bypassPermissions" } });
    await emulator.call("simulator_tap", { simulatorId: emulator.simulatorId, intent: "tap", x: 10, y: 10 });
    // THE MUTANT: prompt under bypass for every device — a bypass run testing an app stalls at its first tap.
    expect(emulator.calls.gates).toEqual([]);

    const phone = await droid("R5CT30XXXXX", { broker: { mode: "bypassPermissions" } });
    await phone.call("simulator_tap", { simulatorId: phone.simulatorId, intent: "tap", x: 10, y: 10 });
    await phone.call("simulator_tap", { simulatorId: phone.simulatorId, intent: "tap", x: 10, y: 10 });
    // THE MUTANT: bypass for the phone too. Somebody's own phone is driven with no card at all.
    expect(phone.calls.gates).toHaveLength(1);
    expect(phone.calls.gates[0]!.title).toBe("Tap, swipe and type on Realm Pixel, a physical phone, for the rest of this session");
    expect(phone.adb).toHaveLength(2);
  });
});

describe("an iOS simulator under bypassPermissions", () => {
  it("is driven without a card, as every other simulator tool is", async () => {
    const dev = setup({ broker: { mode: "bypassPermissions" } });
    const simulatorId = await dev.running();
    await dev.call("simulator_tap", { simulatorId, intent: "tap", x: 10, y: 10 });
    expect(dev.calls.gates).toEqual([]);
    expect(dev.calls.sent).toHaveLength(1);
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
  /** `toolchain` is what the injected probe answers — or "unprobed", for an app given no probe. */
  async function boot(toolchain: "installed" | "missing" | "unprobed" = "installed", serveSim?: Partial<ServeSim>) {
    const home = tempDir("realm-sim-gw-");
    vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
    const clis = fakeClis({ serveSim });
    app = await createApp({
      home, port: 0, simulator: { simctl: clis.simctl, serveSim: clis.serveSim, android: clis.android },
      ...(toolchain === "unprobed" ? {} : { simulatorToolchain: async () => toolchain === "installed" }),
    });
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
    expect(names).toContain("realm-simulator__simulator_tap");
    expect(names).toHaveLength(15);
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
    const { client } = await boot("installed", {
      claims: async () => [{ device: "UDID-UP", port: 3100 }],
      find: async (udid) => (udid === "UDID-UP" ? STREAM("UDID-UP") : NOTHING),
    });
    const r = (await client.callTool({ name: "realm-browser__browser_open", arguments: { url: "http://127.0.0.1:3100/" } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('simulator_open with udid "UDID-UP"');
    await client.close();
  });

  it("lists nothing on a Mac with no simulators, where the switch alone would have said yes", async () => {
    const { client } = await boot("missing");
    expect((await client.listTools()).tools.some((t) => t.name.startsWith(`${SIMULATOR_PROVIDER_NAME}__`))).toBe(false);
    await client.close();
  });

  it("tells the settings row what the probe said, beside what the space asked for", async () => {
    const provider = async (toolchain: "installed" | "missing" | "unprobed") => {
      const { client, spaceId } = await boot(toolchain);
      await client.close();
      const { result } = await rpcCall(app!.port, "mcp.providers.list", { spaceId }) as { result: { providers: { name: string }[] } };
      await app!.close(); app = null;
      return result.providers.find((p) => p.name === SIMULATOR_PROVIDER_NAME);
    };
    // The space's switch is on in all three; only the Mac differs.
    expect(await provider("installed")).toEqual({ name: SIMULATOR_PROVIDER_NAME, enabled: true, offered: true, needs: "Xcode or Android Studio" });
    expect(await provider("missing")).toEqual({ name: SIMULATOR_PROVIDER_NAME, enabled: true, offered: false, needs: "Xcode or Android Studio" });
    // No probe: not known — neither the yes a bare switch would imply nor a no nobody measured.
    expect(await provider("unprobed")).toEqual({ name: SIMULATOR_PROVIDER_NAME, enabled: true, offered: null, needs: "Xcode or Android Studio" });
  });
});

describe("createApp's toolchain probe", () => {
  /**
   * The probe in a suite, measured at the process: `REALM_XCRUN_BIN` pointed at a script that writes
   * down every call made to it. A mock of `execFile` would prove less — this is the spawn itself.
   */
  function recordingXcrun() {
    const dir = tempDir("realm-sim-xcrun-");
    const log = join(dir, "calls.log");
    const bin = join(dir, "xcrun");
    writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`);
    chmodSync(bin, 0o755);
    vi.stubEnv("REALM_XCRUN_BIN", bin);
    return { log, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
  }

  async function bootAndUse(simulatorToolchain?: () => Promise<boolean>) {
    const home = tempDir("realm-sim-probe-");
    vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
    app = await createApp({ home, port: 0, ...(simulatorToolchain ? { simulatorToolchain } : {}) });
    // Everything that asks the provider whether there are simulators: a session listing its tools,
    // and the gateway composing what a session is told.
    const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
    const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "S", icon: "folder" });
    const { session } = app.sessions.create({ spaceId: space.id, agentKind: "claude", projectId: null, model: null, effort: null, permissionMode: "default" });
    const cfg = app.gateway.register(session.id, space.id) as Extract<McpServerConfig, { url: string }>;
    const client = new Client({ name: "t", version: "1.0.0" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
    // No sleep, and none is needed: `tools/list` awaits every provider's `tools()`, which awaits the
    // simulator provider's own probe — so a probe that ran has exited, and written its line, by now.
    const tools = (await client.listTools()).tools.map((t) => t.name);
    app.gateway.realmProvidersFor(session.id, space.id);
    await client.close();
    return tools;
  }

  it("spawns nothing when it is not given one — the suite's case", async () => {
    const xcrun = recordingXcrun();
    const tools = await bootAndUse();
    // THE MUTANT: default the probe to the real one. Every `createApp` in the suite then runs
    // `xcrun simctl help` in the background, 68 of them a run, and lists or hides the tools by
    // whatever Xcode the machine running the tests has.
    expect(xcrun.calls()).toEqual([]);
    expect(tools.some((n) => n.startsWith(`${SIMULATOR_PROVIDER_NAME}__`))).toBe(false);
  });

  it("tells connected sessions and the settings row when its answer arrives", async () => {
    // A probe the test answers by hand, so "later" is a moment the test chooses.
    let answer: (v: boolean) => void = () => {};
    const home = tempDir("realm-sim-late-");
    vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
    app = await createApp({ home, port: 0, simulatorToolchain: () => new Promise<boolean>((r) => { answer = r; }) });
    const relisted = vi.spyOn(app.gateway, "notifyToolsChanged");
    const events: string[] = [];
    const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${app!.port}`); w.once("open", () => res(w)); w.once("error", rej); });
    ws.on("message", (raw) => { const m = JSON.parse(raw.toString()) as { event?: string }; if (m.event) events.push(m.event); });
    answer(true);
    // THE MUTANT: build the provider without `onOfferedChange` (or with one that does nothing). The
    // answer lands, and every session keeps the tool list it started with — and an open settings row
    // keeps saying "Checking…" — until something else happens to make them look again.
    await vi.waitFor(() => expect(events).toContain("mcp.changed"));
    expect(relisted).toHaveBeenCalled();
    ws.close();
  });

  it("asks xcrun when it is handed the production probe — so the silence above is not a blind test", async () => {
    const xcrun = recordingXcrun();
    await bootAndUse(() => toolchainAvailable());
    expect(xcrun.calls()).toContain("simctl help");
  });
});

describe("a target in words (Laya's Assist)", () => {
  const OPEN = { available: true, reason: null, threshold: 0.8, accuracy: 0.97 } as const;
  const SHUT = { available: false, reason: "The active checkpoint picks the right element 79% of the time on held-out steps. Assist needs 95%.", threshold: null, accuracy: 0.79 };
  const scripted = (gate: typeof OPEN | typeof SHUT, outcome: (els: readonly import("../mcp/act-observer").ObservedElement[]) => AssistOutcome) => {
    const asked: { description: string; intent: string; ids: string[] }[] = [];
    const assist: LayaAssist = {
      gate: () => gate,
      resolve: async (description, intent, elements) => { asked.push({ description, intent, ids: elements.map((e) => e.id) }); return outcome(elements); },
    };
    return { assist, asked };
  };

  it("lists a target in words on the tap-shaped tools only while Assist can act on one", async () => {
    const on = setup({ assist: scripted(OPEN, () => ({ kind: "ask-agent", candidates: [], best: null, why: "no-answer" })).assist });
    const off = setup({ assist: scripted(SHUT, () => ({ kind: "ask-agent", candidates: [], best: null, why: "no-answer" })).assist });
    const props = async (s: ReturnType<typeof setup>, name: string) =>
      Object.keys(((await s.provider.tools(s.ctx)).find((t) => t.name === name)!.inputSchema as { properties: Record<string, unknown> }).properties);
    for (const name of ["simulator_tap", "simulator_double_tap", "simulator_long_press"]) {
      expect(await props(on, name), name).toContain("target");
      // THE MUTANT: list it always. Every use of the field is then a refusal.
      expect(await props(off, name), name).not.toContain("target");
    }
    expect(await props(on, "simulator_swipe")).not.toContain("target");
  });

  it("refuses a target in words while Assist is shut — before any card, saying what to do instead", async () => {
    const { assist } = scripted(SHUT, () => { throw new Error("never asked"); });
    const dev = device({ assist });
    const simulatorId = await dev.running();
    const r = await dev.call("simulator_tap", { simulatorId, intent: "open General", target: "the general row" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("needs Laya's Assist, which is not on here (The active checkpoint picks the right element 79%");
    expect(text(r)).toContain("pass the element's [number]");
    expect(dev.calls.gates).toEqual([]);
    expect(dev.calls.sent).toEqual([]);
  });

  it("taps Laya's pick on the LIVE screen after the card, says so, and tells the shadow Laya chose it", async () => {
    const observed: ActObservation[] = [];
    const { assist, asked } = scripted(OPEN, (els) => ({ kind: "pick", element: els.find((e) => e.id === "0.1")!, confidence: 0.93, ms: 12 }));
    const dev = device({ assist, observe: (o) => { observed.push(o); } });
    const simulatorId = await dev.running();
    const r = await dev.call("simulator_tap", { simulatorId, intent: "open General", target: "the general settings" });
    expect(r.isError).toBe(false);
    expect(asked).toEqual([{ description: "the general settings", intent: "open General", ids: ["0.1", "0.2"] }]);
    // The card first, then the act — the order every input step keeps.
    expect(dev.calls.order).toEqual(["card", "act"]);
    const [begin] = frames(dev.calls.sent);
    expect(begin).toMatchObject({ op: 3, type: "begin", x: 201 / 402 });
    expect(begin!.y).toBeCloseTo(315.3 / 874, 10);
    expect(text(r)).toMatch(/Tapped \[\d+\] "General" on iPhone Air — Laya's pick for "the general settings" \(0\.93; Assist acts at 0\.80 or above\)/);
    // THE MUTANT: report it as the agent's choice. The shadow would then train Laya on its own answers.
    expect(observed[0]).toMatchObject({ tool: "simulator_tap", chosenBy: "laya", chosen: { element: { id: "0.1", label: "General" } } });
  });

  it("sends nothing when Laya is unsure, and hands back numbers the agent's next tap can use", async () => {
    const { assist } = scripted(OPEN, (els) => ({ kind: "ask-agent", why: "unsure", candidates: [...els], best: { element: els[1]!, confidence: 0.61 } }));
    const dev = device({ assist });
    const simulatorId = await dev.running();
    const r = await dev.call("simulator_tap", { simulatorId, intent: "turn Wi-Fi off", target: "the wireless row" });
    expect(r.isError).toBe(true);
    expect(dev.calls.sent).toEqual([]);
    expect(text(r)).toContain('nothing was tapped: Laya was not sure which element "the wireless row" means');
    expect(text(r)).toContain("scored 0.61, and Assist acts only at 0.80 or above");
    const wifi = /\[(\d+)\] "Wi-Fi"/.exec(text(r));
    expect(wifi).not.toBeNull();
    // Those numbers are the agent's latest list: tapping one by number works with no read in between.
    const again = await dev.call("simulator_tap", { simulatorId, intent: "turn Wi-Fi off", element: Number(wifi![1]) });
    expect(again.isError).toBe(false);
  });

  it("sends nothing on a step the sensitive rule flags, and says Laya never chooses those", async () => {
    const { assist } = scripted(OPEN, (els) => ({ kind: "ask-agent", why: "sensitive", matched: "delete", candidates: [...els], best: { element: els[0]!, confidence: 0.99 } }));
    const dev = device({ assist });
    const simulatorId = await dev.running();
    const r = await dev.call("simulator_tap", { simulatorId, intent: "delete the account", target: "the delete button" });
    expect(r.isError).toBe(true);
    expect(dev.calls.sent).toEqual([]);
    expect(text(r)).toContain('looks like a step Laya never chooses on its own (it reads as "delete")');
    expect(text(r)).toContain("If that is the step you mean, tap it by its [number].");
  });

  it("takes one target — an element, a point, or words — never two", async () => {
    const { assist } = scripted(OPEN, () => { throw new Error("never asked"); });
    const dev = device({ assist });
    const simulatorId = await dev.running();
    for (const extra of [{ element: 1 }, { x: 10, y: 10 }]) {
      const r = await dev.call("simulator_tap", { simulatorId, intent: "open General", target: "general", ...extra });
      expect(r.isError, JSON.stringify(extra)).toBe(true);
      expect(text(r)).toContain("give exactly one of");
    }
    expect(dev.calls.sent).toEqual([]);
  });
});

/* ---------------------------------- walks ---------------------------------- */

type WalkRow = { label: string; to?: string; role?: string };
const ROWS_AT = 120, ROW_STEP = 52, WALK_SCREEN = { width: 402, height: 874 };

/**
 * A device a walk can drive: screens of rows, and a tap — decoded off the frames its socket was sent
 * — that opens whatever the row under it leads to. A swipe moves nothing here, so a label that is not
 * on a screen is not anywhere on it.
 */
function walkable(screens: Record<string, WalkRow[]>, start: string, over: Parameters<typeof setup>[0] = {}) {
  let current = start;
  const tree = (): SimulatorAxTree => ({
    screen: WALK_SCREEN, units: "points", app: "Settings",
    elements: screens[current]!.map((r, i) => ({ path: `0.${i}`, label: r.label, value: "", role: r.role ?? "Button", id: null, enabled: true, frame: { x: 16, y: ROWS_AT + ROW_STEP * i, width: 370, height: 44 }, depth: 1 })),
  });
  const onInput = (steps: readonly InputStep[]) => {
    const f = steps.map((st) => decode(st.frame));
    const begin = f.find((x) => x.type === "begin");
    if (!begin || f.some((x) => x.type === "move")) return;
    const row = screens[current]![Math.floor(((begin.y as number) * WALK_SCREEN.height - ROWS_AT) / ROW_STEP)];
    if (row?.to) current = row.to;
  };
  const s = setup({ ...over, onInput, serveSim: { ...over.serveSim, ax: async () => tree() } });
  return { ...s, at: () => current };
}

const SETTINGS: Record<string, WalkRow[]> = {
  root: [{ label: "General", to: "general" }, { label: "Accessibility", to: "a11y" }, { label: "Erase All Content and Settings", to: "root" }],
  general: [{ label: "Settings", to: "root" }, { label: "About", to: "about" }],
  about: [{ label: "General", to: "general" }, { label: "iOS Version", role: "StaticText" }],
  a11y: [{ label: "Settings", to: "root" }],
};

describe("simulator_do", () => {
  it("walks the whole path in one call and hands back the screen it ended on, numbered for the next tap", async () => {
    const dev = walkable(SETTINGS, "root");
    const simulatorId = await dev.running();
    const r = await dev.call("simulator_do", { simulatorId, intent: "find the iOS version", path: ["General", "About"] });
    expect(r.isError).toBe(false);
    expect(dev.at()).toBe("about");
    expect(text(r)).toMatch(/^Walked "General" → "About" on iPhone Air in \d+\.\d s\./);
    expect(text(r)).toContain('[1] Button "General"');
    expect(text(r)).toContain('[2] StaticText "iOS Version"');
    // The answer IS the agent's latest read: a number from it is one the next tap takes.
    const back = await dev.call("simulator_tap", { simulatorId, intent: "back to General", element: 1 });
    expect(back.isError).toBe(false);
    expect(dev.at()).toBe("general");
  });

  it("taps each step at the centre of its element as the live screen has it", async () => {
    const dev = walkable(SETTINGS, "root");
    const simulatorId = await dev.running();
    await dev.call("simulator_do", { simulatorId, intent: "find the iOS version", path: ["General", "About"] });
    const begins = frames(dev.calls.sent).filter((f) => f.type === "begin");
    expect(begins.map((f) => Math.round((f.y as number) * WALK_SCREEN.height))).toEqual([142, 194]);
    expect(begins.every((f) => Math.round((f.x as number) * WALK_SCREEN.width) === 201)).toBe(true);
  });

  it("asks the device's input card once, before anything is sent, with the path on it", async () => {
    const dev = walkable(SETTINGS, "root");
    const simulatorId = await dev.running();
    await dev.call("simulator_do", { simulatorId, intent: "find the iOS version", path: ["General", "About"] });
    const card = dev.calls.gates.find((g) => g.toolKey === "simulator_input:UDID-UP")!;
    expect(card.toolName).toBe("simulator_do");
    expect(card.input).toMatchObject({ intent: "find the iOS version", path: ["General", "About"] });
    expect(card.opts).toMatchObject({ perSession: true });
    expect(dev.calls.order.indexOf("card")).toBeLessThan(dev.calls.order.indexOf("act"));
  });

  it("sends nothing when the card is refused", async () => {
    const dev = walkable(SETTINGS, "root", { gate: { allowed: false, reason: "The user declined." } });
    const simulatorId = await dev.running();
    const r = await dev.call("simulator_do", { simulatorId, intent: "x", path: ["General"] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("The user declined.");
    expect(dev.calls.sent).toEqual([]);
    expect(dev.at()).toBe("root");
  });

  it("opens the app fresh first, asking what simulator_launch asks", async () => {
    const dev = walkable(SETTINGS, "root");
    const simulatorId = await dev.running();
    const r = await dev.call("simulator_do", { simulatorId, intent: "check the version", app: "com.apple.Preferences", path: ["General"] });
    expect(r.isError).toBe(false);
    // THE MUTANT: launch without `fresh`. A running Settings comes back wherever it was left, and the
    // path's first label is not on that screen.
    expect(dev.calls.cli).toContain("launch:UDID-UP:com.apple.Preferences:fresh");
    expect(dev.calls.gates.map((g) => g.toolKey)).toEqual(["simulator_launch", "simulator_input:UDID-UP"]);
  });

  it("refuses an app the device does not have, before any card", async () => {
    const dev = walkable(SETTINGS, "root");
    const simulatorId = await dev.running();
    const r = await dev.call("simulator_do", { simulatorId, intent: "x", app: "com.example.nope", path: ["General"] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("simulator_apps lists the bundle ids it has");
    expect(dev.calls.gates).toEqual([]);
    expect(dev.calls.cli.some((c) => c.startsWith("launch:"))).toBe(false);
  });

  it("stops at a label it cannot find, says where, and numbers the likeliest for a tap", async () => {
    const dev = walkable(SETTINGS, "root");
    const simulatorId = await dev.running();
    const r = await dev.call("simulator_do", { simulatorId, intent: "x", path: ["General", "Software Update"] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Walked "General", then stopped at "Software Update" on iPhone Air');
    expect(text(r)).toContain('no "Software Update" on the screen');
    expect(text(r)).toMatch(/The likeliest: \[\d+\] "Settings" button; \[\d+\] "About" button\./);
    expect(text(r)).toContain("The screen it ended on: 2 element(s)");
    expect(dev.at()).toBe("general");
  });

  it("never takes a step that erases, and says to take it by number if that is the step meant", async () => {
    const dev = walkable(SETTINGS, "root");
    const simulatorId = await dev.running();
    const r = await dev.call("simulator_do", { simulatorId, intent: "x", path: ["Erase All Content and Settings"] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("A walk never takes that kind of step");
    expect(text(r)).toMatch(/The likeliest: \[\d+\] "Erase All Content and Settings" button/);
    expect(dev.calls.sent).toEqual([]);
  });

  it("takes \"General › About\" written as one string as the same two steps", async () => {
    const dev = walkable(SETTINGS, "root");
    const simulatorId = await dev.running();
    expect((await dev.call("simulator_do", { simulatorId, intent: "x", path: ["General › About"] })).isError).toBe(false);
    expect(dev.at()).toBe("about");
  });

  it("refuses, before any card, a path past twelve steps, text the device cannot type, and nothing to do", async () => {
    const dev = walkable(SETTINGS, "root");
    const simulatorId = await dev.running();
    const long = await dev.call("simulator_do", { simulatorId, intent: "x", path: [Array.from({ length: 13 }, () => "General").join(" › ")] });
    expect(text(long)).toContain("a path is at most 12 steps");
    const listed = await dev.call("simulator_do", { simulatorId, intent: "x", path: Array.from({ length: 13 }, () => "General") });
    expect(text(listed)).toContain("a path is at most 12 steps");
    const essay = await dev.call("simulator_do", { simulatorId, intent: "x", path: [`General › ${"a".repeat(130)}`] });
    expect(text(essay)).toContain("a label is a few words, 120 characters at most");
    const emoji = await dev.call("simulator_do", { simulatorId, intent: "x", path: ["General"], text: "🙂" });
    expect(text(emoji)).toContain("cannot be typed");
    const empty = await dev.call("simulator_do", { simulatorId, intent: "x", path: [] });
    expect(text(empty)).toContain("give a path to walk, text to type, or an app to open");
    expect(dev.calls.gates).toEqual([]);
    expect(dev.calls.sent).toEqual([]);
  });

  it("tells the observer each tap of the walk, with the element chosen and the screen it left", async () => {
    const seen: ActObservation[] = [];
    const afters: string[][] = [];
    const observe: ActObserver = (o) => { seen.push(o); return (after) => { afters.push(after.map((e) => e.label)); }; };
    const dev = walkable(SETTINGS, "root", { observe });
    const simulatorId = await dev.running();
    await dev.call("simulator_do", { simulatorId, intent: "find the iOS version", path: ["General", "About"] });
    expect(seen.map((o) => [o.tool, o.intent, o.chosen && "element" in o.chosen ? o.chosen.element.label : null]))
      .toEqual([["simulator_do", "find the iOS version", "General"], ["simulator_do", "find the iOS version", "About"]]);
    // Each step's "after" is the screen it settled on — not a read taken at a guessed moment.
    expect(afters).toEqual([["Settings", "About"], ["General", "iOS Version"]]);
  });

  it("watches the device's own stream during the walk, and lets go of it after", async () => {
    let watched: string | null = null;
    const close = vi.fn();
    const motion: ScreenMotion = { mark: () => ({ moved: 0, edges: 0, edgeBusy: false }), settle: async () => "lost", rest: async () => true, close };
    const dev = walkable(SETTINGS, "root", { watchScreen: (url) => { watched = url; return motion; } });
    const simulatorId = await dev.running();
    await dev.call("simulator_do", { simulatorId, intent: "x", path: ["General"] });
    expect(watched).toBe("http://127.0.0.1:3100/helper/UDID-UP/stream.mjpeg");
    expect(close).toHaveBeenCalledOnce();
  });

  it("scrolls by holding still before it lifts, so the list stops where the finger does", async () => {
    const dev = walkable(SETTINGS, "root");
    const simulatorId = await dev.running();
    await dev.call("simulator_do", { simulatorId, intent: "x", path: ["Developer"] });
    const swipe = dev.calls.sent.find((x) => x.steps.some((st) => decode(st.frame).type === "move"))!;
    const f = swipe.steps.map((st) => decode(st.frame));
    expect(f[0]).toMatchObject({ type: "begin", x: 0.5, y: 0.75 });
    expect(f.at(-1)).toMatchObject({ type: "end", x: 0.5, y: 0.25 });
    // THE MUTANT: lift straight after the last move. The list then flies on past rows never read.
    const moves = swipe.steps.filter((st) => decode(st.frame).type === "move");
    expect(moves.at(-1)!.waitMs).toBe(120);
  });

  it("asks Laya only while its Assist can act, and only for a label the screen does not have", async () => {
    const resolve = vi.fn(async (_d: string, _i: string, elements: readonly { id: string; label: string }[]): Promise<AssistOutcome> =>
      ({ kind: "pick", element: elements.find((e) => e.label === "Accessibility") as never, confidence: 0.97, ms: 9 }));
    const open = { gate: () => ({ available: true, reason: null, threshold: 0.9, accuracy: 0.96 }), resolve } as unknown as LayaAssist;
    const dev = walkable(SETTINGS, "root", { assist: open });
    const simulatorId = await dev.running();
    const r = await dev.call("simulator_do", { simulatorId, intent: "x", path: ["vision settings"] });
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve.mock.calls[0]![0]).toBe("vision settings");
    expect(dev.at()).toBe("a11y");
    expect(text(r)).toContain(`"Accessibility" (Laya's pick for "vision settings")`);

    const shutResolve = vi.fn();
    const shut = { gate: () => ({ available: false, reason: "Laya is not in Assist mode.", threshold: null, accuracy: null }), resolve: shutResolve } as unknown as LayaAssist;
    const dev2 = walkable(SETTINGS, "root", { assist: shut });
    const id2 = await dev2.running();
    expect((await dev2.call("simulator_do", { simulatorId: id2, intent: "x", path: ["vision settings"] })).isError).toBe(true);
    expect(shutResolve).not.toHaveBeenCalled();
  });
});

describe("a real iPhone", () => {
  const phones: FakePhone[] = [];
  afterEach(async () => { await Promise.all(phones.splice(0).map((p) => p.close())); });

  /** The tools on a scripted phone on the cable, through the real service and physical layer. */
  async function onPhone(opts: Parameters<typeof setup>[0] = {}) {
    const phone = await new FakePhone().listen();
    phones.push(phone);
    const dev = setup({ ...opts, phone });
    return { ...dev, phone };
  }

  /** `simulator_open` on the phone, answered, and the pane it opened. */
  async function opened(dev: Awaited<ReturnType<typeof onPhone>>) {
    const r = await dev.call("simulator_open", { udid: PHONE_UDID });
    const simulatorId = text(r).match(/simulator pane (\S+?),/)?.[1] ?? "";
    return { r, simulatorId };
  }

  it("is listed in a group of its own, marked as a real device", async () => {
    const dev = await onPhone();
    const listed = text(await dev.call("simulator_list"));
    expect(listed).toContain(`Real iPhones and iPads\n  ${PHONE_UDID} — Test’s iPhone · iOS 27.2 · a real device, connected`);
    // Not one more simulator in the iOS group.
    expect(listed.split("Real iPhones and iPads")[0]).not.toContain(PHONE_UDID);
  });

  it("opens behind a card that says it is a phone and what will run on it — asked even under bypassPermissions", async () => {
    const dev = await onPhone({ broker: { mode: "bypassPermissions", answer: "allow" } });
    const { r, simulatorId } = await opened(dev);
    expect(r.isError).toBe(false);
    expect(text(r)).toMatch(/^Opened Test’s iPhone \(iOS 27\.2\) in simulator pane \S+, beside this session\. Its screen is 1206×2622 pixels\./);
    // THE MUTANT: open a phone as the simulator it is not — no card under bypass.
    expect(dev.calls.gates.map((g) => g.title)).toEqual(["Open Test’s iPhone (iOS 27.2), a physical phone, in a simulator pane — runs Realm's test runner on it"]);
    expect(dev.service.get(simulatorId)).toMatchObject({ physical: true, udid: PHONE_UDID });
  });

  it("says why it did not start, in the runner's words, when the phone is locked", async () => {
    const phone = await new FakePhone().listen();
    phones.push(phone);
    const dev = { ...setup({ phone }), phone };
    (dev.devicectl as unknown as { lockState: () => Promise<{ locked: boolean }> }).lockState = async () => ({ locked: true });
    const { r } = await opened(dev);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/did not start in simulator pane \S+: the phone is locked\. The user has to unlock it — Realm never works past a passcode\.$/);
  });

  it("reads the phone's screen by name, in points, numbered for the input tools", async () => {
    const dev = await onPhone();
    const { simulatorId } = await opened(dev);
    dev.phone.screen = "root";
    const r = text(await dev.call("simulator_elements", { simulatorId }));
    expect(r).toContain('Frames are "(x,y width×height)" in points, on a 402×874 screen');
    expect(r).toContain("app: Settings");
    expect(r).toMatch(/\[\d+\] Button "General" id=com\.apple\.settings\.general \(16,160 370×52\)/);
    const shot = await dev.call("simulator_screenshot", { simulatorId });
    expect(shot.content.some((c) => c.type === "image")).toBe(true);
  });

  it("drives it with each input tool, sending the runner points — behind one card for the session, even under bypass", async () => {
    const heard: ActObservation[] = [];
    const dev = await onPhone({ broker: { mode: "bypassPermissions", answer: "allow" }, observe: (o) => { heard.push(o); } });
    const { simulatorId } = await opened(dev);
    dev.phone.screen = "root";
    const list = text(await dev.call("simulator_elements", { simulatorId }));
    const general = Number(list.match(/\[(\d+)\] Button "General"/)![1]);
    const steps: [string, Record<string, unknown>][] = [
      ["simulator_tap", { element: general }],
      ["simulator_double_tap", { x: 100, y: 200 }],
      ["simulator_long_press", { x: 100, y: 200, durationMs: 700 }],
      ["simulator_swipe", { direction: "up" }],
      ["simulator_type", { text: "About" }],
      ["simulator_press", { key: "home" }],
    ];
    for (const [tool, args] of steps) {
      const r = await dev.call(tool, { simulatorId, intent: "use the phone", ...args });
      expect(r.isError, `${tool}: ${text(r)}`).toBe(false);
    }
    expect(dev.phone.acts()).toEqual([
      "tap 201,186", "tap 100,200 x2", "tap 100,200 hold 700", "swipe 201,656 → 201,219", "text About", "button home",
    ]);
    // ONE input card for the phone, raised though the session bypasses permissions.
    const inputCards = dev.calls.gates.filter((g) => g.title.startsWith("Tap, swipe and type"));
    expect(inputCards.map((g) => g.title)).toEqual(["Tap, swipe and type on Test’s iPhone, a physical phone, for the rest of this session"]);
    // And the shadow heard every step, the tap by the element the agent chose.
    expect(heard.map((o) => o.tool)).toEqual(steps.map(([t]) => t));
    expect(heard[0]).toMatchObject({ surface: "simulator", intent: "use the phone", chosen: { element: { role: "Button", label: "General" } } });
  });

  it("refuses the side button before any card, and Plan refuses every step on it", async () => {
    const dev = await onPhone({ broker: { mode: "default", answer: "allow" } });
    const { simulatorId } = await opened(dev);
    const lock = await dev.call("simulator_press", { simulatorId, intent: "lock it", key: "lock" });
    expect(lock.isError).toBe(true);
    expect(text(lock)).toContain("never presses a real iPhone's side button");
    expect(dev.calls.gates.filter((g) => g.title.startsWith("Tap"))).toEqual([]);
    dev.setMode("plan");
    const tap = await dev.call("simulator_tap", { simulatorId, intent: "tap", x: 10, y: 10 });
    expect(text(tap)).toContain("read-only");
    expect(dev.phone.acts()).toEqual([]);
  });

  it("walks General › About on the phone in one call, opening Settings fresh, and answers with the About screen", async () => {
    const heard: ActObservation[] = [];
    const dev = await onPhone({ broker: { mode: "bypassPermissions", answer: "allow" }, observe: (o) => { heard.push(o); } });
    const { simulatorId } = await opened(dev);
    dev.phone.screen = "home";
    const r = await dev.call("simulator_do", { simulatorId, intent: "find the iOS version", app: "com.apple.Preferences", path: ["General", "About"] });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(/^Walked "General" → "About" on Test’s iPhone in \d+\.\d s\./);
    expect(text(r)).toMatch(/\[\d+\] StaticText "iOS Version" value="27\.2"/);
    // Settings looked up alone and opened fresh, with devicectl; the taps at each row's centre, in points.
    expect(dev.devicectl!.calls).toEqual(["lockState", "app:com.apple.Preferences", "launch:com.apple.Preferences:fresh"]);
    expect(dev.phone.acts()).toEqual(["tap 201,186", "tap 201,186"]);
    // Two cards, both asked under bypass: the launch's and the phone's input card, once.
    expect(dev.calls.gates.map((g) => g.title)).toEqual([
      "Open Test’s iPhone (iOS 27.2), a physical phone, in a simulator pane — runs Realm's test runner on it",
      "Launch com.apple.Preferences on Test’s iPhone, a physical phone",
      "Tap, swipe and type on Test’s iPhone, a physical phone, for the rest of this session",
    ]);
    // Each tap of the walk reached the shadow as the step it was.
    expect(heard.map((o) => [o.tool, o.chosen && "element" in o.chosen ? o.chosen.element.label : null])).toEqual([["simulator_do", "General"], ["simulator_do", "About"]]);
    // A number from the answer is the next tap's: the Back button, named for General.
    const back = Number(text(r).match(/\[(\d+)\] Button "General"/)![1]);
    expect((await dev.call("simulator_tap", { simulatorId, intent: "back to General", element: back })).isError).toBe(false);
    expect(dev.phone.screen).toBe("general");
  });

  it("lists only what Xcode installed on it, and says how Apple's apps are launched", async () => {
    const dev = await onPhone();
    const { simulatorId } = await opened(dev);
    const r = text(await dev.call("simulator_apps", { simulatorId }));
    expect(r).toContain("Apps Xcode installed on Test’s iPhone — the only ones a real device's list includes. Apple's apps launch by their bundle id too — com.apple.Preferences is Settings.");
    expect(r).toContain("com.acme.debug — Acme (Debug)");
  });

  it("asks before a launch on the phone under bypassPermissions, and launches it with devicectl", async () => {
    const dev = await onPhone({ broker: { mode: "bypassPermissions", answer: "allow" } });
    const { simulatorId } = await opened(dev);
    const r = await dev.call("simulator_launch", { simulatorId, bundleId: "com.apple.Preferences" });
    expect(r.isError).toBe(false);
    expect(dev.calls.gates.at(-1)?.title).toBe("Launch com.apple.Preferences on Test’s iPhone, a physical phone");
    expect(dev.devicectl!.calls.at(-1)).toBe("launch:com.apple.Preferences");
  });
});
