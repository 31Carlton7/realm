import { describe, expect, it } from "vitest";
import { browserMenuItems, parseBrowserMenuChoice, type BrowserMenuInput } from "./browser-menu";

const input = (over: Partial<BrowserMenuInput> = {}): BrowserMenuInput => ({
  zoom: 1, canZoomIn: true, canZoomOut: true, back: [], forward: [], blocked: [], saved: [], shareTargets: [],
  hasPage: true, current: "Sign in", device: null, ...over,
});

type Row = { id?: string; label?: string; enabled?: boolean; checked?: boolean; submenu?: Row[]; type?: string };
const rows = (items: NativeMenuItem[]): Row[] => items as Row[];
const byLabel = (items: NativeMenuItem[], label: string) => rows(items).find((r) => r.label === label)!;
const ids = (items: NativeMenuItem[]): string[] => rows(items).flatMap((r) => [...(r.id ? [r.id] : []), ...(r.submenu ? ids(r.submenu as NativeMenuItem[]) : [])]);

describe("browserMenuItems", () => {
  it("lists the browser's controls in the order a browser's menu does — and no cookie import", () => {
    const labels = rows(browserMenuItems(input())).map((r) => r.label ?? "—");
    expect(labels).toEqual([
      "Find in page…", "Print…", "—", "Zoom out", "Actual size (100%)", "Zoom in", "Device size", "—",
      "Take a screenshot", "—", "Downloads", "History", "—", "Clear browsing data…", "Browser settings",
    ]);
    // Plan 26 D3: importing another browser's cookies or passwords would hand every agent the user's
    // real sessions. It is not offered, disabled or otherwise.
    expect(JSON.stringify(browserMenuItems(input()))).not.toMatch(/import|password/i);
  });

  it("every row it can answer with is one the pane knows how to run", () => {
    /* THE mutant: respell an id on one side only. Main answers with whatever id the row carried, and a
       row whose id parses to nothing is a menu item that silently does nothing. */
    const all = ids(browserMenuItems(input({
      back: [{ index: 0, label: "Home" }], forward: [{ index: 2, label: "Docs" }],
      blocked: [{ id: "bd_1", name: "week-3.pdf", ts: 1 }], saved: [{ id: "sd_1", name: "report.pdf", path: "/p/report.pdf", ts: 2 }],
      shareTargets: [{ id: "pSchool", name: "School" }],
    })));
    expect(all.length).toBeGreaterThan(10);
    for (const id of all) expect(parseBrowserMenuChoice(id), id).not.toBeNull();
    expect(all.map((id) => parseBrowserMenuChoice(id)!.kind)).toEqual(expect.arrayContaining([
      "find", "print", "zoom", "device", "screenshot", "save-download", "show-download", "history", "clear-data", "share-signin", "settings",
    ]));
  });

  it("offers to share this site's sign-in with each OTHER profile — the profile is what the row answers with", () => {
    const items = browserMenuItems(input({ shareTargets: [{ id: "pWork", name: "Work" }, { id: "pSchool", name: "School" }] }));
    const share = byLabel(items, "Share this site's sign-in with");
    expect(share.enabled).toBe(true);
    expect(share.submenu!.map((r) => [r.label, r.id])).toEqual([["Work", "share-signin:pWork"], ["School", "share-signin:pSchool"]]);
    expect(parseBrowserMenuChoice("share-signin:pSchool")).toEqual({ kind: "share-signin", profileId: "pSchool" });
    // It sits with the other things about the browser's data, just above Clear browsing data.
    const labels = rows(items).map((r) => r.label ?? "—");
    expect(labels.indexOf("Share this site's sign-in with")).toBe(labels.indexOf("Clear browsing data…") - 1);
    // A blank tab has no site whose sign-in could be shared.
    expect(byLabel(browserMenuItems(input({ hasPage: false, shareTargets: [{ id: "pWork", name: "Work" }] })), "Share this site's sign-in with").enabled).toBe(false);
  });

  it("with one profile there is no other to share with, and the row is not drawn at all", () => {
    expect(rows(browserMenuItems(input())).some((r) => r.label === "Share this site's sign-in with")).toBe(false);
  });

  it("with no page, only what is not about a page stays live", () => {
    const items = browserMenuItems(input({ hasPage: false }));
    for (const label of ["Find in page…", "Print…", "Zoom out", "Zoom in", "Device size", "Take a screenshot", "History"]) {
      expect(byLabel(items, label).enabled, label).toBe(false);
    }
    expect(byLabel(items, "Clear browsing data…").enabled).not.toBe(false);
    expect(byLabel(items, "Browser settings").enabled).not.toBe(false);
  });

  it("names the zoom level on the row that would undo it, and holds each end of the ladder", () => {
    const zoomed = browserMenuItems(input({ zoom: 1.25 }));
    expect(byLabel(zoomed, "Actual size (125%)").enabled).toBe(true);
    // At 100% there is nothing to reset.
    expect(byLabel(browserMenuItems(input()), "Actual size (100%)").enabled).toBe(false);
    const top = browserMenuItems(input({ zoom: 5, canZoomIn: false }));
    expect(byLabel(top, "Zoom in").enabled).toBe(false);
    expect(byLabel(top, "Zoom out").enabled).toBe(true);
  });

  it("Downloads: saves what was blocked, shows what was saved, newest first — or says there is nothing", () => {
    const items = browserMenuItems(input({
      blocked: [{ id: "bd_1", name: "old.pdf", ts: 1 }, { id: "bd_2", name: "new.pdf", ts: 2 }],
      saved: [{ id: "sd_1", name: "report.pdf", path: "/p/report.pdf", ts: 3 }],
    }));
    expect(byLabel(items, "Downloads").submenu!.map((r) => r.label ?? "—")).toEqual(["Save new.pdf", "Save old.pdf", "—", "Show report.pdf in Finder"]);
    const empty = byLabel(browserMenuItems(input()), "Downloads").submenu!;
    expect(empty).toEqual([{ label: "Nothing downloaded in this pane" }]);
  });

  it("History: the pages ahead, the page it is on — ticked, not choosable — then the pages behind", () => {
    const items = browserMenuItems(input({
      back: [{ index: 1, label: "Docs" }, { index: 0, label: "Home" }],
      forward: [{ index: 3, label: "Pricing" }, { index: 4, label: "Contact" }],
      current: "Sign in",
    }));
    const history = byLabel(items, "History").submenu!;
    expect(history.map((r) => [r.label, r.id ?? null, r.checked ?? false])).toEqual([
      ["Contact", "history:4", false], ["Pricing", "history:3", false],
      ["Sign in", null, true],
      ["Docs", "history:1", false], ["Home", "history:0", false],
    ]);
  });
});

describe("parseBrowserMenuChoice", () => {
  it("reads back exactly the ids the menu spells, and nothing else", () => {
    expect(parseBrowserMenuChoice("zoom:in")).toEqual({ kind: "zoom", step: "in" });
    expect(parseBrowserMenuChoice("download:save:bd_7")).toEqual({ kind: "save-download", id: "bd_7" });
    expect(parseBrowserMenuChoice("download:show:sd_2")).toEqual({ kind: "show-download", id: "sd_2" });
    expect(parseBrowserMenuChoice("history:12")).toEqual({ kind: "history", index: 12 });
    expect(parseBrowserMenuChoice(null)).toBeNull();
    expect(parseBrowserMenuChoice("history:-1")).toBeNull();
    expect(parseBrowserMenuChoice("zoom:sideways")).toBeNull();
    expect(parseBrowserMenuChoice("import-cookies")).toBeNull();
  });
});

describe("Device size (Plan 26 W7e)", () => {
  it("offers the pane, then a phone, a tablet and a desktop, each saying how wide it is — one ticked", () => {
    const rows = (device: BrowserMenuInput["device"]) => byLabel(browserMenuItems(input({ device })), "Device size").submenu!
      .map((r) => r.label ? `${r.checked ? "✓ " : ""}${r.label}` : "—");
    expect(rows(null)).toEqual(["✓ Fit the pane", "—", "iPhone · 390px", "iPad · 820px", "Desktop · 1440px"]);
    expect(rows("tablet")).toEqual(["Fit the pane", "—", "iPhone · 390px", "✓ iPad · 820px", "Desktop · 1440px"]);
  });

  it("each row answers with the preset it names, and Fit the pane with none", () => {
    expect(parseBrowserMenuChoice("device:phone")).toEqual({ kind: "device", preset: "phone" });
    expect(parseBrowserMenuChoice("device:desktop")).toEqual({ kind: "device", preset: "desktop" });
    expect(parseBrowserMenuChoice("device:none")).toEqual({ kind: "device", preset: null });
    expect(parseBrowserMenuChoice("device:watch")).toBeNull();
  });
});
