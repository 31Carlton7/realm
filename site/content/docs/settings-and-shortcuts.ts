import { code, figure, h2, h3, note, p, page, table, tip, ul } from "@/lib/docs-blocks"

export default page({
  slug: "settings-and-shortcuts",
  title: "Settings, themes and shortcuts",
  summary:
    "What each page of Settings holds, how to make Realm look the way you want, and every keyboard shortcut, with how to change them.",
  body: [
    h2("Settings"),
    p(
      "Open Settings with [[⌘,]], or from your profile at the foot of the rail. The search at the top of its column finds any setting by name, and [[↩]] goes to the first result.",
    ),
    table(
      ["Page", "What it holds"],
      ["**General**", "How you send messages, what a message typed mid-turn does, the mode new sessions start in, where files and links open, terminals, updates, power, and Realm's easter eggs"],
      ["**Appearance**", "Theme, palettes, contrast, translucency, Reduce motion, the Dock icon, fonts and text sizes, and the cursor"],
      ["**Keys**", "Every command and its shortcut"],
      ["**Notifications**", "System notifications, sounds, a notification on your paired iPhone, a text or a Slack post when an agent needs you, and which moments count"],
      ["**Devices**", "Pair an iPhone, and the iPhones paired with this Mac. See [Mobile](/docs/mobile#pair-an-iphone)."],
      ["**Engines**", "Every agent Realm can run, with its install, update and sign-in state; failover; and Laya"],
      ["**Usage**", "Spend, tokens and activity, your plans' limits, the heaviest sessions, and a monthly budget"],
      ["**Passwords**", "This profile's saved passwords and passkeys, and how they unlock. See [The browser](/docs/browser#saved-passwords)."],
      ["**Permissions**", "macOS grants for the apps Realm reads, and Realm's own file access"],
      ["**Computer use**", "Computer control, and which spaces may use it. See [Computer use and Laya](/docs/computer-use)."],
      ["**Lab**", "Settings for a Mac left running on its own"],
      ["**Import**", "Bring in transcripts, memory and skills from Claude Code, Codex and Cursor"],
      ["**Archived**", "Archived sessions, to restore or delete"],
    ),
    note("Permissions, Computer use and Lab are about the Mac itself, so Linux and Windows don't show them."),

    h2("Themes"),
    p("**Settings ▸ Appearance** sets how Realm looks."),
    ul(
      "**Theme**: **System**, **Light** or **Dark**. System follows your Mac. The window's material and Realm's menus follow the choice too.",
      "**Dark theme** and **Light theme** each choose a palette: Realm, One, Solarized, Gruvbox, Catppuccin, GitHub and Rosé Pine for both, with Monokai, Dracula and Nord for dark and Codex for light. Each palette's accent, background and foreground can be changed and copied, and **Import a VS Code theme…** brings in one of yours.",
      "**Contrast** lifts or quiets the text.",
      "**Sidebar translucency** and **Pane translucency** set how much of the desktop shows through. Both follow macOS's Reduce transparency.",
      "**Reduce motion**: **System**, **On** or **Off**.",
      "**App icon** puts one of nine icons on the Dock while Realm is open. The Finder and Launchpad keep the standard icon.",
      "Under **Text**: the UI font and its size, the font for messages and documents, line height, and the code font and its size. **Add a font from Google Fonts…** adds another.",
      "Under **Cursor**: the text cursor's shape, animation and colour, and the terminal cursor's.",
    ),
    tip("[[⌘K]] then type `Theme` or `Palette` switches either without opening Settings. [[⌘+]], [[⌘-]] and [[⌘0]] zoom the whole window."),

    h2("Keyboard shortcuts"),
    figure(
      { crop: "keys-list" },
      "Settings ▸ Keys. A search field over every command, then the Panes group: Split right ⌘\\, Split down ⌘⇧\\, Close tab or split ⌘W, Focus pane full-screen ⌘⇧F, the four Focus the pane commands on ⌘⌥ and an arrow, Back in this pane ⌘[, Forward in this pane ⌘], Rename the focused pane (not bound), New tab in the side pane ⌘⇧B and New tab in full view ⌘⌥B.",
      "Settings ▸ Keys, with the Panes group.",
    ),
    p(
      "These are the defaults. Most don't fire while you're typing in a field, so they never take a letter from your message. The ones marked as working in the prompter do, and so do the palette, Open a file, Find in files, All spaces, Settings, Go back and Go forward.",
    ),
    h3("App"),
    table(
      ["Command", "Keys"],
      ["Command palette", "[[⌘K]]"],
      ["Open a file", "[[⌘P]]"],
      ["Find in files", "[[⌘⇧P]]"],
      ["Show/hide the sidebar", "[[⌘B]]"],
      ["Settings", "[[⌘,]]"],
      ["New terminal", "[[⌘T]]"],
      ["Go back, to where the window was", "[[⌃-]]"],
      ["Go forward", "[[⌃⇧-]]"],
      ["New browser, Connect a machine, Documents, Show changes, MCP Activity, What's new", "Not bound"],
    ),
    h3("Sessions"),
    table(
      ["Command", "Keys"],
      ["New session", "[[⌘N]]"],
      ["Quick chat", "[[⌘⇧N]]"],
      ["Add files to this session (works in the prompter)", "[[⌘U]]"],
      ["Select in Realm (works in the prompter)", "[[⌘⇧C]]"],
      ["Dispatch the draft to a new session (works in the prompter)", "[[⌘⇧↩]]"],
      ["Interrupt the running session (works in the prompter)", "[[Esc]]"],
      ["Show this session's terminal (works in the prompter)", "[[⌘J]]"],
      ["New session in a worktree", "Not bound"],
    ),
    h3("Panes"),
    table(
      ["Command", "Keys"],
      ["Split right, with a new session (works in the prompter)", "[[⌘\\]]"],
      ["Split down (works in the prompter)", "[[⌘⇧\\]]"],
      ["Close tab or split", "[[⌘W]]"],
      ["Focus pane full-screen", "[[⌘⇧F]]"],
      ["Focus the pane to the left, right, above or below", "[[⌘⌥←]] [[⌘⌥→]] [[⌘⌥↑]] [[⌘⌥↓]]"],
      ["Back in this pane", "[[⌘[]]"],
      ["Forward in this pane", "[[⌘]]]"],
      ["New tab in the side pane", "[[⌘⇧B]]"],
      ["New tab in full view", "[[⌘⌥B]]"],
      ["Rename the focused pane", "Not bound"],
    ),
    h3("Spaces"),
    table(
      ["Command", "Keys"],
      ["Switch to space 1 to 9 of this profile", "[[⌘1]] to [[⌘9]]"],
      ["Next space", "[[⌃ Tab]]"],
      ["Previous space", "[[⌃⇧ Tab]]"],
      ["All spaces", "[[⌘⇧ Space]]"],
      ["Open this space", "Not bound"],
    ),
    h3("In the prompter and the transcript"),
    table(
      ["Action", "Keys"],
      ["Send", "[[↩]], or [[⌘↩]] (see **Settings ▸ General ▸ Send message with**)"],
      ["New line", "[[⇧↩]]"],
      ["Bulleted or numbered list", "[[⌘⇧8]] or [[⌘⇧7]]"],
      ["Star a model in the picker", "[[⌥↩]]"],
      ["Pick a starred model in the picker", "[[⌘1]] to [[⌘9]]"],
      ["Save a turn, on the track", "[[S]]"],
      ["Jump between saved turns", "[[⌥↑]] [[⌥↓]]"],
      ["Answer a permission card", "[[1]] [[2]] [[3]], or [[↩]] Allow, [[⇧↩]] Allow always, [[⌘⌫]] Deny"],
    ),

    h2("Change a shortcut"),
    p(
      "Shortcuts live in one file, `~/Realm/keybindings.json`, which Realm writes with the defaults on first run. **Settings ▸ Keys** lists every command with its keys and shows where the file is, with **Reveal in Finder**; edit it to rebind. The menu bar follows your file, so a rebound command shows your keys there too.",
    ),
    p(
      "Each rule names a key, a command, and optionally when it applies. The last rule for a key wins, and a rule with an empty command frees the key:",
    ),
    code(
      `[
  { "key": "mod+shift+k", "command": "palette.toggle", "when": "!sheetOpen" },
  { "key": "mod+t", "command": "" }
]`,
      "~/Realm/keybindings.json",
    ),
    p(
      "`mod` is [[⌘]] on a Mac and Ctrl elsewhere. **Reset to defaults** on the Keys page puts the shipped rules back. A space's scripts can have keys too: copy a script's command id from its **⋯** menu into a rule.",
    ),

    h2("The menu bar"),
    p(
      "Realm's menus hold its commands with your shortcuts beside them: **File** for new sessions, terminals and browsers; **View** for the sidebar, the palette, focus and panels; **Go** for back, forward and switching spaces; **Window** for splits. **Help** has **Realm Website** and **What's New**, which shows this version's notes again.",
    ),
  ],
})
