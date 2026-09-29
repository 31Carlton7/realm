import type { SimulatorAxElement, SimulatorAxTree } from "@realm/contracts";

/**
 * The device runner's `/hierarchy` → the `SimulatorAxTree` every simulator tool already speaks.
 *
 * The runner (`resources/ios-device-runner`) answers with the foreground app's XCUITest snapshot:
 * `{ bundleId, tree }`, where each node is `{ type, identifier, label, title, value?, placeholder?,
 * enabled, selected?, focused?, frame, children }` and frames are in POINTS from the top-left of the
 * portrait screen — the same unit serve-sim's tree reports, so nothing downstream converts.
 *
 * What differs from serve-sim's tree is how much of it there is. An XCUITest snapshot has a node for
 * every view that holds another, and most of those are `Other` with nothing to say: 99 of the 166 nodes
 * in Settings' root. Those are left out of the LIST — a container is not a thing anyone taps or reads
 * — while their children keep their full index paths, so a path still names one place in one tree and
 * two reads of the same screen still agree on every one of them.
 */

/** `XCUIElement.ElementType`, by raw value, in the words XCUITest's own header uses — read out of
 *  XCUIAutomation's `XCUIElementTypes.h`, not typed from memory. Index = raw value. */
export const XCUI_ELEMENT_TYPES = [
  "Any", "Other", "Application", "Group", "Window", "Sheet", "Drawer", "Alert", "Dialog", "Button",
  "RadioButton", "RadioGroup", "CheckBox", "DisclosureTriangle", "PopUpButton", "ComboBox", "MenuButton",
  "ToolbarButton", "Popover", "Keyboard", "Key", "NavigationBar", "TabBar", "TabGroup", "Toolbar",
  "StatusBar", "Table", "TableRow", "TableColumn", "Outline", "OutlineRow", "Browser", "CollectionView",
  "Slider", "PageIndicator", "ProgressIndicator", "ActivityIndicator", "SegmentedControl", "Picker",
  "PickerWheel", "Switch", "Toggle", "Link", "Image", "Icon", "SearchField", "ScrollView", "ScrollBar",
  "StaticText", "TextField", "SecureTextField", "DatePicker", "TextView", "Menu", "MenuItem", "MenuBar",
  "MenuBarItem", "Map", "WebView", "IncrementArrow", "DecrementArrow", "Timeline", "RatingIndicator",
  "ValueIndicator", "SplitGroup", "Splitter", "RelevanceIndicator", "ColorWell", "HelpTag", "Matte",
  "DockItem", "Ruler", "RulerMarker", "Grid", "LevelIndicator", "Cell", "LayoutArea", "LayoutItem",
  "Handle", "Stepper", "Tab", "TouchBar", "StatusItem",
] as const;

/** A type number this table has no word for — a newer Xcode's — still arrives, as itself. */
export const roleOf = (type: unknown): string =>
  typeof type === "number" && Number.isInteger(type) && type >= 0 && type < XCUI_ELEMENT_TYPES.length
    ? XCUI_ELEMENT_TYPES[type]!
    : typeof type === "number" ? `Type${type}` : "Element";

type Node = Record<string, unknown>;

/** An element as the runner reads it, plus the one thing iOS's snapshot can say that serve-sim's
 *  tree cannot: which element has focus. Only ever `true` when present. */
export type RunnerElement = SimulatorAxElement & { focused?: true };

export function parseRunnerTree(body: string): (SimulatorAxTree & { bundleId: string; elements: RunnerElement[] }) | null {
  let v: unknown;
  try { v = JSON.parse(body); } catch { return null; }
  if (!v || typeof v !== "object") return null;
  const root = (v as { tree?: unknown }).tree as Node | undefined;
  if (!root || typeof root !== "object") return null;
  const rootFrame = frameOf(root);
  if (!rootFrame) return null;
  const elements: RunnerElement[] = [];
  const walk = (node: Node, path: string, depth: number): void => {
    const frame = frameOf(node);
    const role = roleOf(node.type);
    const label = str(node.label);
    const id = str(node.identifier);
    /* The value a person sees in the element: what it holds, or — for an empty field — what it says
       it is for. serve-sim's tree reports a field's placeholder as its value in exactly that case,
       and the tools read the two trees the same way. */
    const value = str(node.value) || str(node.placeholder);
    /* The Application node is the SCREEN, not an element on it (serve-sim's rule too), and an `Other`
       that names nothing is a container: both are walked through rather than listed. */
    if (frame && depth > 0 && (role !== "Other" || label || id || value)) {
      elements.push({
        path, label, value, role, id: id || null,
        enabled: node.enabled !== false,
        frame, depth,
        ...(node.focused === true ? { focused: true as const } : {}),
      });
    }
    const kids = Array.isArray(node.children) ? (node.children as Node[]) : [];
    kids.forEach((k, i) => { if (k && typeof k === "object") walk(k, `${path}.${i}`, depth + 1); });
  };
  walk(root, "0", 0);
  return {
    units: "points",
    screen: { width: rootFrame.width, height: rootFrame.height },
    app: str(root.label),
    bundleId: str((v as { bundleId?: unknown }).bundleId),
    elements,
  };
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** A frame worth drawing: four finite numbers and a size. The runner writes 0 where XCUITest said
 *  infinity or NaN (JSON has neither), and a zero-sized element is nothing to tap. */
function frameOf(node: Node): SimulatorAxElement["frame"] | null {
  const f = node.frame as Record<string, unknown> | undefined;
  if (!f || typeof f !== "object") return null;
  const n = (k: string) => (typeof f[k] === "number" && Number.isFinite(f[k]) ? (f[k] as number) : null);
  const [x, y, width, height] = [n("x"), n("y"), n("width"), n("height")];
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}
