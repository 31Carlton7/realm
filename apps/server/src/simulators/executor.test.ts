import { describe, expect, it, vi } from "vitest";
import type { SimulatorAxElement, SimulatorAxTree } from "@realm/contracts";
import type { AssistOutcome } from "../laya/assist";
import { findLabel, fold, runPath, signature, type ExecIO, type ExecOptions } from "./executor";
import type { ScreenMotion } from "./screen-motion";

/**
 * The walk against a scripted device on a virtual clock: screens of rows, a scroll offset, taps that
 * navigate, a read that costs half a second. What must die: a tap on the wrong element, a scroll that
 * runs past the end of its list, a step that buys or deletes, a tap that changed nothing reported as
 * done, and a walk that reads the tree three times a step when the picture could have told it once.
 */

type Row = { label: string; role?: string; to?: string; value?: string; toggles?: boolean; nothing?: boolean };
type Screen = { app?: string; rows: Row[]; heading?: string; searchBar?: boolean; topBar?: boolean; background?: boolean; fields?: { role: string; label: string }[]; alert?: string };

const SCREEN = { width: 400, height: 800 };
const PAGE = 13;
const ROW_H = 50;
const rowY = (i: number) => 120 + ROW_H * i;

class Device {
  current: string;
  offset = 0;
  reads = 0;
  taps: string[] = [];
  /** Where each tap landed, in points — to tell a tap on a settled screen from one mid-slide. */
  at: { x: number; y: number }[] = [];
  /** Reads after a navigation that still show the new screen sliding in from the right. */
  slide = 0;
  private sliding = 0;
  scrolls: ("up" | "down")[] = [];
  typed: string[] = [];
  clock = 0;
  clockLabel = "9:41";
  /** Reads before a tap shows: an app answering a moment late. */
  lag = 0;
  private pending: (() => void) | null = null;
  private pendingReads = 0;
  failReads = 0;

  constructor(public screens: Record<string, Screen>, start: string, o: { offset?: number } = {}) {
    this.current = start;
    this.offset = o.offset ?? 0;
  }

  tree(): SimulatorAxTree {
    const s = this.screens[this.current]!;
    const els: SimulatorAxElement[] = [];
    const el = (path: string, label: string, role: string, frame: SimulatorAxElement["frame"], value = ""): SimulatorAxElement =>
      ({ path, label, value, role, id: null, enabled: true, frame, depth: path.split(".").length });
    if (s.heading) els.push(el("0.0", s.heading, "Heading", { x: 20, y: 70, width: 200, height: 40 }));
    // A picture behind the list, listed before it — drawn first, so under everything after it.
    if (s.background) els.push(el("0.6", "", "Image", { x: 0, y: 100, width: 400, height: 700 }));
    const dx = this.sliding > 0 ? 200 : 0;
    s.rows.slice(this.offset, this.offset + PAGE).forEach((r, i) =>
      els.push(el(`0.1.${this.offset + i}`, r.label, r.role ?? "Button", { x: 20 + dx, y: rowY(i), width: 360, height: 44 }, r.value ?? "")));
    // A container drawn after the list that fills the screen and holds a bar at the top: the bar is
    // over the first row, the container itself is over nothing.
    if (s.topBar) {
      els.push(el("0.5", "", "Group", { x: 0, y: 0, width: 400, height: 800 }));
      els.push(el("0.5.0", "Done", "Button", { x: 0, y: 100, width: 400, height: 60 }));
    }
    (s.fields ?? []).forEach((f, i) => els.push(el(`0.3.${i}`, f.label, f.role, { x: 20, y: 60 + i * 5, width: 360, height: 4 })));
    // Drawn over the last rows, the way iOS 27 Settings floats its search bar over its list.
    if (s.searchBar) els.push(el("0.2", "", "TextField", { x: 20, y: 690, width: 360, height: 60 }, "Search"));
    if (s.alert) els.push(el("0.4", s.alert, "Alert", { x: 40, y: 300, width: 320, height: 200 }));
    els.push(el("0.9", this.clockLabel, "StaticText", { x: 20, y: 10, width: 40, height: 20 }));
    return { screen: SCREEN, units: "points", app: s.app ?? "Settings", elements: els };
  }

  io(extra: Partial<ExecIO> = {}): ExecIO {
    return {
      read: async () => {
        this.clock += 500;
        this.reads++;
        if (this.failReads > 0) { this.failReads--; throw new Error("the device has not published its accessibility tree yet"); }
        if (this.pending && ++this.pendingReads > this.lag) { this.pending(); this.pending = null; }
        const t = this.tree();
        if (this.sliding > 0) this.sliding--;
        return t;
      },
      tap: async (element) => {
        this.taps.push(element.label);
        this.at.push({ x: element.frame.x + element.frame.width / 2, y: element.frame.y + element.frame.height / 2 });
        const row = this.screens[this.current]!.rows.find((r) => r.label === element.label);
        const apply = () => {
          if (!row || row.nothing) return;
          if (row.toggles) row.value = row.value === "1" ? "0" : "1";
          if (row.to) { this.current = row.to; this.offset = 0; this.sliding = this.slide; }
        };
        if (this.lag > 0) { this.pending = apply; this.pendingReads = 0; } else apply();
        return { ok: true, detail: "" };
      },
      scroll: async (direction) => {
        this.scrolls.push(direction);
        const max = Math.max(0, this.screens[this.current]!.rows.length - PAGE);
        this.offset = direction === "up" ? Math.min(max, this.offset + 6) : Math.max(0, this.offset - 6);
        return { ok: true, detail: "" };
      },
      type: async (text) => { this.typed.push(text); return { ok: true, detail: "" }; },
      now: () => this.clock,
      sleep: async (ms) => { this.clock += ms; },
      ...extra,
    };
  }
}

const rows = (...labels: string[]): Row[] => labels.map((label) => ({ label }));
const LONG = Array.from({ length: 30 }, (_, i) => `Row ${i + 1}`);

const settings = (): Record<string, Screen> => ({
  root: { heading: "Settings", rows: [{ label: "General", to: "general" }, { label: "Accessibility", to: "a11y" }, { label: "Privacy & Security", to: "privacy" }, { label: "Wi-Fi", to: "wifi" }, { label: "Display & Brightness", to: "display" }] },
  general: { heading: "General", rows: [{ label: "Settings", role: "Button", to: "root" }, { label: "About", to: "about" }, { label: "Keyboard", to: "keyboard" }, { label: "Erase All Content and Settings", to: "erase" }] },
  about: { heading: "About", rows: [{ label: "General", to: "general" }, { label: "iOS Version", role: "StaticText", nothing: true }] },
  a11y: { heading: "Accessibility", rows: rows("Display & Text Size") },
  privacy: { heading: "Privacy & Security", rows: rows("Location Services") },
  wifi: { heading: "Wi-Fi", rows: rows("Other Network") },
  display: { heading: "Display & Brightness", rows: rows("Text Size") },
  keyboard: { heading: "Keyboards", rows: rows("All Keyboards") },
  erase: { heading: "Erase", rows: rows("Continue") },
});

const walk = (d: Device, o: ExecOptions, extra: Partial<ExecIO> = {}) => runPath(d.io(extra), o);
const heading = (t: SimulatorAxTree) => t.elements.find((e) => e.role === "Heading")?.label;

describe("walking a path", () => {
  it("taps each label in turn and ends on the screen the last one opened", async () => {
    const d = new Device(settings(), "root");
    const r = await walk(d, { path: ["General", "About"] });
    expect(r.ok).toBe(true);
    expect(d.taps).toEqual(["General", "About"]);
    expect(r.steps.map((s) => [s.label, s.how, s.matched])).toEqual([["General", "exact", "General"], ["About", "exact", "About"]]);
    expect(heading(r.final)).toBe("About");
    expect(r.stop).toBeNull();
  });

  it("taps what can be tapped over what only reads the same words — the back button, not the heading", async () => {
    // The heading "Settings" comes first in the tree; the Back button of the same name is a row below.
    const d = new Device({ list: { heading: "Settings", rows: [{ label: "Settings", role: "Button", to: "root" }] }, root: settings().root! }, "list");
    await walk(d, { path: ["Settings"] });
    // THE MUTANT: rank the heading as highly as the button, and the first in reading order — the
    // heading, at y 90 — is what gets tapped.
    expect(d.at.map((p) => p.y)).toEqual([rowY(0) + 22]);
  });

  it("reads a label the way a person writes it: case, '&' for 'and', dashes and spaces", async () => {
    for (const [asked, tapped] of [
      ["privacy and security", "Privacy & Security"],
      ["WiFi", "Wi-Fi"],
      ["Display", "Display & Brightness"],
      ["Brightness", "Display & Brightness"],
    ] as const) {
      const d = new Device(settings(), "root");
      const r = await walk(d, { path: [asked] });
      expect(d.taps, asked).toEqual([tapped]);
      expect(r.steps[0]!.how, asked).toBe(asked.toLowerCase() === "privacy and security" ? "exact" : "close");
    }
  });

  it("takes the first of two equal matches in reading order", async () => {
    const d = new Device({ list: { rows: [{ label: "Show", to: "a" }, { label: "Show", to: "b" }] }, a: { heading: "A", rows: [] }, b: { heading: "B", rows: [] } }, "list");
    await walk(d, { path: ["Show"] });
    // THE MUTANT: let a later match of the same rank replace an earlier one — the second row.
    expect(d.at.map((p) => p.y)).toEqual([rowY(0) + 22]);
  });

  it("taps a screen that has stopped moving, not one still sliding in", async () => {
    const d = new Device(settings(), "root");
    d.slide = 1;
    const r = await walk(d, { path: ["General", "About"] });
    expect(r.ok).toBe(true);
    // The first read after General shows its rows 200 points to the right, mid-slide. THE MUTANT:
    // take the first changed read as the screen, and About is tapped where it was passing through.
    expect(d.at.map((p) => p.x)).toEqual([200, 200]);
  });

  it("does not take a fragment of a word for the word", async () => {
    // THE MUTANT: match by substring. "Gen" then taps General, and "Row 1" taps "Row 10".
    const d = new Device(settings(), "root");
    const r = await walk(d, { path: ["Gen"] });
    expect(r.stop?.why).toBe("not-found");
    expect(d.taps).toEqual([]);
    const long = new Device({ list: { rows: rows("Row 10", "Row 1") } }, "list");
    await walk(long, { path: ["Row 1"] });
    expect(long.taps).toEqual(["Row 1"]);
  });
});

describe("scrolling to a label", () => {
  it("scrolls down the list until the label is on the screen, then taps it there", async () => {
    const d = new Device({ list: { rows: [...rows(...LONG.slice(0, 25)), { label: "Developer", to: "dev" }] }, dev: { heading: "Developer", rows: [] } }, "list");
    const r = await walk(d, { path: ["Developer"] });
    expect(r.ok).toBe(true);
    // 26 rows, 13 a page, 6 a scroll: Developer, the 26th, comes into view on the third.
    expect(d.scrolls).toEqual(["up", "up", "up"]);
    expect(r.steps[0]!.scrolls).toBe(3);
    expect(heading(r.final)).toBe("Developer");
  });

  it("stops at the end of the list rather than scrolling on — a scroll that shows nothing new is the end", async () => {
    const d = new Device({ list: { rows: rows(...LONG) } }, "list", { offset: 0 });
    const r = await walk(d, { path: ["Nowhere"], maxScrolls: 8 });
    expect(r.stop).toMatchObject({ why: "not-found", label: "Nowhere" });
    // 30 rows, 13 a page, 6 a scroll: three scrolls reach the end and the fourth shows nothing new;
    // the first screen of a walk is then scanned back to the top the same way.
    // THE MUTANT: keep scrolling the whole budget. That is 8 + 16 scrolls of a list that ended.
    expect(d.scrolls.filter((s) => s === "up")).toHaveLength(4);
    expect(d.scrolls.filter((s) => s === "down")).toHaveLength(4);
  });

  it("looks back up the list on the walk's first screen, which somebody may have scrolled", async () => {
    const d = new Device({ list: { rows: rows(...LONG) }, top: { heading: "Top", rows: [] } }, "list", { offset: 12 });
    d.screens.list!.rows[1] = { label: "Near the top", to: "top" };
    const r = await walk(d, { path: ["Near the top"] });
    expect(d.taps).toEqual(["Near the top"]);
    expect(d.scrolls).toContain("down");
    expect(r.steps[0]!.label).toBe("Near the top");
  });

  it("does not look back up a screen the walk opened itself — that one starts at the top", async () => {
    const d = new Device({ root: { rows: [{ label: "Go", to: "list" }] }, list: { rows: rows(...LONG) } }, "root");
    const r = await walk(d, { path: ["Go", "Nowhere"] });
    expect(r.stop?.why).toBe("not-found");
    // THE MUTANT: scan every screen both ways. A missing label on the second screen then costs a
    // full second pass over a list the walk has already seen from its top.
    expect(d.scrolls.every((s) => s === "up")).toBe(true);
  });

  it("stops quickly at the end of a list, rather than waiting out the scroll's timeout", async () => {
    const d = new Device({ list: { rows: rows(...LONG.slice(0, 5)) } }, "list");
    const r = await walk(d, { path: ["Nowhere"] });
    expect(r.stop?.why).toBe("not-found");
    // Two scrolls that moved nothing, each seen as nothing twice. THE MUTANT: wait for a change that
    // is never coming — two full scroll timeouts for a list that fits on one screen.
    expect(r.ms).toBeLessThan(2 * 2_000);
  });

  it("scrolls toward the middle a row that a bar at the TOP is drawn over", async () => {
    const d = new Device({ list: { rows: [{ label: "Wi-Fi", to: "wifi" }, ...rows(...LONG)], topBar: true }, wifi: { heading: "Wi-Fi", rows: [] } }, "list", { offset: 0 });
    // Row 1's centre (y=142) is under the bar (100-160). THE MUTANT: scroll the way the list goes
    // first, which carries the row further under the bar and off the top.
    d.offset = 0;
    const r = await walk(d, { path: ["Wi-Fi"], maxScrolls: 1 });
    expect(d.scrolls[0]).toBe("down");
    void r;
  });

  it("does not take what is drawn BEHIND a row for something covering it", async () => {
    const d = new Device({ list: { rows: rows("Alpha", "Beta"), background: true } }, "list");
    // THE MUTANT: count anything overlapping a row, before it in the tree or after. A list over a
    // background picture then has nothing that can be tapped.
    expect(findLabel(d.tree(), "Alpha")?.el.label).toBe("Alpha");
  });

  it("stops when a scroll does not reach the device, rather than scrolling on blind", async () => {
    const d = new Device({ list: { rows: rows(...LONG) } }, "list");
    const r = await walk(d, { path: ["Nowhere"] }, { scroll: async () => ({ ok: false, detail: "the device's input channel did not answer" }) });
    expect(r.stop).toMatchObject({ why: "tap-failed", detail: "the device's input channel did not answer" });
  });

  it("does not take a container drawn over the list for something covering it — only what it holds", async () => {
    const d = new Device({ list: { rows: rows("Alpha", "Beta", "Gamma"), topBar: true } }, "list");
    // The container fills the screen and comes after the rows; the bar inside it covers row 1 only.
    // THE MUTANT: count every element drawn later, containers too — then nothing is ever tappable.
    expect(findLabel(d.tree(), "Beta")?.el.label).toBe("Beta");
    expect(findLabel(d.tree(), "Alpha")).toBeNull();
  });

  it("counts a container as holding what is inside it even when the tree left out the layer between", () => {
    // The device runner's tree lists no empty container, so a bar's field can be its GRANDCHILD by path.
    // THE MUTANT: judge a leaf by its immediate parent — then the bar, whose child was left out, is a
    // leaf the size of the screen drawn over every row, and nothing can be tapped.
    const el = (path: string, label: string, role: string, frame: { x: number; y: number; width: number; height: number }) =>
      ({ path, label, value: "", role, id: null, enabled: true, frame, depth: path.split(".").length - 1 });
    const tree = { units: "points" as const, app: "Settings", screen: { width: 390, height: 844 }, elements: [
      el("0.0.0", "General", "Button", { x: 16, y: 365, width: 358, height: 52 }),
      el("0.1", "Bar", "Toolbar", { x: 0, y: 0, width: 390, height: 844 }),
      el("0.1.0.0", "Search", "SearchField", { x: 28, y: 778, width: 334, height: 28 }),
    ] };
    expect(findLabel(tree, "General")?.el.label).toBe("General");
  });

  it("scrolls a row that a floating bar is drawn over into the clear before tapping it", async () => {
    const list = [...rows(...LONG.slice(0, 11)), { label: "Screen Time", to: "time" }, ...rows(...LONG.slice(11, 20))];
    const d = new Device({ root: { rows: list, searchBar: true }, time: { heading: "Screen Time", rows: [] } }, "root");
    // Row 12 sits under the search bar: its centre is inside the bar's frame, so a tap there types
    // into search instead. THE MUTANT: match it where it is.
    const covered = findLabel(d.tree(), "Screen Time");
    expect(covered).toBeNull();
    const r = await walk(d, { path: ["Screen Time"] });
    expect(d.scrolls).toEqual(["up"]);
    expect(d.taps).toEqual(["Screen Time"]);
    expect(heading(r.final)).toBe("Screen Time");
  });
});

describe("where a walk stops", () => {
  it("never walks into a step that erases, buys, sends or signs out, and hands it back by name", async () => {
    const d = new Device(settings(), "root");
    const r = await walk(d, { path: ["General", "Erase All Content and Settings"] });
    expect(d.taps).toEqual(["General"]);
    expect(r.stop).toMatchObject({ why: "sensitive", label: "Erase All Content and Settings" });
    expect(r.stop!.detail).toContain('"erase"');
    // The element it would have tapped comes first, so the agent can take it by number if it means to.
    expect(r.stop!.candidates[0]!.label).toBe("Erase All Content and Settings");
  });

  it("judges the element as well as the words asked for", async () => {
    const screens = settings();
    screens.root!.rows.push({ label: "Buy iCloud+ for $0.99", to: "root" });
    const d = new Device(screens, "root");
    // "iCloud" asks for nothing sensitive; the row it matches is a purchase.
    const r = await walk(d, { path: ["iCloud"] });
    expect(r.stop?.why).toBe("sensitive");
    expect(d.taps).toEqual([]);
  });

  it("stops when a tap changes nothing, rather than going on as if it had worked", async () => {
    const d = new Device(settings(), "about");
    const r = await walk(d, { path: ["iOS Version", "Anything"] });
    expect(r.stop).toMatchObject({ why: "no-change", label: "iOS Version" });
    expect(d.taps).toEqual(["iOS Version"]);
  });

  it("takes a tap into a field that changed nothing as the field taking focus", async () => {
    const d = new Device({ form: { rows: [{ label: "Name", role: "TextField", nothing: true }] } }, "form");
    // THE MUTANT: hold a field to the rule for everything else. On a Mac a click into a field
    // changes nothing its tree shows, and the walk would stop there, before the typing it came for.
    const r = await walk(d, { path: ["Name"], text: "Ada" });
    expect(r.ok).toBe(true);
    expect(d.typed).toEqual(["Ada"]);
  });

  it("does not take the status bar's clock turning over for a tap that worked", async () => {
    const d = new Device(settings(), "about");
    const io = d.io();
    const read = io.read;
    // THE MUTANT: fold the status bar into the screen's signature. The minute changing mid-step
    // then reads as the tap having done something.
    io.read = async () => { d.clockLabel = d.clockLabel === "9:41" ? "9:42" : "9:41"; return read(); };
    const r = await runPath(io, { path: ["iOS Version"] });
    expect(r.stop?.why).toBe("no-change");
  });

  it("names the likeliest elements when a label is not there, and an alert that is in the way", async () => {
    const screens = settings();
    screens.root!.alert = "Allow “Maps” to use your location?";
    const d = new Device(screens, "root");
    const r = await walk(d, { path: ["Privacy settings"] });
    expect(r.stop?.why).toBe("not-found");
    expect(r.stop!.candidates[0]!.label).toBe("Privacy & Security");
    expect(r.stop!.detail).toContain("an alert is up");
  });

  it("checks the final screen for the label it was told to expect", async () => {
    const d = new Device(settings(), "root");
    expect((await walk(d, { path: ["General", "About"], until: "iOS Version" })).ok).toBe(true);
    const d2 = new Device(settings(), "root");
    const r = await walk(d2, { path: ["General", "Keyboard"], until: "iOS Version" });
    expect(r.stop).toMatchObject({ why: "not-there", label: "iOS Version" });
  });
});

describe("Laya, for a label nothing on the screen matches", () => {
  const pick = (label: string, confidence = 0.97): ((l: string, els: readonly { id: string; label: string }[]) => Promise<AssistOutcome>) =>
    async (_l, els) => {
      const element = els.find((e) => e.label === label)!;
      return { kind: "pick", element: element as never, confidence, ms: 12 };
    };

  it("is asked only after the screen and the scroll have come up empty, and its pick is tapped", async () => {
    const d = new Device(settings(), "root");
    const laya = vi.fn(pick("Wi-Fi"));
    const r = await walk(d, { path: ["General", "About"] }, { laya: laya as never });
    expect(laya).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);

    const d2 = new Device(settings(), "root");
    const heard: string[] = [];
    const r2 = await walk(d2, { path: ["wireless networks"] }, { laya: vi.fn(pick("Wi-Fi")) as never, observe: (s) => { heard.push(s.by); } });
    expect(d2.taps).toEqual(["Wi-Fi"]);
    expect(r2.steps[0]).toMatchObject({ how: "laya", matched: "Wi-Fi" });
    // The shadow is told who chose: Laya's picks are what its evaluation counts separately.
    expect(heard).toEqual(["laya"]);
  });

  it("offers Laya the screen without its status bar: the clock is nobody's goal, and takes a candidate's place", async () => {
    const d = new Device(settings(), "root");
    const laya = vi.fn(pick("Wi-Fi"));
    await walk(d, { path: ["wireless networks"] }, { laya: laya as never });
    const offered = laya.mock.calls[0]![1].map((e) => e.label);
    expect(offered).toContain("Wi-Fi");
    expect(offered).toContain("Settings");
    expect(offered).not.toContain("9:41");
  });

  it("taps nothing when Laya hands the choice back", async () => {
    const d = new Device(settings(), "root");
    const laya = vi.fn(async (): Promise<AssistOutcome> => ({ kind: "ask-agent", candidates: [], best: null, why: "unsure" }));
    const r = await walk(d, { path: ["wireless networks"] }, { laya });
    expect(laya).toHaveBeenCalledOnce();
    expect(r.stop?.why).toBe("not-found");
    expect(d.taps).toEqual([]);
  });

  it("still holds a sensitive step back when Laya is the one who picked it", async () => {
    const screens = settings();
    screens.root!.rows.push({ label: "Sign Out", to: "root" });
    const d = new Device(screens, "root");
    const r = await walk(d, { path: ["leave my account"] }, { laya: vi.fn(pick("Sign Out")) as never });
    expect(r.stop?.why).toBe("sensitive");
    expect(d.taps).toEqual([]);
  });
});

describe("typing at the end of a walk", () => {
  it("types into the field the walk's last tap landed on", async () => {
    const d = new Device({ root: { rows: [{ label: "Search", role: "SearchField", toggles: true }] } }, "root");
    const r = await walk(d, { path: ["Search"], text: "Siri" });
    expect(d.taps).toEqual(["Search"]);
    expect(d.typed).toEqual(["Siri"]);
    expect(r.steps.at(-1)).toMatchObject({ how: "typed" });
  });

  it("taps the only field on the screen first when the walk ended elsewhere", async () => {
    const d = new Device({ root: { rows: [{ label: "Name", role: "TextField", toggles: true }, { label: "Other", nothing: true }] } }, "root");
    await walk(d, { path: [], text: "Ada" });
    expect(d.taps).toEqual(["Name"]);
    expect(d.typed).toEqual(["Ada"]);
  });

  it("asks which field when there are several, and never types into a password field", async () => {
    const two = new Device({ root: { rows: [{ label: "First", role: "TextField" }, { label: "Last", role: "TextField" }] } }, "root");
    expect((await walk(two, { path: [], text: "x" })).stop?.why).toBe("which-field");
    expect(two.typed).toEqual([]);
    const secret = new Device({ root: { rows: [{ label: "Password", role: "SecureTextField" }] } }, "root");
    expect((await walk(secret, { path: [], text: "hunter2" })).stop?.why).toBe("sensitive");
    expect(secret.typed).toEqual([]);
  });
});

describe("the first screen", () => {
  it("waits out the device's \"not yet\" on the first read", async () => {
    const d = new Device(settings(), "root");
    d.failReads = 2;
    expect((await walk(d, { path: ["General"] })).ok).toBe(true);
  });

  it("waits for an app just launched to be the one in front, and for its screen to stop filling in", async () => {
    const screens: Record<string, Screen> = {
      home: { app: "", rows: rows("Settings", "Maps") },
      partial: { app: "Settings", rows: [] },
      root: settings().root!,
      general: settings().general!,
    };
    const d = new Device(screens, "home");
    const io = d.io();
    const read = io.read;
    const seq = ["home", "home", "partial", "root", "root"];
    io.read = async () => { if (seq.length) d.current = seq.shift()!; return read(); };
    const r = await runPath(io, { path: ["General"], launched: "Settings" });
    // THE MUTANT: take the first read of the app as its screen. That is Settings with no rows yet, and
    // General is then looked for by scrolling a list that is still filling in.
    expect(r.steps[0]?.label).toBe("General");
    expect(d.taps).toEqual(["General"]);
    expect(d.scrolls).toEqual([]);
  });

  it("says so when the app never comes to the front", async () => {
    const d = new Device({ home: { app: "", rows: rows("Maps") } }, "home");
    const r = await walk(d, { path: ["General"], launched: "Settings" });
    expect(r.stop).toMatchObject({ why: "not-found", label: "Settings" });
    expect(r.stop!.detail).toContain("did not come to the front");
    expect(d.taps).toEqual([]);
  });
});

describe("settling on the picture instead of the tree", () => {
  const motion = (script: ("still" | "none" | "moving" | "lost")[] = []) => {
    let n = 0;
    const m: ScreenMotion & { settles: number } = {
      settles: 0,
      mark: () => ({ moved: n, edges: 0, edgeBusy: false }),
      settle: async () => { m.settles++; n++; return script.shift() ?? "still"; },
      rest: async () => true,
      close: vi.fn(),
    };
    return m;
  };

  it("reads the tree once a step when the picture says the screen has come to rest", async () => {
    const polled = new Device(settings(), "root");
    await walk(polled, { path: ["General", "About"] });
    const watched = new Device(settings(), "root");
    const r = await walk(watched, { path: ["General", "About"] }, { motion: motion() });
    expect(r.ok).toBe(true);
    // One read to start and one per step. THE MUTANT: ignore the picture and poll the tree, which is
    // two reads a step at the very least — and each read is the slow part.
    expect(watched.reads).toBe(3);
    expect(polled.reads).toBeGreaterThanOrEqual(5);
  });

  it("looks again before a tap when the picture moved after the read — a row put in above", async () => {
    const d = new Device(settings(), "root");
    let moved = 0, reads = 0;
    const io = d.io();
    const read = io.read;
    // Settings puts a row in above General a moment after it launches: here, just after the first read.
    io.read = async () => {
      const t = await read();
      if (++reads === 1) { d.screens.root!.rows.unshift({ label: "Optimizing Search and Siri", nothing: true }); moved++; }
      return t;
    };
    const m: ScreenMotion = { mark: () => ({ moved, edges: 0, edgeBusy: false }), settle: async () => "still", rest: async () => true, close: () => {} };
    const r = await runPath({ ...io, motion: m }, { path: ["General"] });
    expect(r.ok).toBe(true);
    // THE MUTANT: tap where General was read — which is where the new row is now.
    expect(d.at.map((p) => p.y)).toEqual([rowY(1) + 22]);
    expect(heading(r.final)).toBe("General");
  });

  it("does not read again before a tap when nothing moved", async () => {
    const d = new Device(settings(), "root");
    const m: ScreenMotion = { mark: () => ({ moved: 0, edges: 0, edgeBusy: false }), settle: async () => "still", rest: async () => true, close: () => {} };
    await runPath({ ...d.io(), motion: m }, { path: ["General"] });
    // One read to start and one after the tap: a still picture costs no extra read.
    expect(d.reads).toBe(2);
  });

  it("waits past a picture that moved while the tree did not — a highlight on a tap still being answered", async () => {
    const d = new Device(settings(), "root");
    d.lag = 1;
    const m = motion(["still", "still"]);
    const r = await walk(d, { path: ["General"] }, { motion: m });
    expect(r.ok).toBe(true);
    expect(m.settles).toBe(2);
    expect(heading(r.final)).toBe("General");
  });

  it("calls a tap that moved nothing on the screen a tap that did nothing — after one look at the tree", async () => {
    const d = new Device(settings(), "about");
    const r = await walk(d, { path: ["iOS Version"] }, { motion: motion(["none"]) });
    expect(r.stop?.why).toBe("no-change");
    // The first read, and one to confirm: no picture change is not proof of no change.
    expect(d.reads).toBe(2);
  });

  it("takes a change the picture missed when the tree shows it — a switch at the edge", async () => {
    const d = new Device({ list: { rows: [{ label: "Airplane Mode", role: "Switch", value: "0", toggles: true }] } }, "list");
    // THE MUTANT: trust "none". The switch flipped, the picture could not tell it from a fading
    // scroll indicator, and the walk would stop saying the tap did nothing.
    const r = await walk(d, { path: ["Airplane Mode"] }, { motion: motion(["none"]) });
    expect(r.ok).toBe(true);
    expect(r.final.elements.find((e) => e.label === "Airplane Mode")?.value).toBe("1");
  });

  it("gives a scroll a short window to start moving, and a tap its whole timeout", async () => {
    const seen: { changeWithinMs: number }[] = [];
    const m: ScreenMotion = { mark: () => ({ moved: 0, edges: 0, edgeBusy: false }), settle: async (_m, o) => { seen.push(o); return "none"; }, rest: async () => true, close: () => {} };
    const d = new Device({ list: { rows: rows("Alpha"), fields: [] }, }, "list");
    await walk(d, { path: ["Nowhere"] }, { motion: m });
    // A scroll's picture moves while the finger does; one that has not moved soon after is the end.
    expect(seen[0]!.changeWithinMs).toBe(300);
    seen.length = 0;
    const t = new Device(settings(), "about");
    await walk(t, { path: ["iOS Version"] }, { motion: m });
    expect(seen[0]!.changeWithinMs).toBeGreaterThan(2_500);
  });

  it("takes a scroll that bounced back to the same screen for the end of the list", async () => {
    const d = new Device({ list: { rows: rows(...LONG.slice(0, 10)) } }, "list");
    const r = await walk(d, { path: ["Nowhere"] }, { motion: motion() });
    expect(r.stop?.why).toBe("not-found");
    expect(d.scrolls).toEqual(["up", "down"]);
  });

  it("falls back to reading the tree when the stream goes away mid-walk", async () => {
    const d = new Device(settings(), "root");
    const r = await walk(d, { path: ["General", "About"] }, { motion: motion(["lost", "lost"]) });
    expect(r.ok).toBe(true);
    expect(heading(r.final)).toBe("About");
  });
});

describe("a read the source vouches for", () => {
  /** The device's own reads, each marked as taken at rest — what a browser hands over when it reports
   *  its page loaded and its network quiet. */
  const vouched = (d: Device): Partial<ExecIO> => {
    const own = d.io();
    return { read: async () => ({ ...(await own.read()), atRest: true as const }) };
  };

  it("settles a step on one read, where any other read has to be read again and agree", async () => {
    const polled = new Device(settings(), "root");
    await walk(polled, { path: ["General", "About"] });
    const trusted = new Device(settings(), "root");
    const r = await walk(trusted, { path: ["General", "About"] }, vouched(trusted));
    expect(r.ok).toBe(true);
    expect(trusted.taps).toEqual(["General", "About"]);
    // One read to start and one a step. THE MUTANT: ignore the vouching, and read twice a step.
    expect(trusted.reads).toBe(3);
    expect(polled.reads).toBe(5);
  });

  it("still takes a tap that changed nothing for a tap that did nothing", async () => {
    const d = new Device({ root: { rows: [{ label: "Nothing here", nothing: true }] } }, "root");
    const r = await walk(d, { path: ["Nothing here"] }, vouched(d));
    expect(r.stop?.why).toBe("no-change");
  });

  it("ends a scroll that moved nothing on one read", async () => {
    const polled = new Device({ list: { rows: rows(...LONG.slice(0, 5)) } }, "list");
    await walk(polled, { path: ["Nowhere"] });
    const trusted = new Device({ list: { rows: rows(...LONG.slice(0, 5)) } }, "list");
    const r = await walk(trusted, { path: ["Nowhere"] }, vouched(trusted));
    expect(r.stop?.why).toBe("not-found");
    expect(trusted.scrolls).toEqual(polled.scrolls);
    expect([trusted.reads, polled.reads]).toEqual([3, 5]);
  });
});

describe("what the observer hears", () => {
  it("each tap before it is sent, with the element chosen, and each screen once it has settled", async () => {
    const d = new Device(settings(), "root");
    const order: string[] = [];
    const observe = vi.fn((s: { label: string; chosen: SimulatorAxElement; by: string }) => { order.push(`observe:${s.chosen.label}:${s.by}:${d.taps.length}`); });
    const settled = vi.fn((t: SimulatorAxTree) => { order.push(`settled:${heading(t)}`); });
    await walk(d, { path: ["General", "About"] }, { observe, settled });
    expect(order).toEqual(["observe:General:agent:0", "settled:General", "observe:About:agent:1", "settled:About"]);
  });
});

describe("fold and signature", () => {
  it("folds what a person would not tell apart", () => {
    expect(fold("Privacy & Security")).toBe("privacy and security");
    expect(fold("Wi‑Fi")).toBe("wi fi");
    expect(fold("  Screen  Time ")).toBe("screen time");
  });

  it("leaves the status bar out of what counts as the screen", () => {
    const d = new Device(settings(), "root");
    const a = signature(d.tree());
    d.clockLabel = "9:42";
    expect(signature(d.tree())).toBe(a);
  });
});
