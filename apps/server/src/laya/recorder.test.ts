import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import type { SimulatorAxElement, SimulatorAxTree } from "@realm/contracts";
import { LayaRecorder, nextLook } from "./recorder";
import { RpcError } from "../store/rows";

/**
 * Recording what a person does in an app, read and never tapped. What must die here: a screen of an
 * app nobody asked for kept (Messages, mid-recording), the home screen kept, a caption or a typed
 * message or a field's contents kept, the same screen kept a hundred times, a failing read reported
 * as nothing, and two recordings at once.
 */

const recorders: LayaRecorder[] = [];
afterEach(() => { for (const r of recorders.splice(0)) r.stop(); });

const el = (path: string, role: string, label: string, value = "", y = 100): SimulatorAxElement =>
  ({ path, role, label, value, id: null, enabled: true, frame: { x: 0, y, width: 390, height: 44 }, depth: 2 });
const tree = (app: string, elements: SimulatorAxElement[]): SimulatorAxTree => ({ screen: { width: 390, height: 844 }, units: "points", app, elements });

const FEED = tree("Instagram", [
  el("0.1", "Button", "Home"), el("0.2", "Button", "Reels"), el("0.3", "Button", "Profile"),
  el("0.4", "StaticText", "a caption somebody wrote about their weekend at the lake, with friends and a dog"),
  el("0.5", "Button", "Like"), el("0.6", "TextField", "Add a comment…", "you look great!"),
  el("0.7", "Switch", "Private account", "1"),
]);
const FEED_SCROLLED = tree("Instagram", [...FEED.elements, el("0.8", "Button", "Save")]);
const REELS = tree("Instagram", [el("0.1", "Button", "Home"), el("0.2", "Button", "Reels"), el("0.9", "Button", "Audio"), el("0.10", "Button", "Remix")]);
const MESSAGES = tree("Messages", [el("0.1", "Cell", "Mom, see you at 6")]);
const UNNAMED = tree("Instagram", [el("0.1", "Button", "Home"), el("0.2", "Other", ""), el("0.3", "Image", "  ")]);
const HOME = tree("", [el("0.1", "Icon", "Instagram")]);

function recorder(script: (SimulatorAxTree | Error)[], o: { dir?: string; maxScreens?: number } = {}) {
  const dir = o.dir ?? join(tempDir("realm-laya-rec-"), "recordings");
  let i = 0, changes = 0;
  const r = new LayaRecorder({
    dir,
    read: async () => {
      const next = script[Math.min(i++, script.length - 1)]!;
      if (next instanceof Error) throw next;
      return next;
    },
    deviceName: () => "Test’s iPhone",
    onChange: () => { changes++; },
    intervalMs: 2,
    retryMs: 2,
    ...(o.maxScreens ? { maxScreens: o.maxScreens } : {}),
  });
  recorders.push(r);
  return { r, dir, reads: () => i, changes: () => changes };
}

const settle = async (until: () => boolean) => {
  for (let n = 0; n < 400 && !until(); n++) await new Promise((res) => setTimeout(res, 2));
};

describe("recording an app while a person uses it", () => {
  it("keeps each new screen of the apps asked for, and nothing of any other app or the home screen", async () => {
    const { r, reads } = recorder([FEED, MESSAGES, HOME, REELS, MESSAGES]);
    await r.start("sim1", ["instagram"]);
    await settle(() => reads() >= 6);
    const done = r.stop()!;
    // THE MUTANT: keep every app. A person who glanced at Messages would have recorded their family.
    expect(r.screens().map((s) => s.app)).toEqual(["Instagram", "Instagram"]);
    expect(done).toMatchObject({ device: "Test’s iPhone", apps: ["instagram"], seen: ["Instagram"], screens: 2 });
    expect(r.screens().flatMap((s) => s.elements.map((e) => e.label))).not.toContain("Mom, see you at 6");
  });

  it("with no app named, records the app in front as it starts — and refuses the home screen, which is none", async () => {
    const home = recorder([HOME]);
    await expect(home.r.start("sim1", [])).rejects.toMatchObject({ code: "LAYA_NO_APP", message: expect.stringContaining("Open the app you want Laya to learn on Test’s iPhone first") });
    expect(home.r.current()).toBeNull();
    expect(home.r.list()).toEqual([]);
    const { r, reads } = recorder([REELS, REELS, MESSAGES, HOME, FEED]);
    expect((await r.start("sim1", [])).apps).toEqual(["Instagram"]);
    await settle(() => reads() >= 6);
    r.stop();
    // THE MUTANT: every app when none is named. The glance at Messages, and the home screen, are kept.
    expect(r.screens().map((s) => s.app)).toEqual(["Instagram", "Instagram"]);
  });

  it("asks again, briefly, a device that has not published its tree yet — and takes any other failure as the answer", async () => {
    // MEASURED on a simulator: the read straight after Home can be "not yet".
    const notYet = () => new RpcError("UNAVAILABLE", "the device has not published its accessibility tree yet");
    const slow = recorder([notYet(), notYet(), FEED], {});
    // THE MUTANT: no retry. Record, pressed a moment after the app opened, refuses with the device's "not yet".
    expect((await slow.r.start("sim1", [])).apps).toEqual(["Instagram"]);
    expect(slow.reads()).toBeGreaterThanOrEqual(3);
    slow.r.stop();
    const never = recorder([notYet()]);
    await expect(never.r.start("sim1", [])).rejects.toThrow(/not published/);
    expect(never.reads()).toBe(3);
    const broken = recorder([new Error("the phone is locked")]);
    await expect(broken.r.start("sim1", [])).rejects.toThrow("the phone is locked");
    expect(broken.reads()).toBe(1);
  });

  it("starts one recording at a time, even while the first is still reading which app is in front", async () => {
    let answer = null as ((t: SimulatorAxTree) => void) | null;
    const r = new LayaRecorder({ dir: join(tempDir("realm-laya-rec-"), "recordings"), read: () => new Promise((res) => { answer = res; }), deviceName: () => "Test’s iPhone", onChange: () => {}, intervalMs: 2 });
    recorders.push(r);
    const first = r.start("sim1", []);
    // THE MUTANT: check for a recording only once it exists. Two start, and one is never stopped.
    await expect(r.start("sim1", ["TikTok"])).rejects.toThrow(/already starting a recording/);
    answer!(FEED);
    expect((await first).apps).toEqual(["Instagram"]);
  });

  it("keeps nothing nobody could name", async () => {
    const { r, reads } = recorder([UNNAMED]);
    await r.start("sim1", []);
    await settle(() => reads() >= 2);
    r.stop();
    expect(r.screens()[0]!.elements.map((e) => e.id)).toEqual(["0.1"]);
  });

  it("ends itself at its cap, and reads nothing after", async () => {
    const screens = [FEED, REELS, tree("Instagram", [el("0.1", "Button", "Search"), el("0.2", "Button", "Explore")])];
    const { r, reads, changes } = recorder(screens, { maxScreens: 2 });
    await r.start("sim1", ["Instagram"]);
    await settle(() => r.current() === null);
    // THE MUTANT: no cap. A recording left running is an hour of a phone being read for nothing.
    expect(r.current()).toBeNull();
    expect(r.screens()).toHaveLength(2);
    expect(r.list()[0]!.endedAt).not.toBeNull();
    const after = reads();
    await new Promise((res) => setTimeout(res, 20));
    expect(reads()).toBe(after);
    expect(changes()).toBeGreaterThan(0);
  });

  it("keeps nothing from a read that lands after the stop", async () => {
    let answer = null as ((t: SimulatorAxTree) => void) | null;
    const dir = join(tempDir("realm-laya-rec-"), "recordings");
    const r = new LayaRecorder({ dir, read: () => new Promise((res) => { answer = res; }), deviceName: () => "Test’s iPhone", onChange: () => {}, intervalMs: 2 });
    recorders.push(r);
    await r.start("sim1", ["Instagram"]);
    await settle(() => answer !== null);
    r.stop();
    answer!(FEED);
    await new Promise((res) => setTimeout(res, 20));
    // THE MUTANT: leave the look running past the stop. A screen the person never meant to record is kept.
    expect(r.screens()).toEqual([]);
    expect(r.list()[0]!.screens).toBe(0);
  });

  it("keeps a control's name and a switch's state, and never long text or what a field holds", async () => {
    const { r, reads } = recorder([FEED]);
    await r.start("sim1", ["Instagram"]);
    await settle(() => reads() >= 2);
    r.stop();
    const [screen] = r.screens();
    const labels = screen!.elements.map((e) => e.label);
    expect(labels).toEqual(expect.arrayContaining(["Home", "Reels", "Profile", "Like", "Add a comment…", "Private account"]));
    // THE MUTANT: keep text whatever its length — then every caption and comment is kept.
    expect(labels.some((l) => l.startsWith("a caption"))).toBe(false);
    // THE MUTANT: keep values — then what was typed into the comment box is kept.
    expect(screen!.elements.find((e) => e.label === "Add a comment…")!.value).toBeUndefined();
    expect(screen!.elements.find((e) => e.label === "Private account")!.value).toBe("1");
    expect(screen!.elements[0]).toMatchObject({ id: "0.1", role: "Button", frame: [0, 100, 390, 44] });
  });

  it("cuts a long control name short, and never through an emoji", async () => {
    // A button named past the 60 characters the recorder keeps, with an emoji where the cut falls.
    const long = `${"x".repeat(58)}\u{1F600} and the rest of a long name`;
    const { r, reads } = recorder([tree("Instagram", [el("0.1", "Button", "Home"), el("0.2", "Button", "Reels"), el("0.3", "Button", long)])]);
    await r.start("sim1", ["Instagram"]);
    await settle(() => reads() >= 2);
    r.stop();
    const kept = r.screens()[0]!.elements.find((e) => e.id === "0.3")!.label;
    // THE MUTANT: cut by UTF-16 unit. The emoji's first half is kept, and train.py refuses the run.
    expect(kept).toBe(`${"x".repeat(58)}…`);
  });

  it("keeps a screen scrolled a little once, and a new screen each time", async () => {
    const { r, reads } = recorder([FEED, FEED, FEED_SCROLLED, FEED, REELS]);
    await r.start("sim1", []);
    await settle(() => reads() >= 6);
    r.stop();
    // FEED and FEED_SCROLLED differ by one control in eight: the same screen. THE MUTANT: keep any
    // screen that differs at all — an hour of scrolling is then an hour of near-copies.
    expect(r.screens().map((s) => s.elements.length)).toEqual([6, 4]);
  });

  it("says why it is not reading — a locked phone — and clears it once a read works", async () => {
    const { r, reads, changes } = recorder([...Array.from({ length: 4 }, () => new Error("the phone is locked")), FEED]);
    await r.start("sim1", ["Instagram"]);
    const atStart = changes();
    await settle(() => reads() >= 1 && r.current()?.lastError === "the phone is locked");
    expect(r.current()!.lastError).toBe("the phone is locked");
    // THE MUTANT: keep the reason to itself. Settings and the pane go on saying nothing is wrong.
    expect(changes()).toBeGreaterThan(atStart);
    const before = changes();
    await settle(() => (r.current()?.screens ?? 0) >= 1);
    expect(r.current()!.lastError).toBeNull();
    expect(changes()).toBeGreaterThan(before);
  });

  it("records one device at a time, and stops reading when stopped", async () => {
    const { r, reads } = recorder([FEED]);
    await r.start("sim1", []);
    await expect(r.start("sim2", [])).rejects.toThrow(/already recording Test’s iPhone/);
    await settle(() => reads() >= 2);
    r.stop();
    const after = reads();
    await new Promise((res) => setTimeout(res, 20));
    // THE MUTANT: leave the timer running. The phone is read for ever after the person said stop.
    expect(reads()).toBe(after);
    expect(r.current()).toBeNull();
  });

  it("waits twice as long as a slow read took before the next, and three intervals after a failed one", async () => {
    expect(nextLook(1_200, 100, false)).toBe(1_200);
    // THE MUTANT: the interval alone. A phone describing TikTok's feed is never left alone, and the
    // person watching it feels every read.
    expect(nextLook(1_200, 36_000, false)).toBe(72_000);
    expect(nextLook(1_200, 50, true)).toBe(3_600);
    expect(nextLook(1_200, 20_000, true)).toBe(40_000);
  });

  it("leaves a slow device alone between reads for twice as long as each took", async () => {
    const starts: number[] = [];
    const r = new LayaRecorder({
      dir: join(tempDir("realm-laya-rec-"), "recordings"), deviceName: () => "Test’s iPhone", onChange: () => {}, intervalMs: 2,
      read: async () => { starts.push(performance.now()); await new Promise((res) => setTimeout(res, 25)); return FEED; },
    });
    recorders.push(r);
    await r.start("sim1", ["Instagram"]);
    await settle(() => starts.length >= 3);
    r.stop();
    const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
    // Each read took ~25 ms, so the next begins no sooner than ~75 ms after the last began.
    for (const gap of gaps.slice(0, 2)) expect(gap).toBeGreaterThanOrEqual(70);
  });

  it("lists what was recorded across restarts, and deletes all of it", async () => {
    const first = recorder([FEED]);
    await first.r.start("sim1", ["Instagram"]);
    await settle(() => first.reads() >= 2);
    first.r.stop();
    // A new recorder over the same folder — Realm restarted — still has it for training.
    const again = recorder([REELS], { dir: first.dir });
    expect(again.r.list()).toHaveLength(1);
    expect(again.r.screens()).toHaveLength(1);
    const meta = JSON.parse(readFileSync(join(first.dir, again.r.list()[0]!.id, "recording.json"), "utf8"));
    expect(meta.endedAt).not.toBeNull();
    again.r.deleteAll();
    expect(existsSync(first.dir) ? readdirSync(first.dir) : []).toEqual([]);
    expect(again.r.screens()).toEqual([]);
  });
});
