import { newId, type Simulator, type SimulatorPlatform, type SimulatorAct, type SimulatorApp, type SimulatorAxTree, type SimulatorCameraSource, type SimulatorDevice, type SimulatorEvent, type SimulatorState, type SimulatorUiState } from "@realm/contracts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RpcServer } from "../rpc/server";
import type { ItemsStore } from "../store/items";
import type { SimulatorsStore } from "../store/simulators";
import type { SpacesStore } from "../store/spaces";
import { NotFoundError, RpcError } from "../store/rows";
import { android, type Android } from "./android";
import { AndroidStream } from "./android-stream";

/** A row's name, as a filename. Spaces and punctuation out, so a screenshot of "Carlton's iPhone"
 *  is a file anyone can type at a shell. */
const slug = (name: string): string =>
  name.normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "simulator";
import { simctl, type Simctl } from "./simctl";
import { serveSim, type ServeSim, type ServeSimStream } from "./serve-sim";

/**
 * Owns a simulator's pair — DB row + sidebar item — and the live state of its stream.
 *
 * `MachineService`'s sibling, deliberately much smaller. A machine needs a driver, a proxy, a port
 * and a secret box; a simulator needs two command-line calls and a URL, because `serve-sim` already
 * owns the hard part and the renderer can reach loopback itself.
 *
 * The one structural difference worth stating: THE DAEMON IS NOT OURS. `serve-sim --detach` outlives
 * the call that started it and is keyed by device, not by pane — so two panes on one simulator share
 * a stream, and closing a pane leaves the other one's pixels alone. `stop` kills the stream on
 * purpose (it is a thing the user asked for); closing a pane does not.
 *
 * Shutting the DEVICE down is not something this does at all. A simulator is usually somebody's
 * Xcode session, and a pane closing is not a reason to take it away from them.
 */
export type SimulatorServiceDeps = {
  rpc: RpcServer; spaces: SpacesStore; items: ItemsStore; simulators: SimulatorsStore;
  /** Test seams. Both default to the real CLIs, so a suite never depends on this Mac having Xcode. */
  simctl?: Simctl;
  serveSim?: ServeSim;
  /** The Android half. Same seam, same reason — a suite must not need an SDK either. */
  android?: Android;
  androidStream?: AndroidStream;
};

/** How long to wait for the framebuffer to have a size. serve-sim answers `{"width":0}` until the
 *  capture engine has a frame, and a freshly booted device can take a few seconds to produce one. */
const SCREEN_TIMEOUT_MS = 20_000;
const SCREEN_POLL_MS = 400;
/** A cold AVD is slow — MEASURED at over a minute to `sys.boot_completed` on an M4. */
const ANDROID_BOOT_TIMEOUT_MS = 180_000;

const OFF = (simulatorId: string, udid: string | null): SimulatorState =>
  ({ simulatorId, status: "off", udid, serial: null, streamUrl: null, wsUrl: null, screen: null, error: null, detail: null });

export class SimulatorService {
  private readonly state = new Map<string, SimulatorState>();
  /** Which start is the one anyone is still waiting for. A second press while the first is booting
   *  must not have the first one's failure land on top of the second one's stream. */
  private readonly token = new Map<string, number>();
  /** The last stream each simulator was shown, kept because `/ax` is asked of the daemon's own base
   *  URL — which is not in `SimulatorState` (the pane needs the stream and the socket, not the root)
   *  and must not be re-derived by string surgery on the stream URL. */
  private readonly served = new Map<string, ServeSimStream>();
  private readonly cli: Simctl;
  private readonly stream: ServeSim;
  private readonly droid: Android;
  private readonly droidStream: AndroidStream;
  /** The adb serial each running Android row is on. Separate from the row's `udid`, which is the
   *  AVD's name: a serial is a port handed out at boot and belongs with the in-memory state. */
  private readonly serials = new Map<string, string>();

  constructor(private readonly d: SimulatorServiceDeps) {
    this.cli = d.simctl ?? simctl();
    this.stream = d.serveSim ?? serveSim();
    this.droid = d.android ?? android();
    this.droidStream = d.androidStream ?? new AndroidStream(this.droid, (serial) => this.droid.size(serial));
  }

  /** Which toolchain a row is reached with. Read from the row rather than guessed from the udid. */
  private platformOf(simulatorId: string): SimulatorPlatform { return this.get(simulatorId).platform; }

  /** The adb serial for a running Android row, or a refusal naming what is missing. */
  private serialOf(simulatorId: string): string {
    const serial = this.serials.get(simulatorId);
    if (!serial) throw new RpcError("INVALID_ARGUMENT", "start the emulator first");
    return serial;
  }

  /** One sentence, used everywhere an iOS-only capability is asked of an Android device. Refusing by
   *  name beats a silent no-op: `simctl ui`, the CoreAnimation overlays, the permission table and
   *  the injected camera have no adb counterpart at all, and pretending otherwise would be a menu
   *  item that does nothing. */
  private refuseOnAndroid(what: string): never {
    throw new RpcError("INVALID_ARGUMENT", `${what} is an iOS simulator feature — this row is an Android device.`);
  }

  /** Row + item + one broadcast, in one transaction — `MachineService.create`'s shape, minus the
   *  things that can fail slowly. A simulator with no device chosen is legal and is what the session
   *  bar's button makes: the picker is the pane's own body, so the pane exists first. */
  create(p: { spaceId: string; name: string; udid?: string | null }): { simulatorId: string; itemId: string } {
    const space = this.d.spaces.get(p.spaceId);
    if (!space) throw new NotFoundError("space", p.spaceId);
    const simulatorId = newId();
    const itemId = this.d.items.create({ spaceId: p.spaceId, kind: "simulator", title: p.name, refId: simulatorId }).id;
    this.d.simulators.insert({ id: simulatorId, spaceId: p.spaceId, name: p.name, udid: p.udid ?? null });
    this.d.rpc.broadcast("items.changed", { spaceId: p.spaceId });
    return { simulatorId, itemId };
  }

  get(simulatorId: string): Simulator {
    const row = this.d.simulators.get(simulatorId);
    if (!row) throw new NotFoundError("simulator", simulatorId);
    return row;
  }

  list(spaceId: string): Simulator[] { return this.d.simulators.list(spaceId); }

  stateOf(simulatorId: string): SimulatorState {
    return this.state.get(simulatorId) ?? OFF(simulatorId, this.d.simulators.get(simulatorId)?.udid ?? null);
  }

  states(spaceId: string): SimulatorState[] { return this.list(spaceId).map((s) => this.stateOf(s.id)); }

  /** This Mac's installed simulators. Asked fresh every time the picker opens: a device list is a
   *  fact about the machine right now, and Xcode adds runtimes while Realm is running. */
  /** Every device this Mac can show, from both toolchains. Neither side's absence is an error: a Mac
   *  with no Android SDK simply contributes no Android rows, which is what the picker should show. */
  async devices(): Promise<SimulatorDevice[]> {
    const [ios, droid] = await Promise.all([
      this.cli.devices().catch(() => [] as SimulatorDevice[]),
      this.droid.devices().catch(() => [] as SimulatorDevice[]),
    ]);
    return [...ios, ...droid];
  }

  /** Whether `simctl` answers at all — the honest difference between "no simulators" and "no Xcode". */
  /** Whether ANY toolchain answers. The pane's "nothing installed" state is about both. */
  async available(): Promise<boolean> {
    const [ios, droid] = await Promise.all([this.cli.available().catch(() => false), this.droid.available().catch(() => false)]);
    return ios || droid;
  }

  /**
   * Point the row at a device and bring its stream up.
   *
   * Returns the state as it stands when the walk has been kicked off, not when it finishes: booting
   * a cold device takes tens of seconds, and the pane's job in the meantime is to say so.
   */
  start(simulatorId: string, udid?: string | null, platform?: SimulatorPlatform): SimulatorState {
    const row = this.get(simulatorId);
    const device = udid ?? row.udid;
    if (!device) throw new RpcError("INVALID_ARGUMENT", "choose a simulator to stream first");
    // The platform moves WITH the device, always together: a row left saying `ios` while pointed at
    // an AVD is a row that reaches for simctl and fails with a message about Xcode.
    const kind: SimulatorPlatform = platform ?? (device === row.udid ? row.platform : "ios");
    if (device !== row.udid || kind !== row.platform) this.d.simulators.update(simulatorId, { udid: device, platform: kind });
    const mine = (this.token.get(simulatorId) ?? 0) + 1;
    this.token.set(simulatorId, mine);
    void (kind === "android" ? this.walkAndroid(simulatorId, device, mine) : this.walk(simulatorId, device, mine));
    return this.set({ ...OFF(simulatorId, device), status: "booting" });
  }

  /**
   * The device's own settings — appearance, text size, the accessibility switches.
   *
   * Asked of the DEVICE every time rather than cached. These are simulator-wide and anyone can
   * change them: Xcode's own Features menu, `simctl ui`, the app under test. A menu drawn from a
   * copy Realm took when the pane opened would be a menu that lies about the phone in front of you.
   */
  async ui(simulatorId: string): Promise<SimulatorUiState> {
    if (this.platformOf(simulatorId) === "android") this.refuseOnAndroid("Appearance and text size");
    const row = this.get(simulatorId);
    if (!row.udid) throw new RpcError("INVALID_ARGUMENT", "choose a simulator first");
    return (await this.stream.ui(row.udid)) ?? {};
  }

  /**
   * Change one, and answer with what the device says afterwards.
   *
   * The value is NOT echoed back as though it had landed. `serve-sim ui` prints nothing on success,
   * so the only honest source for "what is it now" is a fresh read — and a refused value (an option
   * a runtime does not support) would otherwise leave the menu showing a state the phone is not in.
   */
  async setUi(simulatorId: string, option: string, value: string): Promise<{ ok: boolean; ui: SimulatorUiState; detail: string }> {
    if (this.platformOf(simulatorId) === "android") this.refuseOnAndroid("Appearance and text size");
    const row = this.get(simulatorId);
    if (!row.udid) throw new RpcError("INVALID_ARGUMENT", "choose a simulator first");
    const r = await this.stream.setUi(row.udid, option, value);
    return { ok: r.ok, ui: r.state ?? {}, detail: r.detail };
  }

  /** A memory warning, or a CoreAnimation debug overlay. One method because they are one kind of
   *  thing from the pane's side: a fire-and-forget poke at the device that answers yes or no. */
  async poke(simulatorId: string, poke: { kind: "memory-warning" } | { kind: "ca-debug"; option: string; on: boolean }): Promise<{ ok: boolean; detail: string }> {
    if (this.platformOf(simulatorId) === "android") this.refuseOnAndroid("The CoreAnimation overlays");
    const row = this.get(simulatorId);
    if (!row.udid) throw new RpcError("INVALID_ARGUMENT", "choose a simulator first");
    return poke.kind === "memory-warning"
      ? this.stream.memoryWarning(row.udid)
      : this.stream.caDebug(row.udid, poke.option, poke.on);
  }

  /**
   * What is on screen, by NAME: the foreground app's accessibility tree.
   *
   * This is the one thing the pane could never see. Its picture is a single DOM node — every icon and
   * row inside it is pixels as far as the page is concerned — so an element picker over the device
   * resolves to "the simulator" and nothing finer. The tree is how the device says what is on it,
   * and the frames it carries are what makes an element tappable by label rather than by guess.
   */
  async ax(simulatorId: string): Promise<SimulatorAxTree> {
    const row = this.get(simulatorId);
    if (row.platform === "android") {
      const tree = await this.droid.ax(this.serialOf(simulatorId));
      // Same "not yet" as iOS's 503, and the same answer: uiautomator refuses while a window is
      // animating, which is exactly when a tap has just landed. The driver already retries.
      if (!tree) throw new RpcError("UNAVAILABLE", "the device would not publish its view tree — something is still animating");
      return tree;
    }
    const stream = this.served.get(simulatorId);
    if (!row.udid || !stream) throw new RpcError("INVALID_ARGUMENT", "start the simulator's stream first");
    const tree = await this.stream.ax(stream, row.udid);
    // A 503 from the daemon means the device's AX framework is still warming up after a boot, which
    // is a "not yet" rather than a "cannot" — the pane says so and offers to look again.
    if (!tree) throw new RpcError("UNAVAILABLE", "the device has not published its accessibility tree yet");
    return tree;
  }

  /** Everything installed on the device. Asked fresh: an app can be installed while a pane watches. */
  async apps(simulatorId: string): Promise<SimulatorApp[]> {
    // `async` so that a row with no device chosen REJECTS rather than throwing synchronously — every
    // caller here is `await`ing or `.catch`ing, and a sync throw out of a promise-shaped method
    // escapes both.
    if (this.platformOf(simulatorId) === "android") return this.droid.apps(this.serialOf(simulatorId));
    return this.cli.apps(this.udidOf(simulatorId));
  }

  /**
   * A PNG of the screen, in the space's own folder, opened where files are read.
   *
   * `simctl` takes it rather than the stream: the stream is JPEG frames scaled for a pane, and a
   * screenshot is the thing people paste into a pull request. Under `simulator/` rather than loose
   * in the space root — the folder is the user's, and a feature that drops files into the top of it
   * is a feature that makes a mess of somebody's project.
   */
  async screenshot(simulatorId: string): Promise<{ path: string; absolute: string }> {
    const row = this.get(simulatorId);
    const udid = this.udidOf(simulatorId);
    const space = this.d.spaces.get(row.spaceId);
    if (!space) throw new NotFoundError("space", row.spaceId);
    const dir = join(space.folderPath, "simulator");
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const rel = join("simulator", `${slug(row.name)}-${stamp}.png`);
    const absolute = join(space.folderPath, rel);
    if (row.platform === "android") {
      // The same PNG the stream is made of, written once at full size. `screencap` is the only
      // capture adb has, so unlike iOS there is no second, higher-quality path to prefer.
      const png = await this.droid.screencap(this.serialOf(simulatorId));
      if (!png) throw new RpcError("FAILED", "the screenshot did not happen");
      await writeFile(absolute, png);
      return { path: rel, absolute };
    }
    const r = await this.cli.screenshot(udid, absolute);
    if (!r.ok) throw new RpcError("FAILED", r.detail || "the screenshot did not happen");
    return { path: rel, absolute };
  }

  /** Everything else a device can be told to do that is one command and one answer. */
  async act(simulatorId: string, act: SimulatorAct): Promise<{ ok: boolean; detail: string; text?: string }> {
    if (this.platformOf(simulatorId) === "android") return this.actAndroid(this.serialOf(simulatorId), act);
    const udid = this.udidOf(simulatorId);
    switch (act.kind) {
      case "open-url": return this.cli.openUrl(udid, act.url);
      case "install": return this.cli.install(udid, act.path);
      case "launch": return this.cli.launch(udid, act.bundleId);
      case "add-media": return this.cli.addMedia(udid, act.paths);
      case "paste": return this.cli.pasteTo(udid, act.text);
      case "copy": return this.cli.copyFrom(udid);
      case "permission": return this.stream.permission(udid, act.action, act.permission, act.bundleId);
      case "camera":
        // With a bundle id the app is LAUNCHED with the feed injected; without one the helper that
        // is already attached hot-swaps its source, which is what the CLI's own `switch` is for.
        return act.bundleId
          ? this.stream.camera(udid, act.bundleId, act.source)
          : this.stream.cameraSwitch(udid, act.source);
      case "camera-stop": return this.stream.cameraStop(udid);
    }
  }

  /**
   * The acts an Android device actually has.
   *
   * Three of the nine map cleanly, one maps with a caveat, and the rest do not exist — so they are
   * refused BY NAME rather than quietly returning `ok: false`. There is no `simctl addmedia` for
   * Android (a file push plus a media-scanner broadcast is a different operation with different
   * failure modes), no permission table shaped like `simctl privacy`, and nothing at all like the
   * injected camera, which on iOS works by swizzling AVFoundation inside the launched app.
   */
  private async actAndroid(serial: string, act: SimulatorAct): Promise<{ ok: boolean; detail: string; text?: string }> {
    switch (act.kind) {
      case "open-url": return this.droid.openUrl(serial, act.url);
      case "install": return this.droid.install(serial, act.path);
      case "launch": return this.droid.launch(serial, act.bundleId);
      // Not a clipboard write: adb has no way to SET the device clipboard without an agent app
      // installed. Typing the text into whatever has focus is the honest nearest thing, and it
      // refuses outright on anything it cannot type rather than typing something else.
      case "paste": return this.droid.text(serial, act.text);
      case "copy": return { ok: false, detail: "Reading the device clipboard needs an agent app on Android, which Realm does not install." };
      case "add-media": return { ok: false, detail: "Adding media to an Android device is not supported yet." };
      case "permission": return { ok: false, detail: "Android permissions are granted per package with `pm grant`, which Realm does not drive yet." };
      case "camera": case "camera-stop":
        return { ok: false, detail: "The injected camera is an iOS simulator feature — it works by swizzling AVFoundation inside the app." };
    }
  }

  /** This Mac's own cameras, for the `webcam` source. Nothing to do with the device. */
  webcams(): Promise<string[]> { return this.stream.webcams(); }

  /** What the device has been told to do lately — by this pane, by a CLI, by anyone. */
  async events(simulatorId: string, limit: number): Promise<SimulatorEvent[]> {
    return this.stream.eventLog(this.udidOf(simulatorId), limit);
  }

  private udidOf(simulatorId: string): string {
    const row = this.get(simulatorId);
    if (!row.udid) throw new RpcError("INVALID_ARGUMENT", "choose a simulator first");
    return row.udid;
  }

  /** Stop the stream. The device stays booted — see the note on the class. */
  async stop(simulatorId: string): Promise<SimulatorState> {
    const row = this.get(simulatorId);
    // Bump the token first: a walk in flight must not publish `running` after this.
    this.token.set(simulatorId, (this.token.get(simulatorId) ?? 0) + 1);
    if (row.platform === "android") {
      /* The stream stops; the DEVICE stays up, which is the same promise the iOS side makes. An
         emulator someone is developing against is not Realm's to switch off because a pane closed. */
      const serial = this.serials.get(simulatorId);
      if (serial) this.droidStream.stop(serial);
      this.serials.delete(simulatorId);
      return this.set(OFF(simulatorId, row.udid));
    }
    if (row.udid) await this.stream.kill(row.udid).catch(() => {});
    return this.set(OFF(simulatorId, row.udid));
  }

  /** The pane closed for good: row + item go, the stream does not. Another pane may be watching it,
   *  and a device somebody is still developing against is not Realm's to switch off. */
  close(simulatorId: string): void {
    const row = this.d.simulators.get(simulatorId);
    if (!row) return;
    this.token.set(simulatorId, (this.token.get(simulatorId) ?? 0) + 1);
    this.state.delete(simulatorId);
    const item = this.d.items.findByRefId(simulatorId);
    this.d.simulators.delete(simulatorId);
    if (item) {
      this.d.items.delete(item.id);
      this.d.rpc.broadcast("items.changed", { spaceId: item.spaceId });
    }
  }

  closeAllInSpace(spaceId: string): void {
    for (const s of this.list(spaceId)) { this.token.set(s.id, (this.token.get(s.id) ?? 0) + 1); this.state.delete(s.id); }
  }

  /* --------------------------- internals --------------------------- */

  /**
   * Boot the device, get a stream, wait for it to have a size.
   *
   * `simctl boot` on an already-booted device is a no-op that returns immediately, so there is one
   * path rather than a probe and two. Likewise `find` before `start`: a device somebody already
   * served — from a terminal, or through the ios-simulator skill — is one this pane can simply show,
   * and starting a second daemon for it would be the wrong answer to "it is already running".
   */
  /**
   * The Android walk. Same three beats as the iOS one — boot, serve, wait for a size — against three
   * different tools.
   *
   * The shape that differs and matters: an AVD's NAME is not how adb addresses it. So this resolves
   * a serial after booting, and everything downstream speaks the serial while the row still
   * remembers the name. A row that remembered `emulator-5554` would point at whichever emulator
   * happened to start first next time.
   */
  private async walkAndroid(simulatorId: string, avd: string, token: number): Promise<void> {
    const current = () => this.token.get(simulatorId) === token;
    const fail = (error: string, detail: string) => { if (current()) this.set({ ...OFF(simulatorId, avd), status: "failed", error, detail: detail || null }); };
    try {
      if (!(await this.droid.available())) return fail("no_sdk", "no Android SDK on this Mac — install the emulator and platform-tools.");
      let serial = await this.droid.serialFor(avd);
      if (!current()) return;
      if (!serial) {
        // Not running yet. `boot` returns as soon as the process is launched; the wait is below.
        const booted = await this.droid.boot(avd);
        if (!current()) return;
        if (!booted.ok) return fail("boot_failed", booted.detail);
        const deadline = Date.now() + ANDROID_BOOT_TIMEOUT_MS;
        while (!serial && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, SCREEN_POLL_MS));
          if (!current()) return;
          serial = await this.droid.serialFor(avd);
        }
        if (!serial) return fail("boot_failed", "the emulator did not appear on adb in time");
      }

      this.set({ ...OFF(simulatorId, avd), status: "serving", serial });
      // `serialFor` only returns devices adb calls `device`, but a device can be listed before the
      // system is usable — `sys.boot_completed` is the one that means the phone is up.
      if (!(await this.droid.waitForBoot(serial, Date.now() + ANDROID_BOOT_TIMEOUT_MS))) {
        return fail("boot_failed", "the device came up on adb but never finished booting");
      }
      if (!current()) return;

      const screen = await this.droid.size(serial);
      if (!current()) return;
      if (!screen) return fail("no_frames", "the device did not report a screen size");

      const handle = await this.droidStream.start(serial);
      if (!current()) { this.droidStream.stop(serial); return; }
      this.serials.set(simulatorId, serial);
      this.set({
        simulatorId, status: "running", udid: avd, serial,
        streamUrl: handle.streamUrl, wsUrl: handle.wsUrl,
        // Android reports no orientation with its size; the tree carries rotation and the pane does
        // not read this field for anything but a label.
        screen: { ...screen, orientation: "portrait" },
        error: null, detail: null,
      });
    } catch (e) {
      fail("failed", e instanceof Error ? e.message : String(e));
    }
  }

  private async walk(simulatorId: string, udid: string, token: number): Promise<void> {
    const current = () => this.token.get(simulatorId) === token;
    const fail = (error: string, detail: string) => { if (current()) this.set({ ...OFF(simulatorId, udid), status: "failed", error, detail: detail || null }); };
    try {
      const booted = await this.cli.boot(udid);
      if (!current()) return;
      if (!booted.ok) return fail("boot_failed", booted.detail);

      this.set({ ...OFF(simulatorId, udid), status: "serving" });
      let stream = await this.stream.find(udid);
      if (!current()) return;
      if (!stream.streamUrl) {
        const started = await this.stream.start(udid);
        if (!current()) return;
        if (!started.stream.streamUrl) return fail("serve_failed", started.detail);
        stream = started.stream;
      }

      const deadline = Date.now() + SCREEN_TIMEOUT_MS;
      for (;;) {
        const screen = await this.stream.screen(stream, udid);
        if (!current()) return;
        if (screen) {
          this.served.set(simulatorId, stream);
          this.set({ simulatorId, status: "running", udid, serial: null, streamUrl: stream.streamUrl, wsUrl: stream.wsUrl, screen, error: null, detail: null });
          return;
        }
        if (Date.now() > deadline) return fail("no_frames", "the stream started but the device has not produced a frame yet");
        await new Promise((r) => setTimeout(r, SCREEN_POLL_MS));
      }
    } catch (e) {
      fail("failed", e instanceof Error ? e.message : String(e));
    }
  }

  private set(next: SimulatorState): SimulatorState {
    const prev = this.state.get(next.simulatorId);
    this.state.set(next.simulatorId, next);
    // The no-churn guard every live-state service here has: an identical state is not an event, and
    // a sidebar dot must not repaint because a poll said the same thing twice.
    if (prev && prev.status === next.status && prev.streamUrl === next.streamUrl && prev.error === next.error
      && prev.screen?.width === next.screen?.width && prev.screen?.height === next.screen?.height
      && prev.screen?.orientation === next.screen?.orientation) return next;
    this.d.rpc.broadcast("simulator.status", next);
    return next;
  }
}
