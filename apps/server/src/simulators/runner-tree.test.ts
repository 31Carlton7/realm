import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRunnerTree, roleOf, XCUI_ELEMENT_TYPES } from "./runner-tree";

/** What the device runner answered for Settings' root on the iPhone 17e simulator, iOS 27.0 — the
 *  simulator's own Settings, so nothing in it is anybody's. */
const SETTINGS = readFileSync(join(__dirname, "fixtures", "runner-settings.json"), "utf8");

describe("the runner's tree, as the simulator tools read one", () => {
  it("is Settings, measured in points, on a screen the size of the root's frame", () => {
    const tree = parseRunnerTree(SETTINGS)!;
    expect(tree).toMatchObject({ units: "points", app: "Settings", bundleId: "com.apple.Preferences", screen: { width: 390, height: 844 } });
  });

  it("names each element by the XCUITest type its number is, and keeps the app's own labels and ids", () => {
    const tree = parseRunnerTree(SETTINGS)!;
    const general = tree.elements.find((e) => e.id === "com.apple.settings.general")!;
    expect(general).toMatchObject({ role: "Button", label: "General", enabled: true, frame: { x: 16, width: 358, height: 52 } });
    // Points as the tree reports them, fractions and all: rounding is for printing, not for tapping.
    expect(general.frame.y).toBeCloseTo(365.33, 2);
    expect(tree.elements.find((e) => e.role === "NavigationBar")).toMatchObject({ id: "Settings" });
    expect(tree.elements.some((e) => e.role === "StaticText" && e.label === "General")).toBe(true);
  });

  it("leaves out the screen itself and every container that names nothing, and keeps each element's full path", () => {
    const raw = JSON.parse(SETTINGS) as { tree: Record<string, unknown> };
    let nodes = 0;
    const count = (n: Record<string, unknown>): void => { nodes++; for (const c of (n.children as Record<string, unknown>[]) ?? []) count(c); };
    count(raw.tree);
    const tree = parseRunnerTree(SETTINGS)!;
    expect(tree.elements.some((e) => e.role === "Application")).toBe(false);
    expect(tree.elements.some((e) => e.role === "Other" && !e.label && !e.id && !e.value)).toBe(false);
    // Well under the node count: the snapshot's containers are most of it.
    expect(tree.elements.length).toBeLessThan(nodes / 2);
    // A path is a place in the WHOLE tree, containers included, so it names the same node read after read.
    const general = tree.elements.find((e) => e.id === "com.apple.settings.general")!;
    let at: Record<string, unknown> = raw.tree;
    for (const i of general.path.split(".").slice(1)) at = (at.children as Record<string, unknown>[])[Number(i)]!;
    expect(at.identifier).toBe("com.apple.settings.general");
    expect(general.depth).toBe(general.path.split(".").length - 1);
    expect(parseRunnerTree(SETTINGS)!.elements.map((e) => e.path)).toEqual(tree.elements.map((e) => e.path));
  });

  it("reads an empty field's placeholder as its value, as serve-sim's tree does", () => {
    const field = parseRunnerTree(SETTINGS)!.elements.find((e) => e.role === "SearchField")!;
    expect(field).toMatchObject({ label: "Search", value: "Search" });
    const typed = parseRunnerTree(JSON.stringify(doc([{ type: 49, label: "Name", value: "Carl", placeholder: "Your name", frame: F }])))!;
    expect(typed.elements[0]!.value).toBe("Carl");
  });

  it("says which element has focus only where the snapshot says one does", () => {
    const tree = parseRunnerTree(JSON.stringify(doc([
      { type: 49, label: "Search", focused: true, frame: F },
      { type: 9, label: "Cancel", focused: false, frame: F },
    ])))!;
    expect(tree.elements[0]!.focused).toBe(true);
    expect("focused" in tree.elements[1]!).toBe(false);
  });

  it("keeps an unlabelled Other that has an id or a value, and drops one with nothing but a frame", () => {
    const tree = parseRunnerTree(JSON.stringify(doc([
      { type: 1, identifier: "label-view", frame: F },
      { type: 1, label: "", value: "50%", frame: F },
      { type: 1, frame: F, children: [{ type: 9, label: "Inside", frame: F }] },
    ])))!;
    expect(tree.elements.map((e) => [e.path, e.role, e.id ?? (e.value || e.label)])).toEqual([
      ["0.0", "Other", "label-view"], ["0.1", "Other", "50%"], ["0.2.0", "Button", "Inside"],
    ]);
  });

  it("drops an element with no size, and one whose frame is not four numbers", () => {
    const tree = parseRunnerTree(JSON.stringify(doc([
      { type: 9, label: "Zero", frame: { x: 0, y: 0, width: 0, height: 10 } },
      { type: 9, label: "Broken", frame: { x: "a", y: 0, width: 10, height: 10 } },
      { type: 9, label: "Fine", frame: F },
    ])))!;
    expect(tree.elements.map((e) => e.label)).toEqual(["Fine"]);
  });

  it("marks a disabled element disabled and everything else enabled", () => {
    const tree = parseRunnerTree(JSON.stringify(doc([{ type: 9, label: "Off", enabled: false, frame: F }, { type: 9, label: "On", frame: F }])))!;
    expect(tree.elements.map((e) => e.enabled)).toEqual([false, true]);
  });

  it("is no tree at all for junk, a missing root, or a root with no size", () => {
    expect(parseRunnerTree("not json")).toBeNull();
    expect(parseRunnerTree("{}")).toBeNull();
    expect(parseRunnerTree(JSON.stringify({ tree: { type: 2, frame: { x: 0, y: 0, width: 0, height: 0 } } }))).toBeNull();
  });

  it("calls a type number it has no word for by its number, and anything else an element", () => {
    expect(roleOf(9)).toBe("Button");
    expect(roleOf(75)).toBe("Cell");
    expect(roleOf(XCUI_ELEMENT_TYPES.length)).toBe(`Type${XCUI_ELEMENT_TYPES.length}`);
    expect(roleOf("9")).toBe("Element");
    expect(roleOf(-1)).toBe("Type-1");
  });
});

const F = { x: 10, y: 10, width: 100, height: 40 };
function doc(children: Record<string, unknown>[]) {
  return { bundleId: "com.example", tree: { type: 2, label: "Example", frame: { x: 0, y: 0, width: 390, height: 844 }, children } };
}
