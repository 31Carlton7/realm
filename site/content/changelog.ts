import type { Entry } from "@/lib/changelog"

/**
 * Every notable change to Realm, newest first.
 *
 * Written from the repository's own history — each entry corresponds to work that actually landed,
 * and the release entries repeat what `CHANGELOG.md` says rather than inventing a second account of
 * the same tag. Add new entries at the top; `changelog.ts` sorts by date regardless.
 */
export const entries: Entry[] = [
  {
    slug: "v1-3-0",
    title: "Realm v1.3.0",
    date: "2026-09-12",
    version: "v1.3.0",
    area: "Release",
    summary:
      "A keymap that is a file you own, your own slash commands and a space's scripts, source files in an editor with search across the checkout, a restore that takes the conversation with it, and a macOS sandbox for agents and terminals.",
    body: [
      { kind: "h", text: "The keymap is a file" },
      { kind: "p", text: "`~/Realm/keybindings.json` holds rules of `{key, command, when}`, where `when` is a boolean expression over what the window is doing — `!overlayOpen && sessionFocus`. The last matching rule wins, which is how a rule you write beats a default Realm ships. Defaults are seeded the first time it is read, and newly shipped ones merge in later unless a rule of yours already claims that command or that key. Everything that prints a shortcut reads the same list the handler reads, so a rebind moves the hint with it instead of leaving a lie in the palette." },
      { kind: "p", text: "Settings ▸ Keys lists all 43 commands with their current chord, marks a rule a later rule has already defeated, and says plainly when your file could not be parsed — Realm runs its defaults and leaves the file exactly as you left it." },
      { kind: "h", text: "Your own slash commands, and scripts a space owns" },
      { kind: "p", text: "A command is a markdown file with front matter, found in the space folder's `commands/`, in `~/Realm/commands/`, and read-only from `~/.claude/commands/`. `$ARGUMENTS` and `$1`…`$9` expand into the draft, and a placeholder nothing was typed for is left standing rather than quietly emptied." },
      { kind: "p", text: "A script is a named shell line — `pnpm test` — that runs in a real terminal and is addressable as `script.<id>.run`, so a key can be bound to it." },
      { kind: "h", text: "Source files open in an editor" },
      { kind: "p", text: "CodeMirror 6 in the documents pane, in the app's own theme, with find, undo and a file-changed-on-disk prompt that asks rather than picking a winner. Markdown still opens in the rich editor." },
      { kind: "p", text: "⌘P finds a file by name across the checkout and ⌘⇧P searches its contents through `git grep` — which honours `.gitignore` and still finds the file written ten seconds ago and never committed. A space with no checkout says so instead of showing an empty list." },
      { kind: "h", text: "A restore can take the conversation with it" },
      { kind: "p", text: "Restoring a checkpoint put the files back and left the agent remembering having written them. For Claude sessions it now rewinds both: the transcript is cut back to that point and the provider conversation is resumed truncated at the same turn, so the agent carries on with no memory of the turns after it. Every other agent says so rather than implying otherwise — \"Files only — the agent keeps its memory of these turns.\"" },
      { kind: "h", text: "Agents and terminals can be sandboxed" },
      { kind: "p", text: "A macOS Seatbelt policy applied when Realm starts an agent CLI or a shell: this space's checkouts and the toolchain caches are writable, `$HOME` is not, and `~/.ssh`, `~/.aws` and `~/Library/Keychains` cannot be read at all. It confines the process and everything that process starts." },
      { kind: "p", text: "It ships **off**, per space and on purpose: the writable-root list has not met enough real toolchains yet, and one shared `codex app-server` cannot hold two spaces' policies — so a Codex session in a sandboxed space refuses to start rather than running unprotected. Seatbelt is not a container, and the settings page says so." },
      { kind: "h", text: "The activity lens lists your chats" },
      { kind: "p", text: "Every one, across the profile's spaces, grouped by the day it was last worked on, each row carrying the space, the folder and the branch — the facts that tell two chats called \"Fix the login form\" apart." },
      { kind: "h", text: "Machines" },
      { kind: "p", text: "A pane that shows a screen somewhere else and lets an agent drive it: a second Mac over Screen Sharing, a cloud sandbox, or a Linux guest Realm boots here. Four transports are recognised from whatever address a provider hands out, the password stays on this side of the relay, and the agent's pointer is drawn as a pointer so you can watch it work." },
      { kind: "h", text: "realm-server outlives the app" },
      { kind: "p", text: "It has a name, a lock and a door now: closing the window stops looking rather than stops working, a second launch finds the daemon already running instead of racing it for the database, and Realm keeps a menu-bar presence while it does. A refusal to run against a server this app did not ship is enforced, not assumed." },
      { kind: "h", text: "Smaller things" },
      { kind: "p", text: "A cursor on terminal output, so reattaching to a shell is not the same as losing it. Codex\u2019s plan windows read off the wire it was already sending them on, and how much of the plan is left. A message typed mid-turn can wait its turn or take it. Focus is restored where you left it, with an answer to what changed while you were away." },
      { kind: "h", text: "Fixed" },
      { kind: "p", text: "The band above the prompter is one object again: a plan, goal or agents strip stacked over a composer in Plan or Ask mode kept the neutral edge while the card wore the mode's colour, which notched the join at both sides." }
    ],
  },
  {
    slug: "v1-2-0",
    title: "Realm v1.2.0",
    date: "2026-09-10",
    version: "v1.2.0",
    area: "Release",
    summary:
      "Pane dividers that stay put under a browser view, pane-group tabs you can reorder, first run in two columns, and a quieter set of surfaces.",
    body: [
      { kind: "h", text: "Dividers that stay put" },
      { kind: "p", text: "The line between two panes was disappearing and coming back when you nudged it. A browser pane is a native view that composites above the window's own drawing, and its bounds rounded each edge independently — so a pane whose left edge landed a fraction of a pixel short covered the divider beside it and could not be drawn over in return. Even splits were where it bit: halves round outward-safe, thirds and sixths do not. The view is now inset to the pixel grid and can never reach outside its own box." },
      { kind: "h", text: "Reorderable pane-group tabs" },
      { kind: "p", text: "Drag a tab along the strip to reorder it, or move it with ⌥← and ⌥→. The drop indicator is a rule in the gap between tabs, distinct from dropping a pane onto a tab, which still moves that pane into the group." },
      { kind: "h", text: "First run, in two columns" },
      { kind: "p", text: "The agents on the left, the space on the right. Stacked, the one field anybody types sat below a dozen radios; side by side each half is scannable on its own. The space's icon and colour are on that form now — first run was already choosing them, it just never showed you." },
      { kind: "h", text: "Quieter surfaces" },
      { kind: "p", text: "The prompter's lift is cast from its curve rather than its box, so the shadow follows the corner instead of squaring it off. The space strip's fill dissolves into the material behind it, and the under-strip takes the card's ring and as much of its rounding as it can hold." },
      { kind: "h", text: "Fixed" },
      { kind: "p", text: "`pnpm app:icons` finds and clears the stale bundle registrations that were putting an old app icon on notification banners — every packaged build left in a worktree claims the same bundle identifier, and macOS can resolve a notification's icon to any of them." }
    ],
  },
  {
    slug: "v1-1-0",
    title: "Realm v1.1.0",
    date: "2026-09-09",
    version: "v1.1.0",
    area: "Release",
    summary:
      "An Agents page that reads every session at once, one-click connectors to the apps a space works in, notifications that reach your phone, and ligatures on at last.",
    body: [
      { kind: "h", text: "Agents" },
      { kind: "p", text: "A page that reads every session the way a manager would: grouped by what they need from you — Needs you, Working, Failed, then Ready and Ended folded away — rather than by the space they happen to live in." },
      { kind: "h", text: "Connectors" },
      { kind: "p", text: "The apps a space works in, connected in one click: each a vendor's own remote MCP server over OAuth, so there is nothing to install and no token to paste. Connecting one makes an ordinary server row, with the same tools policy and activity log as any other. Pasted links from those apps become chips that say what they point at — a Slack permalink reads as a thread instead of ninety characters of nothing." },
      { kind: "h", text: "Notifications reach your phone" },
      { kind: "p", text: "A relay beside the desktop notifications sends the three things worth interrupting for — a permission, a blocked run, a finished turn — to iMessage or a Slack webhook." },
      { kind: "h", text: "Ligatures" },
      { kind: "p", text: "JetBrains Mono draws =>, !== and >= as single glyphs everywhere Realm shows code. They had been off for a reason nothing said out loud: Chromium disables every ligature on text with letter-spacing, and the app's -0.1px tracking applied to code as well as prose. Monospace wants no tracking anyway." },
      { kind: "h", text: "The model picker" },
      { kind: "p", text: "The strip above the list used to filter by who made the model. It now names the list's own separators — Claude, Codex, Cursor, Grok, DeepSeek — with each harness's mark, and takes you to one. Nothing is hidden by pressing it, so nothing has to be put back. Effort and permission labels moved above their controls, which stops \"Ask each time\" from wrapping onto two lines, and the list's edges dissolve properly: the fades had never once painted." },
      { kind: "h", text: "Dropped icons are compressed" },
      { kind: "p", text: "A photo dropped on the space-icon picker was sent at full size and refused by the upload cap; only the file dialog had ever compressed. Both paths now do." },
      { kind: "h", text: "Smaller things" },
      { kind: "p", text: "A bigger space name in the sidebar with room around the search field and the new-session row, a subtler sidebar edge, an entrance for the connection banner and the error bar instead of a hard cut, and Hermes as an agent." }
    ],
  },
  {
    slug: "v1-0-0",
    title: "Realm v1.0.0",
    date: "2026-09-09",
    version: "v1.0.0",
    area: "Release",
    summary:
      "The 1.0. Documents and files sit beside the session working on them, runs can be scheduled and delegated, and the whole interface has been through one design pass.",
    body: [
      { kind: "p", text: "The 1.0. Realm stops being a place to run one agent and becomes a workspace: documents and files sit beside the session that is working on them, runs can be scheduled and delegated, and the whole interface has been taken through a single design pass so it reads as one instrument." },
      { kind: "h", text: "Documents" },
      { kind: "p", text: "Word, Excel, Keynote, PDF and Markdown files open in a pane of their own, beside the session rather than on top of it. A tab is marked unsaved while you type, and a file changed on disk under an open editor asks rather than picking a winner. The pane scrolls, and tables look like tables." },
      { kind: "h", text: "The Library" },
      { kind: "p", text: "It holds the files now, not just the skills. A card carries a real thumbnail where the picture is the file, and clicking any card opens one preview — the render, the path, the size, and a button back to the session that produced it, switching space when it lives in another one. Save a copy, Reveal in Finder, Copy path, Expand and Open all route through the same predicate a session summary uses, so a file cannot open two different ways depending on which list reached it. The skills page was restructured alongside it, and no longer rejects a file it has just written itself." },
      { kind: "h", text: "Scheduled tasks" },
      { kind: "p", text: "A clock in front of the runs — work that fires on its own schedule, with a search field and four counted chips over the list. Beside it, a year of the days Realm was used, drawn as a grid." },
      { kind: "h", text: "Delegation" },
      { kind: "p", text: "The dock lists the sub-agents the harness is running, not just the ones Realm made. Background `Agent`/`Task` calls return in under a second and then work for minutes, so ten of them used to look exactly like ten finished calls; Realm now reads the harness's own task protocol and shows them for as long as they run." },
      { kind: "h", text: "What a session knows" },
      { kind: "p", text: "Every session is now told, at start, what Realm's own tools are for — and only the ones it actually has. A space that switched the browser off is never handed a paragraph about driving one, and each block says when not to reach for the tools, so nothing gets delegated that would have been a one-line edit." },
      { kind: "h", text: "Plan mode" },
      { kind: "p", text: "Plan mode looks like planning, and a plan has somewhere to go when it is finished. The permission and mode chips are drawn as one control, and Full access no longer borrows Plan's colour." },
      { kind: "h", text: "Prompter" },
      { kind: "p", text: "The prompter takes `/` commands, starting with Export session, and a turn's summary now lands in the transcript instead of covering the thing you type into — so what a turn produced is still readable tomorrow." },
      { kind: "h", text: "Simulators" },
      { kind: "p", text: "A control inside an Apple Simulator streamed into a browser pane can be picked. The device screen is one canvas as far as the DOM is concerned, so Realm resolves the click against the device's own accessibility tree and says plainly, in the prompt, that `browser_act` cannot address it." },
      { kind: "h", text: "A new app icon" },
      { kind: "p", text: "The old one was a shader that read as a smudge at 32px. This is a drawn mark — two interlocking bays on the app's own near-black, each face lit by the way it points: a white top, grey sides, a near-black base — taken from one SVG to every native size, so the menu bar and the dock come off the same geometry." },
      { kind: "h", text: "Design" },
      { kind: "p", text: "Fast mode, OpenHands as an agent, ⌘K on the app's own curve, real app icons on the permissions page, per-CLI self-update, and a pass over every control: buttons and fields on the squircle rather than snapping square on hover, hairlines and blurs softened, settings and connections rebuilt as cards, list edges dissolved, the sidebar actually translucent, and nothing set below 11px anywhere in the renderer." },
      { kind: "h", text: "Site" },
      { kind: "p", text: "The site was rebuilt around what Realm does rather than how to configure it: the mark drawn live as liquid glass on the GPU, a features page over real product screenshots, a changelog, share images for links, and a download button that asks GitHub for the current release instead of pinning a URL that goes stale." }
    ],
  },
  {
    slug: "plan-mode-looks-like-planning",
    title: "Plan mode looks like planning",
    date: "2026-09-08",
    area: "Interface",
    summary:
      "A plan is no longer a wall of assistant prose with a different label on it. Plan mode has its own card in the transcript, and the plan it produces has somewhere to go when the turn ends.",
    body: [
      {
        kind: "p",
        text: "Every backend Realm speaks to can produce a plan, and until now all three arrived as ordinary assistant text. The transcript rendered them as prose, which meant the one message a reader most wants to skim, compare and come back to was the one hardest to find.",
      },
      {
        kind: "p",
        text: "Plans now render as a card with their steps as steps. The card carries the plan's own state, so a plan that has been superseded reads differently from the one the session is currently working against.",
      },
      {
        kind: "p",
        text: "The other half is what happens next. A plan that only exists inside a scrollback is a plan you retype; this release gives it a destination, so the work described in Plan mode can be handed to the run that carries it out without a copy and paste in between.",
      },
    ],
  },
  {
    slug: "settings-lists-and-a-translucent-sidebar",
    title: "Meshed settings lists, and a sidebar that is actually translucent",
    date: "2026-09-08",
    area: "Interface",
    summary:
      "Settings lists mesh into their sections instead of stacking as separate blocks, and the sidebar's translucency now composites the way the setting promises.",
    body: [
      {
        kind: "p",
        text: "Settings had accumulated three list idioms across its tabs — hairline rows here, background pills there, cards in the newest pages. They now share one, so a row in Permissions and a row in Connections read as the same kind of object.",
      },
      {
        kind: "p",
        text: "The sidebar's translucency is the older bug. The material was correct, but a filter layered above it was compositing toward black, so what shipped was a slightly muddier opaque column rather than the window behind it. Removing the filter is what made the setting mean something.",
      },
      {
        kind: "note",
        text: "Never put a backdrop blur over a translucent window surface: a filter blurs the window's own transparency, and the band reads as a dark smudge. Dissolve a scrolling edge on such a surface by masking the scroller instead — a mask paints nothing.",
      },
    ],
  },
  {
    slug: "every-button-on-the-apps-curve",
    title: "Every button on the app's corner, and each CLI updating itself",
    date: "2026-09-08",
    area: "Interface",
    summary:
      "The radius ladder now reaches the controls it had skipped, and an agent CLI with an update available can be updated from the row that reports it.",
    body: [
      {
        kind: "p",
        text: "Realm's shape language is a ladder — 2px for ticks and rails, 6px for chips, 8px for controls, 12px for cards and rows, 16px for sheets, and the composer's superellipse for panels the eye rests in. Buttons across the renderer had drifted off it one at a time, each for a locally reasonable reason. They are back on it.",
      },
      {
        kind: "p",
        text: "In Settings, the CLI rows gained the action they were describing. Realm already knew a newer version of an agent CLI existed and where the installed copy came from; it now runs the update, visibly, and re-checks afterwards.",
      },
      {
        kind: "p",
        text: "It still refuses to update a CLI a different package manager installed. Offering the button in that case would produce nothing but a refusal, and a broken install is a worse outcome than a version number that is one behind.",
      },
    ],
  },
  {
    slug: "the-skills-page-restructured",
    title: "The skills page, restructured",
    date: "2026-09-08",
    area: "Workspace",
    summary:
      "Skills are grouped by where they come from rather than listed flat, and Realm stopped rejecting skill files it had just written itself.",
    body: [
      {
        kind: "p",
        text: "A machine with a full skills library has them arriving from several places at once — the user's own directory, a project, Realm's bundled set — and a single flat list gave no way to tell which was which. The page now groups by source, so the answer to \"why is this agent behaving like that\" is one scroll rather than a search.",
      },
      {
        kind: "p",
        text: "The fix underneath: the validator that guards skill files was rejecting files Realm had written moments earlier. A skill created in the app failed its own read-back.",
      },
    ],
  },
  {
    slug: "real-app-icons-and-updates-that-run",
    title: "Real app icons, updates that run, and a menu that reads",
    date: "2026-09-08",
    area: "Interface",
    summary:
      "The permissions page shows each application's real icon, the update path actually installs, and a menu that had grown past what it could explain was rewritten.",
    body: [
      {
        kind: "p",
        text: "Settings → Permissions lists the macOS applications an agent may drive. It was drawing a generic glyph for each of them, which made a list of twelve applications a list of twelve identical rows. It now reads each application's own icon off disk.",
      },
      {
        kind: "p",
        text: "A saved sign-in gets a sheet rather than an inline expansion, so the credential and what it unlocks are stated in one place.",
      },
      {
        kind: "p",
        text: "The update flow is the substantive fix. The check for a newer Realm was correct; the install it offered afterwards did not always complete. It does now.",
      },
    ],
  },
  {
    slug: "one-thing-for-the-memory-page",
    title: "One thing for the memory page to do",
    date: "2026-09-08",
    area: "Workspace",
    summary:
      "The memory manager stopped offering four half-answers to the question of what memory is, and now does the one thing a person opens it for.",
    body: [
      {
        kind: "p",
        text: "Memory arrived alongside skills and MCP connections, and inherited their page shape: a browser, an editor, a sync control and a source list, all at equal weight. None of them was the reason anyone opened the page.",
      },
      {
        kind: "p",
        text: "The page now has one dominant working object and the rest supports it. Nothing was removed that a person was using; what changed is which of the four is the page and which three are chrome.",
      },
    ],
  },
  {
    slug: "the-palette-and-the-connection-grid",
    title: "⌘K reads as opening, and connections become a grid",
    date: "2026-09-08",
    area: "Interface",
    summary:
      "The command palette enters like something opening rather than appearing, its search field takes the prompter's shape, and the connections list becomes a grid of cards.",
    body: [
      {
        kind: "p",
        text: "The palette used to cross-fade in. A cross-fade says a thing changed; an open says a thing arrived over what you were looking at, and can be reversed by closing it. The palette now opens, and it carries the app's own curve while it does.",
      },
      {
        kind: "p",
        text: "Its search field is the prompter's shape at palette size, so the two places you type into Realm are visibly the same kind of surface.",
      },
      {
        kind: "p",
        text: "Connections were a list of rows carrying three lines each, which is a list of cards written as rows. They are now cards, in a grid, and the rules between them came off — a card's fill already separates it from its neighbour, and a rule says so a second time.",
      },
      {
        kind: "p",
        text: "The edge fades throughout the renderer learned when not to appear. A fade over a list that fits is a gradient announcing content that is not there.",
      },
    ],
  },
  {
    slug: "session-summary",
    title: "A session summary: what a run made, took in, and proposed",
    date: "2026-09-07",
    area: "Agents",
    summary:
      "A long session now has a summary panel beside it: the files it wrote, the context it consumed, and the plans it proposed, without scrolling the transcript to find them.",
    body: [
      {
        kind: "p",
        text: "A session that has run for an hour has its evidence spread across a few hundred messages. The facts a person actually wants — what changed on disk, what was read, what was proposed and whether it was accepted — are recoverable from the transcript but not readable from it.",
      },
      {
        kind: "p",
        text: "The summary collects them. It is a side panel rather than a card in the scrollback, because it describes the whole session rather than a moment in it, and because it needs to stay visible while you scroll the thing it is summarising.",
      },
      {
        kind: "p",
        text: "Everything in it is derived from events the session already recorded. It states no totals it cannot source, and where a figure genuinely cannot be established it draws nothing rather than an empty meter.",
      },
    ],
  },
  {
    slug: "a-year-of-days",
    title: "A year of the days Realm was used",
    date: "2026-09-07",
    area: "Workspace",
    summary:
      "A contribution-graph view of activity across the last year, opening at the present end where the recent weeks are.",
    body: [
      {
        kind: "p",
        text: "Usage already had spend and activity charts by model and by day. What it did not have was the shape of a year — the weeks that were heavy, the weeks that were not, and where the current one sits against them.",
      },
      {
        kind: "p",
        text: "The graph opens scrolled to the present. A year-wide graph that starts at its oldest column hides the part the reader came for behind a scroll they may not attempt.",
      },
      {
        kind: "p",
        text: "The scale steps one hue's opacity rather than walking across hues. A quantity that changes colour reads as a set of categories, which is the opposite of what a day count means.",
      },
    ],
  },
  {
    slug: "scheduled-tasks",
    title: "Scheduled tasks: a clock in front of the runs",
    date: "2026-09-07",
    area: "Agents",
    summary:
      "A session can be scheduled to run on a clock, with the schedule, the next firing and the history of past firings all in one place.",
    body: [
      {
        kind: "p",
        text: "Realm could already run an agent, resume it, and let one session delegate to another. What it could not do was start one without a person present.",
      },
      {
        kind: "p",
        text: "A scheduled task is a prompt, a workspace and a cadence. It runs in the space it belongs to, produces an ordinary session with an ordinary transcript, and its output is inspectable afterwards exactly like a run you started yourself.",
      },
      {
        kind: "p",
        text: "The schedule list shows what will fire next and what fired last, because a scheduler whose state you cannot read is a scheduler you stop trusting after the first surprise.",
      },
    ],
  },
  {
    slug: "slash-commands-in-the-prompter",
    title: "Slash commands in the prompter, starting with Export session",
    date: "2026-09-07",
    area: "Agents",
    summary:
      "Typing / in the prompter opens Realm's own commands, separately from the ones the harness provides. The first is Export session.",
    body: [
      {
        kind: "p",
        text: "The prompter already had two mention namespaces: @ for skills and files, and the model and mode chips beside it. A slash namespace gives Realm somewhere to put actions that belong to the session rather than to the agent running in it.",
      },
      {
        kind: "p",
        text: "Export session is the first. It writes the transcript out in a form you can read outside Realm — which is the request that had been arriving most often, and the one hardest to satisfy by hand.",
      },
      {
        kind: "note",
        text: "Realm's commands are listed separately from the harness's own. A palette that mixes them makes it impossible to tell which will still be there if you change model.",
      },
    ],
  },
  {
    slug: "fast-mode",
    title: "Fast mode, and the prompter's curve on sent messages",
    date: "2026-09-07",
    area: "Agents",
    summary:
      "Fast mode is selectable per session where the backend supports it, and a sent message now wears the same curve as the prompter it was typed into.",
    body: [
      {
        kind: "p",
        text: "Fast mode reaches the model picker as a mode rather than as a separate entry in the catalogue, so choosing it does not mean re-choosing the model.",
      },
      {
        kind: "p",
        text: "The visual half: a message you sent used to lose the shape of the surface you typed it in the moment it left. Sent messages now carry the prompter's superellipse, which is what makes a transcript read as a conversation with the composer rather than as a log beside it.",
      },
      {
        kind: "p",
        text: "The same pass removed a set of dividers that were separating things already separated by their own surfaces.",
      },
    ],
  },
  {
    slug: "office-documents-in-a-pane",
    title: "Word, Excel and Keynote files open in a pane",
    date: "2026-09-07",
    area: "Documents",
    summary:
      "Office and iWork documents render in a Realm pane instead of bouncing to another application, alongside the existing Markdown, PDF and study-guide previews.",
    body: [
      {
        kind: "p",
        text: "A space's working files are rarely all one format. A repository has Markdown; a course has PDFs and slides; real work has the spreadsheet somebody sent. Every format Realm could not draw was a reason to leave the workspace.",
      },
      {
        kind: "p",
        text: "Word, Excel, PowerPoint and Keynote files now open in a document pane. They sit in the pane grammar everything else uses — splittable, persisted across relaunch, and addressable by an agent through realm-docs.",
      },
      {
        kind: "p",
        text: "The docs pane also learned to scroll properly and to draw tables as tables, which the study guides had been quietly working around.",
      },
    ],
  },
  {
    slug: "files-a-session-names",
    title: "The files a session names became reachable",
    date: "2026-09-07",
    area: "Agents",
    summary:
      "A path an agent mentions in its answer is now something you can open, rather than a string you copy into a terminal.",
    body: [
      {
        kind: "p",
        text: "Agents talk in paths. Every answer of any length names files, and every one of those names was inert text — the shortest route to the file it identified was to select it, copy it, and paste it somewhere that could act on it.",
      },
      {
        kind: "p",
        text: "Realm now resolves paths a session names against that session's workspace and makes them openable in a pane. A path that does not resolve is left as text: a link that might not lead anywhere is worse than no link.",
      },
    ],
  },
  {
    slug: "finish-the-turn-somewhere-else",
    title: "Finish the turn somewhere else",
    date: "2026-09-07",
    area: "Agents",
    summary:
      "A turn started in one session can be finished in another, carrying its context, so a run that has outgrown where it started does not have to be restarted.",
    body: [
      {
        kind: "p",
        text: "Sessions get chosen before their scope is known. Work that started as a question in one space turns into a change that belongs in another, on another branch, with another model — and until now the only way to move it was to start again and re-explain.",
      },
      {
        kind: "p",
        text: "Handing a turn on carries what the session established with it. The originating transcript records that the work left and where it went, so neither half of the pair is a dead end.",
      },
    ],
  },
  {
    slug: "nothing-below-11px",
    title: "Nothing is set below 11px any more",
    date: "2026-09-07",
    area: "Interface",
    summary:
      "The type floor is now enforced by a test rather than by intention. Two exceptions survive, each named individually rather than tolerated by a range.",
    body: [
      {
        kind: "p",
        text: "A 10.5px uppercase micro-label looks considered on its own. Thirty-seven of them are why a page becomes unreadable, and the renderer had accumulated thirty-seven.",
      },
      {
        kind: "p",
        text: "The floor is 11px. The exceptions are geometry or typography, never taste: a superscript sized against its own line, and text inside a box whose height is fixed by something other than the text.",
      },
      {
        kind: "note",
        text: "Both exceptions are listed by name in the stylesheet's test rather than allowed by a range. A range would readmit the thirty-seven one at a time.",
      },
    ],
  },
  {
    slug: "harness-sub-agents",
    title: "The sub-agents the harness is running, not just the ones Realm made",
    date: "2026-09-07",
    area: "Agents",
    summary:
      "A session's dock now shows every sub-agent running underneath it, including the ones the harness spawned on its own.",
    body: [
      {
        kind: "p",
        text: "Realm's delegation dock listed the agents Realm had started. It said nothing about the sub-agents a harness spawns for itself, which meant a session that was clearly busy could show an empty dock.",
      },
      {
        kind: "p",
        text: "Both kinds now appear, distinguished by who started them. A run that stalls is attributable to the sub-agent holding it up rather than to the session as a whole.",
      },
    ],
  },
  {
    slug: "v0-6-1",
    title: "Realm v0.6.1",
    date: "2026-09-06",
    version: "v0.6.1",
    area: "Release",
    summary:
      "A fixes release for the prompter, the sidebar and Settings, from a round of screenshot review.",
    body: [
      { kind: "h", text: "Prompter" },
      {
        kind: "p",
        text: "The note under the attachment chips no longer narrates a handoff the agent completes itself — Codex getting a path, Cursor getting a link — for any provider. Only a file the agent will silently drop still earns a warning; the rest stays on the chip's tooltip. The strip under the card now sits evenly, ten pixels above and below its chips instead of two and twelve, and its bottom corners draw at the card's own squircle.",
      },
      { kind: "h", text: "Model picker" },
      {
        kind: "p",
        text: "The provider strip says the model family — Claude, GPT, Gemini, Grok, Kimi, GLM — beside its mark, matching the list's own separators, instead of the maker's corporate name. Kimi and Z.ai marks are new; a maker Realm has no mark for keeps its name and gets none invented.",
      },
      { kind: "h", text: "Sidebar" },
      {
        kind: "p",
        text: "The list's bottom fade was a backdrop blur over the translucent column, which blurs the window's own transparency and rendered as a dark smudge above the space strip. The list now dissolves by masking the scroller itself, which paints nothing over the rows, on the vibrancy material and under reduced transparency alike.",
      },
      { kind: "h", text: "Settings" },
      {
        kind: "p",
        text: "The decorative wash is gone from the page. The content column no longer clips the selection ring off the theme and appearance cards at its left edge.",
      },
    ],
  },
  {
    slug: "v0-6-0",
    title: "Realm v0.6.0",
    date: "2026-09-05",
    version: "v0.6.0",
    area: "Release",
    summary:
      "The largest release so far: computer use, a real theming system, plan and ask modes, sub-agent visibility, and a long pass of interface work.",
    body: [
      { kind: "h", text: "Computer use" },
      {
        kind: "p",
        text: "Realm can drive other macOS applications through the Accessibility APIs, via a Swift helper and a `realm-computer` tool provider. It is off until a space turns it on, refuses a list of applications no mode can lift (Realm itself, System Settings, password prompts, terminals), and raises a permission card per application that `bypassPermissions` does not skip — approving TextEdit never licenses Mail. A menu-bar indicator shows when an agent is driving, because at that moment Realm is by definition not the frontmost app.",
      },
      { kind: "h", text: "Theming" },
      {
        kind: "p",
        text: "Seven palettes across seventeen light and dark faces, chosen independently per mode, with per-palette colour overrides, a contrast control, UI and code font pickers, JSON import/export, and an adjustable sidebar translucency. Every face is held to a WCAG floor per role, and overrides run through the same derivation so a moved background brings its whole surface ladder with it.",
      },
      { kind: "h", text: "Plan and Ask modes" },
      {
        kind: "p",
        text: "Plans from Claude, Codex and ACP now render as a first-class card instead of being discarded. Ask is a read-only mode enforced by each backend rather than requested politely — and it is not offered where it cannot be enforced.",
      },
      { kind: "h", text: "Sub-agents" },
      {
        kind: "p",
        text: "A `Task`'s tool calls nest under the call that spawned them, and a session shows the agents it is waiting on in a dock inside its own pane.",
      },
      { kind: "h", text: "Browser" },
      {
        kind: "p",
        text: "Panes survive a space switch — the view is retained, unthrottled and still drivable, bounded by an LRU budget. Elements can be picked from a page and sent to the prompter as a chip.",
      },
      { kind: "h", text: "Interface" },
      {
        kind: "p",
        text: "A genuine superellipse on the floating cards, drawn by a paint worklet because `corner-shape` is inert on this runtime. A motion ladder, trackless scrollbars, far fewer dividers, centred page content, an icon ladder, a plan strip above the prompter, and response actions — copy, retry, feedback and sources — on finished answers. Two sound cues, off-window only.",
      },
      { kind: "h", text: "Tooling" },
      {
        kind: "p",
        text: "Agent CLIs and model catalogues are checked for updates on launch, read-only, with install and update one visible click away — and Realm refuses to update a CLI a different package manager installed.",
      },
      { kind: "h", text: "Fixed" },
      {
        kind: "ul",
        items: [
          "Attachments in sent messages rendered at zero size.",
          "The prompter's shadow was drawn from its square box rather than its painted curve.",
          "The test suite leaked roughly a thousand scratch directories per run.",
        ],
      },
    ],
  },
  {
    slug: "response-actions",
    title: "Response actions on a finished answer",
    date: "2026-09-05",
    area: "Agents",
    summary:
      "A completed assistant message gained a row of its own: copy, ask again, a record of what the reader made of it, and the pages the answer was built from.",
    body: [
      {
        kind: "p",
        text: "A finished message had nowhere to hang its controls, so the actions that belong to it were either absent or parked in the pane bar, where they applied to the session rather than to the answer.",
      },
      {
        kind: "ul",
        items: [
          "**Copy** takes the message as written, not as rendered.",
          "**Ask again** re-sends the question that produced it. It is not dressed up as a regenerate — the model gets the question a second time, and the transcript says so.",
          "**Feedback** records what the reader made of an answer in the log the answer already lives in, rather than in a separate store nobody reads.",
          "**Sources** cites the pages an answer was built from, and only those.",
        ],
      },
      {
        kind: "p",
        text: "The row was measured in a real window rather than in jsdom. Claims about where a bar sits need a compositor to be checked against.",
      },
    ],
  },
  {
    slug: "sound-cues",
    title: "Two sound cues, off-window only",
    date: "2026-09-05",
    area: "Interface",
    summary:
      "Realm makes exactly two sounds, both for the notifications that ask you to come back to it, with a switch and a level in Settings.",
    body: [
      {
        kind: "p",
        text: "An agent that runs for four minutes is an agent you leave. The two moments worth interrupting someone for are a permission that is blocking a run and a turn that has finished.",
      },
      {
        kind: "p",
        text: "Those two make a sound. Nothing else does, and neither does either of them while Realm is the window you are looking at — a cue for something already on screen is noise.",
      },
      {
        kind: "p",
        text: "Settings carries the switch and the level. The readout names the volume rather than sitting beside an unlabelled bar, and a disabled switch looks disabled.",
      },
    ],
  },
  {
    slug: "cli-manager",
    title: "Agent CLIs Realm can check, install and update",
    date: "2026-09-05",
    area: "Platform",
    summary:
      "Realm learns where each installed agent CLI came from, checks for newer versions without touching the machine, and offers the install command before the button that runs it.",
    body: [
      {
        kind: "p",
        text: "Realm runs other people's binaries. Which ones are present, which are current, and which package manager owns them are facts that decide whether a session starts at all, and they were only discoverable in a terminal.",
      },
      {
        kind: "p",
        text: "Each CLI's install route is now data rather than prose in a README. Realm learns where an installed copy actually came from — Homebrew, npm, a downloaded binary — checks the registry for a newer version on launch, and acts on none of it.",
      },
      {
        kind: "p",
        text: "The install path shows the command first and the button that runs it second, so an install you would rather run yourself is copyable. The install decision lives behind the server rather than in the button, and Realm refuses to update a CLI a different package manager installed rather than fighting it.",
      },
      {
        kind: "note",
        text: "The whole thing is checked against a real machine and a real registry, installing nothing. A check that stubs the registry proves the stub.",
      },
    ],
  },
  {
    slug: "accent-wash",
    title: "A decorative wash anchored to the theme's own accent",
    date: "2026-09-05",
    area: "Interface",
    summary:
      "The calm surfaces carry a faint field of the current theme's accent — and only the surfaces a person passes through, never the ones they sit on all day.",
    body: [
      {
        kind: "p",
        text: "The wash is drawn from the active theme's accent rather than from a fixed brand colour, so it moves with the palette instead of fighting whichever one you chose.",
      },
      {
        kind: "p",
        text: "Where it goes is the decision that mattered. A decorative colour wash belongs on a surface someone passes through — first run, a feed, an empty state. A page of controls someone sits on all day stays plain. Both sets are pinned by test, including the pages that are deliberately undecorated.",
      },
      {
        kind: "p",
        text: "Every ink tier is held above its contrast floor on all seventeen faces with the wash applied, and the check measures the rendered pixels rather than the stylesheet — the wash only exists once something composites it.",
      },
    ],
  },
  {
    slug: "plan-strip",
    title: "The plan, pinned above the prompter",
    date: "2026-09-05",
    area: "Agents",
    summary:
      "A session's current plan is read off its own transcript and pinned above the composer, so the list of what is left stays visible while the run scrolls past it.",
    body: [
      {
        kind: "p",
        text: "The plan is the one message you keep scrolling back to. Pinning it above the prompter puts it where the next thing you type is, which is where the question it answers gets asked.",
      },
      {
        kind: "p",
        text: "It is derived from the transcript rather than stored beside it, so it cannot drift from what the session actually agreed to. A plan the agent has replaced is replaced in the strip.",
      },
      {
        kind: "p",
        text: "The strip takes the under-strip's tab shape and leaves the composer card's corners alone, and its fade band paints on the strip rather than over the card beneath it.",
      },
    ],
  },
  {
    slug: "computer-use",
    title: "Computer use: an agent that can drive your Mac",
    date: "2026-09-04",
    area: "Agents",
    summary:
      "Realm can drive other macOS applications through the Accessibility APIs, off until a space asks for it, refusing a list no mode can lift, and permissioned one application at a time.",
    body: [
      {
        kind: "p",
        text: "A Swift helper reads and drives other applications through the Accessibility APIs; a `realm-computer` tool provider exposes that to a session. Both grants macOS requires — Accessibility and Screen Recording — are requested from Settings, with the reason strings that appear in the system dialogs written for Realm rather than for a generic app.",
      },
      { kind: "h", text: "What it refuses" },
      {
        kind: "p",
        text: "A fixed list is refused by name before anything is looked up: Realm itself, System Settings, password prompts, and the terminals people actually run rather than only Apple's and iTerm's. No mode lifts that list, `bypassPermissions` included.",
      },
      { kind: "h", text: "What it asks" },
      {
        kind: "p",
        text: "Permission is per application, and a space remembers which ones it has allowed — visible in Settings, and revocable there. Approving TextEdit never licenses Mail.",
      },
      {
        kind: "p",
        text: "A menu-bar indicator says when an agent is driving. At that moment Realm is by definition not the frontmost application, so the app's own window is the one place the state cannot be shown.",
      },
      {
        kind: "note",
        text: "Screen captures crop to the target application's own windows on the display it is actually on, so a capture cannot quietly include whatever else was open.",
      },
    ],
  },
  {
    slug: "theming",
    title: "Seven palettes, seventeen faces",
    date: "2026-09-04",
    area: "Interface",
    summary:
      "A real theming system: palettes chosen independently for light and dark, per-colour overrides that run through the same derivation, a contrast control, font pickers, and themes you can carry between two Realms.",
    body: [
      {
        kind: "p",
        text: "Realm's own palette gained a seed, which made it moveable like any other. Everything else follows from that: a palette is twelve values and a derivation, not a stylesheet.",
      },
      { kind: "h", text: "What you can change" },
      {
        kind: "ul",
        items: [
          "A palette for light and a palette for dark, chosen separately.",
          "Ground, ink and accent moved per palette — through the derivation, so a moved background brings its whole surface ladder with it.",
          "How far the ink ramp spreads, as a contrast control.",
          "UI and code faces, offered only where the app can actually deliver them, and reaching open terminals too.",
          "Sidebar translucency as a switch and an amount, over one number.",
        ],
      },
      {
        kind: "p",
        text: "Catppuccin, GitHub and Rosé Pine are vendored at their published values rather than approximated, and the ramps are proved to have been measured from the palette they claim. Every one of the seventeen faces is held to a WCAG floor per role.",
      },
      {
        kind: "p",
        text: "A theme exports and imports as the twelve values it is made of, so it can be carried between two installations. The Appearance tab shows the window a choice produces next to the choice itself.",
      },
    ],
  },
  {
    slug: "plan-and-ask-modes",
    title: "Plan and Ask, enforced rather than requested",
    date: "2026-09-04",
    area: "Agents",
    summary:
      "Plans from Claude, Codex and ACP get a card in the transcript instead of being discarded, and Ask is a read-only mode each backend actually enforces.",
    body: [
      {
        kind: "p",
        text: "Every backend can produce a plan and each expresses it differently. Realm was dropping the structure and keeping the prose. Plans now carry into the transcript as a card, from all three families.",
      },
      {
        kind: "p",
        text: "Ask is read-only. The distinction that matters is that it is enforced by the backend rather than asked for in a system prompt — and where a backend cannot enforce it, Realm does not offer it.",
      },
      {
        kind: "note",
        text: "Offer a capability only where its owner has said it exists. A control offered on a guess has one outcome: a refusal.",
      },
    ],
  },
  {
    slug: "sub-agent-nesting",
    title: "Sub-agents nest under the call that spawned them",
    date: "2026-09-04",
    area: "Agents",
    summary:
      "A Task's tool calls are drawn underneath the call that started them, counted in the run that owns them, and the session shows which agents it is waiting on.",
    body: [
      {
        kind: "p",
        text: "A delegating session used to produce a flat transcript in which a sub-agent's forty tool calls sat as siblings of the one call that had spawned them. The structure was in the events; the transcript was throwing it away.",
      },
      {
        kind: "p",
        text: "Calls now nest. A sub-agent's parent is resolved only among calls already seen, so a late-arriving event cannot re-parent history, and its calls are counted in the run that spawned them rather than in the session at large.",
      },
      {
        kind: "p",
        text: "Beside the transcript, a dock lists the agents this session is waiting on. A delegation stays alive independently of whoever is watching it, and the registry is refetched when the socket comes back — a reconnect used to lose the list.",
      },
    ],
  },
  {
    slug: "browser-persistence",
    title: "A browser pane that survives a space switch",
    date: "2026-09-04",
    area: "Browser",
    summary:
      "A browser view outlives the pane showing it: switching spaces no longer reloads the page, logs you out, or interrupts the agent working in it.",
    body: [
      {
        kind: "p",
        text: "Browser views were owned by their pane, so leaving a space destroyed them. Coming back reloaded, which meant a form half-filled was gone and a signed-in session sometimes was too.",
      },
      {
        kind: "p",
        text: "A view now outlives its pane. It stays retained, unthrottled and drivable across the switch, bounded by an LRU budget so a day of browsing does not accumulate without limit — and a browser an agent is currently working in is kept out of the eviction queue entirely.",
      },
      {
        kind: "p",
        text: "Closing a browser became the user's decision rather than a consequence of navigating away. This is checked against the real binary: that the page survives the switch is the kind of claim only a real window can settle.",
      },
    ],
  },
  {
    slug: "element-picker",
    title: "Pick an element, send it as a chip",
    date: "2026-09-04",
    area: "Browser",
    summary:
      "Point at an element inside a browser pane and it arrives in the prompter as a chip — a reference the agent can act on, not a screenshot and a description.",
    body: [
      {
        kind: "p",
        text: "Asking an agent to change something on a page meant describing where it was. The picker replaces the description with the element.",
      },
      {
        kind: "p",
        text: "Picked elements arrive in the prompter as chips, alongside skills and files. A chip is one thing to the caret — one backspace removes it, it does not fracture mid-word, and it says under the pointer that it is a thing to click. The prompter takes eight; the ninth is refused in the composer rather than on the wire, where the refusal would arrive too late to explain.",
      },
      {
        kind: "p",
        text: "The transcript draws a sent message's chips as chips, so a message that carried three page elements still reads as having carried them a week later.",
      },
      {
        kind: "note",
        text: "The picker's claims about Chrome are checked against a real Chrome, not a fixture.",
      },
    ],
  },
  {
    slug: "the-superellipse",
    title: "A real superellipse, drawn by a paint worklet",
    date: "2026-09-04",
    area: "Interface",
    summary:
      "The composer's curve is a genuine squircle rather than a rounded rectangle, painted by a worklet because the CSS property that would do it is inert on this runtime.",
    body: [
      {
        kind: "p",
        text: "`corner-shape: squircle` is inert in the Chromium this app ships on. A surface that declares it and nothing else renders a plain rounded rect next to a composer wearing a real curve, which is worse than not having asked.",
      },
      {
        kind: "p",
        text: "A paint worklet draws the curve. Any surface declaring it is listed in the worklet's rule, and a test enforces the pairing so the two cannot drift.",
      },
      {
        kind: "p",
        text: "Where the signature goes, the hairline ring comes off — a ring traced around a large radius is the one thing that reliably makes the radius read as a mistake rather than a decision. The prompter's lift is cast from the painted curve rather than from its bounding box, which is what had made the shadow look detached.",
      },
      {
        kind: "p",
        text: "It belongs on a panel the eye rests in: the composer, a fenced code block, a commit card, an install card. Not on a routine list row, a menu, or a chip — anything whose job is to be counted rather than read.",
      },
    ],
  },
  {
    slug: "motion-and-scrollbars",
    title: "One motion ladder, and trackless scrollbars",
    date: "2026-09-04",
    area: "Interface",
    summary:
      "Every timing in the renderer moved onto one ladder, popovers leave the way they arrived, and every scrollbar track is hidden rather than the nine that had been listed.",
    body: [
      {
        kind: "p",
        text: "Durations had been chosen locally, one component at a time, which is how an app ends up with four different ideas of what \"quick\" means. They are now drawn from one ladder: interactive fills answer immediately, popovers and swaps are short, drawers and spatial moves take longer.",
      },
      {
        kind: "p",
        text: "Popovers exit the way they entered, reversed and shorter. The archived shelf unfolds rather than snapping open. An icon button has one way to change its state — opacity, a blur from 4px to 0, and a scale from 0.25 to 1, with no bounce.",
      },
      {
        kind: "p",
        text: "Scrollbar tracks are hidden by a rule that covers all of them rather than by an enumeration of nine, which is the kind of list that is correct on the day it is written.",
      },
      {
        kind: "p",
        text: "A running session's ring survives having its motion taken away: under reduced motion it still reads as running, because the state is not carried by the animation alone.",
      },
    ],
  },
  {
    slug: "icon-ladder-and-traffic-lights",
    title: "An icon ladder with five rungs, and traffic lights inline with the panes",
    date: "2026-09-04",
    area: "Interface",
    summary:
      "Icon sizes across the renderer collapsed onto five rungs, the split glyph draws the split it describes, and the window controls sit in line with the panes instead of on a rail of their own.",
    body: [
      {
        kind: "p",
        text: "The sidebar's icons had eleven sizes between them. Five rungs cover every legitimate use, and the whole renderer is on them rather than just the sidebar.",
      },
      {
        kind: "p",
        text: "The split glyph now draws the split it is describing, which is the difference between an icon you read and one you learn.",
      },
      {
        kind: "p",
        text: "The traffic lights moved inline with the panes. A dedicated rail above them was fifty pixels of chrome that existed to hold three buttons macOS draws itself.",
      },
      {
        kind: "p",
        text: "The sidebar list dissolves at the bottom instead of being cut off, and light mode was given the colours its ramps could not reach — a light theme is an equal mode, not an inverted dark screenshot.",
      },
    ],
  },
  {
    slug: "v0-5-1",
    title: "Realm v0.5.1 — signed and notarized",
    date: "2026-09-03",
    version: "v0.5.1",
    area: "Release",
    summary:
      "Replaces the unsigned v0.5.0 downloads with a Developer ID signed, Apple-notarized build. The feature set is unchanged.",
    body: [
      {
        kind: "p",
        text: "v0.5.0 shipped unsigned, which meant a first launch on any Mac other than the build machine needed right-click → Open, or a Gatekeeper complaint that the app was damaged.",
      },
      {
        kind: "ul",
        items: [
          "Signed with Realm's Developer ID Application certificate and notarized through credentials stored in the macOS Keychain.",
          "Fixed the packaged server staging layout so codesign can validate every bundled runtime file.",
        ],
      },
      {
        kind: "p",
        text: "The product feature set is identical to v0.5.0.",
      },
    ],
  },
  {
    slug: "v0-5-0",
    title: "Realm v0.5.0",
    date: "2026-09-03",
    version: "v0.5.0",
    area: "Release",
    summary:
      "The work from every active branch, brought back into one build: pane groups, the school workflow, usage dashboards, parallel delegation and a long interface pass.",
    body: [
      {
        kind: "ul",
        items: [
          "Named pane groups, full-pane focus, profile-scoped space navigation, and smoother Arc-style space switching. Existing layouts migrate into a single Main group.",
          "The complete school workflow: HTML study guides and PDF previews, lecture sheets, Plynn imports, bundled study skills, and `realm-docs` tools for agents.",
          "Settings → Usage with spend and activity charts, model pricing, monthly budgets, and threshold alerts.",
          "Agents can run in parallel and delegate one level deeper. Transcripts show run duration, richer tool results, maths and code, and inline local audio and video playback.",
          "An expanded model and harness picker with live catalogue data, model costs, DeepSeek ACP readiness, and better defaults.",
          "Graphify probing, extraction RPCs, local graph preview support, and a live integration check.",
          "Next-prompt suggestions in the composer, quieter attachment guidance, and richer media handling. Sessions that have already run can move between spaces.",
          "Credential-backed browser sign-in, gated downloads, native notifications, public update-feed support, and safer local app installation.",
        ],
      },
      { kind: "h", text: "Fixed" },
      {
        kind: "p",
        text: "Shell-path discovery, stale run timing after restarts, native overlay placement, oversized icon storage, and several integration gaps that only appeared once the combined suite ran.",
      },
    ],
  },
  {
    slug: "usage-and-budgets",
    title: "Spend dashboards and budget alerts",
    date: "2026-09-03",
    area: "Workspace",
    summary:
      "Settings → Usage: what each model cost, what it was spent on, a monthly budget, and an alert before the budget is reached rather than after.",
    body: [
      {
        kind: "p",
        text: "Running four agents across three providers means four billing pages. Realm already had the token counts; what it lacked was the arithmetic and somewhere to put it.",
      },
      {
        kind: "p",
        text: "Usage charts spend and activity by model and by day, priced from real catalogue data. Figures are set in tabular numerals so a column of costs compares by eye.",
      },
      {
        kind: "p",
        text: "A monthly budget with a threshold alert is the part that changes behaviour. An alert after the fact is a receipt.",
      },
    ],
  },
  {
    slug: "parallel-delegation",
    title: "Agents in parallel, and delegation that nests",
    date: "2026-09-03",
    area: "Agents",
    summary:
      "A session can run several agents at once and delegate one level deeper, with the concurrency proved by overlap rather than assumed.",
    body: [
      {
        kind: "p",
        text: "Delegation was sequential and one level deep. Both limits were arbitrary — a session that needs three files read has no reason to read them one after another.",
      },
      {
        kind: "p",
        text: "Runs now overlap, and a delegated agent can delegate in turn. One run's cleanup cannot evict its siblings, which was the failure mode that made the first attempt at this untrustworthy.",
      },
      {
        kind: "note",
        text: "The concurrency test proves overlap directly rather than inferring it from wall-clock time. A timing assertion on a loaded machine measures the machine.",
      },
    ],
  },
  {
    slug: "transcript-tool-results",
    title: "Draw what a tool did",
    date: "2026-09-03",
    area: "Agents",
    summary:
      "Tool calls render as what they were — a read, a write, a search, a command — with maths and code set properly, and a run's duration stated in its own words.",
    body: [
      {
        kind: "p",
        text: "Every tool call looked the same: a collapsed box with a name on it. A file write and a directory listing are not the same event, and a transcript that draws them identically makes the reader open both to find out which is which.",
      },
      {
        kind: "p",
        text: "Calls now carry the shape of what they did. Maths renders as maths, code as code with its language named, and local audio and video play inline rather than linking out.",
      },
      {
        kind: "p",
        text: "A finished run says how long it took in ordinary language. The raw detail is still reachable — it just stops competing with the result.",
      },
    ],
  },
  {
    slug: "prompt-suggestions",
    title: "The next prompt, suggested and filled in on Tab",
    date: "2026-09-03",
    area: "Agents",
    summary:
      "The composer proposes a plausible next prompt from where the session actually is, accepted with Tab and ignorable by typing.",
    body: [
      {
        kind: "p",
        text: "The suggestion is drawn from the session's own state rather than from a list of generic follow-ups, and it is phrased the way a person would type it.",
      },
      {
        kind: "p",
        text: "Tab fills it in. Anything else dismisses it. It never sends on its own — a composer that submits something you did not write is a composer you stop trusting.",
      },
    ],
  },
  {
    slug: "school-workflow",
    title: "Study guides, lecture sheets and PDF previews",
    date: "2026-09-02",
    area: "Documents",
    summary:
      "A complete coursework workflow: interactive HTML study guides, PDF and guide previews in a pane, dated lecture sheets, Plynn imports, and realm-docs tools so an agent can read the same folder you can.",
    body: [
      {
        kind: "p",
        text: "A space full of lecture notes is the same problem as a space full of source: work that lives in files, gets read more than it gets written, and needs to be adjacent to the agent working on it.",
      },
      { kind: "h", text: "In the app" },
      {
        kind: "ul",
        items: [
          "Study guides render as a self-contained interactive page — quizzes, step-throughs, flashcards, KaTeX maths, per-topic progress.",
          "PDFs preview in a pane rather than opening elsewhere.",
          "Lecture sheets are dated Markdown files under `lectures/`, written during class and cleaned up after it.",
          "Plynn imports bring an existing set of course material in.",
        ],
      },
      { kind: "h", text: "For the agent" },
      {
        kind: "p",
        text: "The `realm-docs` tools let a session search and open the same folder, so a study guide can be built from the lecture notes without anything being pasted into a prompt. Two bundled skills — study-guide and lecture-notes — use them, and neither invents what a lecture said.",
      },
    ],
  },
  {
    slug: "browser-sign-in",
    title: "Credential-backed sign-in, and downloads that stay gated",
    date: "2026-09-02",
    area: "Browser",
    summary:
      "A browser pane can sign in from a stored credential without the agent ever seeing it, and a download an agent triggers still needs a person.",
    body: [
      {
        kind: "p",
        text: "An agent that needs a signed-in page has two bad options: be given the password, or be blocked. Realm fills the credential into the page itself. The agent drives the browser; it never receives the secret.",
      },
      {
        kind: "p",
        text: "Downloads stay gated behind an explicit approval. A file arriving on disk because a page offered it is exactly the event that should not be automatic.",
      },
    ],
  },
  {
    slug: "v0-4-0",
    title: "Realm v0.4.0",
    date: "2026-09-01",
    version: "v0.4.0",
    area: "Release",
    summary:
      "Ten branches composed into one build: pane groups, document panes, skill discovery, durable runs, session interjection, imports from the agent CLIs, and the model picker rework.",
    body: [
      {
        kind: "p",
        text: "v0.4.0 is the release where the parallel branches stopped being parallel. Ten of them merged, and a further pass was needed to make them compose — the failures that only appear once two features share a store are not visible on either branch.",
      },
      {
        kind: "ul",
        items: [
          "Pane groups, and focusing one pane to fill the space.",
          "Documents as a first-class pane kind, with their own store and migration.",
          "Skill discovery and a composer skill picker.",
          "Imports of sessions, memory and skills from the agent CLIs.",
          "Durable runs, and session interjection.",
          "Six ACP agents, with Gemini offered again.",
          "A model-first picker with a favourites shelf, and a harness chip of its own in the prompter.",
          "macOS access for the `mac` CLI, granted from the Permissions tab.",
          "A collapsible sidebar, with the toggle following it out.",
        ],
      },
    ],
  },
  {
    slug: "document-panes",
    title: "Documents get a pane of their own",
    date: "2026-09-01",
    area: "Documents",
    summary:
      "Documents became a pane kind rather than a file an agent mentions: created before they are named, renamed in place, persisted across relaunch.",
    body: [
      {
        kind: "p",
        text: "Realm's pane grammar covered sessions, terminals and browsers. Documents were the obvious fourth, and their absence was why work kept leaving the app the moment it produced something worth reading.",
      },
      {
        kind: "p",
        text: "A document is created before it is named — the naming dialogue in front of an empty file is a question nobody can answer yet — and renamed in place afterwards.",
      },
      {
        kind: "p",
        text: "Rich and source modes preserve the same document identity, and a document keeps its tab, its title and its save state across a relaunch.",
      },
    ],
  },
  {
    slug: "skill-discovery",
    title: "Skills, discovered and @-mentioned",
    date: "2026-09-01",
    area: "Workspace",
    summary:
      "Realm finds the skills already installed on the machine and lets a session reach one by name from the composer.",
    body: [
      {
        kind: "p",
        text: "Skills were already on disk, spread across the directories each CLI uses. The discovery service reads all of them and reports scope — user, project, or system — so it is clear which copy of a name is in play.",
      },
      {
        kind: "p",
        text: "In the composer, `@` reaches a skill by name. Realm injects per invocation rather than writing to the CLIs' own configuration; `~/.claude`, `~/.codex` and `~/.cursor` are read-only as far as Realm is concerned.",
      },
      {
        kind: "note",
        text: "A skill switched off in Settings is not a chip in the bubble, so a transcript never claims a skill was in play when it was not.",
      },
    ],
  },
  {
    slug: "import-from-the-clis",
    title: "Import sessions, memory and skills from the agent CLIs",
    date: "2026-09-01",
    area: "Platform",
    summary:
      "Existing work in Claude Code, Codex and the ACP agents can be brought into Realm — the fullest copy of each thread, deduplicated, with its real title.",
    body: [
      {
        kind: "p",
        text: "Nobody starts with Realm. Everyone starts with a directory full of transcripts written by the CLI they were already using, and an import that loses them is a reason not to switch.",
      },
      {
        kind: "p",
        text: "The importer takes the fullest copy of a thread where several exist, deduplicates the archives, and keeps the real titles rather than regenerating them. Memory files and skills come across in the same pass.",
      },
    ],
  },
  {
    slug: "durable-runs",
    title: "Durable runs: a goal that owns a session across attempts",
    date: "2026-09-01",
    area: "Agents",
    summary:
      "A run is a goal that survives its own failures — it owns the session, records each attempt, and can be resumed rather than restarted.",
    body: [
      {
        kind: "p",
        text: "A session is a conversation; a run is an intention. Conflating them means a crashed attempt loses the thing you actually asked for, and the only recovery is to type it again.",
      },
      {
        kind: "p",
        text: "A durable run holds the goal. Attempts happen underneath it, each recorded, and a resumed run picks up where the last attempt stopped rather than from the beginning.",
      },
      {
        kind: "p",
        text: "Run timing is stated from the run's own record, so a restart of Realm no longer reports a stale duration for something that finished before it.",
      },
    ],
  },
  {
    slug: "session-interjection",
    title: "One session asks another, mid-turn",
    date: "2026-09-01",
    area: "Agents",
    summary:
      "A running session can put a question to another session and use the answer without either of them being restarted.",
    body: [
      {
        kind: "p",
        text: "Two sessions working in the same space frequently hold halves of one answer. Without a channel between them, the only way to combine those halves is a person copying text from one pane to the other.",
      },
      {
        kind: "p",
        text: "Interjection gives one session a way to ask another while its own turn is still running. The question and the answer both land in both transcripts, so neither is a black box to the other afterwards.",
      },
    ],
  },
  {
    slug: "pane-groups",
    title: "Pane groups, and focusing one pane to fill the space",
    date: "2026-09-01",
    area: "Workspace",
    summary:
      "Named groups of panes, switchable from the command palette, plus a focus mode that gives one pane the whole space and gives it back.",
    body: [
      {
        kind: "p",
        text: "A space accumulates layouts. The arrangement for reviewing a diff is not the arrangement for debugging a terminal, and rebuilding one from the other by hand is the work the pane grammar exists to avoid.",
      },
      {
        kind: "p",
        text: "Groups are named layouts within a space. Existing layouts migrate into a single Main group, so nothing has to be rebuilt.",
      },
      {
        kind: "p",
        text: "Focus fills the space with one pane and restores the arrangement when you leave. Splitting equalises every pane in that split — three sessions side by side are three equal columns, not 50/25/25 — and double-clicking a divider restores a split to its original sizes.",
      },
    ],
  },
  {
    slug: "six-acp-agents",
    title: "Six ACP agents",
    date: "2026-09-01",
    area: "Agents",
    summary:
      "The generic ACP adapter now covers six agents, with modes and models read from configOptions and written back on the same channel.",
    body: [
      {
        kind: "p",
        text: "ACP is one protocol with several implementations that disagree about where a session's configuration lives. Realm was reading modes and models from the place the specification suggests rather than the place the agents use.",
      },
      {
        kind: "p",
        text: "Both now come from `configOptions`, and changes are written back on the same channel — which is what made the mode chip in the prompter mean anything for these agents. Gemini is offered again as a result.",
      },
    ],
  },
  {
    slug: "model-picker",
    title: "A model picker that leads with the model",
    date: "2026-09-01",
    area: "Agents",
    summary:
      "Rows are model-first rather than (harness, model), the harness moved to its own chip, and a favourites shelf sits above the list.",
    body: [
      {
        kind: "p",
        text: "The picker had been organised around the harness, which is the part of the choice a person makes once a week. The model is the part they change several times a day.",
      },
      {
        kind: "p",
        text: "Rows now lead with the model and carry the real provider mark. The harness moved out to its own chip in the prompter, where it can be changed without reopening the model list.",
      },
      {
        kind: "p",
        text: "A favourites shelf and a top rail sit above the catalogue, and the picker can be asked who made a model rather than only what it is called. The highlight anchors to a row rather than to a slot, so it cannot end up pointing at whatever moved into position.",
      },
    ],
  },
  {
    slug: "v0-3-0",
    title: "Realm v0.3.0",
    date: "2026-09-01",
    version: "v0.3.0",
    area: "Release",
    summary:
      "Claude Fable 5.1 as the Claude default, a rich-text composer draft, and an icon picker whose popover is anchored where it was opened.",
    body: [
      {
        kind: "ul",
        items: [
          "Claude Fable 5.1 added to the model picker, as the Claude default.",
          "The composer's draft renders as rich text rather than as a plain textarea.",
          "The icon picker's popover is anchored to its trigger, with menu and style tests covering it.",
        ],
      },
    ],
  },
  {
    slug: "v0-2-0",
    title: "Realm v0.2.0",
    date: "2026-09-01",
    version: "v0.2.0",
    area: "Release",
    summary:
      "Space icons from a per-profile library, AskUserQuestion as a real question card, Markdown in thinking blocks, and a configurable send key.",
    body: [
      {
        kind: "ul",
        items: [
          "Space icons can be generated or uploaded, from a per-profile icon library reusable by every space under it.",
          "Thinking blocks render as Markdown, so an agent's headings, lists and code fences stop reading as literal syntax.",
          "`AskUserQuestion` gets a question card with the actual choices, rather than an Allow / Deny gate over a JSON blob. The chosen labels persist, so a replayed transcript records what was answered.",
          "Image attachments show a thumbnail in the transcript instead of only a filename.",
          "An unstarted session can be moved to another space from the sidebar, re-homing its environment and tearing down any terminal rooted at the old working directory.",
          "The composer's send key is configurable: Enter, or ⌘/Ctrl+Enter to free plain Enter for newlines.",
          "The notifications list reads as hairline-separated rows rather than a stack of background pills.",
        ],
      },
      { kind: "h", text: "Fixed" },
      {
        kind: "p",
        text: "Streaming ids were retired on an interim `assistant` notification, which can arrive per completed content block. A thinking block followed by text therefore splintered every remaining delta onto its own id.",
      },
    ],
  },
  {
    slug: "v0-1-0",
    title: "Realm v0.1.0 — the first installable build",
    date: "2026-09-01",
    version: "v0.1.0",
    area: "Release",
    summary:
      "The first version of Realm anyone could install: the Universe shell, the MCP gateway, browser panes, orchestration, global search and session forks, packaged as a macOS app.",
    body: [
      {
        kind: "p",
        text: "v0.1.0 collects the first sixteen plans. It is the point at which Realm stopped being a repository you ran with `pnpm dev` and became an application you install.",
      },
      {
        kind: "ul",
        items: [
          "The Universe shell: scoped tools, pages, notifications and settings.",
          "The MCP gateway — agents reach servers only through Realm.",
          "The browser pane, and browser agents.",
          "Orchestration: Realm as the coordinator between sessions.",
          "Global search, and session forks.",
          "SkillSync, MCP connections and the memory manager.",
          "Real model catalogues for Codex and Cursor.",
          "Distribution readiness, and Realm as an installable macOS app.",
        ],
      },
    ],
  },
  {
    slug: "mcp-gateway",
    title: "The MCP gateway: agents reach servers only through Realm",
    date: "2026-08-31",
    area: "Platform",
    summary:
      "One Streamable HTTP gateway inside realm-server. Every MCP call an agent makes goes through it, which is how the credential stays out of the agent.",
    body: [
      {
        kind: "p",
        text: "The usual arrangement gives each agent its own MCP configuration and its own copy of every token. That is one credential store per harness, and no single place that can say what was called.",
      },
      {
        kind: "p",
        text: "Realm runs the gateway. Servers are configured once, connected once, and every agent reaches them through Realm — so the agent never receives the token, and there is one call log rather than four.",
      },
      { kind: "h", text: "How it is exposed" },
      {
        kind: "code",
        text: "agent  ->  realm-server (gateway)  ->  MCP server\n                      ^\n       credentials, scoping, call log",
      },
      {
        kind: "p",
        text: "The gateway listens on port 0 and reports the port it was given, so nothing collides with whatever else is running. Tools are scoped per space: a space that has not asked for a provider does not see it.",
      },
    ],
  },
  {
    slug: "browser-pane",
    title: "The browser pane, and browser agents",
    date: "2026-08-31",
    area: "Browser",
    summary:
      "A real browser as a pane kind, drivable by an agent, laid out without an overlay so it obeys the same split grammar as everything else.",
    body: [
      {
        kind: "p",
        text: "An agent that can read a page is a different agent from one that can only be told about it. The browser pane makes the page a first-class object in the workspace rather than a screenshot pasted into a prompt.",
      },
      {
        kind: "p",
        text: "It is laid out without an overlay, which is what lets it split, resize and persist like a session or a terminal instead of floating above the grid pretending to.",
      },
      {
        kind: "p",
        text: "Browser agents drive it through the same tool surface a person drives it with — navigate, snapshot, act by reference, read, screenshot — so what the agent did is reconstructable afterwards.",
      },
    ],
  },
  {
    slug: "worktrees-and-checkpoints",
    title: "Worktrees, a diff pane, and checkpoints",
    date: "2026-08-31",
    area: "Workspace",
    summary:
      "An environment split that gives a session its own worktree, a diff pane to review what it did, and checkpoints to undo it.",
    body: [
      {
        kind: "p",
        text: "Two agents in one checkout edit each other's files. Giving a session its own Git worktree makes parallel work possible without either of them noticing the other.",
      },
      {
        kind: "p",
        text: "The diff pane is where the result gets read. Diffs use colour plus signs, line structure and labels — colour alone never carries add or delete state — and they take the full useful width rather than a centred column.",
      },
      {
        kind: "p",
        text: "A checkpoint taken before a long run is the thing that makes letting one loose reasonable. Restoring is itself undoable.",
      },
    ],
  },
  {
    slug: "attachments",
    title: "File attachments in the prompter",
    date: "2026-08-31",
    area: "Agents",
    summary:
      "Files attach to a message as chips, dropped anywhere on the session pane, drawn as what they are rather than as one glyph for everything.",
    body: [
      {
        kind: "p",
        text: "Attachments arrive as chips on the prompter and stay chips in the sent message, so a transcript records what a question actually carried.",
      },
      {
        kind: "p",
        text: "A drop lands anywhere on the session pane rather than on a target you have to find. Each attachment is drawn as what it is — an image, a PDF, a spreadsheet — instead of the same glyph repeated, and a tile opens the file it is a picture of.",
      },
      {
        kind: "note",
        text: "Where a provider will silently drop a file, the composer says so before you send. Where the agent handles it itself, it says nothing — a note that appears every time is a note nobody reads by the third session.",
      },
    ],
  },
  {
    slug: "the-realm-mark",
    title: "The Realm mark",
    date: "2026-08-31",
    area: "Interface",
    summary:
      "A spectral ring set into a macOS squircle: layered spaces with the front room lit, shipped as SVG source and a macOS icns.",
    body: [
      {
        kind: "p",
        text: "The mark is layered spaces with the front room lit — the product's own mental model rather than an abstract glyph.",
      },
      {
        kind: "p",
        text: "It is built on Apple's icon grid: a 1024 canvas with an 824 superellipse, drawn as a fifth-order superellipse so its diagonal extent matches macOS's continuous corners rather than approximating them with a rounded rectangle.",
      },
      {
        kind: "p",
        text: "The animated version on this site is the same composition compiled to WGSL and run on the GPU: the bright head of the ring sweeps round, the hue drifts, and the icon tilts toward the pointer with its rim light following.",
      },
    ],
  },
  {
    slug: "the-prompter",
    title: "Grayscale ink, the prompter, and instant sessions",
    date: "2026-08-28",
    area: "Interface",
    summary:
      "The composer became the prompter — one surface carrying model, mode, workspace and context — and starting a session stopped being a form.",
    body: [
      {
        kind: "p",
        text: "The ink ramp went grayscale, with the space's colour reduced to an accent. A workspace tinted end to end by whichever colour a space was assigned is a workspace that cannot show state.",
      },
      {
        kind: "p",
        text: "The prompter collects everything that changes what the next send means — provider, model, mode, workspace, connectors — beside the thing you type, rather than in a settings sheet two clicks away.",
      },
      {
        kind: "p",
        text: "Starting a session became immediate. The sheet that used to ask four questions first now asks none: type, and the session exists.",
      },
    ],
  },
  {
    slug: "session-shell",
    title: "Full-bleed panes and a command layer",
    date: "2026-08-27",
    area: "Interface",
    summary:
      "The topbar was retired, panes run edge to edge with hairline dividers, and a global keyboard layer with a real command palette took over navigation.",
    body: [
      {
        kind: "p",
        text: "The topbar was chrome above chrome. Retiring it gave the panes the whole window, separated by hairlines rather than by margins.",
      },
      {
        kind: "p",
        text: "The command palette covers all spaces, orders by recency, starts one-shot sessions, and searches honestly — it does not claim a match it cannot open. Menus became keyboard-first, and hotkeys learned to keep out of the way of a focused terminal.",
      },
      {
        kind: "p",
        text: "Sessions gained inline rename, a pane menu, a git context row and durable drafts; the RPC socket reconnects with backoff and catches up on the events it missed rather than resetting the view.",
      },
    ],
  },
  {
    slug: "flat-shell",
    title: "Panels, Arc-true navigation, and a flat material",
    date: "2026-08-27",
    area: "Interface",
    summary:
      "Tabs became panels, the sidebar became the open set with close and delete finally distinct, and the glass material was replaced with a flat frame/panel/raised ladder.",
    body: [
      {
        kind: "p",
        text: "The shell had been built on glass and vibrancy. It was replaced with a flat three-step material — frame, panel, raised — because translucency was carrying decoration rather than depth, and depth is what a pane grid needs.",
      },
      {
        kind: "p",
        text: "One item per layout leaf replaced tabs, with a silent migration for existing layouts. The sidebar became the open set: an OPEN group and a SPACE group, with closing a pane and deleting its session distinguished rather than conflated behind one X.",
      },
      {
        kind: "p",
        text: "A sidebar item can be dragged onto a panel edge to split there, with the legal drop zones pinned by test rather than by feel.",
      },
    ],
  },
  {
    slug: "codex-and-acp",
    title: "Codex and ACP adapters",
    date: "2026-08-24",
    area: "Agents",
    summary:
      "Realm stopped being a Claude client: a shared NDJSON JSON-RPC transport, a Codex app-server adapter, and a generic ACP adapter covering Cursor and Gemini.",
    body: [
      {
        kind: "p",
        text: "One stdio transport is shared by both families. Above it sit pure mappers — Codex app-server notifications to session events, ACP `session/update` to the same — which is what lets the transcript be written once rather than three times.",
      },
      {
        kind: "p",
        text: "The Codex adapter runs against a single shared app-server connection with per-thread fan-out, and never leaves a server request unanswered. Streamed text is kept when a turn is interrupted, rather than discarded with the interruption.",
      },
      {
        kind: "p",
        text: "The ACP adapter confines its `fs/*` handlers to the session's working directory, and cancels a permission raised during teardown instead of leaving it dangling.",
      },
      {
        kind: "note",
        text: "Covered by a live end-to-end check against the real CLIs, not only against fakes. An adapter that only ever meets a fixture is an adapter for the fixture.",
      },
    ],
  },
  {
    slug: "arc-sessions",
    title: "Arc-style spaces, and the first agent sessions",
    date: "2026-08-17",
    area: "Agents",
    summary:
      "Spaces got colour, ordering and a swipeable strip driven by real trackpad phases — and Realm ran its first agent session, on the Claude adapter.",
    body: [
      {
        kind: "p",
        text: "The sidebar became a space strip you can swipe between, driven by native trackpad phases through a CGEventTap rather than by accumulated wheel deltas, so it tracks a finger the way macOS Spaces does and can be reversed mid-gesture.",
      },
      {
        kind: "p",
        text: "Underneath, the first agent session: an adapter interface, a message mapper, a sessions store and a session pane with a transcript, tool cards, permissions and a composer.",
      },
      {
        kind: "p",
        text: "Session status reached the sidebar, titles came from the first message, and a permission left dangling by a relaunch stopped blocking the session it belonged to.",
      },
    ],
  },
  {
    slug: "foundation",
    title: "The foundation",
    date: "2026-08-17",
    area: "Platform",
    summary:
      "The first commits: a pnpm monorepo, typed contracts, realm-server on SQLite and WebSockets with node-pty terminals, and an Electron shell with a split-tree pane host.",
    body: [
      {
        kind: "p",
        text: "Realm starts as four pieces that have not changed shape since.",
      },
      {
        kind: "ul",
        items: [
          "**contracts** — ids, entity schemas, layout-tree operations and an RPC envelope with method and event registries. Everything else is typed against this.",
          "**realm-server** — a `node:sqlite` database with append-only migrations, stores for profiles, spaces, projects and items, a WebSocket RPC server with broadcast, and a node-pty terminal manager.",
          "**desktop** — an Electron shell that spawns the server, a typed WebSocket client, a split-tree pane host, and terminal panes on xterm.",
          "**ui** — the icon wrapper and the palette-from-colour theme engine.",
        ],
      },
      {
        kind: "p",
        text: "Layouts persist and terminals respawn on boot, which is the property everything since has had to preserve: what you leave open is what you come back to.",
      },
    ],
  },
]
