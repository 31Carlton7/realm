# Changelog

## v1.6.0 — 2026-10-04

**Every space is in the sidebar at once.** A space used to be a room: you stood in one, the sidebar
listed what was in it, and an agent waiting in another space was a badge on a strip and a walk away.
Now each space of the profile is a section of one list — its name in its colour, a tally of what is
waiting and working in it, and its sessions, with what needs you first and five before Show more. A
section folds and remembers that it did; its + starts a session there, and its ⋯ reaches the space's
folder, connections, memory, archived sessions and settings. Pinned gathers the pins from every
space, and Recent lists the same sessions by when they last moved. The sidebar lists sessions only
now, and the space strip and its swipe went with the rooms. Since you no longer go anywhere to be in
a space, a session says where it works — its pane bar reads *Space › Session*, in the space's colour
— and one that has not started yet can be moved from the composer's space chip.

**The window shows one view, not a layout per space.** One pane, or two side by side, from whichever
spaces their sessions are in, and moving between them loads and unloads nothing, because every space
is already loaded. The current space is just the one the focused session works in, which is where a
new session goes. ⌘-click a session to open it beside the one you are in; ⌘\ and ⌘⇧\ still split.
Named splits went with the rooms, and so did their strip and their keys — ⌘⇧[, ⌘⇧] and ⌘⇧G. On the
first launch the split you were last in comes back as the view, and the sessions in your other
splits stay in their spaces. The view, and where the keyboard was in it, survive a relaunch.

**The app's destinations moved to a rail at the window's edge.** Home, Library, Connections,
Scheduled tasks and Notifications are a column of icons beside the sidebar, and the column stays
when ⌘B folds the sidebar away, so Home's count of what waits on you never leaves the screen. Your
avatar at its foot opens your page and Settings. The sidebar's head holds the profile switcher,
search and a new session, with the window's one pair of back and forward arrows beside them — on ⌃-
and ⌃⇧- too — and landing on a session puts the keyboard in its prompter. The pane bars' own arrows
are gone; ⌘[ and ⌘] still walk the focused pane's history. A page with sections of its own, such as
Settings or the Library, puts them in the sidebar's column while it is up, under a Back, instead of
drawing a second sidebar beside the first.

**What needs you is one list, and you can answer from it.** Needs you, at the top of the sidebar,
gathers every session waiting on a permission or a question — longest first, then failures you have
not read — from every space and every profile, and it is drawn only while something waits. A waiting
row unfolds that session's own card: Allow, Allow always or Deny, or a question's options and a
field for an answer of your own. Home, the Agents page, puts the same card under each row and tile
and a Stop on anything running, so a fan-out can be answered without opening one session of it. The
cards are the transcript's own, so an answer given anywhere clears it everywhere, and Escape folds a
card or closes the page instead of denying the request that had the focus. Peek, from a session's
menu, a row on Home or a notification, opens any session as a tab beside the one you are in — its
transcript and its card, with no prompter — and saves it nowhere.

**What an agent opens arrives as a tab beside its session.** A browser, a device, a document or a
terminal an agent opens is a tab of one side pane, to the right of the session that asked, rather
than a new column beside whatever had focus — which is how a fan-out of six agents once filled a
window with eight columns too narrow to read. A sub-agent gets no pane at all: the agents a session
has working are a count in its bar, and the list behind the count can preview one as a tab. Every
browser tab stays live behind the one showing, and what is opened for a session that is off screen
waits in that session's side pane, still live for the agent driving it. The + after the tabs (⌘⇧B,
or ⌥⌘B for full view) opens a blank tab listing the session's tools — Files, Terminal, Documents,
Simulator, Machine — and the pages you visited last, and ⌘J puts the session's terminal there too.
A terminal an agent opened comes back to the front when it stops at a password prompt; in 1.5, a
sudo prompt sat for a day and a half in a terminal its owner could not find.

**Profiles keep their sign-ins to themselves.** Every browser pane in every profile shared one
cookie jar, so Work was signed in to whatever Personal was, and an agent in a Work space was offered
Personal's saved passwords. Each profile now has its own cookie jar, saved sign-ins, passkeys and
browsing history, and Clear browsing data clears only the profile it names. What you were already
signed in to stays with your first profile; the others start signed out. Where you do want to share,
a saved sign-in or passkey has Share with, and a browser pane's menu can copy the site's sign-in
into another profile. A space moved to another profile takes its browser into that profile's jar.
Profiles can be made, renamed, recoloured and deleted in the app now — deleting one says how many
spaces and sessions go with it, and asks you to type its name — and the switcher says what waits in
each.

**An agent can make a password for a sign-up, and nobody sees it.** Asked to create an account, an
agent had nowhere to put a password but the chat. Now it can ask Realm to make one: Realm generates
it on this Mac, saves it to the profile's sign-ins and types it into the page, after a card that names
the site and after Touch ID. The agent is never told the value; it can fill the same password into a
confirm field by the new sign-in's id, and nothing more. Settings ▸ Sign-ins marks those rows
Generated by Realm, and because you have never seen the value either, the site's own reset is the way
back if you need it outside Realm.

**A profile can have a window of its own.** The profile switcher, or the command palette, opens a
profile in a window of its own, or brings forward the one already showing it, so Work and Personal
can sit side by side. Each window boots into its profile and remembers its place, and a browser an
agent drives, or a passkey prompt, finds the window that holds its pane.

**Realm behaves like a Mac app, not a page in one.** The difference was a dozen small web habits,
each one a Mac user notices without being able to name it. A button darkens when pressed instead of
shrinking, and lets go if you drag off it; the pointing hand is kept for links; dragging across the
interface no longer selects it like text. Menus are the system's own — type-to-select, real
shortcuts, and able to open over a browser pane, which nothing Realm drew could — and a right-click
in text offers spelling, Look Up and the link under the pointer. Popovers and sheets move on a
spring, lists rubber-band under the trackpad but never under a mouse wheel, and a window that is not
in front greys its accent. There is a real menu bar — Settings… (⌘,), File, Edit, View, Go, Window
and Help — whose rows show your own keybindings, and Reload is in development builds only; before,
⌘R could reload the app out from under a running agent. The window reopens where you left it, at its
size, maximised or in full screen.

**Light mode is light.** On a Mac set to Dark, Realm's light mode came out a muddy grey: nothing
told macOS the window had an appearance of its own, so the material behind it stayed dark and the
light ground was laid over that. Realm now tells macOS which theme it is in, and menus, Quick Look
and the Share sheet follow it. The light palette also steps the way the dark one does — the sidebar
a shade under the work, wells recessed instead of bright — lets far less of the desktop through, and
its quiet text, hints and links, is dark enough to read.

**Realm has a new icon, and eight more for the Dock.** It is the folded-hexagon mark in polished
chrome, on a satin graphite body. Settings ▸ Appearance ▸ App icon offers eight alternates in the
same material — indigo chrome, clay, frost, smoke, sticker, ocean, ember and mint — and a pick goes
on the Dock at once and is there from the start of the next launch. The Finder and Launchpad keep
the standard icon, because a running app can change only its own Dock tile, and the row says so.

**Type sits on one scale, and icons are drawn at the weight of their text.** Six text sizes had
grown inside a 2.5px band and were used interchangeably. Every size is a rung of one ladder now,
which also put the code preview's line numbers back beside their lines — they had drifted a full
line behind by the twenty-fourth. Icons come from a rounder set and are drawn heavier at small
sizes, the way a Mac draws small symbols, so a 12px glyph is no longer a hairline beside its label.
Labels set in tracked capitals are sentence case, edges are a rung softer, and a focus ring follows
its control's curve rather than drawing a rectangle around it.

**Settings is grouped by what you came for, and you can read it.** Seven flat tabs read as seven
equal things, and App alone held a theme picker, a permission default, a notification relay and the
credits. The pages now sit under You, Engines, Browser, Computer and Data; App is split into
General, Appearance and Notifications; and a search finds any row and opens its page on that
control. Rows are cards, with labels at reading size and descriptions dark enough to read — the old
hints measured 3.5:1 on the dark ground — and each page's head names the page. Computer use gathers
every space's computer-control switch and always-allowed apps beside the two macOS grants they need,
and Archived lists every space's archived sessions. Appearance gains UI and code text sizes that
change the type without zooming the layout, a content font for messages and documents, Reduce motion
as System, On or Off, and separate translucency for the sidebar and the panes. General gains Keep
the Mac awake while agents work, off unless you turn it on; where the session terminal goes; and
Open files in, for whichever of Cursor, VS Code, Zed and Xcode this Mac has.

**The Library sorts by kind, and Memory saves itself.** The Library's files open on tabs — All,
Images, Documents, Code, Data — beside a filter for where a file was made and by whom, a choice of
tiles or rows, and a search; a tab narrows the whole Library, not only the page already loaded.
Every file is one square tile, a picture filling its own. "Every space" now means every space of
this window's profile; a Work window used to list what School's sessions had made. Memory was a
textarea with a Save button. It is the document itself now, at reading size, with Write and Preview:
a pause in typing saves it, and the head says Edited, Saving or Saved. It says who reads it — every
new Claude and Codex session in the space — and how it travels, through the AGENTS.md mirror and the
file it is kept in. The Library's Memory covers every space, the profile's own document first.

**First run gets you to a signed-in agent with no terminal.** It was thirteen equal radio rows
beside a form, and a row that said "Not installed" or "Signed out" handed a newcomer a problem with
no way to solve it. Now it is one page: Choose your agent, with Claude and Codex as cards that do
what their state needs right there — Install, Sign in with Claude, Sign in with ChatGPT, a field for
the code the sign-in page shows — the other agents folded behind one line, then Name your space, and
Start. Claude needs no install, since Realm already carries Claude Code, and Codex's card says when
it needs Node.js first. A signed-out Claude also reads as signed out now: the check misread the
CLI's answer, and a stale credentials file passed for a sign-in.

**A page about you.** Your avatar at the foot of the rail opens it: your name and picture; tokens
over all time, your busiest day, the longest an agent worked on one turn, and your current and
longest streaks; the activity calendar, which now reads by day, by week or as a running total; and
the models, efforts, skills and tools you use most. A figure no engine can report is left off, with
the reason, rather than shown as a zero. A picture you choose is copied into Realm's folder, so
moving the original changes nothing, and until you choose one you are a person in a neutral circle
rather than a bare initial.

**The browser pane has a browser's controls.** Each tab wears its site's own icon, kept for the next
launch. The ⋯ at the end of the toolbar opens a menu macOS draws, so it can sit over the page: Find
in page (⌘F), Print, Zoom, Take a screenshot — saved to the space's screenshots folder and attached
to the session — downloads, history and Clear browsing data. Device size lays the page out at an
iPhone's, an iPad's or a desktop's width; it is a check of a layout at a width, not a phone, since
the user agent stays Realm's and touch is not emulated. The address field suggests pages you have
visited as you type, most visited first, then a web search — a history that starts with this
version, because Realm kept none before. And Annotate pins several elements of a page, numbered, and
sends them to the session as one chip, with a screenshot that shows the numbers.

**A file in Realm does what a file in the Finder does.** In the Library or a session's file list,
Space shows it in Quick Look and Return opens it; it drags out into another app as the real file;
and its menu, there and on a path in the transcript, offers Quick Look and the Share menu. A picture
opens in the Documents pane now, where it used to leave a tab over "Nothing open yet", and one
opened from a session's file browser fills the window instead of the sheet meant for handing a file
to the Finder. That browser can also lay its folder out as the Library's tiles. Reveal in Finder
works on the ~/ and relative paths agents write, and says so when nothing is there.

**Agents get the simulator pane, and hands to use it with.** Asked to show an iOS app, an agent used
to start serve-sim in a terminal and open its stream in a browser pane — a worse copy of the pane
Realm already had, without the device controls. The simulator tools hand it the pane itself: list
devices, open one beside the session, take a screenshot, read the elements, install, launch and open
a URL — and tap, double tap, long press, swipe, type and press the hardware buttons, on iOS
simulators and Android emulators. An element is a number from the agent's latest read, and a number
from an older read is refused, because the same position on a screen that has moved is a different
control. Each step says what it is for, which is what the permission card shows, and the card is
asked once per device per session. The tools are on by default; on a Mac with neither Xcode nor
Android Studio, the Connections row says what is missing instead of a switch reading Enabled.

**A whole path in one call.** Tapping through an app by number costs an agent a read and a tap per
step, each one of its turns, and a turn takes seconds. A walk takes the labels once —
`["General", "About"]` on a device, `["File", "Export as PDF…"]` in a Mac app,
`["Docs", "Getting started"]` on a web page — finds each on the live screen as a person would write
it, presses it, waits for the screen to settle, and answers with where it ended up, numbered for the
next step. On a web page it measured no faster in tool time; what it saves is the agent's turns. It
stops rather than guesses: at a label it cannot find, at a press that changed nothing, and before
any step that buys, deletes, clears data, sends or shares, signs out, makes an account or types a
secret — and, in Instagram, TikTok and the other social apps, before a like, a follow, a comment or
a message.

**A real iPhone, over the cable.** A connected iPhone or iPad appears in the device pane's picker
under Connected devices. Picking it has Realm build a small test runner, sign it with your own Apple
Development identity and run it on the phone — a minute or two the first time, with the phone
unlocked — and the agents' device tools and walks then work on it as they do on a simulator. The
picture is live, the way QuickTime shows a connected phone, rather than a screenshot about once a
second; macOS reaches a phone's screen as a camera, so the pane asks for camera access with one
click, and Settings ▸ Permissions has a Camera row. No web page in a browser pane can have the
camera or the microphone. And because a phone is somebody's phone, the rules are stricter: its cards
are asked even under Full access, a locked phone is refused, the side button is never pressed, a
system alert is never answered for you, only apps Xcode installed are listed, and every touch is
checked under the finger just before it lands — one on the keyboard's Dictate key is refused,
whatever was asked for. The runner comes off the phone when its last pane closes.

**Laya, a decision model that runs on your Mac, watches agents work.** Settings ▸ Engines ▸ Laya
(local decisions) installs it when you ask — about 1 GB of PyTorch and 0.8 GB of weights, on Apple
silicon — and it runs on this Mac alone. In Shadow it is asked about every step an agent takes in a
Mac app, on a device or on a web page: which element fits what the agent meant, whether the step is
sensitive, whether it worked. Its answers are logged beside what really happened, and nothing it
says reaches the agent, a permission card or the transcript. Train makes a new checkpoint from the
screens Realm ships, your recordings and that log, in half an hour to an hour on the Mac's GPU, and
keeps it only if it scores better on steps it never trained on; it will not start on a Mac short of
memory or disk, and stops itself before swap can fill the disk. Record for Laya, in a device pane's
bar, reads each new screen of the app you are using and taps nothing, keeping no typed text. Assist,
where an agent names an element in words and Laya picks it, is earned rather than chosen: it unlocks
only for a checkpoint that is right 95% of the time on held-out steps. None is yet, the download
included, so Assist stays locked and says by how much. The log and the recordings never leave this
Mac.

### Smaller changes and fixes

- Fast mode switched on before a session's first message now runs fast; until now it never reached
  Claude. The Speed switch is offered from the first message on any model a session has already run
  — Opus 5.5 picked by name never showed it at all — and its note no longer reads an old turn that
  never asked for fast mode as a refusal.
- An answer fades in as it streams, a run of text at a time, instead of stamping on in chunks. A
  restored transcript stays still, and so does everything under Reduce motion.
- Send now on a queued message waits for the Claude turn it stops to settle, instead of landing in
  that turn and being lost with it.
- A sidebar row keeps its state at its far end, and its actions take that place on hover rather than
  holding back part of the title for buttons it is not showing. A resting row wears nothing; one
  with news wears the unread ring, which until now could never appear, and opening the session
  clears it.
- The empty session's greeting links to its space, and names the worktree or linked checkout when
  that is where the next message runs.
- A delegating tool call links to each agent it started. A delegated Claude agent you stop yourself
  is reported to the lead as stopped, with what it had written, rather than as finished; a stopped
  Codex or ACP agent still reads as finished.
- Skills in `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills` (or under `CODEX_HOME`) and
  `~/.cursor/skills` are found now; the scan had been looking inside Realm's own folder. They arrive
  switched off, as before.
- A browser an agent drives with no pane showing it keeps its page, title and icon saved, so its
  tab, and the next launch, show where it really is.
- A finished download is reported as finished rather than "interrupted", and a pane's first page no
  longer has a Back that leads to a blank page.
- A theme with a hue, Rosé Pine or Nord, now colours the sidebar as well as the panes. The sidebar
  had been more the system's grey than the theme.
- Panes are a touch more see-through by default, at 84%: measured, the thinnest at which body text
  still clears WCAG AA on every theme, over a white desktop or a black one.
- The terminal takes the chat's background instead of a darker slab, and in light mode a program's
  colours are darkened until they read.
- The transcript no longer scrolls sideways under a sent file's tip, or paints a scrollbar corner
  white.
- `pnpm app:update`, which builds and installs Realm from source, now signs the build with your
  Developer ID, so macOS keeps its Accessibility, Screen Recording, Automation, Calendar and
  Contacts grants from one install to the next. It refuses to put an unsigned build over a signed
  one unless told to.

## v1.5.0 — 2026-09-27

**Realm can use itself.** A session in a space can now open a terminal pane and read what it is
actually displaying — the rendered screen, so a full-screen program's repaints resolve instead of
replaying as escape codes — and it can read Realm's own interface as elements and click in it. The
terminal provider is on by default and the interface one is off, and the asymmetry is the point:
every harness already has a shell tool, so a terminal that talks back adds a capability rather than
a second way to run commands, while reaching the window you are reading in is a different kind of
thing to hand out. A sign-in is the case that pays for all of it: `claude auth login` under a
non-interactive shell hangs forever, because there is nothing on the other end to answer the code it
prints. Here it runs, and Realm can read the URL, open the consent page, and stop at the one act
that grants a durable capability — which stays yours unless you say otherwise, per space.

**The Agents page is a room, not only a list.** Three views over the same agents, because "what is
everything doing" and "what did that one just say" are different questions and a list only answers
the second. The wall is tiles with state on their faces; the office is a drawn room with a figure per
agent in a seat, redrawn from a sentence you type at it. Ordering comes from what actually moved,
which is also what the new "Sort spaces by activity" switch reads.

**Two things are called what they are.** The sidebar's catch-all section said "Space" — a container's
name sitting under "Open", which names what its rows *are* — and now says Sessions. And a pane group
is a split: the strip above the panes, the sidebar's button, the palette's row, the ⌘⇧[ / ⌘⇧] labels
and the names new ones are given all say so. The strip also stopped crowding the traffic lights.

**The cursor has the controls it should have had.** A terminal's cursor gets a shape — block, bar or
underline — as its own setting rather than a mode of the blink, because a bar that holds still and a
block that pulses are both pairs people ask for. The code editor's caret gets its own blink switch,
separate from the terminal's, the same split VS Code makes. The prompter's caret still cannot be
told either way: it is the platform's, and Chromium exposes no way to hold it still until
`caret-animation` lands. The switch says so rather than quietly covering half of what it names.

**Claude Opus 5.5** is in the model picker. Adding a Claude model is not just a row — the bundled CLI
has to know the id, or the API answers with a 400 and the session quietly runs something else. That
rule had been written in three comments and enforced by none of them, and it had already gone wrong
once. It is a test now: every model Realm offers is checked against the binary that will be asked to
run it.

### Reading and writing

- Line height is adjustable, as an offset rather than a value. Prose is 1.6, markdown 1.55 and a
  code block 1.65, and one slider moves all of them from their own starting point — a control that
  set a single number would flatten the distances that are the reason a code block breathes more
  than a paragraph.
- A Quick Look render and a guide come back to where you were reading. A PDF still does not, and
  cannot: Chromium renders it in a nested viewer that runs no script of ours.
- An answer's own passage can be quoted back instead of described.
- The prompter's pickers show a scrollbar while they scroll and not the rest of the time.

### Getting rid of things

- "Really delete?" is optional, in Settings ▸ App ▸ Deleting. On unless you say otherwise, and read
  so that an unset preference keeps asking.
- Sidebar rows that are not sessions have a trash of their own. Archiving is a session's answer to
  being finished; a terminal or a documents pane had no way out but a right-click.
- Downloads no longer refuse a file because of its extension. The boundary that matters is the
  grant, not whether someone has heard of `.parquet`.

### Elsewhere

- A schedule can name a single moment — "in two weeks, open the PR" — instead of being written as a
  cron expression that fires once in 2031 and is forgotten.
- A signed-out session says what to do about it, with the command to run, instead of showing the raw
  failure. It only says so after re-checking, because the credentials file cannot answer "signed
  out" on macOS and a remedy offered on a guess is worse than none.
- A passkey works in a browser pane. Electron ships the WebAuthn API without an authenticator behind
  it, so Realm is the authenticator: the key is held encrypted and reaches the page for the length of
  one request you approved with Touch ID.
- Right-click either arrow in a browser pane for the pages behind or ahead of it.
- ⌘⇧N opens Quick Chat; ⌘⇧G makes a split. Both were reachable only by mouse.
- A profile's spaces moved into that page's rail, beside Skills, Connections and Memory, instead of
  sitting over the title as a strip of chips.

## v1.4.1 — 2026-09-21

**A packaging fix for v1.4.0, which could not start.** The terminal renderer that v1.4.0 introduced
pulls in a CommonJS library, and the server bundler leaves anything declared as a dependency for the
runtime to resolve — so the shipped server carried an import Node refuses at load, and died the
moment the app spawned it. v1.4.0 was withdrawn; everything below it is in this release.

Nothing caught it, and that is the more interesting half. The test suite passed, because the test
runner resolves that import through its own transform. Type checking passed, because the types were
never wrong. The build passed, because compiling a bundle does not run it. The first execution of
that line was going to be on someone's machine.

So `pnpm release` now boots the server it just packaged, on a scratch home, and requires it to report
ready before the version commit and the tag exist. It closes the class rather than the instance: any
import that resolves while compiling and explodes while loading now fails the release instead of
shipping.

## v1.4.0 — 2026-09-20

**Realm can use a terminal.** An agent gets `terminal_open`, `terminal_write`, `terminal_read` and
`terminal_wait` over a real terminal pane in the space — visible in the sidebar, yours to take over
by typing into it. This is not a second shell tool: every harness already has one, and for running a
command and reading its output that one is better. This is for what a non-interactive shell
structurally cannot do — a program that keeps a terminal and asks questions. `claude auth login`
under `bash -c` hangs, because there is nothing on the other end to answer it.

What made it possible was reading, not access. A terminal's scrollback is a raw tail, and every agent
CLI worth signing into draws its login as a full-screen TUI: stripping the escape codes gives you
everything the program typed *and untyped*, in order, which reads as gibberish that looks like
content. Realm now renders those bytes into the screen a person would be looking at — on demand, per
read, so a pty nobody is reading costs what it always did. Soft-wrapped rows come back rejoined,
because a sign-in URL is two hundred characters, splits across three rows at any width, and one
spliced back together wrong is a failure with nothing on screen to explain it.

**Signing an agent in is a button now.** When a CLI is signed out, the card that used to print a
command at you offers *Sign in*: Realm opens a terminal, runs that CLI's own login command, reads the
URL it prints and opens the consent page in a pane beside it. It stops there. Approving a sign-in
grants a durable capability, so that click is yours — and Realm's browser tools refuse it, in every
permission mode. A space can hand that last step over in Connections ▸ *Finishing sign-ins*, and even
then the permission is narrow: the one page Realm opened, from a login it started itself, for five
minutes. Off by default.

**An agent can be refused a consent screen it is already looking at.** Realm has always refused to
*navigate* an agent to an OAuth authorization page. It turned out that never covered the act the rule
exists to prevent: a pane that reached one by a redirect, a link, or your own address bar could be
clicked freely, in every mode. Acting on a pane now asks where that pane actually is. This release
makes that guard stronger than it was, and the sign-in flow above is the one deliberate, provenanced
exception to it.

**Realm's own interface, for an agent that needs to see it.** `app_snapshot` reads the window you are
looking at as elements; `app_act` clicks, types and scrolls in it. It is for seeing what is on your
screen and checking that something really renders — not for doing what Realm already has a tool or a
setting for, which is direct where a click is a guess about layout. It ships **off**, per space: every
other Realm toolset reaches a pane Realm made for it, and this one reaches the window you read and
answer questions in.

Two buttons in that window are refused outright, in every mode: the permission card and the
permission-mode confirmation. An agent that could press those could approve the request it is blocked
on, and no permission model survives that. The surfaces declare themselves in the markup, checked
against the live screen at the moment of the click.

**You can see it happening.** The accent frame and pointer that mark a browser pane as agent-driven
now appear on Realm's own panes too, drawn from one table of numbers both halves read, so the two
faces of that signal cannot drift apart. A terminal being typed into wears the frame and a driving dot
on its sidebar row.

**Sort spaces by activity.** Settings ▸ App ▸ Sidebar orders the space strip by what is happening —
a space with a question waiting first, then whichever moved most recently — leaving the order you
dragged untouched underneath, so turning it off puts the strip back exactly as you left it. Dragging
is off while it is on, and the page says so: a drop into a spot the next status change would move
away from is a drop that did nothing.

## v1.3.0 — 2026-09-12

**The keymap is a file.** `~/Realm/keybindings.json` holds rules of `{key, command, when}`, where
`when` is a boolean expression over what the window is doing — `!overlayOpen && sessionFocus`. The
last matching rule wins, which is how a rule you write beats a default Realm ships. Defaults are
seeded the first time it is read, and newly shipped ones merge in later unless a rule of yours
already claims that command or that key. Everything that *prints* a shortcut reads the same list the
handler reads, so a rebind moves the hint with it instead of leaving a lie in the palette. Settings ▸
Keys lists all 43 commands with their current chord, marks a rule a later rule has already defeated,
and says plainly when your file could not be parsed — Realm runs its defaults and leaves the file
exactly as you left it.

**Your own slash commands, and scripts a space owns.** A command is a markdown file with front
matter, found in the space folder's `commands/`, in `~/Realm/commands/`, and read-only from
`~/.claude/commands/`; `$ARGUMENTS` and `$1`…`$9` expand into the draft, and a placeholder nothing was
typed for is left standing rather than quietly emptied. A script is a named shell line — `pnpm test` —
that runs in a real terminal and is addressable as `script.<id>.run`, so a key can be bound to it.
A key bound to a script this space does not define is left alone rather than swallowed, so it still
does whatever it would have done.

**Source files open in an editor.** CodeMirror 6 in the documents pane, in the app's own theme, with
find, undo and a file-changed-on-disk prompt that asks rather than picking a winner. Markdown still
opens in the rich editor. ⌘P finds a file by name across the checkout and ⌘⇧P searches its contents
through `git grep` — which honours `.gitignore` and still finds the file written ten seconds ago and
never committed. A space with no checkout says so instead of showing an empty list.

**A restore can take the conversation with it.** Restoring a checkpoint put the files back and left
the agent remembering having written them. For Claude sessions it now rewinds both: the transcript is
cut back to that point and the provider conversation is resumed truncated at the same turn, so the
agent carries on with no memory of the turns after it. Every other agent says so rather than
implying otherwise — "Files only — the agent keeps its memory of these turns."

**Agents and terminals can be sandboxed.** A macOS Seatbelt policy applied when Realm starts an agent
CLI or a shell: this space's checkouts and the toolchain caches are writable, `$HOME` is not, and
`~/.ssh`, `~/.aws` and `~/Library/Keychains` cannot be read at all. It confines the process and
everything that process starts. It ships **off**, per space and on purpose: the writable-root list has
not met enough real toolchains yet, and one shared `codex app-server` cannot hold two spaces'
policies — so a Codex session in a sandboxed space refuses to start rather than running unprotected.
Seatbelt is not a container, and the settings page says so.

**The activity lens lists your chats.** Every one, across the profile's spaces, grouped by the day it
was last worked on, each row carrying the space, the folder and the branch — the facts that tell two
chats called "Fix the login form" apart. The gateway's call log keeps its record in the ⌘K sheet and
in a space's Connections tab.

**Machines.** A pane that shows a screen somewhere else and lets an agent drive it: a second Mac over
Screen Sharing, a cloud sandbox, or a Linux guest Realm boots here. Four transports are recognised
from whatever address a provider hands out, the password stays on this side of the relay, and the
agent's pointer is drawn as a pointer so you can watch it work.

**realm-server outlives the app.** It has a name, a lock and a door now: closing the window stops
looking rather than stops working, a second launch finds the daemon already running instead of
racing it for the database, and Realm keeps a menu-bar presence while it does. A refusal to run
against a server this app did not ship is enforced, not assumed.

**Smaller things.** A cursor on terminal output, so reattaching to a shell is not the same as losing
it. Codex's plan windows read off the wire it was already sending them on, and how much of the plan
is left. A message typed mid-turn can wait its turn or take it. Focus is restored where you left it,
with an answer to what changed while you were away.

**Fixed.** The band above the prompter is one object again: a plan, goal or agents strip stacked over
a composer in Plan or Ask mode kept the neutral edge while the card wore the mode's colour, which
notched the join at both sides.

## v1.2.0 — 2026-09-10

**Dividers that stay put.** The line between two panes was disappearing and coming back when you
nudged it. A browser pane is a native view that composites above the window's own drawing, and its
bounds rounded each edge independently — so a pane whose left edge landed a fraction of a pixel
short covered the divider beside it and could not be drawn over in return. Even splits were where it
bit: halves round outward-safe, thirds and sixths do not. The view is now inset to the pixel grid and
can never reach outside its own box.

**Reorderable pane-group tabs.** Drag a tab along the strip to reorder it, or move it with ⌥←/⌥→.
The drop indicator is a rule in the gap between tabs, distinct from dropping a pane *onto* a tab,
which still moves that pane into the group.

**First run, in two columns.** The agents on the left, the space on the right. Stacked, the one field
anybody types sat below a dozen radios; side by side each half is scannable on its own. The space's
icon and colour are on that form now — first run was already choosing them, it just never showed you.

**Quieter surfaces.** The prompter's lift is cast from its curve rather than its box, so the shadow
follows the corner instead of squaring it off. The space strip's fill dissolves into the material
behind it, and the under-strip takes the card's ring and as much of its rounding as it can hold.

**Fixed.** `pnpm app:icons` finds and clears the stale bundle registrations that were putting an old
app icon on notification banners — every packaged build left in a worktree claims the same bundle
identifier, and macOS can resolve a notification's icon to any of them.

## v1.1.0 — 2026-09-09

**Agents.** A page that reads every session the way a manager would: grouped by what they need from
you — Needs you, Working, Failed, then Ready and Ended folded away — rather than by the space they
happen to live in.

**Connectors.** The apps a space works in, connected in one click: each a vendor's own remote MCP
server over OAuth, so there is nothing to install and no token to paste. Connecting one makes an
ordinary server row, with the same tools policy and activity log as any other. Pasted links from
those apps become chips that say what they point at — a Slack permalink reads as a thread instead of
ninety characters of nothing.

**Notifications reach your phone.** A relay beside the desktop notifications sends the three things
worth interrupting for — a permission, a blocked run, a finished turn — to iMessage or a Slack
webhook.

**Ligatures.** JetBrains Mono draws `=>`, `!==` and `>=` as single glyphs everywhere Realm shows
code. They had been off for a reason nothing said out loud: Chromium disables every ligature on text
with letter-spacing, and the app's -0.1px tracking applied to code as well as prose. Monospace wants
no tracking anyway.

**The model picker.** The strip above the list used to filter by who made the model. It now names
the list's own separators — Claude, Codex, Cursor, Grok, DeepSeek — with each harness's mark, and
takes you to one. Nothing is hidden by pressing it, so nothing has to be put back. Effort and
permission labels moved above their controls, which stops "Ask each time" from wrapping onto two
lines, and the list's edges dissolve properly: the fades had never once painted.

**Dropped icons are compressed.** A photo dropped on the space-icon picker was sent at full size and
refused by the upload cap; only the file dialog had ever compressed. Both paths now do.

**Smaller things.** A bigger space name in the sidebar with room around the search field and the
new-session row, a subtler sidebar edge, an entrance for the connection banner and the error bar
instead of a hard cut, and Hermes as an agent.

## v1.0.0 — 2026-09-09

The 1.0. Realm stops being a place to run one agent and becomes a workspace: documents and files
sit beside the session that is working on them, runs can be scheduled and delegated, and the whole
interface has been taken through a single design pass so it reads as one instrument.

**Documents.** Word, Excel, Keynote, PDF and Markdown files open in a pane of their own, beside the
session rather than on top of it. A tab is marked unsaved while you type, and a file changed on disk
under an open editor asks rather than picking a winner. The pane scrolls, and tables look like
tables.

**The Library.** It holds the files now, not just the skills. A card carries a real thumbnail where
the picture *is* the file, and clicking any card opens one preview — the render, the path, the size,
and a button back to the session that produced it, switching space when it lives in another one. Save
a copy, Reveal in Finder, Copy path, Expand and Open all route through the same predicate a session
summary uses, so a file cannot open two different ways depending on which list reached it. The skills
page was restructured alongside it, and no longer rejects a file it has just written itself.

**Scheduled tasks.** A clock in front of the runs — work that fires on its own schedule, with a
search field and four counted chips over the list. Beside it, a year of the days Realm was used,
drawn as a grid.

**Delegation.** The dock lists the sub-agents the harness is running, not just the ones Realm made.
Background `Agent`/`Task` calls return in under a second and then work for minutes, so ten of them
used to look exactly like ten finished calls; Realm now reads the harness's own task protocol and
shows them for as long as they run.

**What a session knows.** Every session is now told, at start, what Realm's own tools are for — and
only the ones it actually has. A space that switched the browser off is never handed a paragraph
about driving one, and each block says when *not* to reach for the tools, so nothing gets delegated
that would have been a one-line edit.

**Plan mode** looks like planning, and a plan has somewhere to go when it is finished. The permission
and mode chips are drawn as one control, and Full access no longer borrows Plan's colour.

**The prompter** takes `/` commands, starting with Export session, and a turn's summary now lands in
the transcript instead of covering the thing you type into — so what a turn produced is still
readable tomorrow.

**Simulators.** A control inside an Apple Simulator streamed into a browser pane can be picked. The
device screen is one canvas as far as the DOM is concerned, so Realm resolves the click against the
device's own accessibility tree and says plainly, in the prompt, that `browser_act` cannot address it.

**A new app icon.** The old one was a shader that read as a smudge at 32px. This is a drawn mark —
two interlocking bays on the app's own near-black, each face lit by the way it points: a white top,
grey sides, a near-black base — taken from one SVG to every native size, so the menu bar and the
dock come off the same geometry.

**Design.** Fast mode, OpenHands as an agent, ⌘K on the app's own curve, real app icons on the
permissions page, per-CLI self-update, and a pass over every control: buttons and fields on the
squircle rather than snapping square on hover, hairlines and blurs softened, settings and connections
rebuilt as cards, list edges dissolved, the sidebar actually translucent, and nothing set below 11px
anywhere in the renderer.

**The site** was rebuilt around what Realm does rather than how to configure it: the mark drawn live
as liquid glass on the GPU, a features page over real product screenshots, a changelog, share images
for links, and a download button that asks GitHub for the current release instead of pinning a URL
that goes stale.

## v0.6.1 — 2026-09-06

A fixes release for the prompter, the sidebar and Settings, from a round of screenshot review.

**Prompter.** The note under the attachment chips no longer narrates a handoff the agent completes
itself — Codex getting a path, Cursor getting a link — for any provider. Only a file the agent will
silently drop still earns a warning; the rest stays on the chip's tooltip. The strip under the card
now sits evenly, ten pixels above and below its chips instead of two and twelve, and its bottom
corners draw at the card's own squircle: the paint worklet reduces radii the way `border-radius`
does, rather than clamping every corner to half the box.

**Model picker.** The provider strip says the model family — Claude, GPT, Gemini, Grok, Kimi, GLM —
beside its mark, matching the list's own separators, instead of the maker's corporate name. Kimi and
Z.ai marks are new; a maker Realm has no mark for keeps its name and gets none invented.

**Sidebar.** The list's bottom fade was a backdrop blur over the translucent column, which blurs the
window's own transparency and rendered as a dark smudge above the space strip. The list now
dissolves by masking the scroller itself, which paints nothing over the rows, on the vibrancy
material and under reduced transparency alike.

**Settings.** The decorative wash is gone from the page. The content column no longer clips the
selection ring off the theme and appearance cards at its left edge.

## v0.6.0 — 2026-09-05

The largest release so far: computer use, a real theming system, plan and ask modes, sub-agent
visibility, and a long pass of interface work.

**Computer use.** Realm can drive other macOS applications through the Accessibility APIs, via a
Swift helper and a `realm-computer` tool provider. It is off until a space turns it on, refuses a
list of applications no mode can lift (Realm itself, System Settings, password prompts, terminals),
and raises a permission card per application that `bypassPermissions` does not skip — approving
TextEdit never licenses Mail. A menu-bar indicator shows when an agent is driving, because at that
moment Realm is by definition not the frontmost app.

**Theming.** Seven palettes across seventeen light and dark faces, chosen independently per mode,
with per-palette colour overrides, a contrast control, UI and code font pickers, JSON import/export,
and an adjustable sidebar translucency. Every face is held to a WCAG floor per role, and overrides
run through the same derivation so a moved background brings its whole surface ladder with it.

**Plan and Ask modes.** Plans from Claude, Codex and ACP now render as a first-class card instead of
being discarded. Ask is a read-only mode enforced by each backend rather than requested politely —
and it is not offered where it cannot be enforced.

**Sub-agents.** A `Task`'s tool calls nest under the call that spawned them, and a session shows the
agents it is waiting on in a dock inside its own pane.

**Browser.** Panes survive a space switch — the view is retained, unthrottled and still drivable,
bounded by an LRU budget. Elements can be picked from a page and sent to the prompter as a chip.

**Interface.** A genuine superellipse on the floating cards, drawn by a paint worklet because
`corner-shape` is inert on this runtime. A motion ladder, trackless scrollbars, far fewer dividers,
centred page content, an icon ladder, a plan strip above the prompter, and response actions — copy,
retry, feedback and sources — on finished answers. Two sound cues, off-window only.

**Tooling.** Agent CLIs and model catalogues are checked for updates on launch, read-only, with
install and update one visible click away — and Realm refuses to update a CLI a different package
manager installed.

**Fixed.** Attachments in sent messages rendered at zero size. The prompter's shadow was drawn from
its square box rather than its painted curve. The test suite leaked roughly a thousand scratch
directories per run.

## v0.5.1 — 2026-09-04

This maintenance release replaces the unsigned v0.5.0 downloads with a Developer ID signed and
Apple-notarized build. The product feature set is unchanged from v0.5.0.

- Signed with Realm's Developer ID Application certificate and notarized through credentials stored
  securely in macOS Keychain.
- Fixed the packaged server staging layout so codesign can validate every bundled runtime file.

## v0.5.0 — 2026-09-04

This release brings the work from every active Realm branch back into one build.

- Added named pane groups, full-pane focus, profile-scoped space navigation, and smoother Arc-style
  space switching. Existing layouts migrate into a single Main group.
- Added the complete school workflow: HTML study guides and PDF previews, lecture sheets, Plynn
  imports, bundled study skills, and `realm-docs` tools for agents.
- Added Settings → Usage with spend/activity charts, model pricing, monthly budgets, and threshold
  alerts.
- Agents can now run in parallel and delegate one level deeper. Transcripts show run duration, richer
  tool results, maths and code, and inline local audio/video playback.
- Expanded the model and harness picker with live catalog data, clearer model guidance, model costs,
  DeepSeek ACP readiness, and better defaults.
- Added Graphify probing, extraction RPCs, local graph preview support, and a live integration check.
- Improved the composer with next-prompt suggestions, quieter attachment guidance, and richer media
  handling. Sessions that have already run can move between spaces.
- Added credential-backed browser sign-in, gated downloads, native notifications, public update-feed
  support, and safer local app installation.
- Refined the interface throughout: better pane dragging, diff and settings surfaces, lazy-loaded
  emoji picking, attachment-specific icons, hairlines, spacing, radii, and typography.
- Fixed shell-path discovery, stale run timing after restarts, native overlay placement, oversized icon
  storage, and several integration gaps found while running the combined suite.

## v0.4.0 — 2026-09-02

- Make the ten merged branches compose
- Document panes: documents store, pane, contracts and migration
- Skills: skill discovery service and composer skill picker
- Deslop: shared harness/bag/cursor helpers, tidy live-check scripts
- Deps: bump agent SDK, add Fable 5.1 preset
- Site: marketing site and README pointer
- Pane groups: sidebar item grouping, space swiper, tool-group changes
- Show a session's cost in its header, and only that
- Session interjection — one session asks another, mid-turn
- Anchor the picker's highlight to a row rather than a slot
- Durable runs: a goal that owns a session across attempts
- README — the ACP agent family and the configOptions split
- Six ACP agents, and Gemini offered again
- Import the fullest copy of a thread, dedup archives, keep real titles
- Fix two model-identity bugs that only running the app exposed
- Acp: read modes and models from configOptions, and write back on the same channel
- Plan 21 — visual editor, mobile half (Flutter, Compose, SwiftUI)
- Import sessions, memory and skills from the agent CLIs
- Plans 17-20 — visual editor (web), agents, gateway agent, session interjection
- Give the harness menu's hints a class that actually styles them
- Split the harness onto its own chip in the prompter
- Collapse the sidebar, with the toggle following it out
- Pin two favourites rules the first tests only appeared to cover
- Give the model picker a favourites shelf and a top rail
- Group switching and pane focus in the command palette
- Pin the own-harness rule with a test, and drop a dead guard beside it
- Pane groups, and focusing one pane to fill the space
- Make the model picker's rows model-first, not (harness, model)
- Settings: name the app macOS will actually list, on both rows that name one
- Settings: grant the mac CLI's macOS access from the Permissions tab

## v0.3.0 — 2026-09-01

- Merge integration/v0.3 — Fable 5.1, rich composer, icon picker anchoring
- Render the composer's draft as rich text
- Anchor the icon picker's popover and cover it with menu/style tests
- Add Claude Fable 5.1 to the model picker, as the Claude default

## v0.2.0 — 2026-09-01

- Space icons can now be AI-generated or uploaded, from a per-profile icon
  library reusable by every space under it (migration v16: `icon_assets`).
- Thinking blocks render as Markdown instead of raw text, so an agent's
  headings, lists and code fences stop reading as literal syntax.
- AskUserQuestion gets a real question card with the actual choices, rather
  than an Allow / Allow always / Deny gate over a JSON blob. The chosen
  labels persist, so a replayed transcript records what was answered.
- Image attachments show a thumbnail in the transcript instead of only a
  filename.
- An unstarted session can be moved to another space from the sidebar
  ("Move to space…", `sessions.moveToSpace`), re-homing its environment and
  tearing down any terminal panel rooted at the old cwd.
- The composer's send key is configurable: Enter (default) or ⌘/Ctrl+Enter,
  the latter freeing plain Enter for newlines.
- Splitting a pane now resizes every pane in that split to be equal — three
  sessions side by side are three equal columns, not 50/25/25 — and
  double-clicking a divider restores a split to its original sizes.
- The notifications list reads as hairline-separated rows rather than a
  stack of background pills.

Fixed:

- Streaming ids were retired on an interim `assistant` notification, which
  can arrive per completed content block; a thinking block followed by text
  therefore splintered every remaining delta onto its own id.

## v0.1.0 — 2026-09-01

- Plan 16 — global search and session forks (#19)
- Plan 15 — distribution readiness (#18)
- Plan 13 — orchestration: Realm becomes the coordinator (#17)
- Plan 14 — dogfood polish convoy (#16)
- Real model catalogs for Codex and Cursor (#15)
- Plan 12 — the Universe shell: scoped tools, pages, notifications, settings (#14)
- Realm as an installable macOS app (#13)
- Plan 11 — the browser pane and browser agents (#12)
- Plan 9 — MCP gateway: agents reach servers only through Realm (#11)
- Plan 8 (W4–W5) — @-mention skills, control-row rework, settings home (#10)
- Plan 9 — Beautiful UI on the Ara shell (#9)
- Plan 8 (W1–W3) — SkillSync, MCP connections, memory manager (#8)
- File attachments in the prompter (#7)
- Plan 7 (partial) — environment split, worktrees, diff pane, checkpoints (#6)
- Combined model picker with real provider marks, and Build/Plan mode (#5)
- Plan 6 — grayscale ink, the prompter, instant sessions (#4)
- Plan 5 — Session shell: full-bleed panes, command layer, sessions-not-terminals (#3)
- Plan 4 — Codex-flat shell: panels, Arc-true navigation, flat material (#2)
- Plan 3 — Codex and ACP (Cursor/Gemini) agent adapters (#1)
