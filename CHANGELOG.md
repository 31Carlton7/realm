# Changelog

## v2.0.0 — 2026-10-05

This release was going to be 1.6, and before it shipped it grew into a redesign of the prompter, the
model picker, the transcript and the window around them — so it is 2.0. What 1.6 was to bring is all
here, as it now stands.

### Working with an agent

**The prompter is quieter, and every chip in it is one shape.** What you type is set in medium
weight, a rung up from the text around it, because it is what the card is for. A picked element, a
link, a skill, a skill that has since gone and a command opening the draft, such as `/goal`, are
each one rounded pill in its own tone, with a mark and a name; under the pointer the mark becomes
the chip's ×, and a selection that covers a chip lights the chip instead of a square box round it.
The permission control has lost its fill and its chevron and is a shield and a word — a shield with
a question mark for Ask each time, one with a tick for Accept edits, and one with a warning mark, in
red, for Full access — and its menu wears the same marks. The + opens a menu drawn by Realm rather
than macOS, because its rows say what they do: Add, with Files… (⌘U), Folder…, Select in Realm,
Skills and Goal…; Mode, picked in place rather than through a submenu; and Connectors, which lead to
the space's Connections. The skill picker and the @ and / lists fade where they scroll instead of
being cut off by their search field.

**@ names anything the agent can use.** One list: the files in the session's checkout, the ones it
has changed first; the Library; skills; the apps on this Mac; and @Mac, which drives Calendar,
Reminders, Contacts and the Mac's other apps, and wears the Apple mark. A bare @ is a short tour, a
few of each kind under quiet heads; a word after it is one list ranked across every kind, each row
saying what it is, so Return takes the best match whatever it is. A mentioned file goes to the agent
as an attached one would, and the chip is the file. A mentioned app gets computer use for that app,
in that session, and nothing more: its first action still asks, the session's mode still holds, and
nothing outlives the session or becomes a setting of the space.

**Point at a part of Realm, and the agent gets it.** Select in Realm, in the + menu or on ⌘⇧C, does
for the app what the browser pane's picker does for a page: the same outline follows the pointer
across the window, and a click drops the part it outlines into the prompter as a chip, with a
picture of it attached. A press on a control's glyph or its label picks the control; hold ⌥ to take
exactly what is under the pointer. The chip is written for an agent working on Realm — what the part
is and says, the component that draws it, a selector made of the app's own class names — and
mentions the picture only while the picture is still attached. A part under a browser pane, which
the window's own capture cannot see, goes without one, and its chip says so. Escape cancels.

**The model picker is one short list, with effort and fast mode at its foot.** The chip says who
will answer — the harness's mark, the model, its effort, and a bolt when fast mode is on — and
behind it is one compact list, grouped by the harness a click runs a model through, with the current
model ticked and in view, a search at the top, and another harness's mark on a row only where that
harness can run the same model too, one click away, rather than the model listed twice. What the
highlighted model is for, its context and its price sit in a strip under the list. The foot is the
effort card: the level by name, a track with a dot for each level that model takes — ← and → step
it, Home and End go to the ends — a reset once you have moved it, and the bolt. Unset, it names the
model's own default rather than going blank, and the level now reaches the agent: on every Codex
turn, mid-session for Claude, and through an ACP agent's own thought level where it has one. Fast
mode can be asked for before the first turn — Codex's catalog says which models take it, one Claude
session answers for every Claude model, and elsewhere the bolt says the first turn will check — and
a model that cannot run fast names the ones that can. Asked for before a session's first message, it
also really runs fast; until now it never reached Claude. Code review's and the media viewer's
question boxes kept only the model you picked before their first question, so the level, the bolt
and the permission did nothing there; that question now starts with all four. Every popover opens
where it will stay, so the bolt is still under the pointer for a second press. Picking a model no
longer closes the picker: the model changes, the list stays where it was and the card turns to the
new model's levels, so its level and fast mode are set in the same visit, and a click outside, the
chip or Escape put it away; ← and → in its search step the level of the model just picked. A level you choose at
XHigh or Max lights the track the way the landing page draws its light — streams running into a white
core at the knob, the cube's facets faint beside it — hotter at Max, and turning fast mode on charges
the bolt and sends a glint down the track and across the chip. Reduce motion shows the light still;
Low power and a window in the background pause it.

**A session can hand work to other models.** Ask in words — "have GPT-6 Luna build this" — and the
session's agent starts a sub-agent on that model. A model is found by its name, so GPT-6 Luna runs
through Codex and Fable on the newest Fable, and a sub-agent on the lead's own harness runs the
lead's model unless another is named. Or open the session's Agents tab, from the side panel's +: its
sub-agents, each with its model, its task, where it stands and its report, a click from its own
transcript, and under them Build with, where you pick models — this session's own, your starred
ones, More models for the rest — say what to build, and Split by model to give each its own part
instead of leaving the split to the agent. It sends an ordinary message in your name, so the
session's agent still divides the work, starts each sub-agent, gives them worktrees of their own
when they would edit the same files, waits for their reports and tells you what each did, all in the
transcript beside your ask. Implement with…, on a plan and under an answer, opens the tab with that
text in it. In the lead's transcript each sub-agent is a quiet line of its own — "Subagent finished
· Write the tests", its model, its time — rather than folded into a "Worked for 8s" that hides the
one thing a reader of a delegation came for.

**Every agent's questions come on one card.** A question looks the same whichever agent or server
asks it, and says who is asking first — "Codex asks", "Linear's MCP server asks" — because the same
question means something different from each. What it offers comes from Realm, never from the asker:
options, with pictures as tiles; several at once; text, masked when it is a secret; yes or no; a
model for each step of a plan, from the catalog; a file in the workspace, found the way ⌘P finds
one; a branch of the checkout; a date or a time; or a page to open, shown whole and opened in your
browser only on a click. 1 to 9 pick an option, Return takes the highlighted row and Escape skips.
Answered, it stays where it was asked, as the question and your answer. Codex's questions used to
arrive as nothing at all; they reach the card now, with the ones its MCP servers pass on. Gemini,
Cursor and the other ACP agents can ask too, and so can a Connection's MCP server in the middle of a
call, which waits while you think. Any agent can ask through `ui_ask`, one of Realm's own tools, on
by default and allowed in every permission mode — up to four questions at once, a secret among them
masked as you type it. A form from Codex, an ACP agent or an MCP server that asks for a key or a
password is declined without being put to you.

**The transcript says when, and what each turn changed.** A message you send shows the time it was
sent as you point at it, and the keyboard can reach it too. A finished turn is dated the same way —
a clock time today, Yesterday 7:38 PM, then the date, with the full date and time in the tooltip —
where it used to show a bare time that read the same a minute or a week later, and a turn that
failed says Failed after 4s instead of the playful past tense, which read as a job done. A file the
agent names that is really in its checkout becomes a link, and opens in Documents beside the session
at the line it named. A turn that changed files ends with an Edited 3 files card: each file, in the
order it was edited and a click from opening, with its counts as git measured them when the turn
settled rather than as its tool calls claimed them; Review, which opens that turn's diff as the side
pane's Changes tab; and Undo, offered only where a checkpoint takes back exactly that turn and
nothing after it — where Realm took none, the card says so. A tool call that edits a file now names
it the same way for Claude, Codex and the ACP agents: the file's mark, its path, its counts.

**A track down every transcript's edge, and turns you can keep.** A session pane has a tick down its
left edge for each prompt, placed where the prompt sits in the log, the one being read in ink and a
dot on any turn that changed files. Point at a tick and a card says what was asked, how the answer
began, when, and what the turn edited; a click goes there and leaves the keyboard in the prompter,
and once the track has the keyboard ↑ and ↓ walk it. The bookmark in the card's corner, or S on the
track, saves that turn: its tick takes the accent, ⌥↑ and ⌥↓ step between saved turns, and Library ▸
Saved lists every turn saved in the profile, with the answer each began with, a click from the
prompt in its session.

**A reply can carry a chart, a diagram or a comparison.** An agent can write a Mermaid diagram, a
`realm-chart` (columns, bars, lines or a sparkline) or a `realm-compare` of up to six options as
fenced code, and the transcript draws it once the fence closes — in Realm's own palette, with the
values a click away and the source a click further. A body that does not parse stays code, with the
reason. Nothing in a block fetches anything: a diagram that would load a picture or follow a link to
lay itself out is left as code, saying so. In a narrow column a comparison becomes a card per option,
and a Markdown document's rich view draws the same blocks.

**A Connection can show its own views, and they act only on your click.** An MCP server that ships
views, as the MCP Apps extension describes them, now has them drawn: compact under the tool call
that made one, or as a tab beside the session. Each runs in a sandboxed frame on an origin of its
own, out of reach of Realm and of every other view. What a view asks to do waits on a card Realm
draws outside the frame, where the view can neither reach nor imitate it, and only your click
answers: running one of its server's tools, writing a message for the agent — which goes into the
prompter for you to read, change and send yourself — or opening a page in your browser. The
Connection's row says when its server ships views, with a Show views switch, on until you turn it
off and the same in every space; off, its tools answer in text.

### The window

**Every space is in the sidebar at once.** A space used to be a room: you stood in one, the sidebar
listed what was in it, and an agent waiting in another space was a badge on a strip and a walk away.
Now each space of the profile is a section of one list, under a Spaces caption — its name in its
colour, a tally of what is waiting and working in it, and its sessions, with what needs you first
and five before Show more. A section folds and remembers that it did; its + starts a session there,
and its ⋯ reaches the space's folder, connections, memory, archived sessions and settings. Pinned
gathers the pins from every space, and the activity button at the caption's end lists the same
sessions by when they last moved, until you press it again. New space stays at the column's foot,
where no length of list can carry it out of reach. The sidebar lists sessions only now, and the
space strip and its swipe went with the rooms. Since you no longer go anywhere to be in a space, a
session says where it works — its pane bar reads *Space › Session*, in the space's colour — and one
that has not started yet can be moved from the composer's space chip.

**The window shows one view, not a layout per space.** As many panes as you make, split right or
down and nested the way you split them, from whichever spaces their sessions are in, and moving
between them loads and unloads nothing, because every space is already loaded. The only limit is
room: a pane is never drawn narrower than 280 points or shorter than 300, the least a session's
prompter and transcript work at, so where another pane would go below that, Split right, Split down
and a drop on that edge are unavailable and say what would make room, and ⌘\ says it in a toast. A
session is on screen once; opening it again goes to it. The current space is just the one the
focused session works in, which is where a new session goes. ⌘-click a session to open it beside
the one you are in, or beside the one next to it when there is no room for another; ⌘\ and ⌘⇧\
split.
Named splits went with the rooms, and so did their strip and their keys — ⌘⇧[, ⌘⇧] and ⌘⇧G. On the
first launch the split you were last in comes back as the view, and the sessions in your other
splits stay in their spaces. The view, and where the keyboard was in it, survive a relaunch.

**A rail holds the app's pages, and Home takes you back to the work.** Library, Connections,
Scheduled tasks and Code review are a narrow column of icons at the window's edge, under Home, and
the column stays when ⌘B folds the sidebar away. Home is not a page: it puts away whatever page is
up and lands on the session that was in front, in its space, or on a fresh prompter when there was
none, so it is never lit and carries no count — a session that needs you says so on its own row and
under Needs you, and the Dock's badge counts what came in while you were away. At the rail's foot
are the Stop of a Laya recording while one runs; a disc when a newer Realm is out, which rings its
download's progress and, once it is ready, restarts into it; and your avatar, for your page and
Settings. The sidebar's head row holds its toggle, search and a new session, with the profile as the
first row under it; back and forward sit beside the traffic lights, on ⌃- and ⌃⇧- too, and the
toggle joins them once the sidebar has folded. The sidebar opens and closes as one box, its contents
sliding with its edge, and stands a hair above the rail, casting a light shadow over it from its
left edge. Landing on a session puts the keyboard in its prompter. The pane bars' own arrows are
gone; ⌘[ and ⌘] still walk the focused pane's history.

**A page takes the room it needs, and is left the way it was reached.** Connections has no use for
the spaces beside it, so while it is up the sidebar is away and the page takes the width right of
the rail; a page with a column of its own — Settings, the Library, Scheduled tasks, Code review —
puts it in the sidebar's column instead of drawing a second sidebar beside the first, with a Back
at its head only on the settings pages, which are opened from a menu rather than the rail, and the
page's name at the head of the others. Every column's first row — the profile, a Back, a page's
name — stands at one depth under the column's top, with as much room above a name as beside it, so
going from Home to a page moves nothing.
Either change lands in the frame the page opens in — only ⌘B or the toggle draws the sidebar moving
— and leaving gives the sidebar back as it was. A page's bar is its name and nothing
else: there is no close button, because Home, the lit rail button, a session in the sidebar, the
settings pages' Back and Escape already go back.

**What needs you is one list, and you can answer from it.** Needs you, at the top of the sidebar,
gathers every session waiting on a permission or a question — longest first, then failures you have
not read — from every space and every profile, and it is drawn only while something waits. A waiting
row unfolds that session's own card: Allow, Allow always or Deny, or the question and its fields.
The cards are the transcript's own, so an answer given anywhere clears it everywhere, and Escape
folds a card instead of denying the request that had the focus. Peek, from a session's menu, opens
any session as a tab beside the one you are in — its transcript and its card, with no prompter — and
saves it nowhere.

**What an agent opens arrives as a tab in the side panel.** A browser, a device, a document or a
terminal an agent opens is a tab of the one side panel at the window's right edge, rather than a new
column beside whatever had focus — which is how a fan-out of six agents once filled a window with
eight columns too narrow to read. The panel is the full height of the window and half the room right
of the sidebar until you drag its edge, which it remembers for the window (a double-click puts it
back to half). It narrows to make room before any pane goes below its floor, and where even its
narrowest will not fit beside the panes it steps aside, and the button at the top right shows it in
their place. Its tabs still belong to their sessions. The strip holds the tabs of every session on
screen, each session's run in the order its pane is read, a hairline between one run and the next;
a tab's tooltip names its session, and the pointer on a tab marks that session's pane. A session
joining the split brings its tabs into the strip without taking the panel from what you were
reading, and leaving it takes them along, to bring back. What is opened for a session that is off
screen waits with it, still live for the agent driving it, and an agent's new tab comes to the front
only over its own session's. The session's Agents and its Changes are tabs there too; Changes no
longer opens as a pane of its own. A sub-agent gets no pane at all: the agents a session has working
are a count in its bar, and the list behind the count can preview one as a tab. Every browser tab
stays live behind the one showing, and choosing a tab shows it without taking the keyboard from the
prompter you were typing in. The button at the window's top right puts the panel away, every tab
still open behind it, and brings it back. The + after the tabs opens a blank tab for the session
you are working in (⌘⇧B, or ⌥⌘B for full view) whose page lists the session's tools — Documents,
Terminal, Agents, Simulator and Machine — and the pages you visited last, or opens one of those tools
straight away, and ⌘J puts the session's terminal there too. The strip fades where its tabs run past its ends, and every tab's
glyph is one size at any width. A device's controls left the strip, where they took the width the
tabs needed, for a toolbar centred over the device — Home, Screenshot, the elements overlay and
Rotate, with the volume and side buttons, its apps, the Simulator's settings, the frame and stopping
the stream one click away. A terminal an agent opened comes back to the front when it stops at a
password prompt; in 1.5, a sudo prompt sat for a day and a half in a terminal its owner could not
find.

**A session's bar is about the session, and a session has no close.** The bar carried seven
glyphs for the tools a session opens beside itself. It now carries the session's place and name, the
count of agents it has working, its status, one button for what it made — the summary and the
files, switched in the panel's own head — and its menu. The tools are where they open: the side
panel's + and a blank tab's page list them, the button at the window's top right opens the panel
onto that page, and the command palette has each one. A session is left from the
sidebar, the way it was reached, so neither its bar nor its menu has a Close. ⌘W closes what the
keyboard is in: a tab leaves the side panel; a pane leaves the split it shares, which its menu calls
Remove from split, and the pane beside it takes the keyboard; an empty pane beside a session goes
instead of the session; and a session alone closes nothing — the keyboard goes to its prompter. File
▸ Close Tab or Split says the same.

**New space asks what the space is, and lands you in it.** The sheet asked for a name and a profile,
then opened the new space's settings. It leads with the name now, with the space's icon beside it —
a symbol, an emoji, one generated or one uploaded, shown in the space's colour — and its colours
under it, then one card of the rest: a folder, chosen or dropped, or without one the path Realm will
make for it; the profile, with New profile… in the list; and the memory every session there reads
before it starts. Create starts a session in the space, in that folder, with the keyboard in its
prompter, and Return from the name is still all it takes. The sheet stays up while Create runs, so a
failure keeps everything you typed and says what went wrong beside Create, and Create again finishes
the space rather than making a second.

**First run gets you to a signed-in agent with no terminal.** It was thirteen equal radio rows
beside a form, and a row that said "Not installed" or "Signed out" handed a newcomer a problem with
no way to solve it. Now it is one page: Choose your agent, with Claude and Codex as cards that do
what their state needs right there — Install, Sign in with Claude, Sign in with ChatGPT, a field for
the code the sign-in page shows — the other agents folded behind one line, then Name your space —
the New space sheet's own fields, icon and folder included — and Start. Claude needs no install,
since Realm already carries Claude Code, and Codex's card says when it needs Node.js first. A
signed-out Claude also reads as signed out now: the check misread the CLI's answer, and a stale
credentials file passed for a sign-in.

### Look and feel

**Notices are toasts, and tooltips come at once.** A failed action or a refused file was a red bar
across the top of the window that stayed until you closed it. It is a toast at the window's foot
now, and so is a browser pane's receipt: a toast says its piece, runs a thin line along its foot
while it is up, and leaves when the line reaches the end. Toasts stack, the newest in front and two
tucked behind it, and fan out under the pointer; the pointer on them, the keyboard in them or Realm
not being the app in front stops every clock, so one you are reading or copying from never leaves.
They move along the foot clear of a browser pane, which would paint over them, and lift over a
prompter rather than cover its send button. What needs a decision — a permission, a sign-in, a
server that has gone — is not a toast, and stays until it is answered. A tooltip is the app's own
quiet label, shown a fifth of a second after the pointer arrives and at once on the next control,
where the system's took a second and a half, with any shortcut drawn as keys; one with no room above
or below its control goes beside it.

**The cursor is yours to choose.** Settings ▸ Appearance ▸ Cursor sets the caret everywhere text is
typed — the prompter, every field, the code editor — with a field to try it in: its shape, from
Line, Thin line, Pill, Beam, Block, Soft block, Outline block, Underline and Thin underline; its
animation, from Blink, Smooth fade, Phase, Expand, Pulse, a blink that comes to rest, and Solid;
whether it glides to each new position; and whether it takes the accent or the text's colour. In 1.5
the prompter's caret could not be held still, because it was the platform's; Realm draws it now, on
the platform's own pixel, and steps aside where the platform's would, for a selection, an input
method composing or a window that is not in front. Under Reduce motion it holds solid rather than
stopping mid-blink. A terminal's cursor takes any of those shapes as a setting of its own, with its
own blink, drawn on the terminal's own cursor cell, and the code editor, which had a blink switch of
its own, follows the animation.

**Everything that scrolls fades at its ends, nothing sticks, and everything you can click points.**
Every list, page, popover, sheet, strip of tabs and capped well of output dissolves where it has
more to show, as the transcript does, instead of stopping at a hard edge; what keeps its edges is
what is read to the last character — code, a diff, a command — a table whose column heads pin, and
the editors. A page's head scrolls away with the page instead of staying pinned over it, and what
holds still is only what is used while the content moves: a sheet's title and its buttons, a long
table's column heads. The pointing hand is over everything a click acts on — a button, a row, a tab,
a chip, a menu row, a disclosure, the label round a switch — from one rule, so a control added later
points too; that is a deliberate step away from the Mac's arrow over controls. The arrow stays where
a click does nothing: a disabled control, a row that only reports, the space round a sheet. Fields
keep the I-beam, and drag handles and dividers their own cursors.

**Realm behaves like a Mac app, not a page in one.** The difference was a dozen small web habits,
each one a Mac user notices without being able to name it. A button darkens when pressed instead of
shrinking, and lets go if you drag off it, and dragging across the interface no longer selects it
like text. Menus, all but the prompter's +, are the system's own — type-to-select, real shortcuts,
and able to open over a browser pane, which nothing Realm drew could — and a right-click in text
offers spelling, Look Up and the link under the pointer. Popovers and sheets move on a spring, lists
rubber-band under the trackpad but never under a mouse wheel, and a window that is not in front
greys its accent. There is a real menu bar — Settings… (⌘,), File, Edit, View, Go, Window and Help —
whose rows show your own keybindings, and Reload is in development builds only; before, ⌘R could
reload the app out from under a running agent. The window reopens where you left it, at its size,
maximised or in full screen.

**Light mode is light.** On a Mac set to Dark, Realm's light mode came out a muddy grey: nothing
told macOS the window had an appearance of its own, so the material behind it stayed dark and the
light ground was laid over that. Realm now tells macOS which theme it is in, and menus, Quick Look
and the Share sheet follow it. The light palette also steps the way the dark one does — the sidebar
a shade under the work, wells recessed instead of bright — lets far less of the desktop through, and
its quiet text, hints and links, is dark enough to read.

**Realm has a new mark, a new icon, and eight more for the Dock.** The mark is a cube lying on its
side with a lit doorway in its dark wall: a space, and the way into it. The icon wears it in white
and greys on a graphite body, on the very shape macOS gives every app icon — Apple's continuous
corner, measured against the Finder's own — so macOS shows it full size instead of shrinking it
onto a grey plate as it did the last one, and it is lit the way macOS lights its own: a body graded
top to bottom, one short shadow, and the glass edge macOS draws over it. Settings ▸ Appearance ▸
App icon offers eight alternates drawn the same way — indigo, clay, frost, smoke, sticker, ocean,
ember and mint — and a pick goes on the Dock at once and is there from the start of the next launch.
The Finder and Launchpad keep the standard icon, because a running app can change only its own Dock
tile, and the row says so.

**Type sits on one scale, and icons are drawn at the weight of their text.** Six text sizes had
grown inside a 2.5px band and were used interchangeably. Every size is a rung of one ladder now,
which also put the code preview's line numbers back beside their lines — they had drifted a full
line behind by the twenty-fourth. Icons come from a rounder set and are drawn heavier at small
sizes, the way a Mac draws small symbols, so a 12px glyph is no longer a hairline beside its label.
Labels set in tracked capitals are sentence case, edges are a rung softer, and a focus ring follows
its control's curve rather than drawing a rectangle around it.

### Pages

**Pull requests are read and reviewed in Realm.** Code review, on the rail, lists GitHub pull
requests through your own `gh`, so Realm holds no GitHub token and sees what gh sees; until gh is
installed and signed in, the page says what is missing, and Set up GitHub opens a terminal with the
command typed in for you to run. Its column takes a search or a pasted pull request link, and lists
Authored by me, Needs my review and Needs my team's review, with any you pin at the top. A request
opens on Summary — its description, whether it can merge, who has reviewed, its checks — and
Changes, side by side or in one column, beside a file tree. Review with — one button, the model's
mark and name, and a chevron to the reviewer's instructions and its model, every model under its
mark — runs a reviewer over the diff on the model you choose, held to read-only, under instructions
the profile keeps, and leaves its findings on the page; none of them, nor any line comment of yours,
reaches GitHub until you press Submit review and choose Comment, Approve or Request changes, with a
comment, which posts it as you. Ask about this pull request, at its foot, puts a question to the
request's own session in a space you choose, one whose checkout is the request's repository first,
so asking twice is one conversation.

**Scheduled tasks have a page of their own, and every run is a session.** The page follows Codex's
layout. A column holds New task, your upcoming tasks — each with the model it runs on — and their runs
under them, each new run unread until you read it, and suggestions to start from. Beside it a run is
its real session — the transcript, and a prompter to carry it on — with the task's card at the top
right: when it repeats and runs next, a run it missed while the Mac slept, the model each run starts
on, the space and its connections, and Run now, Pause, Edit and Delete. Schedule a task is a sheet: a
name, the instructions, whether it repeats — hourly, daily, on weekdays, weekly, monthly or by a cron
expression — or runs once at a date and time, and under Advanced whether each run starts a new
session or carries on the last, whether successful runs are archived, the space, and the model: the
prompter's own chip and picker, with each model's own levels and its default named, fast mode, and
whether a run asks each time or accepts edits. The card and the column name the model as the chip
does, its level and bolt included. A run is handed the task's instructions first, as written, and
shows them under a quiet Scheduled run line; it lands under its task instead of opening a pane beside
whatever you were doing, and a task that carries on one session carries what you changed since into
its next run. A task an agent schedules from a session runs on that session's agent, model, level
and speed.

**The Library sorts by kind, takes your own files, and Memory saves itself.** The Library's files
open on tabs — All, Images, Documents, Code, Data — beside a filter for where a file was made and by
whom, a choice of tiles or rows, and a search; a tab narrows the whole Library, not only the page
already loaded. Every file is one square tile, a picture filling its own. Add, at the end of its
toolbar, or a drop anywhere on the page, brings files of yours in: Realm keeps its own copy under
the profile, never over another file, never twice and never through a link, a dropped folder asks
before its files go in, and they are marked Added by you wherever the Library's files are listed.
Remove from Library — on a file's menu, its ⋯, the viewer's menu, or ⌫ — takes one back out, with
Undo; Realm's copy waits ten minutes before it goes, and a message the file was sent with keeps its
name. A file a session made stays: only your own come out.
"Every space" now means every space of this window's profile; a Work window used to list what
School's sessions had made. Saved lists the turns you save from a transcript's track. Memory was a
textarea with a Save button. It is the document itself now, at reading size, with Write and Preview:
a pause in typing saves it, and the head says Edited, Saving or Saved. It says who reads it — every
new Claude and Codex session in the space — and how it travels, through the AGENTS.md mirror and the
file it is kept in. The Library's Memory covers every space, the profile's own document first.

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

**A page about you.** Your avatar at the foot of the rail opens it: your name and picture; tokens
over all time, your busiest day, the longest an agent worked on one turn, and your current and
longest streaks; the activity calendar, which now reads by day, by week or as a running total; and
the models, efforts, skills and tools you use most. A figure no engine can report is left off, with
the reason, rather than shown as a zero. A picture you choose is copied into Realm's folder, so
moving the original changes nothing, and until you choose one you are a person in a neutral circle
rather than a bare initial.

### Files, browsers, terminals and devices

**The Documents pane opens on your files.** With nothing open it said "Nothing open yet" over an
empty pane. It opens on a home now — what this session has made and been given, then the Library's
files — under one search that also finds the checkout's own files by name, and its Files tab brings
the home back. ⌘P puts the keyboard in that search from anywhere, where it used to open a palette
that found a file and opened it somewhere else; ⌘⇧P still searches contents. New makes a document, a
spreadsheet, a presentation, a LaTeX paper or a study guide, or a code file — TypeScript, Python,
Swift and more — named with its extension and opened in the code editor, and a name typed in the
search that nothing has is an offer to make it. A button on each row adds the file to the next
message.

**One viewer for every file, with the prompter under it.** A picture in a message, a chip in the
prompter, a tile in the Library, a row of the Documents pane's home, a session's summary and its
file list all open the same viewer, in place of a lightbox and a preview sheet that were two answers
to one question. The file fills the window, ← and → walk the files it came with, and the session's
prompter is docked under it: a question asked there is a turn of the session the file came from,
carrying the file, and the viewer shows its own part of that transcript, so a new version an answer
names lands on the stage with the original a step behind. Mark up draws on a picture, and the next
question carries a copy with the marks in its pixels, so the agent sees what was circled rather than
reading where; a file dropped on the viewer goes with the next question. A file no session can be
asked about starts one in its space at the first question, never at the look. Escape or ⌘W closes
it, and its bar opens the file in Documents or its own app, in Quick Look or the Share menu, in the
Finder, or saves a copy.

**A file in Realm does what a file in the Finder does.** In the Library, the Documents pane's home
or a session's file list, Space shows it in Quick Look and Return opens it; it drags out into
another app as the real file; and its menu, there and on a path in the transcript, offers Quick Look
and the Share menu. A session's file browser can also lay its folder out as the Library's tiles.
Reveal in Finder works on the ~/ and relative paths agents write, and says so when nothing is there.

**A terminal's tab says what is running in it.** A terminal's tab, its pane bar and its dock wear
the mark of what is in the foreground — an agent's own mark on a tile in its maker's colour, a
tool's glyph for node, python, vim and the rest, or the shell's — and name the program before the
folder: "claude · realm". Realm reads it from the terminal's foreground process, not its shell. Only
an agent wears colour there, so colour in a strip of tabs means an agent and nothing else. Terminals
draw in Realm's own sixteen colours, tuned to each theme with every text colour readable on the
pane's ground, on the chat's own background instead of a darker slab; a theme such as Nord or Rosé
Pine wears its own terminal colours, and in light mode a program's own colours are darkened until
they read. A powerlevel10k prompt keeps its colours, and its icons draw instead of empty boxes.
Settings ▸ General ▸ Terminals ▸ Terminal colours chooses Realm's or your shell's.

**A page that did not load says so.** Typing localhost:3000 with nothing listening left a blank
white pane. The pane now draws a page in its place — "This site can't be reached", the reason, such
as "localhost refused to connect.", what to try, the error code and Reload — for a refused,
unresolved, timed-out, reset or closed connection, an empty or unreadable response, a blocked port,
a proxy, a redirect loop, and a certificate or TLS failure, which gets an open padlock and no way
past it. The address stays in the bar, Back and Forward walk past it and Reload tries again, the
mark pulsing while it does, and a page that failed stays out of a blank tab's Recently visited. An
agent driving the pane is told the same thing in words, where it used to read an empty page. The
pane is one ground from its toolbar down, without the lighter strip under a new tab or round a
device, and the white a page starts on is never shown. And the element picker draws a fine rounded
outline over a soft fill, following the element's own corners, with a small label naming it and its
size, where it drew a thick square box over a dimmed page; Annotate's highlight looks the same.

**The browser pane has a browser's controls.** Each tab wears its site's own icon, kept for the next
launch. The ⋯ at the end of the toolbar opens a menu macOS draws, so it can sit over the page: Find
in page (⌘F), Print, Zoom, Take a screenshot — saved to the space's screenshots folder and attached
to the session — downloads, history and Clear browsing data. Device size lays the page out at an
iPhone's, an iPad's or a desktop's width; it is a check of a layout at a width, not a phone, since
the user agent stays Realm's and touch is not emulated. The address field suggests pages you have
visited as you type, most visited first, then a web search — a history that starts with this
version, because Realm kept none before. And Annotate pins several elements of a page, numbered, and
sends them to the session as one chip, with a screenshot that shows the numbers.

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
memory or disk, and stops itself before swap can fill the disk. Record my use of this app…, under a
device, opens a sheet before anything is kept, saying what is kept of each screen — what each thing
on it is, what it is called and where it sits, as the app describes them to VoiceOver — and what is
left out: pictures of the screen, your taps and keystrokes, anything typed into a field, and every
app but the one in front. Only its Start records, and Realm taps nothing. While it runs, the row
under the device is the recording, with its Stop, and the foot of the rail carries the same Stop,
because a recording goes on while its device is out of sight. Assist, where an agent names an
element in words and Laya picks it, is earned rather than chosen: it unlocks only for a checkpoint
that is right 95% of the time on held-out steps. None is yet, the download included, so Assist stays
locked and says by how much. The log and the recordings never leave this Mac.

### Profiles and sign-ins

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

### What is gone

- The Agents page — its List, Wall and Office, the pixel office and its credit at the foot of
  Settings, and the Start agents… sheet. What it ranked is on each session's own row, under Needs
  you and on the Dock's badge, and work for several agents is asked of a session, in words or from
  its Agents tab.
- The Notifications page and its bell. Notifications still reach macOS and count on the Dock, the
  iMessage and Slack relay still sends, and Settings ▸ Notifications still chooses what counts; Code
  review has the page's place on the rail.
- The red bar across the top of the window, for toasts.
- The lightbox and the file preview sheet, for the media viewer.
- The ⌘P file palette, for the Documents pane's own search.
- The close button on a page's bar, for Home, the rail, the sidebar and Escape.

### Smaller changes and fixes

- Claude's weekly and five-hour limits read right. The readings Claude Code sends during a turn give
  the share used as a fraction and the reset in seconds, and both were read as if they were already
  a percent and milliseconds, so an 86% week showed as "Weekly limit at 1%", resetting on a day in
  January 1970.
- The question and plan cards are as off-limits to an agent driving the window as the permission
  card was: one could answer a question another session had put to you, or press Implement this plan
  and take a session out of Plan. Build with and Implement with…, which start paid work in your
  name, are off-limits too.
- A masked answer reaches the agent that asked and nothing else: the log, every window, the Activity
  record and an exported session keep a mark in its place, even when the agent quotes it back.
- A space whose folder is not a git repository simply has no worktrees: nothing offers one, and
  opening it no longer puts "… is not a git repository, so it has no worktrees" in a red bar across
  the window.
- The strips stacked above the prompter — a plan, a goal, the agents running, the git line — keep
  their side edges down to where the prompter tucks over them, in the mode's colour too.
- A session filling the window no longer shows a half-lit split glyph in the sidebar: the glyph
  pictures the panes of the split, never the side panel beside them.
- A page rising into view no longer makes the window scrollable for the length of its rise, which
  put a scrollbar across the app for a moment and nudged a centred page sideways.
- Scrolling a long transcript no longer redraws all of it on every frame.
- Realm's own tools can run past Codex's one-minute limit on a tool call.
- The + menu and the skill picker take the arrow keys as soon as they open, and an @ chip no longer
  splits from its name at the end of a line, which put every glyph after it a line off the caret.
- Escape in a popover over a sheet closes the popover, not the sheet.
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
