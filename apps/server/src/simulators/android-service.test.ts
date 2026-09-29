import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { tempDir } from "@realm/test-utils";
import { join } from "node:path";
import { openDatabase, type Db } from "../db/database";
import { ItemsStore } from "../store/items";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { SimulatorsStore } from "../store/simulators";
import { SimulatorService } from "./service";
import type { Android } from "./android";
import type { SimulatorDevice } from "@realm/contracts";

/**
 * The Android half of the simulator service, against a fake SDK.
 *
 * Everything here is about the seam rather than about adb: whether the platform reaches the right
 * driver, whether the AVD's name and the adb serial stay in their own lanes, and whether the
 * iOS-only surfaces refuse instead of pretending. The driver itself is proven against a real
 * emulator in `android.test.ts`'s parsers and by the live check.
 */
const dbs: Db[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

const AVD = "Realm_Pixel", SERIAL = "emulator-5554";

function fakeAndroid(over: Partial<Android> = {}) {
  const calls: string[] = [];
  const base: Android = {
    available: async () => true,
    devices: async (): Promise<SimulatorDevice[]> => [
      { udid: AVD, platform: "android", name: "Realm Pixel", runtime: "Android 16", state: "Shutdown", serial: null },
    ],
    boot: async (avd) => { calls.push(`boot:${avd}`); return { ok: true, detail: "" }; },
    waitForBoot: async () => { calls.push("waitForBoot"); return true; },
    serialFor: async (avd) => { calls.push(`serialFor:${avd}`); return SERIAL; },
    size: async () => ({ width: 1080, height: 2400 }),
    screencap: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    ax: async (s) => { calls.push(`ax:${s}`); return { screen: { width: 1080, height: 2400 }, units: "pixels" as const, app: "com.x", elements: [] }; },
    apps: async (s) => { calls.push(`apps:${s}`); return [{ bundleId: "com.x", name: "x" }]; },
    tap: async (_s, x, y, times) => { calls.push(`tap:${x},${y}×${times ?? 1}`); return { ok: true, detail: "" }; },
    swipe: async (_s, a, b, c, d, ms) => { calls.push(`swipe:${a},${b}->${c},${d}:${ms}`); return { ok: true, detail: "" }; },
    drag: async (_s, a, b, c, d, ms) => { calls.push(`drag:${a},${b}->${c},${d}:${ms}`); return { ok: true, detail: "" }; },
    key: async (_s, k) => { calls.push(`key:${k}`); return { ok: true, detail: "" }; },
    text: async (_s, t) => { calls.push(`text:${t}`); return { ok: true, detail: "" }; },
    install: async (_s, p) => { calls.push(`install:${p}`); return { ok: true, detail: "" }; },
    launch: async (_s, p) => { calls.push(`launch:${p}`); return { ok: true, detail: "" }; },
    openUrl: async (_s, u) => { calls.push(`openUrl:${u}`); return { ok: true, detail: "" }; },
    stop: async () => ({ ok: true, detail: "" }),
    ...over,
  };
  return { android: base, calls };
}

/** A stream that hands back URLs without opening a socket: the real one is covered by its own file. */
const fakeStream = { start: async () => ({ streamUrl: "http://127.0.0.1:1/s", wsUrl: "ws://127.0.0.1:1/i" }), stop: () => {}, close: async () => {} };

function bring(over: Partial<Android> = {}) {
  const home = tempDir("realm-droid-");
  const db = openDatabase(join(home, "realm.db"));
  dbs.push(db);
  const profiles = new ProfilesStore(db), spaces = new SpacesStore(db, home), items = new ItemsStore(db);
  const profile = profiles.create({ name: "Work", icon: "briefcase", color: "#fff" });
  const space = spaces.create({ profileId: profile.id, name: "Versed", icon: "folder" });
  const fake = fakeAndroid(over);
  const svc = new SimulatorService({
    rpc: { broadcast: () => {} } as never,
    spaces, items, simulators: new SimulatorsStore(db),
    android: fake.android, androidStream: fakeStream as never,
  });
  const { simulatorId } = svc.create({ spaceId: space.id, name: "Phone" });
  return { svc, simulatorId, calls: fake.calls };
}

describe("an Android row", () => {
  it("remembers the AVD's NAME and never the adb serial", async () => {
    /* The serial is a port handed out at boot. A row that remembered `emulator-5554` would point at
       whichever emulator happened to start first next time — the bug this separation exists for. */
    const { svc, simulatorId } = bring();
    svc.start(simulatorId, AVD, "android");
    await new Promise((r) => setTimeout(r, 200));
    expect(svc.get(simulatorId).udid).toBe(AVD);
    expect(svc.get(simulatorId).platform).toBe("android");
    const state = svc.stateOf(simulatorId);
    expect(state.serial).toBe(SERIAL);
  });

  it("does not boot an emulator that is already running", async () => {
    // `serialFor` answering means it is up. Booting again would start a SECOND emulator on the same
    // AVD, which the tool refuses noisily and which costs a minute finding out.
    const { svc, simulatorId, calls } = bring();
    svc.start(simulatorId, AVD, "android");
    await new Promise((r) => setTimeout(r, 200));
    expect(calls.filter((c) => c.startsWith("boot:"))).toEqual([]);
  });

  it("boots one that is not, and waits for the system rather than for adb", async () => {
    let serial: string | null = null;
    const { svc, simulatorId, calls } = bring({
      serialFor: async () => serial,
      boot: async () => { serial = SERIAL; return { ok: true, detail: "" }; },
    });
    svc.start(simulatorId, AVD, "android");
    await new Promise((r) => setTimeout(r, 900));
    // A device appears on adb before the system is usable; `sys.boot_completed` is the real signal.
    expect(calls).toContain("waitForBoot");
    expect(svc.stateOf(simulatorId).status).toBe("running");
  });

  it("reaches the Android driver for a tree, and says what the frames are measured in", async () => {
    // iOS reports POINTS and Android PIXELS. A pane that assumed one draws every overlay at a third
    // of the size of the thing it outlines.
    const { svc, simulatorId, calls } = bring();
    svc.start(simulatorId, AVD, "android");
    await new Promise((r) => setTimeout(r, 200));
    const tree = await svc.ax(simulatorId);
    expect(tree.units).toBe("pixels");
    expect(calls).toContain(`ax:${SERIAL}`);
  });

  it("refuses the iOS-only surfaces by name instead of quietly doing nothing", async () => {
    const { svc, simulatorId } = bring();
    svc.start(simulatorId, AVD, "android");
    await new Promise((r) => setTimeout(r, 200));
    await expect(svc.ui(simulatorId)).rejects.toThrow(/iOS simulator feature/);
    await expect(svc.poke(simulatorId, { kind: "memory-warning" })).rejects.toThrow(/iOS simulator feature/);
    // And the acts that have no counterpart answer with a reason rather than a bare false.
    const cam = await svc.act(simulatorId, { kind: "camera-stop" });
    expect(cam.ok).toBe(false);
    expect(cam.detail).toMatch(/iOS simulator feature/);
  });

  it("routes the acts Android does have to adb", async () => {
    const { svc, simulatorId, calls } = bring();
    svc.start(simulatorId, AVD, "android");
    await new Promise((r) => setTimeout(r, 200));
    await svc.act(simulatorId, { kind: "open-url", url: "https://x.test" });
    await svc.act(simulatorId, { kind: "launch", bundleId: "com.x" });
    await svc.act(simulatorId, { kind: "paste", text: "hi" });
    expect(calls).toEqual(expect.arrayContaining(["openUrl:https://x.test", "launch:com.x", "text:hi"]));
  });

  it("leaves the device up when the pane stops — the iOS promise, kept here too", async () => {
    const { svc, simulatorId, calls } = bring();
    svc.start(simulatorId, AVD, "android");
    await new Promise((r) => setTimeout(r, 200));
    await svc.stop(simulatorId);
    expect(svc.stateOf(simulatorId).status).toBe("off");
    expect(calls.filter((c) => c.startsWith("stop"))).toEqual([]);
  });

  /* An agent's input, which on Android is `adb shell input` — what the pane's own frames turn into
     on this side too. The tool hands over 0..1 of the screen; adb wants pixels. */
  describe("input", () => {
    const up = async (over: Partial<Android> = {}) => {
      const b = bring(over);
      b.svc.start(b.simulatorId, AVD, "android");
      await new Promise((r) => setTimeout(r, 200));
      b.calls.length = 0;
      return b;
    };

    it("puts a touch on the pixel it names, on the screen size the device reports", async () => {
      const { svc, simulatorId, calls } = await up();
      await svc.input(simulatorId, { kind: "tap", at: { x: 0.5, y: 0.25 }, count: 1 });
      await svc.input(simulatorId, { kind: "tap", at: { x: 0.1, y: 0.9 }, count: 2 });
      // THE MUTANT: multiply by the wrong axis, or not at all — every tap lands somewhere else.
      expect(calls).toEqual(["tap:540,600×1", "tap:108,2160×2"]);
    });

    it("keeps a touch at the very edge on the screen rather than one pixel past it", async () => {
      const { svc, simulatorId, calls } = await up();
      await svc.input(simulatorId, { kind: "tap", at: { x: 1, y: 1 }, count: 1 });
      expect(calls).toEqual(["tap:1079,2399×1"]);
    });

    it("holds as a swipe that goes nowhere, and swipes from where it began to where it ends", async () => {
      const { svc, simulatorId, calls } = await up();
      await svc.input(simulatorId, { kind: "hold", at: { x: 0.5, y: 0.5 }, ms: 900 });
      await svc.input(simulatorId, { kind: "swipe", from: { x: 0.5, y: 0.75 }, to: { x: 0.5, y: 0.25 }, ms: 300, holdMs: 0 });
      expect(calls).toEqual(["swipe:540,1200->540,1200:900", "swipe:540,1800->540,600:300"]);
    });

    it("picks something up before dragging it when asked to hold first", async () => {
      // THE MUTANT: ignore holdMs. A plain swipe over an icon scrolls the page instead of moving it.
      const { svc, simulatorId, calls } = await up();
      await svc.input(simulatorId, { kind: "swipe", from: { x: 0.2, y: 0.5 }, to: { x: 0.8, y: 0.5 }, ms: 500, holdMs: 600 });
      expect(calls).toEqual(["drag:216,1200->864,1200:500"]);
    });

    it("types a new line and a tab as the keys they are, between the runs of text", async () => {
      const { svc, simulatorId, calls } = await up();
      expect(await svc.input(simulatorId, { kind: "text", text: "find me\r\nnow\tok" })).toEqual({ ok: true, detail: "" });
      expect(calls).toEqual(["text:find me", "key:KEYCODE_ENTER", "text:now", "key:KEYCODE_TAB", "text:ok"]);
    });

    it("refuses text it cannot type before typing any of it", async () => {
      const { svc, simulatorId, calls } = await up();
      const r = await svc.input(simulatorId, { kind: "text", text: "first line\ncafé" });
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('"é"');
      // THE MUTANT: refuse only the run that holds it. The first line is typed, then the step fails.
      expect(calls).toEqual([]);
    });

    it("presses buttons and keys as keycodes, back included", async () => {
      const { svc, simulatorId, calls } = await up();
      for (const key of ["back", "home", "lock", "volume-up", "return", "delete"] as const) await svc.input(simulatorId, { kind: "press", key });
      expect(calls).toEqual(["key:KEYCODE_BACK", "key:KEYCODE_HOME", "key:KEYCODE_POWER", "key:KEYCODE_VOLUME_UP", "key:KEYCODE_ENTER", "key:KEYCODE_DEL"]);
    });

    it("says what adb said when the device refuses", async () => {
      const { svc, simulatorId } = await up({ tap: async () => ({ ok: false, detail: "error: device offline" }) });
      expect(await svc.input(simulatorId, { kind: "tap", at: { x: 0.5, y: 0.5 }, count: 1 })).toEqual({ ok: false, detail: "error: device offline" });
    });

    it("sends nothing when the device will not say how big its screen is", async () => {
      // Up with a size, as a device must be to come up at all — and silent about it afterwards.
      let asked = 0;
      const { svc, simulatorId, calls } = await up({ size: async () => (asked++ === 0 ? { width: 1080, height: 2400 } : null) });
      const r = await svc.input(simulatorId, { kind: "tap", at: { x: 0.5, y: 0.5 }, count: 1 });
      expect(r.ok).toBe(false);
      expect(calls.filter((c) => c.startsWith("tap"))).toEqual([]);
    });
  });

  it("says what is missing when there is no SDK, rather than failing with a path", async () => {
    const { svc, simulatorId } = bring({ available: async () => false });
    svc.start(simulatorId, AVD, "android");
    await new Promise((r) => setTimeout(r, 300));
    const state = svc.stateOf(simulatorId);
    expect(state.status).toBe("failed");
    expect(state.detail).toMatch(/Android SDK/);
  });
});
