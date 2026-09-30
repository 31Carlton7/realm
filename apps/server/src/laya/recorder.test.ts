import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import type { SimulatorAxElement, SimulatorAxTree } from "@realm/contracts";
import { LayaRecorder } from "./recorder";

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
const HOME = tree("", [el("0.1", "Icon", "Instagram")]);

function recorder(script: (SimulatorAxTree | Error)[], o: { dir?: string } = {}) {
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
    r.start("sim1", ["instagram"]);
    await settle(() => reads() >= 6);
    const done = r.stop()!;
    // THE MUTANT: keep every app. A person who glanced at Messages would have recorded their family.
    expect(r.screens().map((s) => s.app)).toEqual(["Instagram", "Instagram"]);
    expect(done).toMatchObject({ device: "Test’s iPhone", apps: ["instagram"], seen: ["Instagram"], screens: 2 });
    expect(r.screens().flatMap((s) => s.elements.map((e) => e.label))).not.toContain("Mom, see you at 6");
  });

  it("keeps a control's name and a switch's state, and never long text or what a field holds", async () => {
    const { r, reads } = recorder([FEED]);
    r.start("sim1", ["Instagram"]);
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

  it("keeps a screen scrolled a little once, and a new screen each time", async () => {
    const { r, reads } = recorder([FEED, FEED, FEED_SCROLLED, FEED, REELS]);
    r.start("sim1", []);
    await settle(() => reads() >= 6);
    r.stop();
    // FEED and FEED_SCROLLED differ by one control in eight: the same screen. THE MUTANT: keep any
    // screen that differs at all — an hour of scrolling is then an hour of near-copies.
    expect(r.screens().map((s) => s.elements.length)).toEqual([6, 4]);
  });

  it("says why it is not reading — a locked phone — and clears it once a read works", async () => {
    const { r, reads, changes } = recorder([new Error("the phone is locked"), new Error("the phone is locked"), FEED]);
    r.start("sim1", ["Instagram"]);
    await settle(() => reads() >= 1 && r.current()?.lastError === "the phone is locked");
    expect(r.current()!.lastError).toBe("the phone is locked");
    const before = changes();
    await settle(() => (r.current()?.screens ?? 0) >= 1);
    expect(r.current()!.lastError).toBeNull();
    expect(changes()).toBeGreaterThan(before);
  });

  it("records one device at a time, and stops reading when stopped", async () => {
    const { r, reads } = recorder([FEED]);
    r.start("sim1", []);
    expect(() => r.start("sim2", [])).toThrow(/already recording Test’s iPhone/);
    await settle(() => reads() >= 2);
    r.stop();
    const after = reads();
    await new Promise((res) => setTimeout(res, 20));
    // THE MUTANT: leave the timer running. The phone is read for ever after the person said stop.
    expect(reads()).toBe(after);
    expect(r.current()).toBeNull();
  });

  it("lists what was recorded across restarts, and deletes all of it", async () => {
    const first = recorder([FEED]);
    first.r.start("sim1", ["Instagram"]);
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
