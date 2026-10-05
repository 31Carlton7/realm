import { findLeafOfItem, type SimulatorDevice } from "@realm/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { LayaStatus, SimulatorState } from "@realm/contracts";

/** Every call the pane makes, and what it gets back. The pane talks to the server through the rpc
 *  singleton, which needs a real port — so the socket is the seam, and the calls are the script. */
const calls: { method: string; params: any }[] = [];
let devices: SimulatorDevice[] = [
  { udid: "UDID-1", platform: "ios", name: "iPhone 17 Pro", runtime: "iOS 27.0", state: "Shutdown", serial: null, physical: false },
  { udid: "UDID-2", platform: "ios", name: "iPad Pro 13-inch", runtime: "iPadOS 27.0", state: "Booted", serial: null, physical: false },
];
let available = true;
let getState: SimulatorState = off("sim-1");
/** The settings row the frame choice lives in, so a test can start a pane already wearing one. */
let settings: Record<string, unknown> = {};
/** Which toolchain the stored row says this pane is pointed at. It decides which device art the
 *  stream is framed as, and it comes off the ROW rather than being inferred from the stream. */
let platform: "ios" | "android" = "ios";
/** What the device says when asked for its apps and its settings — or, set, the refusal it gives. */
let refusal: string | null = null;

vi.mock("../../rpc/client", () => ({
  rpc: () => ({
    on: () => () => {},
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "simulators.devices") return { devices, available };
      if (method === "simulators.get") return { simulator: { id: "sim-1", spaceId: "s1", name: "Simulator", udid: getState.udid, platform, createdAt: 0, updatedAt: 0 }, state: getState };
      if (method === "simulators.start") return { state: { ...off("sim-1"), status: "booting", udid: params.udid ?? getState.udid } };
      if (method === "simulators.stop") return { state: off("sim-1") };
      if (method === "simulators.ax") { calls.push({ method: "ax", params }); return { tree: AX_TREE }; }
      if (method === "simulators.act") return { ok: true, detail: "" };
      if (method === "simulators.apps") { if (refusal) throw new Error(refusal); return { apps: [{ bundleId: "com.apple.mobilesafari", name: "Safari" }] }; }
      if (method === "simulators.ui") { if (refusal) throw new Error(refusal); return { ui: { appearance: "dark", "reduce-motion": "on" } }; }
      if (method === "settings.get") return { value: settings[params.key] ?? null };
      if (method === "settings.set") { settings[params.key] = params.value; return { ok: true }; }
      throw new Error(`unexpected ${method}`);
    },
  }),
}));

import { SimulatorPane } from "./SimulatorPane";
import { PanelBar } from "../../components/PanelBar";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { exited } from "../../components/popover-exit.test-fakes";

function off(id: string): SimulatorState {
  return { simulatorId: id, status: "off", udid: null, serial: null, streamUrl: null, wsUrl: null, screen: null, error: null, detail: null, physical: false };
}
const RUNNING: SimulatorState = {
  simulatorId: "sim-1", status: "running", udid: "UDID-1", serial: null,
  streamUrl: "http://127.0.0.1:3100/helper/UDID-1/stream.mjpeg",
  wsUrl: "ws://127.0.0.1:3100/helper/UDID-1/ws",
  screen: { width: 1206, height: 2622, orientation: "portrait" }, error: null, detail: null, physical: false,
};

/** The device's input socket. jsdom has no WebSocket that connects to anything, so this stands in
 *  for one and records the frames the pane sends. */
const sockets: FakeSocket[] = [];
/** Whether a new socket opens: off, it stays connecting for as long as the test looks at it. */
let socketsOpen = true;
class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  binaryType = "arraybuffer";
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { sockets.push(this); if (socketsOpen) queueMicrotask(() => this.onopen?.()); }
  send(f: Uint8Array) { this.sent.push(f); }
  close() { this.readyState = 3; this.onclose?.(); }
}

const paneItem = item("i1", "s1", { kind: "simulator", title: "Simulator", refId: "sim-1" });

/** Where the picture sits inside the pane, once the letterbox and the chassis have had their share.
 *  Chosen rather than computed: what the input path promises is "this point of THIS box", and a test
 *  that recomputed the layout would be asserting the fit twice and the promise not at all. */
const PICTURE_BOX = { left: 50, top: 100, width: 300, height: 600 };

/** A tree in the shape the device sends: frames in POINTS, and 440 points across where the picture
 *  is 300 CSS pixels — so every box is scaled by 300/440 and nothing is drawn at 1:1 by accident. */
const AX_TREE = {
  screen: { width: 440, height: 956 },
  app: "Safari",
  elements: [
    { path: "0.0", label: "Back", value: "", role: "Button", id: "BackButton", enabled: false, frame: { x: 34, y: 874, width: 48, height: 48 }, depth: 1 },
    { path: "0.1", label: "Reload", value: "", role: "Button", id: null, enabled: true, frame: { x: 220, y: 478, width: 44, height: 44 }, depth: 1 },
  ],
};

/** jsdom implements no PointerEvent, and `fireEvent.pointerDown` falls back to a plain Event — which
 *  carries no `clientX` at all, so a touch staged that way arrives at the device as NaN. A
 *  MouseEvent named `pointerdown` is what React's listener is keyed on and what the pane reads. */
const pointer = (el: Element, type: "pointerdown" | "pointermove" | "pointerup", clientX: number, clientY: number) =>
  fireEvent(el, new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 }));

async function mount(state: SimulatorState = off("sim-1")) {
  getState = state;
  const store = createAppStore(fakeApi());
  await store.getState().boot();
  if (state.status !== "off") act(() => store.getState().applySimulatorState(state));
  const r = render(<StoreContext.Provider value={store}><SimulatorPane item={paneItem} visible /></StoreContext.Provider>);
  return { store, ...r };
}

/** The device's toolbar, over the device. */
const toolbar = () => within(screen.getByRole("group", { name: "Device controls" }));
/** The toolbar's overflow, opened. */
async function openMore(): Promise<HTMLElement> {
  fireEvent.click(toolbar().getByRole("button", { name: "More device controls" }));
  return screen.findByRole("menu", { name: "More device controls" });
}
/** Its rows' names in order, a rule between groups written as "—". */
const rowNames = (menu: HTMLElement) => [...menu.querySelectorAll('[role^="menuitem"], [role="separator"]')]
  .map((r) => (r.getAttribute("role") === "separator" ? "—" : r.querySelector(".menu-label")?.textContent ?? r.textContent));
const frameRow = (menu: HTMLElement) => within(menu).getByRole("menuitemcheckbox", { name: "Show device frame" });

beforeEach(() => {
  calls.length = 0; sockets.length = 0; settings = {}; platform = "ios"; socketsOpen = true; refusal = null;
  devices = [
    { udid: "UDID-1", platform: "ios", name: "iPhone 17 Pro", runtime: "iOS 27.0", state: "Shutdown", serial: null, physical: false },
    { udid: "UDID-2", platform: "ios", name: "iPad Pro 13-inch", runtime: "iPadOS 27.0", state: "Booted", serial: null, physical: false },
  ];
  available = true;
  vi.stubGlobal("WebSocket", FakeSocket);
  // jsdom implements no pointer capture, and the drag depends on it.
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.hasPointerCapture = () => true;
  /* jsdom lays nothing out, so the pane's box is 0×0 and `fit.ts` would size the picture to nothing.
     Two boxes, not one: the PANE's, and the picture's own inside it — which is what input is mapped
     against now that a chassis can sit between the two. A single rect for every element would make
     the pane and the picture the same box, and the press that lands on the rail would land on the
     device instead, which is the one case the letterbox test exists to catch. */
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const box = this.classList?.contains("sim-picture") ? PICTURE_BOX : { left: 0, top: 0, width: 400, height: 800 };
    return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => ({}) } as DOMRect;
  });
  vi.stubGlobal("ResizeObserver", class {
    constructor(private cb: ResizeObserverCallback) {}
    observe() { this.cb([{ contentRect: { width: 400, height: 800 } } as ResizeObserverEntry], this as never); }
    disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("choosing a device", () => {
  it("lists this Mac's simulators, and says which are already booted", async () => {
    await mount();
    expect(await screen.findByRole("button", { name: /iPhone 17 Pro/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /iPad Pro/ }).textContent).toContain("already booted");
    expect(screen.getByRole("button", { name: /iPhone 17 Pro/ }).textContent).toContain("iOS 27.0");
  });

  it("picking one starts it, by udid, in a single call", async () => {
    // THE two-step mutant: update the row and then start it. Between the two the row is pointed at a
    // device nobody asked to watch, and a failure in the middle leaves it there.
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: /iPhone 17 Pro/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "simulators.start")).toBe(true));
    // The platform rides WITH the udid: they are one fact about one device, and a row that kept
    // `ios` while pointed at an AVD would reach for simctl and fail talking about Xcode.
    expect(calls.find((c) => c.method === "simulators.start")!.params).toEqual({ simulatorId: "sim-1", udid: "UDID-1", platform: "ios", physical: false });
    expect(calls.some((c) => c.method === "simulators.update")).toBe(false);
  });

  it("groups the two toolchains, and labels them only when there are two", async () => {
    /* A Mac with no Android SDK must not grow an "iOS" heading announcing the absence of the other
       section — a label over the only group labels nothing. */
    await mount();
    expect(await screen.findByRole("button", { name: /iPhone 17 Pro/ })).toBeInTheDocument();
    expect(document.querySelectorAll(".sim-group-label")).toHaveLength(0);
  });

  it("shows an Android device beside the iOS ones, under its own heading", async () => {
    devices = [
      { udid: "UDID-1", platform: "ios", name: "iPhone 17 Pro", runtime: "iOS 27.0", state: "Shutdown", serial: null, physical: false },
      { udid: "Realm_Pixel", platform: "android", name: "Realm Pixel", runtime: "Android 16", state: "device", serial: "emulator-5554", physical: false },
    ];
    await mount();
    expect(await screen.findByRole("button", { name: /Realm Pixel/ })).toBeInTheDocument();
    expect([...document.querySelectorAll(".sim-group-label")].map((e) => e.textContent)).toEqual(["iOS", "Android"]);
    // Each heading wears its platform's own mark. `data-brand` is what `Icon` stamps for exactly this
    // — the marks carry no accessible name, because the heading beside them already says the word.
    expect([...document.querySelectorAll(".sim-group-label svg")].map((e) => e.getAttribute("data-brand")))
      .toEqual(["apple", "android"]);
    // "Already booted" is each toolchain's OWN word: simctl says `Booted`, adb says `device`. Reading
    // simctl's word on an Android row would label a running emulator as stopped.
    expect(screen.getByRole("button", { name: /Realm Pixel/ }).textContent).toContain("already booted");
    expect(screen.getByRole("button", { name: /iPhone 17 Pro/ }).textContent).not.toContain("already booted");
  });

  it("sends the platform with the udid when an Android device is picked", async () => {
    devices = [{ udid: "Realm_Pixel", platform: "android", name: "Realm Pixel", runtime: "Android 16", state: "Shutdown", serial: null, physical: false }];
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: /Realm Pixel/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "simulators.start")).toBe(true));
    expect(calls.find((c) => c.method === "simulators.start")!.params)
      .toEqual({ simulatorId: "sim-1", udid: "Realm_Pixel", platform: "android", physical: false });
  });

  it("shows a phone on the cable under its own heading, as a real device, and starts it as one", async () => {
    devices = [
      { udid: "UDID-1", platform: "ios", name: "iPhone 17 Pro", runtime: "iOS 27.0", state: "Shutdown", serial: null, physical: false },
      { udid: "00008150-PHONE", platform: "ios", name: "Test’s iPhone", runtime: "iOS 27.2", state: "Connected", serial: null, physical: true },
    ];
    await mount();
    const phone = await screen.findByRole("button", { name: /Test’s iPhone/ });
    expect([...document.querySelectorAll(".sim-group-label")].map((e) => e.textContent)).toEqual(["iOS", "Connected devices"]);
    // THE MUTANT: a phone listed as one more simulator — booted, or offered to boot.
    expect(screen.getByRole("group", { name: "iOS devices on this Mac" }).textContent).not.toContain("Test’s iPhone");
    expect(phone.textContent).toContain("iOS 27.2 · real device");
    expect(phone.getAttribute("title")).toBe("Runs Realm's test runner on the phone while its pane is open");
    fireEvent.click(phone);
    await waitFor(() => expect(calls.some((c) => c.method === "simulators.start")).toBe(true));
    expect(calls.find((c) => c.method === "simulators.start")!.params)
      .toEqual({ simulatorId: "sim-1", udid: "00008150-PHONE", platform: "ios", physical: true });
  });

  it("says a phone with Developer Mode off is one, before anyone picks it", async () => {
    devices = [{ udid: "00008150-PHONE", platform: "ios", name: "Test’s iPhone", runtime: "iOS 27.2", state: "Developer Mode off", serial: null, physical: true }];
    await mount();
    expect((await screen.findByRole("button", { name: /Test’s iPhone/ })).textContent).toContain("iOS 27.2 · Developer Mode off");
  });

  it("dissolves the list's far end while more devices are under it", async () => {
    // THE MUTANT: a list of devices that stops at a hard edge where it scrolls, the cut the owner
    // asked every scroller in the app to lose. jsdom lays nothing out, so the scroller's metrics are stated.
    const { container } = await mount();
    await screen.findByRole("button", { name: /iPhone 17 Pro/ });
    const list = container.querySelector<HTMLElement>(".sim-body")!;
    act(() => {
      Object.defineProperty(list, "scrollHeight", { configurable: true, value: 1400 });
      Object.defineProperty(list, "clientHeight", { configurable: true, value: 700 });
      list.dispatchEvent(new Event("scroll"));
    });
    expect(list.dataset.dissolve).toBe("end");
  });

  it("says what is missing when there is nothing to choose from", async () => {
    // design.md: where the precondition is unmet, say so — these are two different absences and a
    // single "no simulators" would send a user with Xcode installed looking in the wrong place.
    available = false; devices = [];
    await mount();
    expect(await screen.findByText(/could not run/i)).toBeInTheDocument();
    cleanup();
    available = true; devices = [];
    await mount();
    expect(await screen.findByText(/nothing to boot/i)).toBeInTheDocument();
  });
});

describe("while it comes up", () => {
  it("says which step it is on rather than showing an empty pane", async () => {
    await mount({ ...off("sim-1"), status: "booting", udid: "UDID-1" });
    expect(screen.getByText(/Booting the simulator/)).toBeInTheDocument();
  });

  it("says a phone is starting Realm's runner, not booting — and what the person must not do meanwhile", async () => {
    await mount({ ...off("sim-1"), status: "booting", udid: "00008150-PHONE", physical: true });
    expect(screen.getByText("Starting Realm's test runner…")).toBeInTheDocument();
    expect(screen.getByText(/Keep the phone unlocked/)).toBeInTheDocument();
    expect(screen.queryByText(/Booting the simulator/)).toBeNull();
  });

  it("says what to do about a phone that did not start, with xcodebuild's own line", async () => {
    await mount({ ...off("sim-1"), status: "failed", udid: "00008150-PHONE", physical: true, error: "ui_automation", detail: "Failed to enable UI Automation." });
    expect(screen.getByText("Realm could not reach the phone")).toBeInTheDocument();
    expect(screen.getByText(/Turn on Settings ▸ Developer ▸ Enable UI Automation/)).toBeInTheDocument();
    expect(screen.getByText("Failed to enable UI Automation.")).toBeInTheDocument();
  });

  it("a failure names the step and keeps what the command said", async () => {
    await mount({ ...off("sim-1"), status: "failed", udid: "UDID-1", error: "serve_failed", detail: "npm ERR! network" });
    expect(screen.getByText(/could not start the stream/i)).toBeInTheDocument();
    expect(screen.getByText("npm ERR! network")).toBeInTheDocument();
    // …and the way out is on screen: try again, or pick a different device.
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /iPhone 17 Pro/ })).toBeInTheDocument();
  });
});

describe("the live device", () => {
  it("shows the stream itself — an <img>, not a native view", async () => {
    // The whole reason this pane can have menus and sheets over it, and be screenshotted.
    const { container } = await mount(RUNNING);
    const img = container.querySelector("img.sim-picture") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toBe(RUNNING.streamUrl);
    expect(container.querySelector("webview, iframe")).toBeNull();
  });

  it("stops decoding frames when the pane is not on screen", async () => {
    // An MJPEG connection decodes whether or not anyone is looking. THE always-on mutant is a
    // background pane burning a core on JPEGs nobody sees.
    getState = RUNNING;
    const store = createAppStore(fakeApi());
    await store.getState().boot();
    act(() => store.getState().applySimulatorState(RUNNING));
    const { container, rerender } = render(<StoreContext.Provider value={store}><SimulatorPane item={paneItem} visible={false} /></StoreContext.Provider>);
    expect(container.querySelector("img.sim-picture")).toBeNull();
    rerender(<StoreContext.Provider value={store}><SimulatorPane item={paneItem} visible /></StoreContext.Provider>);
    expect(container.querySelector("img.sim-picture")).not.toBeNull();
  });

  it("a click on the screen is a touch on the device, in its own coordinates", async () => {
    const { container } = await mount(RUNNING);
    const surface = container.querySelector(".sim-screen") as HTMLElement;
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    const ws = sockets[0]!;
    expect(ws.url).toBe(RUNNING.wsUrl);

    // The centre of the PICTURE is the centre of the screen — wherever the picture ended up.
    pointer(surface, "pointerdown", 200, 400);
    pointer(surface, "pointerup", 200, 400);
    const frames = ws.sent.map((f) => JSON.parse(new TextDecoder().decode(f.slice(1))) as { type: string; x: number; y: number });
    expect(frames.map((f) => f.type)).toEqual(["begin", "end"]);
    expect(frames[0]!.x).toBeCloseTo(0.5, 1);
    expect(frames[0]!.y).toBeCloseTo(0.5, 1);
  });

  it("ignores a press in the letterbox, which is not the device", async () => {
    // THE clamping mutant: treat the surround as the nearest edge pixel. On a phone that edge is the
    // status bar and the home indicator — a miss becomes a press on something.
    const { container } = await mount(RUNNING);
    const surface = container.querySelector(".sim-screen") as HTMLElement;
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    pointer(surface, "pointerdown", 2, 400); // left of the picture: on the rail, or on the ground
    expect(sockets[0]!.sent).toHaveLength(0);
  });

  it("typing goes to the device, and Realm's own chords do not", async () => {
    const { container } = await mount(RUNNING);
    const surface = container.querySelector(".sim-screen") as HTMLElement;
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    const ws = sockets[0]!;
    fireEvent.keyDown(surface, { key: "h" });
    expect(ws.sent).toHaveLength(2); // down, up
    // ⌘K is the command palette's, even while a device has focus.
    fireEvent.keyDown(surface, { key: "k", metaKey: true });
    expect(ws.sent).toHaveLength(2);
  });
});

describe("the device frame", () => {
  /** The chassis, once the pane has settled on which of the three frames this device wears. */
  const chassisOf = (container: HTMLElement) => waitFor(() => {
    const el = container.querySelector(".sim-chassis") as HTMLElement | null;
    if (!el) throw new Error("no chassis");
    return el;
  });

  it("frames an iPhone as an iPhone: the art over the stream, the stream inside its hole", async () => {
    /* The device Realm ships a picture of gets that picture. The art lies OVER the stream — it has
       the island and the camera in it — so it must be announced to nobody and take no press: a tap
       meant for the device has to reach it through the corners the frame overlaps. */
    const { container } = await mount(RUNNING);
    const chassis = await chassisOf(container);
    await waitFor(() => expect(chassis.getAttribute("data-frame")).toBe("art"));
    const art = chassis.querySelector("img.sim-art") as HTMLImageElement;
    expect(art).not.toBeNull();
    expect(art.getAttribute("aria-hidden")).toBe("true");
    expect(art.getAttribute("alt")).toBe("");
    // Which device the art is a picture of is on the tooltip: a label saying "iPhone 15 Pro" over
    // an iPhone 17 would be a claim about the device rather than about the frame.
    expect(frameRow(await openMore()).getAttribute("title")).toMatch(/iPhone/);
    // The stream sits INSIDE the hole rather than filling the frame.
    const glass = chassis.querySelector(".sim-glass") as HTMLElement;
    expect(parseFloat(glass.style.left)).toBeGreaterThan(0);
    expect(parseFloat(glass.style.top)).toBeGreaterThan(0);
  });

  it("fits the device into what its toolbar and the row under it leave, so the three are one column", async () => {
    /* THE MUTANT: fit the device to the whole stage, as when its controls were rows at the pane's two
       ends. The toolbar and the Record row then push the column past the stage, which clips a device
       measured to fill it. jsdom has no heights, so the two rows' are stated: 40px each, in a stage
       800 tall — an upright iPhone is fitted by its height, to the 720 the rows leave. */
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("sim-above") || this.classList.contains("sim-under") ? 40 : 0;
    });
    const { container } = await mount(RUNNING);
    const chassis = await chassisOf(container);
    await waitFor(() => expect(chassis.getAttribute("data-frame")).toBe("art"));
    expect(parseFloat(chassis.style.height)).toBeCloseTo(720, 0);
  });

  it("gives a device it has no picture of the frame Realm draws, with the corners nested concentrically", async () => {
    /* A watch is the case: no art ships for one, and it still has to arrive wearing something. THE
       MUTANT the radii protect is an outer corner picked by eye rather than as inner + border —
       two arcs that are visibly non-parallel, which is the difference between a screen set into a
       surface and a rectangle somebody rounded twice. */
    const { container } = await mount({ ...RUNNING, screen: { width: 396, height: 484, orientation: "portrait" } });
    const chassis = await chassisOf(container);
    await waitFor(() => expect(chassis.getAttribute("data-frame")).toBe("drawn"));
    expect(chassis.querySelector("img.sim-art")).toBeNull();
    expect(chassis.querySelector("img.sim-picture")).not.toBeNull();
    const bezel = parseFloat(chassis.style.getPropertyValue("--sim-bezel"));
    const outer = parseFloat(chassis.style.getPropertyValue("--sim-outer-r"));
    expect(bezel).toBeGreaterThan(0);
    expect(outer - bezel).toBeGreaterThan(bezel); // the display's own corner, not a rounded rectangle's
  });

  it("frames an emulator as a Pixel, not as an iPhone", async () => {
    platform = "android";
    const { container } = await mount({ ...RUNNING, screen: { width: 1080, height: 2400, orientation: "portrait" } });
    const chassis = await chassisOf(container);
    await waitFor(() => expect(chassis.getAttribute("data-frame")).toBe("art"));
    expect((chassis.querySelector("img.sim-art") as HTMLImageElement).src).toContain("android");
  });

  it("keeps the very same <img> through a change of frame, so the stream does not drop", async () => {
    /* THE BUG this exists for: the picture is an `<img>` on an MJPEG stream, and each frame mode used
       to be its own wrapper — so React re-parented the element, which drops the connection and brings
       the device back black for a beat. One node, one data attribute, and the element survives. */
    const { container } = await mount(RUNNING);
    const chassis = await chassisOf(container);
    await waitFor(() => expect(chassis.getAttribute("data-frame")).toBe("art"));
    const before = container.querySelector("img.sim-picture");
    fireEvent.click(frameRow(await openMore()));
    await waitFor(() => expect(chassis.getAttribute("data-frame")).toBe("none"));
    expect(container.querySelector("img.sim-picture")).toBe(before);
    await exited();
    fireEvent.click(frameRow(await openMore()));
    await waitFor(() => expect(chassis.getAttribute("data-frame")).toBe("art"));
    expect(container.querySelector("img.sim-picture")).toBe(before);
  });

  it("hands the picture a clip CSS can use, so the screen's corners are round at all", async () => {
    /* THE BUG this exists for, found on a real screen: the pane set `--sim-clip` to the bare path
       data and the stylesheet spends it straight into `clip-path`, which makes that declaration
       invalid. Nothing looks broken — the device simply renders with square corners inside a frame
       whose own corners are round, which reads as a rendering fault rather than a missing wrapper.
       `MachinePane` wraps its own clip in `path("…")` for exactly this reason. */
    const { container } = await mount(RUNNING);
    const screenEl = await waitFor(() => {
      const el = container.querySelector(".sim-screen") as HTMLElement | null;
      if (!el) throw new Error("no screen");
      return el;
    });
    const clip = screenEl.style.getPropertyValue("--sim-clip");
    expect(clip.startsWith('path("M')).toBe(true);
    expect(clip.endsWith('Z")')).toBe(true);
  });

  it("the frame choice outlives the pane", async () => {
    const { unmount } = await mount(RUNNING);
    await waitFor(() => expect(document.querySelector(".sim-chassis")?.getAttribute("data-frame")).toBe("art"));
    fireEvent.click(frameRow(await openMore()));
    await waitFor(() => expect(document.querySelector(".sim-chassis")?.getAttribute("data-frame")).toBe("none"));
    const write = calls.find((c) => c.method === "settings.set");
    expect(write!.params.key).toBe("simulator.frame:sim-1");
    expect(write!.params.value).toMatchObject({ kind: "none" });

    unmount();
    await mount(RUNNING);
    await waitFor(() => expect(document.querySelector(".sim-chassis")?.getAttribute("data-frame")).toBe("none"));
    expect(frameRow(await openMore()).getAttribute("aria-checked")).toBe("false");
  });

  it("a frame image stored before Realm drew its own falls back to the frame, not to nothing", async () => {
    /* The pane offered a user-supplied mockup PNG once, and a pane left in that mode has the path
       in its settings row. The mode is gone; the device still has to arrive wearing something. */
    settings["simulator.frame:sim-1"] = { kind: "image", path: "/tmp/iphone.png" };
    const { container } = await mount(RUNNING);
    await waitFor(() => expect(container.querySelector(".sim-chassis")?.getAttribute("data-frame")).toBe("art"));
    const menu = await openMore();
    expect(frameRow(menu).getAttribute("aria-checked")).toBe("true");
    expect(rowNames(menu).filter((n) => /mockup|frame image/i.test(n ?? ""))).toEqual([]);
  });

  it("taking the frame off leaves the picture", async () => {
    const { container } = await mount(RUNNING);
    const chassis = await chassisOf(container);
    fireEvent.click(frameRow(await openMore()));
    await waitFor(() => expect(chassis.getAttribute("data-frame")).toBe("none"));
    expect(chassis.querySelector("img.sim-art")).toBeNull();
    expect(container.querySelector("img.sim-picture")).not.toBeNull();
  });
});

describe("a phone's picture", () => {
  const PHONE = { ...RUNNING, udid: "00008150-PHONE", physical: true } as SimulatorState;
  const realm = () => {
    const api = { phoneScreen: { showLive: vi.fn(async () => "granted") }, permissions: { openSettings: vi.fn(async () => {}) } };
    vi.stubGlobal("realm", api);
    return api;
  };

  it("says nothing while the picture is live, nor for a reason nobody here can fix", async () => {
    realm();
    // THE MUTANT: a note whenever the picture is screenshots. "Show live" offered to a phone on Wi-Fi
    // is a button whose only outcome is the same picture.
    for (const stills of [null, undefined, "no-cable", "failed"] as const) {
      const { container, unmount } = await mount({ ...PHONE, stills });
      await act(async () => {});
      expect(container.querySelector(".sim-live")).toBeNull();
      unmount();
    }
    // Nor on a simulator, whose picture is always live.
    const { container } = await mount({ ...RUNNING, stills: "camera" });
    await act(async () => {});
    expect(container.querySelector(".sim-live")).toBeNull();
  });

  it("offers Show live when Realm was never asked for the camera, and asks only on the click", async () => {
    const api = realm();
    await mount({ ...PHONE, stills: "camera" });
    const button = await screen.findByRole("button", { name: "Show live" });
    expect(button.closest(".sim-live")?.textContent).toMatch(/^Screenshots, not live video\./);
    // Why macOS will ask about a camera is said before it asks, on the control that asks.
    expect(button.getAttribute("title")).toMatch(/reaches a connected iPhone's screen as one/);
    // THE MUTANT: ask on sight. A camera prompt nobody clicked for is the one way to get a no.
    expect(api.phoneScreen.showLive).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(api.phoneScreen.showLive).toHaveBeenCalledTimes(1);
  });

  it("takes the note away when the picture goes live under it", async () => {
    realm();
    const { container, store } = await mount({ ...PHONE, stills: "camera" });
    await screen.findByRole("button", { name: "Show live" });
    // THE MUTANT: a store that thinks a state differing only in this is the same state, and keeps the old.
    act(() => store.getState().applySimulatorState({ ...PHONE, stills: null }));
    await waitFor(() => expect(container.querySelector(".sim-live")).toBeNull());
  });

  it("sends a refused camera to its pane in System Settings, since macOS will not ask twice", async () => {
    const api = realm();
    await mount({ ...PHONE, stills: "camera-denied" });
    fireEvent.click(await screen.findByRole("button", { name: "Open Camera settings" }));
    expect(api.permissions.openSettings).toHaveBeenCalledWith("camera");
    expect(api.phoneScreen.showLive).not.toHaveBeenCalled();
  });
});

describe("the device's toolbar", () => {
  const PHONE = { ...RUNNING, udid: "00008150-PHONE", physical: true } as SimulatorState;
  const pressNames = () => toolbar().getAllByRole("button").map((b) => b.getAttribute("aria-label"));

  it("stands over the device: its state, four presses and an overflow — the Record row under it", async () => {
    const { container } = await mount(RUNNING);
    await waitFor(() => expect(toolbar().getByRole("status")).toHaveTextContent("Live1206×2622"));
    expect(pressNames()).toEqual(["Home button", "Take a screenshot", "Show the device's elements", "Rotate the device", "More device controls"]);
    // Over the device and under it, in one column — the order the stage lays out (jsdom has no layout).
    const column = [...container.querySelector(".sim-stage")!.children].map((e) => e.className);
    expect(column).toEqual(["sim-above", "sim-screen", "sim-under"]);
    expect(container.querySelector(".sim-above")).toContainElement(screen.getByRole("group", { name: "Device controls" }));
    expect(container.querySelector(".sim-under")).toContainElement(screen.getByRole("button", { name: "Record my use of this app…" }));
  });

  it("keeps the hardware, the apps, the device's settings, the frame and the stream's off switch one click away", async () => {
    await mount(RUNNING);
    expect(rowNames(await openMore())).toEqual([
      "Volume up", "Volume down", "Side button (lock)", "—", "Apps…", "Device settings…", "—", "Show device frame", "—", "Stop streaming",
    ]);
  });

  it("presses a button on the device from the overflow, down the device's own socket", async () => {
    await mount(RUNNING);
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    fireEvent.click(within(await openMore()).getByRole("menuitem", { name: "Volume up" }));
    // A press opens its own socket, sends one frame and closes: the toolbar holds none open.
    await waitFor(() => expect(sockets.length).toBe(2));
    await waitFor(() => expect(sockets[1]!.sent).toHaveLength(1));
    expect(sockets[1]!.url).toBe(RUNNING.wsUrl);
  });

  it("opens the apps and the device's settings in place, each with the way back at its head", async () => {
    await mount(RUNNING);
    fireEvent.click(within(await openMore()).getByRole("menuitem", { name: "Apps…" }));
    const menu = screen.getByRole("menu", { name: "More device controls" });
    await waitFor(() => expect(rowNames(menu)[0]).toBe("← Apps"));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "← Apps" }));
    await waitFor(() => expect(rowNames(menu)).toContain("Device settings…"));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Device settings…" }));
    await waitFor(() => expect(rowNames(menu)[0]).toBe("← Device settings"));
    // Ticked from the device's own answer, not from a copy the pane kept.
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Appearance: Dark" })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Reduce Motion" })).toHaveAttribute("aria-checked", "true");
    // Both were read as the overflow opened, so neither opens on a list still on its way.
    expect(calls.filter((c) => c.method === "simulators.apps")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "simulators.ui")).toHaveLength(1);
  });

  it("says inside the drill-down when the device will not answer, and raises no toast for opening the overflow", async () => {
    /* THE MUTANT: read the two lists through the store's `run`, which toasts a failure — and then
       opening the overflow for Volume up raises an error nobody asked about. */
    refusal = "the simulator is not responding";
    const { store } = await mount(RUNNING);
    const menu = await openMore();
    await waitFor(() => expect(calls.filter((c) => c.method === "simulators.apps")).toHaveLength(1));
    await act(async () => {});
    expect(store.getState().toasts).toEqual([]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Apps…" }));
    await waitFor(() => expect(rowNames(menu)).toContain("The device did not list its apps: the simulator is not responding"));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "← Apps" }));
    fireEvent.click(await within(menu).findByRole("menuitem", { name: "Device settings…" }));
    await waitFor(() => expect(rowNames(menu)[1]).toBe("The device did not say how it is set: the simulator is not responding"));
  });

  it("gives a phone what Realm can do to one: no rotation, no side button, none of the simulator's settings", async () => {
    await mount(PHONE);
    await waitFor(() => expect(pressNames()).toEqual(["Home button", "Take a screenshot", "Show the device's elements", "More device controls"]));
    expect(rowNames(await openMore())).toEqual(["Volume up", "Volume down", "—", "Apps…", "—", "Show device frame", "—", "Stop streaming this phone"]);
  });

  it("hands a narrow pane's presses to the overflow in a stated order, first and by name", async () => {
    /* THE MUTANT: hide the buttons the toolbar has no room for and say nothing — a press nobody can
       reach. One number decides both halves: what leaves the toolbar arrives at the head of the
       overflow, Rotate first and Home last. 130px holds the state's dot and two presses. */
    vi.stubGlobal("ResizeObserver", class {
      constructor(private cb: ResizeObserverCallback) {}
      observe() { this.cb([{ contentRect: { width: 130, height: 800 } } as ResizeObserverEntry], this as never); }
      disconnect() {}
    });
    await mount(RUNNING);
    await waitFor(() => expect(pressNames()).toEqual(["Home button", "Take a screenshot", "More device controls"]));
    expect(screen.getByRole("group", { name: "Device controls" })).toHaveAttribute("data-status", "dot");
    // The words a narrow toolbar stops showing are still its state's, for a screen reader.
    expect(toolbar().getByRole("status")).toHaveTextContent("Live1206×2622");
    expect(rowNames(await openMore()).slice(0, 3)).toEqual(["Elements", "Rotate", "—"]);
  });

  it("says it is still connecting until the device's touch and keyboard are up", async () => {
    // A socket still opening: the picture streams, and a touch would go nowhere yet.
    socketsOpen = false;
    await mount(RUNNING);
    const status = toolbar().getByRole("status");
    expect(status).toHaveTextContent(/^Connecting/);
    expect(status).toHaveAttribute("title", "Connecting the keyboard and touch…");
    act(() => sockets[0]!.onopen?.());
    expect(status).toHaveTextContent(/^Live/);
  });
});

describe("recording an app for Laya", () => {
  /** The whole pane, because the control lives under the device, the toolbar's counterpart. */
  async function pane(state: SimulatorState, laya?: LayaStatus) {
    getState = state;
    const api = fakeApi(laya ? { laya } : {});
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().loadLaya();
    if (state.status !== "off") act(() => store.getState().applySimulatorState(state));
    render(<StoreContext.Provider value={store}><SimulatorPane item={paneItem} visible /></StoreContext.Provider>);
    return { api, store };
  }
  const recording = { id: "rec-1", simulatorId: "sim-2", device: "Other iPhone", apps: ["TikTok"], seen: [], screens: 3, startedAt: "2026-09-29T07:12:00.000Z", endedAt: null, lastError: null };
  const other: LayaStatus = { mode: "off", installed: false, runtime: { state: "off" }, stepsLogged: 0, dir: "/Users/u/Realm/laya", assist: { available: false, reason: "x", threshold: null, accuracy: null }, recording };
  const record = () => screen.getByRole("button", { name: "Record my use of this app…" });
  const recorded = (api: { calls: string[] }) => api.calls.filter((c) => c.startsWith("layaRecord:"));

  it("asks before it records: the button opens a sheet, and only its Start records", async () => {
    const { api } = await pane({ ...RUNNING, physical: true });
    fireEvent.click(record());
    const sheet = await screen.findByRole("dialog", { name: "Record your use of this app" });
    // THE MUTANT: a button that records on the click. Opening the sheet asks the server nothing.
    expect(recorded(api)).toEqual([]);
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(record());
    await screen.findByRole("dialog");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(recorded(api)).toEqual([]);

    fireEvent.click(record());
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Start recording" }));
    // No app named: the server records the one in front, and only it.
    await waitFor(() => expect(recorded(api)).toEqual(["layaRecord:sim-1:"]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // While it runs, the row under the device is the recording: what is kept, and the Stop that ends it.
    const row = screen.getByRole("group", { name: "Recording Instagram for Laya" });
    expect(row).toHaveTextContent("0 screens kept");
    expect(screen.queryByRole("button", { name: "Record my use of this app…" })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Stop recording Instagram for Laya" }));
    await waitFor(() => expect(api.calls).toContain("layaStopRecording"));
    expect(await screen.findByRole("button", { name: "Record my use of this app…" })).toBeEnabled();
    // And the sheet does not come back on its own once the recording is over.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says what is kept, what is left out, where it goes, what it is for and how it ends", async () => {
    vi.stubGlobal("realm", { home: "/Users/u/Realm" });
    await pane(RUNNING);
    fireEvent.click(record());
    const sheet = await screen.findByRole("dialog", { name: "Record your use of this app" });
    for (const fact of ["What is kept", "What is left out", "Where it goes", "What it is for", "How it ends"]) {
      expect(within(sheet).getByText(fact)).toBeInTheDocument();
    }
    const text = sheet.textContent ?? "";
    // What `laya/recorder.ts` actually does, each in words: it reads, it taps nothing, it keeps no
    // picture and no typing, long text goes, only the app in front, where it keeps it, when it ends.
    expect(text).toContain("Realm taps nothing");
    expect(text).toContain("Pictures of the screen, your taps and keystrokes, anything typed into a field");
    expect(text).toContain("over 60 characters");
    expect(text).toContain("every app but the one in front when you start");
    expect(within(sheet).getByText("/Users/u/Realm/laya/recordings")).toBeInTheDocument();
    expect(text).toContain("Nothing is uploaded");
    expect(text).toContain("2,000 screens");
    expect(text).toContain("Settings ▸ Laya");
  });

  it("keeps a refusal in the sheet, in the server's own words, and records nothing", async () => {
    const { api, store } = await pane(RUNNING);
    const said = "Open the app you want Laya to learn on Test iPhone first — the home screen, or a system alert over it, is in front.";
    api.layaRecord = async () => { throw Object.assign(new Error(said), { code: "LAYA_NO_APP" }); };
    fireEvent.click(record());
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "Start recording" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent(said);
    // Still open, so opening the app on the device and pressing Start again is the whole fix.
    expect(screen.getByRole("dialog")).toBe(sheet);
    expect(within(sheet).getByRole("button", { name: "Start recording" })).toBeEnabled();
    expect(store.getState().laya?.recording ?? null).toBeNull();
    // …and not as a toast as well: the sheet already says it, where the Start is.
    expect(store.getState().toasts).toEqual([]);
  });

  it("is unavailable while another device records, saying which, and keeps its Stop after the stream has gone", async () => {
    await pane(RUNNING, other);
    // THE MUTANT: a Stop on every pane. This pane's would end another phone's recording.
    expect(screen.queryByRole("button", { name: /^Stop recording/ })).toBeNull();
    expect(record()).toBeDisabled();
    expect(record()).toHaveAttribute("title", "Laya is already recording Other iPhone. Stop that first.");
    cleanup();
    // THE MUTANT: hide the Stop with the stream. A phone that locked mid-recording could not be stopped from its pane.
    await pane(off("sim-1"), { ...other, recording: { ...recording, simulatorId: "sim-1", lastError: "The phone is locked." } });
    expect(await screen.findByRole("button", { name: "Stop recording TikTok for Laya" })).toBeInTheDocument();
    expect(screen.getByText("Not reading the device: The phone is locked.")).toBeInTheDocument();
    cleanup();
    // And no Record without a stream: there is no app in front to read.
    await pane(off("sim-1"));
    await screen.findByRole("button", { name: /iPhone 17 Pro/ });
    expect(screen.queryByRole("button", { name: "Record my use of this app…" })).toBeNull();
  });

  it("is not in the pane bar, and nor is anything else of the device's", async () => {
    /* The bar is the pane's, and in a side pane it is the tab strip too: the device's state and its
       eight buttons there left the tabs no width. THE MUTANT: the simulator's meta or actions back in
       the pane registry — the live state and the screenshot in the bar again. */
    const store = createAppStore(fakeApi());
    await store.getState().boot();
    act(() => store.getState().applySimulatorState(RUNNING));
    const { container } = render(<StoreContext.Provider value={store}>
      <PanelBar item={paneItem} leafId="leaf-1" onClose={() => {}} />
    </StoreContext.Provider>);
    const bar = container.querySelector(".panel-bar")!;
    expect(bar.querySelector(".panel-meta")!.textContent).toBe("");
    expect(within(bar as HTMLElement).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Rename Simulator", "Pane menu for Simulator", "Close Simulator",
    ]);
  });
});

describe("picking an element into the prompter", () => {
  const SHOT = "/realm/tmp/attachments/f00d-iphone-reload-button.png";
  const lead = item("i-lead", "s1", { kind: "session", refId: "lead", title: "Lead" });
  const other = item("i-other", "s1", { kind: "session", refId: "other", title: "Other" });
  /** The device as a tab of the lead's side pane, and the window's picture of a pick stubbed: main's
   *  half (app-pick.ts) is tested where it lives, and this records what it was asked for. */
  async function picker({ owned = true } = {}) {
    const realm = { appPick: { arm: vi.fn(), capture: vi.fn(async (_rect: unknown, _ground: unknown, name: string) => {
      overlayWhileCaptured.push(document.querySelector(".sim-ax")?.hasAttribute("data-capturing") ?? null);
      return { file: { path: SHOT, mime: "image/png", name, size: 4096 }, webView: false };
    }) } };
    const overlayWhileCaptured: (boolean | null)[] = [];
    vi.stubGlobal("realm", realm);
    getState = RUNNING;
    const store = createAppStore(fakeApi({ items: { s1: [lead, other, paneItem] }, sessions: [session("lead", "s1"), session("other", "s1")] }));
    await store.getState().boot();
    await store.getState().openItem("i-lead");
    if (owned) await store.getState().openInSidePane("lead", "i1");
    // The keyboard in ANOTHER session: a device's pick goes to the session it belongs to regardless.
    await store.getState().openItemAt("i-other", findLeafOfItem(store.getState().layout!, "i-lead")!.id, "left");
    act(() => store.getState().applySimulatorState(RUNNING));
    render(<StoreContext.Provider value={store}><SimulatorPane item={paneItem} visible /></StoreContext.Provider>);
    return { store, realm, overlayWhileCaptured };
  }
  const select = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Show the device's elements" }));
    return screen.findByRole("button", { name: "Reload" });
  };

  it("puts a clicked element into the prompter of the session the device belongs to, as a chip with its picture", async () => {
    // THE BUG: the click TAPPED the device and nothing reached a prompter.
    const { store, realm, overlayWhileCaptured } = await picker();
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    const reload = await select();
    // What a click will do, and where it goes, said before anyone makes one.
    expect(screen.getByText("Click one to add it to Lead")).toBeInTheDocument();
    fireEvent.click(reload);
    await waitFor(() => expect(store.getState().drafts.lead).toBe("@[iPhone · Reload button] "));
    const [chip] = store.getState().draftElements.lead!;
    expect(chip).toEqual({ label: "iPhone · Reload button", element: {
      role: "Button", label: "Reload", value: "", id: null, enabled: true,
      frame: { x: 220, y: 478, width: 44, height: 44 }, screen: { width: 440, height: 956 }, units: "points",
      simulator: { id: "sim-1", kind: "iPhone", platform: "ios", physical: false, app: "Safari", shot: SHOT },
    } });
    // Its picture: the element's box on screen, armed around, taken with the overlay's boxes off it.
    const k = PICTURE_BOX.width / AX_TREE.screen.width;
    expect(realm.appPick.capture).toHaveBeenCalledTimes(1);
    const [rect, , name] = realm.appPick.capture.mock.calls[0]!;
    expect(rect).toEqual({ x: PICTURE_BOX.left + 220 * k, y: PICTURE_BOX.top + 478 * k, w: 44 * k, h: 44 * k });
    expect(name).toBe("iphone-reload-button.png");
    expect(realm.appPick.arm.mock.calls).toEqual([[true], [false]]);
    expect(overlayWhileCaptured).toEqual([true]);
    expect(store.getState().pendingAttachments.lead?.map((f) => f.path)).toEqual([SHOT]);
    // …said where it went, the overlay gone with the pick, and nothing pressed on the device.
    expect(store.getState().toasts.map((t) => t.text)).toContain("Added iPhone · Reload button to Lead.");
    expect(store.getState().simulatorElements["sim-1"]).toBe(false);
    expect(screen.queryByRole("group", { name: /Pick an element/ })).toBeNull();
    expect(sockets.every((ws) => ws.sent.length === 0)).toBe(true);
    expect(store.getState().drafts.other ?? "").toBe("");
  });

  it("picks a disabled element too — why it is disabled is often the question", async () => {
    const { store } = await picker();
    await select();
    fireEvent.click(screen.getByRole("button", { name: "Back (disabled)" }));
    await waitFor(() => expect(store.getState().drafts.lead).toBe("@[iPhone · Back button] "));
  });

  it("leaves on Escape with nothing picked, and Escape never reaches the device", async () => {
    const { store, realm } = await picker();
    await select();
    const surface = document.querySelector(".sim-screen") as HTMLElement;
    surface.focus();
    fireEvent.keyDown(surface, { key: "Escape" });
    await waitFor(() => expect(store.getState().simulatorElements["sim-1"]).toBe(false));
    expect(store.getState().drafts.lead ?? "").toBe("");
    expect(realm.appPick.capture).not.toHaveBeenCalled();
    expect(sockets.every((ws) => ws.sent.length === 0)).toBe(true);
    // …and from nothing focused at all, the way out of the app picker too.
    fireEvent.click(screen.getByRole("button", { name: "Show the device's elements" }));
    await screen.findByRole("button", { name: "Reload" });
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(store.getState().simulatorElements["sim-1"]).toBe(false));
  });

  it("asks the web picker's question for a device in a pane of its own", async () => {
    // Not a tab of any session's side pane: the session the keyboard was last in takes it.
    const { store } = await picker({ owned: false });
    fireEvent.click(await select());
    await waitFor(() => expect(store.getState().drafts.other).toBe("@[iPhone · Reload button] "));
  });
});
