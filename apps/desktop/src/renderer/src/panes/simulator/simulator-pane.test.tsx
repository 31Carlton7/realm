import type { SimulatorDevice } from "@realm/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SimulatorState } from "@realm/contracts";

/** Every call the pane makes, and what it gets back. The pane talks to the server through the rpc
 *  singleton, which needs a real port — so the socket is the seam, and the calls are the script. */
const calls: { method: string; params: any }[] = [];
let devices: SimulatorDevice[] = [
  { udid: "UDID-1", platform: "ios", name: "iPhone 17 Pro", runtime: "iOS 27.0", state: "Shutdown", serial: null },
  { udid: "UDID-2", platform: "ios", name: "iPad Pro 13-inch", runtime: "iPadOS 27.0", state: "Booted", serial: null },
];
let available = true;
let getState: SimulatorState = off("sim-1");
/** The settings row the frame choice lives in, so a test can start a pane already wearing one. */
let settings: Record<string, unknown> = {};
/** Which toolchain the stored row says this pane is pointed at. It decides which device art the
 *  stream is framed as, and it comes off the ROW rather than being inferred from the stream. */
let platform: "ios" | "android" = "ios";

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
      if (method === "settings.get") return { value: settings[params.key] ?? null };
      if (method === "settings.set") { settings[params.key] = params.value; return { ok: true }; }
      throw new Error(`unexpected ${method}`);
    },
  }),
}));

import { SimulatorPane } from "./SimulatorPane";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item } from "../../state/store.test-fakes";

function off(id: string): SimulatorState {
  return { simulatorId: id, status: "off", udid: null, serial: null, streamUrl: null, wsUrl: null, screen: null, error: null, detail: null };
}
const RUNNING: SimulatorState = {
  simulatorId: "sim-1", status: "running", udid: "UDID-1", serial: null,
  streamUrl: "http://127.0.0.1:3100/helper/UDID-1/stream.mjpeg",
  wsUrl: "ws://127.0.0.1:3100/helper/UDID-1/ws",
  screen: { width: 1206, height: 2622, orientation: "portrait" }, error: null, detail: null,
};

/** The device's input socket. jsdom has no WebSocket that connects to anything, so this stands in
 *  for one and records the frames the pane sends. */
const sockets: FakeSocket[] = [];
class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  binaryType = "arraybuffer";
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { sockets.push(this); queueMicrotask(() => this.onopen?.()); }
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

beforeEach(() => {
  calls.length = 0; sockets.length = 0; settings = {}; platform = "ios";
  devices = [
    { udid: "UDID-1", platform: "ios", name: "iPhone 17 Pro", runtime: "iOS 27.0", state: "Shutdown", serial: null },
    { udid: "UDID-2", platform: "ios", name: "iPad Pro 13-inch", runtime: "iPadOS 27.0", state: "Booted", serial: null },
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
    expect(calls.find((c) => c.method === "simulators.start")!.params).toEqual({ simulatorId: "sim-1", udid: "UDID-1", platform: "ios" });
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
      { udid: "UDID-1", platform: "ios", name: "iPhone 17 Pro", runtime: "iOS 27.0", state: "Shutdown", serial: null },
      { udid: "Realm_Pixel", platform: "android", name: "Realm Pixel", runtime: "Android 16", state: "device", serial: "emulator-5554" },
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
    devices = [{ udid: "Realm_Pixel", platform: "android", name: "Realm Pixel", runtime: "Android 16", state: "Shutdown", serial: null }];
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: /Realm Pixel/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "simulators.start")).toBe(true));
    expect(calls.find((c) => c.method === "simulators.start")!.params)
      .toEqual({ simulatorId: "sim-1", udid: "Realm_Pixel", platform: "android" });
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
    expect(screen.getByRole("radio", { name: "Frame" }).getAttribute("title")).toMatch(/iPhone/);
    // The stream sits INSIDE the hole rather than filling the frame.
    const glass = chassis.querySelector(".sim-glass") as HTMLElement;
    expect(parseFloat(glass.style.left)).toBeGreaterThan(0);
    expect(parseFloat(glass.style.top)).toBeGreaterThan(0);
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

  it("refuses the art for a phone that is not that shape, rather than letterboxing one inside it", async () => {
    // An iPhone SE is 16:9. In a Pro's hole it would be a letterboxed picture under a Dynamic
    // Island — a frame claiming the device is something it is not.
    const { container } = await mount({ ...RUNNING, screen: { width: 750, height: 1334, orientation: "portrait" } });
    const chassis = await chassisOf(container);
    await waitFor(() => expect(chassis.getAttribute("data-frame")).toBe("drawn"));
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
    fireEvent.click(screen.getByRole("radio", { name: "No frame" }));
    await waitFor(() => expect(chassis.getAttribute("data-frame")).toBe("none"));
    expect(container.querySelector("img.sim-picture")).toBe(before);
    fireEvent.click(screen.getByRole("radio", { name: "Frame" }));
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

  it("draws no Dynamic Island — the device already sent one", async () => {
    /* On a modern phone the island is black pixels the SYSTEM draws into the framebuffer, so it
       arrives inside the picture. A drawn one would sit a few pixels above the real thing, which is
       the kind of wrong that only shows up in a screenshot someone sends you. */
    const { container } = await mount(RUNNING);
    await chassisOf(container);
    expect(container.querySelector(".sim-island, .sim-notch")).toBeNull();
  });

  it("the frame choice outlives the pane", async () => {
    const { unmount } = await mount(RUNNING);
    await waitFor(() => expect(document.querySelector(".sim-chassis")?.getAttribute("data-frame")).toBe("art"));
    fireEvent.click(screen.getByRole("radio", { name: "No frame" }));
    await waitFor(() => expect(document.querySelector(".sim-chassis")?.getAttribute("data-frame")).toBe("none"));
    const write = calls.find((c) => c.method === "settings.set");
    expect(write!.params.key).toBe("simulator.frame:sim-1");
    expect(write!.params.value).toMatchObject({ kind: "none" });

    unmount();
    await mount(RUNNING);
    await waitFor(() => expect(screen.getByRole("radio", { name: "No frame" }).getAttribute("aria-checked")).toBe("true"));
  });

  it("a frame image stored before Realm drew its own falls back to the frame, not to nothing", async () => {
    /* The pane offered a user-supplied mockup PNG once, and a pane left in that mode has the path
       in its settings row. The mode is gone; the device still has to arrive wearing something. */
    settings["simulator.frame:sim-1"] = { kind: "image", path: "/tmp/iphone.png" };
    const { container } = await mount(RUNNING);
    await waitFor(() => expect(container.querySelector(".sim-chassis")?.getAttribute("data-frame")).toBe("art"));
    expect(screen.getByRole("radio", { name: "Frame" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("radio", { name: /mockup/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /frame image/i })).toBeNull();
  });

  it("No frame takes the frame away and leaves the picture", async () => {
    const { container } = await mount(RUNNING);
    const chassis = await chassisOf(container);
    fireEvent.click(screen.getByRole("radio", { name: "No frame" }));
    await waitFor(() => expect(chassis.getAttribute("data-frame")).toBe("none"));
    expect(chassis.querySelector("img.sim-art")).toBeNull();
    expect(container.querySelector("img.sim-picture")).not.toBeNull();
    expect(screen.getByRole("radio", { name: "No frame" }).getAttribute("aria-checked")).toBe("true");
  });

  it("the device's own buttons are under the device, not in the pane bar", async () => {
    // The bar had grown to ten icons. A phone's buttons belong with the phone; the bar is for what
    // the PANE does.
    const { container } = await mount(RUNNING);
    const row = await waitFor(() => {
      const el = container.querySelector(".sim-hardware");
      if (!el) throw new Error("no hardware row");
      return el;
    });
    for (const name of ["Home button", "Volume up", "Volume down", "Side button (lock)", "Rotate the device"]) {
      expect(row.querySelector(`[aria-label="${name}"]`), name).not.toBeNull();
    }
  });
});
