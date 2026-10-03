import type { Input, MenuItemConstructorOptions } from "electron";
import { chordFromEvent, chordsForCommand, normalizeKeyChord, parseKeyChord, type Keybinding } from "@realm/contracts";

/**
 * The menu bar.
 *
 * A Mac user reaches for the menu bar without thinking: Settings… under the app's name with ⌘, beside
 * it, File ▸ New, a View menu that names what it shows, a Window menu that lists the window, a Help
 * menu with its search field. Electron's default gave none of that, and gave Reload and Developer
 * Tools to every user instead — ⌘R reloaded the whole app.
 *
 * Every app item is a command from the keybinding catalog (`KEY_COMMANDS`), and the shortcut it shows
 * is whatever the person's own keybindings currently resolve that command to (`chordsForCommand`), so
 * a rebinding in Settings ▸ Keys is a rebinding in the menu bar too. A CLICK sends the command id to
 * the renderer, which runs the same runner the keystroke does.
 *
 * The keystroke itself never goes through the menu. A menu accelerator fires BEFORE the page sees the
 * key — on macOS `registerAccelerator: false` does not stop it — and would walk straight past the
 * keybinding layer's `when` clauses: ⌘B would toggle the sidebar from inside a rich field instead of
 * making bold. So every chord the person's rules bind belongs to the page (`shouldPageOwn`, asked per
 * keystroke from `before-input-event`), and the menu keeps only the system's own: copy, paste, undo,
 * quit, hide, minimize, full screen.
 */

/** A menu row for a catalog command, with the title-case label a menu bar uses. */
type CommandRow = { command: string; label: string };
const row = (command: string, label: string): CommandRow => ({ command, label });

/** Which catalog commands the menu bar offers, and where. Each id must be in `KEY_COMMANDS` with a
 *  runner in the renderer — `app-menu.test.ts` holds both. */
export const MENU_LAYOUT = {
  app: [row("settings.open", "Settings…")],
  file: [
    row("session.new", "New Session"), row("session.quickChat", "New Quick Chat"),
    row("terminal.new", "New Terminal"), row("browser.new", "New Browser"),
    null,
    row("session.attachFiles", "Attach Files…"),
    null,
    // A pane, never the window: closing a pane leaves the object behind it (design.md), and the
    // window's own close is its red button.
    row("pane.close", "Close Pane"),
  ],
  view: [
    row("sidebar.toggle", "Toggle Sidebar"), row("palette.toggle", "Command Palette…"), row("spaces.toggle", "All Spaces"),
    null,
    row("pane.toggleFocus", "Focus Pane"), row("terminal.toggle", "Toggle Terminal"), row("diff.open", "Show Changes"),
    row("documents.open", "Documents"), row("activity.open", "MCP Activity"),
  ],
  go: [
    // Where the WINDOW has been, rooms included (Plan 26 W4) — then the focused pane's own trail.
    row("window.back", "Go Back"), row("window.forward", "Go Forward"),
    null,
    row("pane.navBack", "Back"), row("pane.navForward", "Forward"),
    null,
    row("paneGroup.previous", "Previous Split"), row("paneGroup.next", "Next Split"),
    null,
    row("space.previous", "Previous Space"), row("space.next", "Next Space"),
    null,
    row("palette.files", "Open File…"), row("palette.grep", "Find in Files…"),
  ],
  window: [row("pane.splitRight", "Split Right"), row("pane.splitDown", "Split Down"), row("paneGroup.new", "New Split")],
} satisfies Record<string, readonly (CommandRow | null)[]>;

/** A canonical chord (`mod+shift+\`) as an Electron accelerator (`Command+Shift+\`), or undefined
 *  for a key the menu bar cannot print. */
const ACCELERATOR_KEYS: Readonly<Record<string, string>> = {
  escape: "Escape", enter: "Return", tab: "Tab", space: "Space", backspace: "Backspace", delete: "Delete",
  up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End",
  pageup: "PageUp", pagedown: "PageDown", "+": "Plus",
};
export function acceleratorFor(chord: string): string | undefined {
  const c = parseKeyChord(chord);
  if (!c) return undefined;
  const key = ACCELERATOR_KEYS[c.key] ?? (/^f\d+$/.test(c.key) ? c.key.toUpperCase() : c.key.length === 1 ? c.key.toUpperCase() : undefined);
  if (!key) return undefined;
  return [c.mod && "Command", c.ctrl && "Control", c.alt && "Alt", c.shift && "Shift", key].filter(Boolean).join("+");
}

/**
 * Every chord the person's rules bind to something, under the file's own precedence: the LAST rule
 * for a chord wins. An unconditional unbinding (`command: ""`, no `when`) frees the key — the person
 * asked for it back, for the menu or for the page's own editor — and earlier rules for it no longer
 * count. A conditional rule claims the chord, since in some context the page needs it.
 */
export function pageChords(rules: readonly Keybinding[]): Set<string> {
  const owned = new Set<string>();
  const settled = new Set<string>();
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i]!;
    const chord = normalizeKeyChord(r.key);
    if (!chord || settled.has(chord)) continue;
    const conditional = r.when !== undefined && r.when.trim() !== "";
    if (r.command !== "") { owned.add(chord); settled.add(chord); }
    else if (!conditional) settled.add(chord);
  }
  return owned;
}

/** Whether a keystroke belongs to the page rather than to the menu bar. */
export function shouldPageOwn(input: Pick<Input, "type" | "key" | "code" | "meta" | "shift" | "alt" | "control">, owned: Set<string>): boolean {
  if (input.type !== "keyDown") return false;
  const chord = chordFromEvent({ key: input.key, code: input.code, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift });
  return chord !== null && owned.has(chord);
}

export type MenuDeps = {
  appName: string;
  /** The person's keybindings, as the renderer last reported them (the shipped table until then). */
  rules: readonly Keybinding[];
  /** Run a catalog command in the focused window's renderer. */
  send: (command: string) => void;
  openExternal: (url: string) => void;
  /** Reload and Developer Tools, for a build someone is working on. */
  developer: boolean;
  darwin: boolean;
};

export const WEBSITE_URL = "https://realm.computer";
export const CHANGELOG_URL = "https://realm.computer/changelog";

export function appMenuTemplate({ appName, rules, send, openExternal, developer, darwin }: MenuDeps): MenuItemConstructorOptions[] {
  const sep: MenuItemConstructorOptions = { type: "separator" };
  const items = (rows: readonly (CommandRow | null)[]): MenuItemConstructorOptions[] => rows.map((r) => {
    if (r === null) return sep;
    const chord = chordsForCommand(rules, r.command)[0];
    const accelerator = chord ? acceleratorFor(chord) : undefined;
    return { label: r.label, ...(accelerator ? { accelerator } : {}), click: () => send(r.command) };
  });
  return [
    ...(darwin ? [{
      label: appName,
      submenu: [
        { role: "about" }, sep,
        ...items(MENU_LAYOUT.app), sep,
        { role: "services" }, sep,
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, sep,
        { role: "quit" },
      ],
    } satisfies MenuItemConstructorOptions] : []),
    { label: "File", submenu: [...items(MENU_LAYOUT.file), ...(darwin ? [] : [sep, { role: "quit" } satisfies MenuItemConstructorOptions])] },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        ...items(MENU_LAYOUT.view), sep,
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, sep,
        { role: "togglefullscreen" },
        ...(developer ? [sep, { label: "Developer", submenu: [
          { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" },
        ] } satisfies MenuItemConstructorOptions] : []),
      ],
    },
    { label: "Go", submenu: items(MENU_LAYOUT.go) },
    {
      // A submenu under the plain `window` role, not `role: "windowMenu"`: this is what lets macOS
      // append the window list below these rows itself.
      role: "window",
      submenu: [
        { role: "minimize" }, { role: "zoom" }, sep,
        ...items(MENU_LAYOUT.window),
        ...(darwin ? [sep, { role: "front" } satisfies MenuItemConstructorOptions] : []),
      ],
    },
    {
      // `role: "help"` is what gets the Help menu its search field on macOS.
      role: "help",
      submenu: [
        { label: `${appName} Website`, click: () => openExternal(WEBSITE_URL) },
        { label: "What's New", click: () => openExternal(CHANGELOG_URL) },
      ],
    },
  ];
}
