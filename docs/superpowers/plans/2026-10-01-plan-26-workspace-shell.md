# Realm Plan 26 — One window for many agents

> Numbered 26: 25 (machines) is the highest on the release line. Renumber on landing if it collides
> with another session's in-flight plan.

> **Status (2026-10-01): planned, not built.** W0 exists on its own branches (below). Decisions D1–D4
> are recommendations; D1 needs the user's answer before W3 and W4 start.

## Why

Realm's spaces are its product idea — the 2026-08-28 competitive audit calls the spatial model "the
one thing in Realm that is a *product idea*, not a feature" — and they are also what makes many agents
hard to run. A space is a room: switching to one saves the current arrangement, clears the active
space's sessions and environments from memory, loads the other room's pane groups, and unmounts every
pane of the room you left (`selectSpace`, `state/store.ts`). Watching agents across rooms therefore
means walking between them. The surfaces that see across rooms are all places you go to rather than
things that are on screen while you work: the Agents page and the Notifications feed are overlays, the
chat lens lists chats by day with no status mark at all, and the menu-bar item exists only while no
window is open.

The Codex desktop app answers the same problem the other way round, with no rooms at all: an icon rail
of destinations, one sidebar that lists every project with its chats nested under it and a Recents list
whose rows carry their state at the far right, and a window whose right half is a strip of tabs
(browser, files, terminal). Picking a chat anywhere opens it; nothing is "switched to".

This plan takes Codex's navigation and keeps Realm's rooms: every space is visible in one sidebar with
its agents' state, opening any agent changes the room underneath without a walk, and the agents that
need you are reachable — and answerable — from wherever you are. It also folds in the rest of what the
screenshots show that Realm lacks: a browser that has the controls a browser has, settings that can be
found, and a page about you.

Already built toward this, on branches not yet merged:

- **W0a — the side pane** (`feat/agent-side-pane`): what a session's agents open lands as tabs of one
  pane beside it, sub-agents get no pane of their own, a count of running agents sits in the session's
  bar and previews a child as a tab. This is Codex's right-hand tab strip, already.
- **W0b — fixes found on the way** (`fix/transcript-scroll-corner`, `fix/prompter-inner-edge`,
  `fix/reveal-named-paths`, `fix/send-now-and-x-icons`).

## What the screenshots show, against what Realm has

Evidence is the current release line (`integration/v0.6`); paths are under `apps/desktop/src/renderer/src`
unless they say otherwise.

### The shell

| Codex | Realm today | Plan |
|---|---|---|
| Icon rail: home, history (badged), library, plugins, mentions, ⋯; account and update at the foot | None. Destinations (Agents, Library, Connections, Scheduled) are rows in the sidebar; Profile and Settings are in the profile chip's menu (`components/sidebar/SpaceStrip.tsx`); there is no update button in the shell | **W2** |
| Sidebar head: workspace name with a switcher, bell, search | Space header (name, switch menu, search glyph, ⋯) plus a separate head band with bell, chat lens and the toggle (`Sidebar.tsx`, `SpaceHeader.tsx`) | **W2** |
| Projects, each with its chats nested | One space at a time: its pane groups as sections, then "Sessions", then Archived (`SpaceSwiper.tsx`). Projects exist in the schema and are never listed (`packages/contracts/src/entities.ts`) | **W3** |
| Recents with trailing state: clock (scheduled), spinner (running), dot (unread) | The chat lens, by day, across the profile — rows set `data-status` and nothing styles it (`ChatFeed.tsx`) | **W1**, **W3** |
| Row state at the far right, actions in its place on hover | State sits after the title; the hover buttons are `opacity: 0` and still take their width, so every row loses ~50px of title for buttons it is not showing (`ItemList.tsx`, `styles.css` `.item-close`) | **W1** |
| Window back/forward | Per pane only (`packages/contracts/src/nav.ts`) | **W4** |
| A tab strip over the right half; "+" offers New tab ⇧⌘B and New tab in full view ⇧⌘F | The side pane's tabs (W0a). Full view exists as pane focus (⌘⇧F) | **W5** |
| New-tab page: Tools — Files ⌘P, Terminal | A blank browser that says "Where to?" (`panes/browser/BrowserPane.tsx`) | **W6** |
| "What should we work on in *stora-platform*?", the project linked | A greeting pool that names the space (`panes/session/greeting.ts`); the name is an `<em>` that nods when clicked | **W8** |
| Context chips (folder, "This computer") above the prompter | The same facts in the under-strip, below it, with the Mac's real name (`Composer.tsx`) | Keep Realm's — **D4** |

### The browser

| Codex | Realm today | Plan |
|---|---|---|
| Omnibox with a suggestion list (history, "Search the web") | One field; a non-URL is searched; no suggestions, because the pane may not open a dropdown (the native view paints over the DOM — W2.3) and there is no history to suggest from | **W7c** |
| ⋯ menu: Find in page, Print, Zoom −/100%/+, Show device toolbar, Take a screenshot, Import cookies and passwords, Passwords and autofill, Downloads, History, Clear browsing data, Browser settings | No ⋯ at all. Of the items: none of find, print, zoom UI, device emulation, user screenshots, cookie import or clear-data exist; passwords, downloads and history exist in part (Settings ▸ Sign-ins; a blocked-download notice; a per-pane back/forward menu) | **W7a, W7b, W7e**; import excluded — **D3** |
| Annotate: click elements, each pinned and numbered, a floating "Annotating · N" toolbar, an "N annotation" chip in the prompter | The element picker: one element per arm, nothing left on the page, each pick an inline `@[button "Sign in"]` token (`main/browser-agent.ts`, `state/store.ts addElementChip`) | **W7d** |

### Settings and the profile

| Codex | Realm today | Plan |
|---|---|---|
| Grouped nav (Personal / Integrations / Coding / Archived) with search | Seven flat tabs, no search (`panes/settings/SettingsPage.tsx`); "Sort by activity" appears twice in App | **W9a** |
| Appearance: mode thumbnails, theme, accent/background/foreground, font; UI and code font size; reduce motion System/On/Off; content font; translucent sidebar | Mode thumbnails, themes, the three colours and both fonts exist; no font sizes (⌘± zoom only), motion follows the system only, no content font, one translucency control for sidebar and panes | **W9b** |
| General: prevent sleep while running; terminal at the bottom or right; open files in an editor; full view by default; show in menu bar | None of these; the terminal is a right-hand dock only | **W9c** |
| Computer use: a global switch, always-allowed apps | A per-space `realm-computer` switch and a per-space review list (`McpSection.tsx`, `ComputerApps.tsx`) | **W9d** |
| Archived chats as a page | A sidebar shelf and the space page's Sessions tab | **W9e** |
| Profile: avatar, lifetime and peak tokens, longest task, streaks, a token heatmap (daily / weekly / cumulative), insights, most-used plugins | The profile page is a scope (skills, connections, memory), not a person; Usage has tiles, a 371-day message calendar and top tools (`panes/settings/usage/`) | **W10** |
| Voice input | None | Later — not this plan |

## The spaces question

How should spaces sit on screen so that running many agents does not mean walking between rooms?
Five shapes were considered.

**A — Every space in one sidebar (Codex's tree, Realm's rooms).** The sidebar lists every space of the
profile as a section: its icon, its name, and its agents' state summarised at the far right. The current
room is expanded; the others are collapsed to that one line, or expand to their live sessions. Opening a
session from another section changes the room underneath — layout, tint, chips — while the sidebar does
not move. *For:* nothing to hunt; the switch becomes a side effect of opening work, which is what it
should have been. *Against:* a long sidebar for someone with fifteen spaces — answered by collapsing,
and by listing only live and recent sessions per section with "Show more".

**B — Spaces in the rail.** Space avatars down the left edge, badged, with the sidebar showing the chosen
one (Slack, Discord). *For:* glanceable state for every space in 48px. *Against:* a badge says *that*
something happened, never *what*; every look is still a walk; and it spends the rail Codex uses for
destinations.

**C — A home board.** The Agents page as the default surface rather than an overlay: needs you, working,
failed, ready, across every space, with the answer on the card — approve the permission, reply, stop.
*For:* the right place to run a fan-out of twenty. *Against:* it is still somewhere else; it does not
help while you are inside one session wanting a glance at another.

**D — Peek.** Any session, from any space, opens as a preview tab in the side pane of the session you are
in — read its last turn, answer its card, close it — with no room change. *For:* a glance costs a click.
*Against:* a session from room B shown inside room A's arrangement; so a peek is a *transient* tab that is
never written into A's saved layout.

**E — An in-window "needs you" control.** A count in the window chrome ("2 need you"), whose list answers
the cards in place — the menu-bar item's job, with the window open. *For:* always on screen, one line
tall. *Against:* a popover near browser views must route around them, which `placeAnchored` already does.

**Recommendation: A for navigation, C for triage, D and E for glances.** They are not competing answers
but four distances to the same agents: the sidebar for *where is it*, the board for *what needs me*,
peek for *let me see*, and the counter for *is anything waiting*. B is rejected: it uses the rail for the
one thing a rail cannot describe. Spaces stay rooms — the tint, the profile boundary and the per-space
arrangements are what Realm has that nobody else does — and what goes is the walk.

## Decisions

- **D1 — Spaces stay rooms; the sidebar shows every room (A).** *Needs the user's answer.* The
  alternative worth naming is Codex's literally: one global layout, spaces reduced to folders and
  filters. It is simpler and it throws away per-space arrangements, the space tint and profile scoping.
- **D2 — The rail holds destinations, not spaces.** Home (the Agents board), Scheduled, Library,
  Connections at the top; the profile avatar (Profile, Settings) and the update control at the foot. The
  bell and search move to the sidebar head beside the space switcher, as in Codex.
- **D3 — No cookie or password import.** Sign-ins are deliberately entered by hand into a Keychain-keyed
  store and filled only by an approved agent action behind Touch ID (`main/index.ts`, Settings ▸
  Sign-ins). Importing a browser's cookie jar would hand every agent the user's real sessions, which is
  the boundary the browser partition exists to keep.
- **D4 — Context chips stay under the prompter.** The under-strip already carries the machine and the
  checkout, below the card where the next send's context is read (design.md, *Agent sessions*). Moving
  them above trades a settled decision for a screenshot.
- **D5 — Pane groups stay where they are.** They are the user's own arrangements inside a room, and their
  strip already sits over the pane host, drawn only with two or more (`components/GroupBar.tsx`). W5 lines
  it up with the rest of the window's top row; it does not move.

## Workstreams

Each is one PR, built and checked in the running app before the next. Order is dependency, then value.

**W1 — Row state at the far right, actions in its place.** The ask that started this. A row's title
takes all the width; its state (status dot, driving dot, machine state) and the pane-position glyph sit
at the far right; on hover or keyboard focus they give way to the row's actions (archive or delete, and
close) in the same slot. Nothing is reserved for buttons that are not showing. Keyboard: focus on the row
reveals the actions, as hover does. *Check:* in the built app, measure a row's title width at rest
against today's, and that the state and the buttons occupy the same box.
*Built (2026-10-01, `feat/sidebar-row-trailing-state`):* the title gains 46px at rest (167 against 121 on
a 248px row), and `sidebar-marks-live.mjs` measures the shared slot under a real hover.
*Found, left for a decision:* the unseen ring cannot draw. `ItemList.tsx` shows it only for a session
with no status, and `refreshSessions` gives every listed session one — `idle` included, which is the grey
dot on every resting row. The code's own comment meant idle to wear nothing and unread to wear the ring,
as Codex's blue dot does; restoring that changes what every resting row looks like, so it is the user's.

**W2 — The rail.** A 48px column left of the sidebar: destinations as icons with their badges (Home's
"N waiting"), the avatar and update at the foot, the sidebar toggle above. Collapsing the sidebar leaves
the rail — the collapsed state stops being a bare corner with the bell, the lens and the destinations
unreachable. The sidebar head becomes: space switcher, bell, search.

**W3 — Every space in the sidebar.** Above the room's own contents, an *Active* section across all
spaces — sessions needing you, then working, then finished-unread — each row naming its space and wearing
its state at the far right. Below it, *Spaces*: the current one expanded to its groups and sessions as
today; every other one a single row with its state summary (`spaceBadge`, plus counts), expandable to its
live sessions. Replaces the chat lens's status-less list as the cross-space view in the sidebar.

**W4 — Open across rooms without the walk.** A session opened from another space's row switches the room
in place — no swipe animation, the sidebar does not scroll or move — and lands focused on that session.
Window back/forward (⌘[ ⌘] at window scope, or the title bar's arrows) steps through *where you were*,
rooms included, so following an agent into another room and coming back is one key.

**W5 — The window's top strip.** One 40px row across the window: the rail and sidebar under the traffic
lights and the window's back/forward (W4), the group tabs over the pane host where they already are (D5),
each pane's bar beside them, and the side pane's tab strip over the side pane. A "+" at the side pane
strip's end offers *New tab* (a new-tab page, W6) and *New tab in full view* (the same, focused to fill
the window). Full view is pane focus under the name Codex gives it.

**W6 — The new-tab page.** What a blank tab shows instead of "Where to?": the address field, then the
session's tools (Files ⌘P, Terminal, Documents, Simulator, Machine), then recently visited pages once W7c
keeps history. Opening a tool replaces the new tab with that tool.

**W7 — The browser.**
- *W7a — A native ⋯ menu.* Built in main from a renderer-supplied template and returned by id — the
  history menu's mechanism made general — so it can draw over the page, which no DOM menu can.
- *W7b — The menu's own items:* Find in page (`webContents.findInPage`, with a find strip above the view
  like the download notice), Print, Zoom −/reset/+ with the level shown, Take a screenshot (saved to the
  space and attached to the prompter), Downloads, History, Clear browsing data (cookies, cache, storage —
  of the browser partition, with a confirm naming that it signs every pane out), Browser settings (the
  space's allowed sites and Sign-ins, gathered on one page).
- *W7c — Suggestions.* A history store (visited URL, title, last visit, count; per profile) and a
  suggestion list drawn as a strip that pushes the page down while the field is focused — the notice
  bars' mechanism, so nothing floats over the view. Rows: history matches, then "Search the web".
- *W7d — Annotate.* The picker kept armed: every click pins a numbered outline that stays on the page
  (injected over CDP, as the picker's overlay already is), an optional note per pin, and a toolbar drawn
  in the page (count, screenshot, show/hide pins, delete, Send, close). Send attaches one "N annotations"
  chip to the session's prompter, carrying the elements, the notes and a screenshot with the pins drawn.
- *W7e — Device toolbar.* A width and a device preset over CDP `Emulation.setDeviceMetricsOverride`.
  Last, and optional: the Simulator pane already shows a real device.

**W8 — The empty session.** "What should we work on in *Space*?" with the name a real link to the space
page (it nods today); when the session's checkout is not the space's primary folder, the checkout's name
instead, as Codex names the project.

**W9 — Settings.**
- *W9a — Grouped navigation and search.* Groups: *You* (General, Appearance, Keys, Notifications,
  Profile), *Engines* (Engines, Usage, Failover, Laya), *Browser* (Sign-ins, allowed sites), *Computer*
  (Permissions, computer control), *Data* (Import, Archived). A search field that filters to the rows
  whose label matches and jumps to them. Removes the duplicated "Sort by activity".
- *W9b — Appearance:* UI font size and code font size in px (with ⌘± staying page zoom); reduce motion
  System/On/Off; a content font for prose; the translucency switch split into sidebar and panes.
- *W9c — General:* prevent sleep while agents are running (`powerSaveBlocker` while any session is
  live); the terminal at the bottom or the right; open files in an editor (Cursor, VS Code, Zed, Xcode —
  detected); full view by default.
- *W9d — Computer use as a page:* the per-space switches and always-allowed apps for every space in one
  list, the macOS grants beside them. The switch stays per space; the page only gathers them.
- *W9e — Archived chats* as a page across spaces, with restore and delete.

**W10 — A page about you.** Your name and an avatar (an initial on your colour until one is chosen); five
figures — lifetime tokens, peak day, longest turn, current and longest streak; the activity calendar with
Daily / Weekly / Cumulative; most-used models, efforts, skills and tools. New `usage` aggregates for
streaks, peak and longest turn; everything else already exists in `usage.summary`.

**W11 — Agents across rooms.**
- *W11a — Home.* The Agents page becomes the rail's Home and a real pane, not an overlay: the list keeps
  its groups, and a card answers in place — Allow / Deny on a permission, a reply field on a question,
  Stop on a running turn.
- *W11b — Peek.* "Peek" on any session row, board card or notification opens it as a transient tab of
  the current session's side pane — never written into the room's saved layout, gone on a room switch.
- *W11c — The counter.* "N need you" in the window's top strip when anything is waiting, its list
  answering cards in place; hidden when nothing is.

## Status (2026-10-01)

Built on one branch per workstream, every one gated (typecheck, build, full suite) and checked in the
built app, and merged together on `integration/plan-26`, which passes the same gates. Not pushed.

- **Built:** W1, W3 (every space under the room, and Active above it), W4 (no slide; Go back and Go
  forward on ⌃- / ⌃⇧-, since ⌘[ / ⌘] are the pane's own trail), W6, W7a–e, W8, W9a–e, W10, W11a–c, and
  W5's "+" with *New tab* / *New tab in full view* (⌘⇧B / ⌥⌘B).
- **Not built:** W2 (the rail), and with it W5's one top strip across the window. The need-you count
  (W11c) sits in the sidebar's head band until there is a strip; the Agents page (W11a) is still an
  overlay until the rail can make it Home.
- **Left over:** the new-tab page's *Recently visited* (W6) is not drawn yet, though W7c's history now
  exists beside it; per-pin notes (W7d) were left out, since a note typed into the page's DOM is the
  page's to rewrite; "Full view by default" (W9c); a peek from a notification row (W11b); Go menu rows
  for Go back / Go forward once the Mac menu bar's Go menu reaches this line.
- **Open for a decision:** with the sidebar open, "needs you" now shows three times — the head band's
  count, the Agents row's pill and Active's first rows; and whether Active retires the activity lens
  (the builder's view: it does not — the lens is the only list of every chat by day).

## Not in this plan

- Voice input. Realm has none, and the honest version needs a local model (Laya) or the system's
  dictation — a plan of its own.
- Plugins, Hooks, Appshots, Mini & Pets, Language. No Realm counterpart or a different idea under the
  same name (skills and connections are Realm's plugins).
- Moving the context chips above the prompter (D4), and cookie or password import (D3).

## Open questions

1. D1: rooms with every room in the sidebar, or one global layout with spaces as folders?
2. Is *Active* (W3) at the top of the sidebar, or is it the rail's Home only?
3. Does a peek (W11b) allow sending a message, or only answering a card?
