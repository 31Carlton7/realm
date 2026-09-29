import { createServer, type Server } from "node:http";
import type { SimulatorApp, SimulatorDevice } from "@realm/contracts";
import { encodePng } from "../machines/framebuffer";
import type { Devicectl } from "./devicectl";
import type { DeviceRunners, RunnerTarget } from "./device-runner";
import { loopbackSocket, RunnerClient } from "./runner-client";

/**
 * A real iPhone, scripted, for the suites: a loopback server answering the device runner's routes
 * (`resources/ios-device-runner/.../Routes.swift`) from a small model of Settings, plus the devicectl
 * a phone is listed and launched with. Nothing here reaches a device, xcodebuild or usbmuxd.
 *
 * The screens answer the way the runner does — an XCUITest snapshot of numbered types with empty
 * `Other` containers around the rows — so a test through it exercises the real mapping, the real
 * HTTP and the real service, and only the phone itself is pretend.
 */

export const PHONE_UDID = "00008150-0000AAAA1B2C3D4E";
export const PHONE_DEVICE: SimulatorDevice = {
  udid: PHONE_UDID, platform: "ios", physical: true, name: "Test’s iPhone", runtime: "iOS 27.2", state: "Connected", serial: null,
};

type Row = { label: string; id?: string; type?: number; to?: string; value?: string; placeholder?: string };
type Screen = { app: string; bundleId: string; title?: string; back?: { label: string; to: string }; rows: Row[] };

const W = 402, H = 874;

/** Settings, as far as the suites walk it. The search field sits at the bottom, as iOS 27's does. */
const SCREENS: Record<string, Screen> = {
  home: { app: " ", bundleId: "com.apple.springboard", rows: [{ label: "Settings", type: 44, to: "root" }, { label: "Maps", type: 44 }] },
  runner: { app: "RealmDeviceRunner-Runner", bundleId: "co.charmtechnologies.realm.device-runner.xctrunner", rows: [] },
  root: {
    app: "Settings", bundleId: "com.apple.Preferences", title: "Settings",
    rows: [
      { label: "General", id: "com.apple.settings.general", to: "general" },
      { label: "Accessibility", id: "com.apple.settings.accessibility", to: "accessibility" },
      { label: "Search", type: 45, placeholder: "Search", to: "search" },
    ],
  },
  general: {
    app: "Settings", bundleId: "com.apple.Preferences", title: "General", back: { label: "Settings", to: "root" },
    rows: [{ label: "About", id: "com.apple.settings.about", to: "about" }, { label: "Erase All Content and Settings", to: "erase" }],
  },
  about: {
    app: "Settings", bundleId: "com.apple.Preferences", title: "About", back: { label: "General", to: "general" },
    rows: [{ label: "iOS Version", type: 48, value: "27.2" }, { label: "Model Name", type: 48, value: "iPhone 17 Pro" }],
  },
  accessibility: { app: "Settings", bundleId: "com.apple.Preferences", title: "Accessibility", back: { label: "Settings", to: "root" }, rows: [{ label: "Display & Text Size" }] },
  search: {
    app: "Settings", bundleId: "com.apple.Preferences", title: "Settings",
    rows: [{ label: "Search", type: 45, placeholder: "Search" }, { label: "Cancel", to: "root" }],
  },
};

export type PhoneRequest = { method: string; path: string; body: Record<string, unknown> };

export class FakePhone {
  screen = "runner";
  typed = "";
  readonly requests: PhoneRequest[] = [];
  /** How many reads of the tree to answer with a server error before the next good one. */
  failReads = 0;
  private server: Server | null = null;
  port = 0;

  async listen(): Promise<this> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://phone");
        let body: Record<string, unknown> = {};
        try { body = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { /* not JSON */ }
        this.requests.push({ method: req.method ?? "", path: url.pathname, body });
        const [status, type, out] = this.answer(req.method ?? "", url, body);
        res.writeHead(status, { "Content-Type": type, "Content-Length": out.length, Connection: "close" });
        res.end(out);
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
    this.port = (this.server.address() as { port: number }).port;
    return this;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise((r) => this.server!.close(() => r(null)));
  }

  /** What an act asked of the phone, in order: `tap 201,418`, `text About`, `button home`. */
  acts(): string[] {
    return this.requests.filter((r) => r.method === "POST").map((r) => {
      const b = r.body;
      switch (r.path) {
        case "/tap": return `tap ${Math.round(Number(b.x))},${Math.round(Number(b.y))}${b.count === 2 ? " x2" : ""}${b.holdMs ? ` hold ${b.holdMs}` : ""}`;
        case "/swipe": return `swipe ${Math.round(Number(b.fromX))},${Math.round(Number(b.fromY))} → ${Math.round(Number(b.toX))},${Math.round(Number(b.toY))}`;
        case "/text": return `text ${String(b.text)}`;
        case "/key": return `key ${String(b.key)}`;
        case "/button": return `button ${String(b.button)}`;
        default: return `${r.path.slice(1)} ${JSON.stringify(b)}`;
      }
    });
  }

  /** The frame of each element on the current screen, top to bottom — where a tap on it lands. */
  private layout(s: Screen): { row: Row; frame: { x: number; y: number; width: number; height: number } }[] {
    const out: { row: Row; frame: { x: number; y: number; width: number; height: number } }[] = [];
    if (s.back) out.push({ row: { label: s.back.label, to: s.back.to, type: 9 }, frame: { x: 8, y: 54, width: 90, height: 44 } });
    s.rows.forEach((row, i) => {
      // The search field floats at the bottom; every other row stacks down from under the title.
      const frame = row.type === 45 ? { x: 20, y: 800, width: 362, height: 36 } : { x: 16, y: 160 + i * 52, width: 370, height: 52 };
      out.push({ row, frame });
    });
    return out;
  }

  private tree(): Record<string, unknown> {
    const s = SCREENS[this.screen]!;
    const node = (row: Row, frame: { x: number; y: number; width: number; height: number }) => ({
      type: row.type ?? 9, identifier: row.id ?? "", label: row.label, title: "", enabled: true, frame,
      ...(row.type === 45 ? { value: this.screen === "search" && this.typed ? this.typed : undefined, placeholder: row.placeholder } : row.value ? { value: row.value } : {}),
      children: [],
    });
    const rows = this.layout(s).map(({ row, frame }) => ({ type: 1, identifier: "", label: "", title: "", enabled: true, frame, children: [node(row, frame)] }));
    const title = s.title ? [{ type: 21, identifier: s.title, label: "", title: "", enabled: true, frame: { x: 0, y: 47, width: W, height: 106 }, children: [{ type: 48, identifier: "", label: s.title, title: "", enabled: true, frame: { x: 16, y: 105, width: 200, height: 41 }, children: [] }] }] : [];
    return {
      bundleId: s.bundleId,
      tree: { type: 2, identifier: "", label: s.app, title: "", enabled: true, frame: { x: 0, y: 0, width: W, height: H }, children: [{ type: 1, identifier: "", label: "", title: "", enabled: true, frame: { x: 0, y: 0, width: W, height: H }, children: [...title, ...rows] }] },
    };
  }

  private answer(method: string, url: URL, body: Record<string, unknown>): [number, string, Buffer] {
    const json = (v: unknown, status = 200): [number, string, Buffer] => [status, "application/json", Buffer.from(JSON.stringify(v))];
    const ok = json({ ok: true });
    if (method === "GET") {
      switch (url.pathname) {
        case "/status": return json({ ok: true, runner: "realm-device-runner", version: 1 });
        case "/device": return json({ width: W, height: H, scale: 3 });
        case "/foreground": return json({ bundleId: SCREENS[this.screen]!.bundleId });
        case "/hierarchy":
          if (this.failReads > 0) { this.failReads--; return json({ error: "not yet" }, 500); }
          return json(this.tree());
        case "/screenshot": {
          const png = encodePng({ width: 4, height: 8, rgba: Buffer.alloc(4 * 8 * 4, 200) });
          return [200, url.searchParams.get("format") === "jpeg" ? "image/jpeg" : "image/png", png];
        }
      }
      return json({ error: "no route" }, 404);
    }
    switch (url.pathname) {
      case "/tap": {
        const x = Number(body.x), y = Number(body.y);
        const hit = this.layout(SCREENS[this.screen]!).find(({ frame: f }) => x >= f.x && x < f.x + f.width && y >= f.y && y < f.y + f.height);
        if (hit?.row.to) { this.screen = hit.row.to; if (hit.row.to !== "search") this.typed = ""; }
        return ok;
      }
      case "/swipe": return ok;
      case "/text": if (this.screen === "search") this.typed += String(body.text); return ok;
      case "/key":
        if (body.key === "delete") this.typed = this.typed.slice(0, -1);
        else if (!["return", "space"].includes(String(body.key))) return json({ error: `no key ${String(body.key)}` }, 400);
        return ok;
      case "/button":
        if (body.button === "home") { this.screen = "home"; return ok; }
        if (body.button === "volume-up" || body.button === "volume-down") return ok;
        return json({ error: `no button ${String(body.button)}` }, 400);
      case "/open": return ok;
    }
    return json({ error: "no route" }, 404);
  }

  /** devicectl, as far as a phone on a cable needs it — its launches land on this phone. */
  devicectl(over: Partial<Devicectl> & { locked?: boolean } = {}): Devicectl & { calls: string[] } {
    const calls: string[] = [];
    const apps: SimulatorApp[] = [{ bundleId: "com.acme.debug", name: "Acme (Debug)" }];
    return {
      calls,
      devices: async () => [PHONE_DEVICE],
      apps: async () => { calls.push("apps"); return apps; },
      app: async (_udid, bundleId) => { calls.push(`app:${bundleId}`); return bundleId === "com.apple.Preferences" ? { bundleId, name: "Settings" } : apps.find((a) => a.bundleId === bundleId) ?? null; },
      lockState: async () => { calls.push("lockState"); return { locked: over.locked === true }; },
      launch: async (_udid, bundleId, fresh) => {
        calls.push(`launch:${bundleId}${fresh ? ":fresh" : ""}`);
        if (bundleId === "com.apple.Preferences") { this.screen = "root"; this.typed = ""; }
        return { ok: true, detail: "" };
      },
      install: async (_udid, path) => { calls.push(`install:${path}`); return { ok: true, detail: "" }; },
      ...over,
    };
  }

  /** The runners, as far as the service sees them: one runner, this phone, reached over loopback. */
  runners(log: string[] = []): DeviceRunners {
    const client = new RunnerClient(loopbackSocket(this.port));
    let up = false;
    return {
      ensure: async (t: RunnerTarget) => { log.push(`ensure:${t.udid}:${t.osVersion}${t.simulator ? ":sim" : ""}`); up = true; return client; },
      client: () => (up ? client : null),
      stop: async (udid: string) => { log.push(`stop:${udid}`); up = false; },
      stopAll: async () => { log.push("stopAll"); up = false; },
    } as unknown as DeviceRunners;
  }
}
