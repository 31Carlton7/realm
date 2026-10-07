import { describe, expect, it, vi } from "vitest";
import { DEFAULT_KEYBINDINGS, KEY_COMMANDS, type Keybinding } from "@realm/contracts";
import type { MenuItemConstructorOptions } from "electron";
import { MENU_LAYOUT, acceleratorFor, appMenuTemplate, pageChords, shouldPageOwn } from "./app-menu";

const build = (over: Partial<Parameters<typeof appMenuTemplate>[0]> = {}) => {
  const send = vi.fn();
  const template = appMenuTemplate({ appName: "Realm", rules: DEFAULT_KEYBINDINGS, send, openExternal: vi.fn(), developer: false, darwin: true, ...over });
  return { template, send };
};
/** Every item in the menu bar, depth first. */
const all = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
  items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? all(i.submenu) : [])]);
const find = (items: MenuItemConstructorOptions[], label: string) => all(items).find((i) => i.label === label);
const keyDown = (code: string, key: string, mods: { meta?: boolean; shift?: boolean; alt?: boolean; control?: boolean } = {}) =>
  ({ type: "keyDown" as const, code, key, meta: !!mods.meta, shift: !!mods.shift, alt: !!mods.alt, control: !!mods.control });

describe("the menu bar", () => {
  it("offers only commands the keybinding catalog has", () => {
    const ids = new Set(KEY_COMMANDS.map((c) => c.id));
    for (const r of Object.values(MENU_LAYOUT).flat()) if (r) expect(ids, r.command).toContain(r.command);
  });

  it("puts Settings… under the app's name with ⌘, beside it, as every Mac app does", () => {
    const { template } = build();
    const appMenu = template[0]!;
    expect(appMenu.label).toBe("Realm");
    const settings = (appMenu.submenu as MenuItemConstructorOptions[]).find((i) => i.label === "Settings…");
    expect(settings?.accelerator).toBe("Command+,");
  });

  /* THE mutant: a menu that hardcodes its shortcuts. A person who rebinds a command in Settings ▸ Keys
     would see the menu bar go on advertising a chord that now does something else. */
  it("shows the person's own shortcut, follows a rebinding, and shows none for an unbound command", () => {
    const rebound: Keybinding[] = [...DEFAULT_KEYBINDINGS, { key: "mod+alt+n", command: "session.new" }, { key: "mod+n", command: "" }];
    const { template } = build({ rules: rebound });
    expect(find(template, "New Session")?.accelerator).toBe("Command+Alt+N");
    const unbound: Keybinding[] = [...DEFAULT_KEYBINDINGS, { key: "mod+b", command: "" }];
    expect(find(build({ rules: unbound }).template, "Toggle Sidebar")).not.toHaveProperty("accelerator");
    expect(find(build().template, "Split Down")?.accelerator).toBe("Command+Shift+\\");
  });

  it("runs a row's command in the renderer when clicked", () => {
    const { template, send } = build();
    (find(template, "Close Tab or Split")!.click as () => void)();
    expect(send).toHaveBeenCalledWith("pane.close");
  });

  /* ⌘R reloading the whole app was the default menu's gift to every user. */
  it("keeps Reload and Developer Tools for a development build only", () => {
    const roles = (t: MenuItemConstructorOptions[]) => all(t).map((i) => i.role).filter(Boolean);
    expect(roles(build().template)).not.toContain("reload");
    expect(roles(build().template)).not.toContain("toggleDevTools");
    expect(roles(build({ developer: true }).template)).toEqual(expect.arrayContaining(["reload", "toggleDevTools"]));
  });

  it("never binds ⌘W to the window — a tab or a split closes, the window keeps its red button", () => {
    const items = all(build().template);
    expect(items.map((i) => i.role)).not.toContain("close");
    expect(items.filter((i) => i.accelerator === "Command+W").map((i) => i.label)).toEqual(["Close Tab or Split"]);
  });

  it("gives Help its search field and the window list its place", () => {
    const { template } = build();
    expect(template.some((m) => m.role === "help")).toBe(true);
    expect(template.some((m) => m.role === "window")).toBe(true);
  });
});

describe("whose keystroke is it", () => {
  const owned = pageChords(DEFAULT_KEYBINDINGS);

  /* THE mutant this kills is the reason the routing exists: a menu accelerator firing first, so ⌘B in
     a rich field toggles the sidebar instead of making bold. */
  it("hands the app's own chords to the page, and leaves the system's to the menu", () => {
    expect(shouldPageOwn(keyDown("KeyB", "b", { meta: true }), owned)).toBe(true);
    expect(shouldPageOwn(keyDown("KeyW", "w", { meta: true }), owned)).toBe(true);
    expect(shouldPageOwn(keyDown("Comma", ",", { meta: true }), owned)).toBe(true);
    // A shifted chord is matched by its physical key, whatever character the layout reports.
    expect(shouldPageOwn(keyDown("Backslash", "|", { meta: true, shift: true }), owned)).toBe(true);
    for (const [code, key] of [["KeyC", "c"], ["KeyV", "v"], ["KeyZ", "z"], ["KeyQ", "q"], ["KeyH", "h"], ["KeyM", "m"]])
      expect(shouldPageOwn(keyDown(code!, key!, { meta: true }), owned), key).toBe(false);
    expect(shouldPageOwn({ ...keyDown("KeyB", "b", { meta: true }), type: "keyUp" }, owned)).toBe(false);
  });

  /* The file's own precedence: the last rule for a chord wins. THE mutant is claiming any chord any
     rule ever bound, which keeps a key the person explicitly freed away from the menu forever. */
  it("frees a chord the person unbound, and keeps one a later rule binds again", () => {
    expect(pageChords([...DEFAULT_KEYBINDINGS, { key: "mod+b", command: "" }]).has("mod+b")).toBe(false);
    expect(pageChords([{ key: "mod+b", command: "" }, { key: "mod+b", command: "sidebar.toggle" }]).has("mod+b")).toBe(true);
    // A conditional unbinding frees the key only in its context, so the page still needs it elsewhere.
    expect(pageChords([...DEFAULT_KEYBINDINGS, { key: "mod+b", command: "", when: "inputFocus" }]).has("mod+b")).toBe(true);
  });
});

describe("accelerators", () => {
  it("spell each canonical chord the way the menu bar prints it", () => {
    expect(acceleratorFor("mod+,")).toBe("Command+,");
    expect(acceleratorFor("mod+shift+\\")).toBe("Command+Shift+\\");
    expect(acceleratorFor("ctrl+shift+tab")).toBe("Control+Shift+Tab");
    expect(acceleratorFor("mod+alt+left")).toBe("Command+Alt+Left");
    expect(acceleratorFor("escape")).toBe("Escape");
    expect(acceleratorFor("mod+shift+enter")).toBe("Command+Shift+Return");
    expect(acceleratorFor("not a chord")).toBeUndefined();
  });
});
