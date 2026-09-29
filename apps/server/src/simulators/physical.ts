import type { SimulatorAct, SimulatorApp, SimulatorAxTree, SimulatorDevice, SimulatorScreen } from "@realm/contracts";
import { DeviceBridge, type BridgeOptions } from "./device-bridge";
import type { DeviceInput } from "./device-input";
import { devicectl as realDevicectl, type Devicectl } from "./devicectl";
import { DeviceRunners, RunnerError, type RunnerTarget } from "./device-runner";
import { loopbackSocket, RunnerUnreachable, type RunnerClient } from "./runner-client";
import type { Simctl } from "./simctl";
import { connectToDevice } from "./usbmux";

/**
 * Real iPhones and iPads, as the simulator service reaches them: listed by devicectl, read and driven
 * through Realm's test runner on the device (`device-runner.ts`), shown through a loopback bridge
 * (`device-bridge.ts`).
 *
 * The one seam that is not a test seam is the REHEARSAL: `REALM_RUNNER_SIMULATOR=<udid>` puts a
 * simulator in the list as a real device, reached the phone's way — the same runner, the same tree,
 * the same input, over this Mac's loopback instead of usbmuxd. It is how everything but the cable is
 * checked before anything is done to somebody's phone.
 */

type Bridge = Pick<DeviceBridge, "streamUrl" | "wsUrl" | "port" | "close">;

export type PhysicalDeps = {
  /** `<REALM_HOME>`, where the runner's builds and logs are kept. */
  home: string;
  devicectl?: Devicectl;
  /** For the rehearsal's simulators, which simctl lists, boots and launches on. */
  simctl?: Simctl;
  runners?: DeviceRunners;
  bridge?: (o: BridgeOptions) => Promise<Bridge>;
  /** Simulator udids to treat as real devices — the rehearsal. */
  rehearsal?: readonly string[];
  /** A runner that stopped by itself, for the pane showing that device to say so. */
  onExit?: (udid: string, error: RunnerError) => void;
};

type Live = { client: RunnerClient; points: { width: number; height: number }; bridge: Bridge };

/** The keys the runner presses on a phone, as the runner names them. */
const RUNNER_KEYS = { return: "return", delete: "delete", space: "space" } as const;
const RUNNER_BUTTONS = { home: "home", "volume-up": "volume-up", "volume-down": "volume-down" } as const;

export class PhysicalDevices {
  private readonly live = new Map<string, Live>();
  private readonly dc: Devicectl;
  private readonly runners: DeviceRunners;
  private readonly rehearsal: ReadonlySet<string>;

  constructor(private readonly d: PhysicalDeps) {
    this.dc = d.devicectl ?? realDevicectl();
    this.rehearsal = new Set(d.rehearsal ?? []);
    this.runners = d.runners ?? new DeviceRunners({
      home: d.home,
      socket: (t: RunnerTarget, port: number) => (t.simulator ? loopbackSocket(port) : () => connectToDevice(t.udid, port)),
      onExit: (udid, error) => { void this.drop(udid); d.onExit?.(udid, error); },
    });
  }

  /** Whether this udid is a simulator standing in for a phone. */
  rehearses(udid: string): boolean { return this.rehearsal.has(udid); }

  /** Every real device this Mac can reach now, and the rehearsal's simulators dressed as ones. */
  async devices(): Promise<SimulatorDevice[]> {
    const [real, sims] = await Promise.all([
      this.dc.devices().catch(() => [] as SimulatorDevice[]),
      this.rehearsal.size > 0 && this.d.simctl ? this.d.simctl.devices().catch(() => [] as SimulatorDevice[]) : Promise.resolve([] as SimulatorDevice[]),
    ]);
    const stand = sims.filter((s) => this.rehearsal.has(s.udid))
      .map((s) => ({ ...s, physical: true, state: "Connected", name: `${s.name} (rehearsal)` }));
    return [...real, ...stand];
  }

  /**
   * Bring a device's runner up and its picture with it. Throws a `RunnerError` saying what to do —
   * a locked phone is refused before anything is installed or run on it: the runner cannot pass a
   * passcode and must not try.
   */
  async start(udid: string): Promise<{ screen: SimulatorScreen; streamUrl: string; wsUrl: string }> {
    const device = (await this.devices()).find((x) => x.udid === udid);
    if (!device) throw new RunnerError("not_connected", "That device is not connected to this Mac now. Plug it in, unlock it, and try again.");
    const simulator = this.rehearses(udid);
    if (simulator) {
      const booted = await this.d.simctl!.boot(udid);
      if (!booted.ok) throw new RunnerError("not_connected", "The rehearsal simulator would not boot.", booted.detail);
    } else {
      if (device.state === "Developer Mode off") throw new RunnerError("developer_mode", `Developer Mode is off on ${device.name}. Turn it on in Settings ▸ Privacy & Security ▸ Developer Mode.`);
      const lock = await this.dc.lockState(udid);
      if (lock?.locked) throw new RunnerError("locked", `${device.name} is locked. Unlock it and try again — Realm never works past a passcode.`);
    }
    const osVersion = device.runtime.replace(/^iOS\s*/, "") || "0";
    const client = await this.runners.ensure({ udid, name: device.name, osVersion, simulator });
    const points = await client.screen();
    const existing = this.live.get(udid);
    const bridge = existing?.bridge ?? await (this.d.bridge ?? DeviceBridge.start)({ runner: client, screen: points });
    this.live.set(udid, { client, points, bridge });
    return {
      screen: { width: Math.round(points.width * points.scale), height: Math.round(points.height * points.scale), orientation: "portrait" },
      streamUrl: bridge.streamUrl, wsUrl: bridge.wsUrl,
    };
  }

  private of(udid: string): Live {
    const l = this.live.get(udid);
    if (!l) throw new RunnerUnreachable("Realm's runner is not running on that device — open it again with simulator_open.");
    return l;
  }

  /** The foreground app's tree, in points. Null when the runner answered with something else. */
  async ax(udid: string): Promise<SimulatorAxTree | null> {
    return this.of(udid).client.tree();
  }

  capture(udid: string): Promise<Buffer> { return this.of(udid).client.screenshot({ format: "png" }); }

  apps(udid: string): Promise<SimulatorApp[]> {
    return this.rehearses(udid) ? this.d.simctl!.apps(udid) : this.dc.apps(udid);
  }

  async app(udid: string, bundleId: string): Promise<SimulatorApp | null> {
    return this.rehearses(udid) ? (await this.d.simctl!.apps(udid)).find((a) => a.bundleId === bundleId) ?? null : this.dc.app(udid, bundleId);
  }

  async act(udid: string, act: SimulatorAct): Promise<{ ok: boolean; detail: string; text?: string }> {
    const sim = this.rehearses(udid) ? this.d.simctl! : null;
    switch (act.kind) {
      case "launch": return sim ? sim.launch(udid, act.bundleId, act.fresh === true) : this.dc.launch(udid, act.bundleId, act.fresh === true);
      case "install": return sim ? sim.install(udid, act.path) : this.dc.install(udid, act.path);
      case "open-url": return this.of(udid).client.openUrl(act.url);
      // Everything else is a simulator's, and a phone is refused by name rather than with a silent no.
      case "add-media": return { ok: false, detail: "Adding pictures to a real iPhone's library is not something Realm does — its Photos are the owner's." };
      case "paste": case "copy": return { ok: false, detail: "A real iPhone's pasteboard is not reachable from Realm." };
      case "permission": return { ok: false, detail: "A real iPhone's permissions are its owner's to grant, in its own Settings." };
      case "camera": case "camera-stop": return { ok: false, detail: "The injected camera is an iOS simulator feature." };
    }
  }

  /** An agent's step, in the runner's words and the screen's POINTS. `inputRefusal` has already said
   *  no to anything a phone cannot do. */
  async input(udid: string, input: DeviceInput): Promise<{ ok: boolean; detail: string }> {
    const { client, points } = this.of(udid);
    const at = (p: { x: number; y: number }) => ({ x: p.x * points.width, y: p.y * points.height });
    switch (input.kind) {
      case "tap": { const p = at(input.at); return client.tap(p.x, p.y, input.count, undefined, input.expect); }
      case "hold": { const p = at(input.at); return client.tap(p.x, p.y, 1, input.ms, input.expect); }
      case "swipe": return client.swipe(at(input.from), at(input.to), input.ms, input.holdMs, input.stopMs);
      case "text": return client.text(input.text);
      case "press": {
        const button = RUNNER_BUTTONS[input.key as keyof typeof RUNNER_BUTTONS];
        if (button) return client.button(button);
        const key = RUNNER_KEYS[input.key as keyof typeof RUNNER_KEYS];
        if (key) return client.key(key);
        return { ok: false, detail: `a real iPhone has no ${input.key} Realm can press` };
      }
    }
  }

  /** The device a bridge on this loopback port shows, or null. */
  streamedOn(port: number): string | null {
    for (const [udid, l] of this.live) if (l.bridge.port === port) return udid;
    return null;
  }

  private async drop(udid: string): Promise<void> {
    const l = this.live.get(udid);
    this.live.delete(udid);
    await l?.bridge.close().catch(() => {});
  }

  /** The picture stops and the runner with it: the phone is its owner's again. */
  async stop(udid: string): Promise<void> {
    await this.drop(udid);
    await this.runners.stop(udid);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((udid) => this.drop(udid)));
    await this.runners.stopAll();
  }
}
