import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ clipboard: {}, Menu: {}, shell: {} }));
const { textMenuTemplate } = await import("./text-context-menu");

const base = {
  x: 0, y: 0, isEditable: false, selectionText: "", misspelledWord: "", dictionarySuggestions: [] as string[], linkURL: "",
  mediaType: "none" as const,
  editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canDelete: false, canSelectAll: false, canEditRichly: false },
};
const act = () => ({ replaceMisspelling: vi.fn(), learnSpelling: vi.fn(), lookUp: vi.fn(), openLink: vi.fn(), copyLink: vi.fn(), copyImageAt: vi.fn() });
const shape = (t: ReturnType<typeof textMenuTemplate>) => t?.map((i) => i.type === "separator" ? "—" : (i.label ?? i.role));

describe("the text context menu", () => {
  it("offers nothing for a right-click on nothing, rather than a menu of disabled rows", () => {
    expect(textMenuTemplate(base, act())).toBeNull();
  });

  it("leads with spelling guesses in a field, then the edit commands, Cocoa's order", () => {
    const a = act();
    const t = textMenuTemplate({ ...base, isEditable: true, misspelledWord: "recieve", dictionarySuggestions: ["receive", "relieve"],
      editFlags: { ...base.editFlags, canPaste: true, canSelectAll: true } }, a);
    expect(shape(t)).toEqual(["receive", "relieve", "Learn Spelling", "—", "cut", "copy", "paste", "—", "selectAll"]);
    (t![0]!.click as () => void)();
    expect(a.replaceMisspelling).toHaveBeenCalledWith("receive");
    // Cut and Copy are there but say they cannot run — the field has nothing selected.
    expect(t!.find((i) => i.role === "cut")!.enabled).toBe(false);
    expect(t!.find((i) => i.role === "paste")!.enabled).toBe(true);
  });

  it("says when it has no guess instead of dropping the spelling group", () => {
    const t = textMenuTemplate({ ...base, isEditable: true, misspelledWord: "xqzv" }, act());
    expect(shape(t)!.slice(0, 2)).toEqual(["No Guesses Found", "Learn Spelling"]);
  });

  it("gives a transcript selection Look Up and Copy, and names what it will look up", () => {
    const t = textMenuTemplate({ ...base, selectionText: "  an unusually long phrase to define  " }, act());
    expect(shape(t)).toEqual(["Look Up “an unusually long…”", "—", "copy"]);
  });

  it("offers a link's two actions, and only for a scheme the OS should open", () => {
    const a = act();
    const t = textMenuTemplate({ ...base, linkURL: "https://realm.computer" }, a);
    expect(shape(t)).toEqual(["Open Link in Default Browser", "Copy Link"]);
    (t![1]!.click as () => void)();
    expect(a.copyLink).toHaveBeenCalledWith("https://realm.computer");
    expect(textMenuTemplate({ ...base, linkURL: "javascript:alert(1)" }, act())).toBeNull();
  });

  it("gives a web page Back, Forward and Reload where nothing more specific is under the pointer", () => {
    const nav = { canGoBack: true, canGoForward: false, back: vi.fn(), forward: vi.fn(), reload: vi.fn() };
    const t = textMenuTemplate(base, { ...act(), navigation: nav });
    expect(shape(t)).toEqual(["Back", "Forward", "Reload"]);
    expect(t![1]!.enabled).toBe(false);
    // …and not over a selection, where the page's own words are what the click was about.
    expect(shape(textMenuTemplate({ ...base, selectionText: "x" }, { ...act(), navigation: nav }))).not.toContain("Back");
  });
});
