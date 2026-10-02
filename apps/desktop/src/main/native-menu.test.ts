import { afterEach, describe, expect, it, vi } from "vitest";
import { MENU_CLOSE_GRACE_MS, MENU_DEPTH_MAX, MENU_ITEMS_MAX, MENU_LABEL_MAX, menuAnchor, menuTemplate, popupNativeMenu, type MenuTemplateItem } from "./native-menu";

/** The template with its click handlers stripped, so a row reads as what the OS will draw. */
const drawn = (t: MenuTemplateItem[]): unknown[] => t.map(({ click, submenu, ...rest }) => ({
  ...rest, ...(click ? { choosable: true } : {}), ...(submenu ? { submenu: drawn(submenu) } : {}),
}));

describe("menuTemplate", () => {
  it("turns the renderer's rows into the OS's, and only a row with an id can be chosen", () => {
    const picked: string[] = [];
    const t = menuTemplate([
      { id: "find", label: "Find in page", accelerator: "CmdOrCtrl+F" },
      { type: "separator" },
      { id: "zoom-out", label: "Zoom out", enabled: false },
      { label: "Nothing downloaded in this pane" },
      { id: "history", label: "History", submenu: [{ id: "h:2", label: "Docs", checked: true }, { id: "h:1", label: "Home" }] },
    ], (id) => picked.push(id));
    expect(drawn(t)).toEqual([
      { label: "Find in page", enabled: true, accelerator: "CmdOrCtrl+F", registerAccelerator: false, choosable: true },
      { type: "separator" },
      { label: "Zoom out", enabled: false, choosable: true },
      // No id is a line of information: drawn, but never a row that answers.
      { label: "Nothing downloaded in this pane", enabled: false },
      { label: "History", enabled: true, submenu: [
        { label: "Docs", enabled: true, type: "checkbox", checked: true, choosable: true },
        { label: "Home", enabled: true, choosable: true },
      ] },
    ]);
    t[0]!.click!();
    t[4]!.submenu![1]!.click!();
    expect(picked).toEqual(["find", "h:1"]);
  });

  it("never registers an accelerator — the popup shows the binding, it does not own the key", () => {
    /* THE mutant: register it. A popup that registers ⌘F becomes a second owner of a key the pane
       already binds, and Electron gives it to whichever menu was built last. */
    const [row] = menuTemplate([{ id: "find", label: "Find in page", accelerator: "CmdOrCtrl+F" }], () => {});
    expect(row).toMatchObject({ accelerator: "CmdOrCtrl+F", registerAccelerator: false });
    // An accelerator Electron would throw on is dropped rather than taking the menu down with it.
    const [bad] = menuTemplate([{ id: "x", label: "X", accelerator: "Cmd+F; rm -rf" }], () => {});
    expect(bad).not.toHaveProperty("accelerator");
  });

  it("cuts a page's long title to something a menu can be scanned by", () => {
    const [row] = menuTemplate([{ id: "h:0", label: `${"A very long page title ".repeat(10)}\n\twith a tail` }], () => {});
    expect(row!.label!.length).toBe(MENU_LABEL_MAX);
    expect(row!.label!.endsWith("…")).toBe(true);
    expect(row!.label).not.toMatch(/[\n\t]/);
  });

  it("tidies separators: none leading, none trailing, never two in a row", () => {
    const t = menuTemplate([
      { type: "separator" }, { id: "a", label: "A" }, { type: "separator" }, { type: "separator" },
      { id: "b", label: "B" }, { type: "separator" },
    ], () => {});
    expect(t.map((r) => r.type ?? r.label)).toEqual(["A", "separator", "B"]);
  });

  it("an empty submenu is a disabled row, not an arrow that opens onto nothing", () => {
    const [row] = menuTemplate([{ id: "downloads", label: "Downloads", submenu: [{ type: "separator" }] }], () => {});
    expect(row).toEqual({ label: "Downloads", enabled: false });
  });

  it("drops what is not a row, and bounds how much one request can describe", () => {
    expect(menuTemplate("not a list", () => {})).toEqual([]);
    expect(menuTemplate([null, 3, { label: "" }, { label: 7 }, { id: "ok", label: "Ok" }], () => {}).map((r) => r.label)).toEqual(["Ok"]);
    const many = Array.from({ length: MENU_ITEMS_MAX + 10 }, (_, i) => ({ id: `r${i}`, label: `Row ${i}` }));
    expect(menuTemplate(many, () => {})).toHaveLength(MENU_ITEMS_MAX);
    // Nesting past the depth bound comes back as a disabled row rather than recursing without end.
    let deep: unknown = [{ id: "leaf", label: "Leaf" }];
    for (let i = 0; i < MENU_DEPTH_MAX + 2; i++) deep = [{ label: `Level ${i}`, submenu: deep }];
    const flatten = (t: MenuTemplateItem[], d = 0): number => Math.max(d, ...t.map((r) => (r.submenu ? flatten(r.submenu, d + 1) : d)));
    expect(flatten(menuTemplate(deep, () => {}))).toBeLessThan(MENU_DEPTH_MAX);
  });
});

describe("menuAnchor", () => {
  it("takes a window-relative point and nothing else", () => {
    expect(menuAnchor({ x: 10.6, y: 40.2 })).toEqual({ x: 11, y: 40 });
    expect(menuAnchor({ x: -5, y: 3 })).toEqual({ x: 0, y: 3 });
    expect(menuAnchor({ x: Number.NaN, y: 3 })).toBeNull();
    expect(menuAnchor({ x: "10", y: 3 })).toBeNull();
    expect(menuAnchor(null)).toBeNull();
  });
});

describe("popupNativeMenu", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("answers with the id of the row that was chosen, at the point the renderer asked for", async () => {
    let shown: { t: MenuTemplateItem[]; at: { x: number; y: number }; close: () => void } | null = null;
    const answer = popupNativeMenu([{ id: "print", label: "Print…" }], { x: 120, y: 44 }, (t, at, close) => { shown = { t, at, close }; });
    expect(shown!.at).toEqual({ x: 120, y: 44 });
    // The OS's order on a Mac: the row's action, then the menu's close.
    shown!.t[0]!.click!();
    shown!.close();
    expect(await answer).toBe("print");
  });

  it("a choice is never read as a dismissal, even when the close arrives first", async () => {
    /* THE mutant: settle null on close at once. Electron documents that the click runs first, but if a
       close ever beat it the menu would silently do nothing for the row the user chose. */
    vi.useFakeTimers();
    let close = () => {};
    let click = () => {};
    const answer = popupNativeMenu([{ id: "zoom-in", label: "Zoom in" }], { x: 0, y: 0 }, (t, _at, onClose) => { close = onClose; click = t[0]!.click!; });
    close();
    await vi.advanceTimersByTimeAsync(MENU_CLOSE_GRACE_MS / 2);
    click();
    expect(await answer).toBe("zoom-in");
  });

  it("a menu dismissed without a choice answers null once the grace has passed", async () => {
    vi.useFakeTimers();
    let close = () => {};
    let done = false;
    const answer = popupNativeMenu([{ id: "a", label: "A" }], { x: 0, y: 0 }, (_t, _at, onClose) => { close = onClose; });
    void answer.then(() => { done = true; });
    close();
    await vi.advanceTimersByTimeAsync(MENU_CLOSE_GRACE_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await answer).toBeNull();
  });

  it("nothing to show, or nowhere to show it, answers null without popping anything", async () => {
    const popup = vi.fn();
    expect(await popupNativeMenu([], { x: 0, y: 0 }, popup)).toBeNull();
    expect(await popupNativeMenu([{ id: "a", label: "A" }], { x: "left" }, popup)).toBeNull();
    expect(popup).not.toHaveBeenCalled();
  });
});
