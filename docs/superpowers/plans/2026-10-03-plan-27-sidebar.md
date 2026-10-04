# Realm Plan 27 — The sidebar

The sidebar has grown one section per feature, and it now shows the same facts many times over.
This plan works out what it is for, what it should hold, and what spaces, profiles and splits
should become underneath it.

## What the sidebar is for

One job: **get me to my work, and tell me what needs me.** It navigates; the window shows what is
open. Two rules follow, and most of what is wrong today breaks one of them.

1. **Never list what the window already shows.** The panes are on screen. Listing them again
   in the sidebar turns the sidebar into a window manager.
2. **Never make me switch rooms to see my own work.** Agents run in the background in every
   space at once. A list that only shows one space at a time hides most of what is happening.

## What is there today

Top to bottom, in the screenshot of Homework:

| Section | Shows | Also shown at |
|---|---|---|
| Head band: "2 need you", bell, activity, toggle | sessions waiting, across profiles | Agents pill, Active, Open rows, strip badges, Other spaces, side-pane tab dot |
| Space header: name, a switcher listing every space, search, ⋯ | the space; a flat list of all spaces | strip, Other spaces, the overview, the palette |
| New session, Quick chat | — | ⌘N, ⌘⇧Space |
| Agents, Library, Connections, Scheduled tasks | destinations | Connections again in the profile menu |
| Active | up to 4 sessions waiting, working or unread | the space's own rows, Other spaces |
| Open (one section per split) | every pane in the split: sessions, YouTube, a terminal, a simulator | **the window itself** |
| New split | — | GroupBar's +, ⌘⇧G |
| Sessions | every *unopened* item of any kind — sessions, a simulator, a machine | — |
| Pinned, Archived | — | Archived again in Settings and on the space page |
| Other spaces | the profile's other spaces, unfolding to their live sessions | strip |
| Space strip (foot) | profile icon, the profile's spaces, + | header switcher, Other spaces |

The facts from the code (the survey behind this plan, `integration/plan-26`):

- **A space is a context container.** It owns its folder and checkouts, the items and sessions in
  it, documents, schedules, machines and simulators. It also owns per-space settings: which
  connections are on, the computer and machine allowlists, allowed browser sites, skills, a memory
  doc, scripts, the sandbox and failover. Agents need all of it.
- **A space is also a room.** `selectSpace` unloads the other room's panes, items and environments
  and loads the new one's. The window layout (splits, and the panes in each) is stored per space.
  21 call sites switch rooms; about 35 components and 27 store actions assume "the current space".
- **The room's identity is thin.** The space colour tints only its icon in the strip. Nothing else
  in the window changes with the room.
- **Profiles are half-built.** A profile scopes its spaces, its connections and skills, its memory,
  and its browser history. But **every profile shares one browser cookie jar and one store of saved
  sign-ins and passkeys**, so a "Work" profile is signed in to the same sites as "Personal". You can
  make a profile only from inside New space, and rename, recolour and delete exist on the server
  with nothing in the app calling them.
- **Splits** are named groups ("Main", "Split 2", …) per space, with no upper limit, each its own
  layout. The GroupBar appears at two or more. The sidebar draws an "Open" section per split.
- **Tools now belong to sessions.** Since Plan 26 a session's browser, terminal, documents,
  simulator and machine open as tabs of its side pane. Only a few things are still loose rows: a
  terminal from ⌘T, a diff, things made from the palette with no session. One bug: an agent-opened
  terminal makes a row and no pane.

## The questions

### Should we have spaces at all?

**Yes, but not as rooms.** What a space owns is exactly what an agent needs to do its work in the
right place: the folder, connections, memory, skills and allowlists. Drop spaces and all of that has
to live somewhere else, per session, which is worse. A flat list with tags (C below) cannot carry
any of it.

What does not earn its cost is the **room**: having to switch to a space to see what is in it, and
a separate window layout per space. Since Plan 26 the arrangement that matters (a session and its
tools) travels with the session. The room's only visual cue is an icon tint.

So spaces stay, renamed nothing — "space" fits Homework, Thesis and Lectures better than "project",
which reads as code — and they become **sections of one list**. Opening a session from any space
opens it. Nothing swipes, unloads, or walks.

### How should profiles and switching work?

A profile should be the thing a **browser profile** is: a separate identity. Switching it is rare and
deliberate (Personal / Work / School), and it should isolate what an identity means:

- **its own browser cookie jar, saved sign-ins and passkeys** (today shared — the main gap);
- its connections, skills and memory (already scoped);
- its spaces.

Switching lives in **one place**, the top of the sidebar, as in Codex, Linear, Notion and Slack: the
profile's avatar and name, opening a menu of profiles. Two more things make switching cheap:

- **A profile can open in its own window** (Chrome's model). Two profiles side by side means no
  switching at all.
- **Other profiles' attention shows in the switcher** ("Work · 2 need you"), and in the need-you list,
  so nothing waits unseen because it is in another profile.

Space switching disappears as a separate act: there are no rooms to switch between.

### What should be on the sidebar?

Five things, in this order — and nothing the window already shows.

1. **The profile, search, and new session**, in one header row.
2. **Needs you** — only when something is waiting on a permission or a question, or failed. It is
   the one list of what needs an answer, across spaces and profiles, and each row answers in place
   or opens the session.
3. **Pinned** — the user's own favourites across spaces (sessions, documents, sites), small.
4. **The spaces**, each a collapsible section of its sessions, with a second lens, **Recent**, that
   lists every session by time instead (today's activity lens, and Codex's Recents).
5. **New space**, at the end of the list.

Destinations (Agents, Library, Connections, Scheduled, Settings) move to a **rail** of icons at the
left edge. That is Codex's dual sidebar, which survives collapsing the sidebar.

### Should splits be one tab? Do they take too much space?

**Yes, and yes.** A split is a way of looking at two sessions at once. It does not need a name, a
bar, a sidebar section, or a list of its own panes.

- **A split is one view**, at most one at a time: drag a session onto the main view's edge, or
  ⌘-click it, and it opens beside. Each session row in it wears the pane glyph W1 already draws.
  Click either row to get the split back; close a side to leave it.
- **No GroupBar, no "New split", no "Open" section.** The window shows what is open. A session keeps
  its own side pane, so there is no layout left that needs saving per space.
- Watching many agents at once is the Agents page's job (Home), and a glance is a peek. Neither needs
  a split.

If saved arrangements turn out to be missed, they come back as **Views**: a named arrangement,
listed once, like a pinned item. They are not a structural layer under every space.

## The proposal

```
┌──────┬──────────────────────────────┬──────────────────────────────────┬─────────────────────────────┐
│ ● ● ●│ (C) Personal ▾          ⌕  ✎ │ ‹ ›   Homework › Wants a yes   ⋯ │ ▶ YouTube  ▢ homework  +    │
│      ├──────────────────────────────┤                                  │                             │
│  ⌂ 2 │ NEEDS YOU                    │  ask me                          │                             │
│  ▤   │   Wants a yes      Homework ●│                                  │      (the session's         │
│  ⛁   │   Which base?      Homework ●│  ● Allow Bash?   rm -rf build    │       side pane: its        │
│  ⏲   │                              │    1 Allow                       │       browser, terminal,    │
│      │ PINNED   ▢ ▢ ▢               │    2 Allow always                │       documents, devices)   │
│      │                              │    3 Deny                        │                             │
│      │ [ Spaces | Recent ]          │                                  │                             │
│      │ ▾ ▣ Homework        ●2  ◉1   │                                  │                             │
│      │     Wants a yes             ●│                                  │                             │
│      │     Which base?             ●│                                  │                             │
│      │     Working away            ◉│                                  │                             │
│      │     Has news                ○│                                  │                             │
│      │     Show more  8             │ ┌──────────────────────────────┐ │                             │
│      │ ▸ ▣ Thesis              ◉1   │ │ Ask anything                 │ │                             │
│ (C)  │ ▸ ▣ Lectures                 │ └──────────────────────────────┘ │                             │
│  ⤓   │ + New space                  │   Mac · Homework ▾               │                             │
└──────┴──────────────────────────────┴──────────────────────────────────┴─────────────────────────────┘
  ●  waiting on you   ◉  working   ○  unread   ⌂  Home (the Agents board), with its waiting count
```

### The rail

Home (the Agents board, with the waiting count), Library, Connections, Scheduled. At the foot: you
(avatar — the page about you, Settings) and the update control. The traffic lights and back/forward
sit above it. Collapsing the sidebar leaves the rail, and Home's count stays on screen.

### The header

`(avatar) Personal ▾` — the profile switcher — then search (⌘K) and new session (⌘N). A new session
goes to the space of the session in focus. The composer's space chip, under the card, can change it
before the first send. Each space section also offers its own + on hover.

The bell moves to the rail. The activity lens becomes Recent, below. Quick chat stays a keystroke
(⌘⇧Space), not a row.

### Needs you

Drawn only when non-empty. Waiting first (oldest first), then failed. Each row: title, the space in
muted text, the state at the far end; it answers in place (the shared request card) or opens the
session. This **replaces** the head-band pill, Active, and the Agents row pill. Two marks remain,
each with its own job: the dot on the row in its space, and Home's count in the rail. Working and
unread are not here — they are visible in their spaces and in Recent.

### The spaces

One section per space: icon, name, and the state summary at the far right (●2 ◉1). Hover offers
**+** (new session here) and **⋯** (open folder, connections, memory, settings, archive). Expanded,
it lists sessions newest first, five, then "Show more", which opens the space page. Collapsed or
expanded is remembered per space. Order: by recent activity, or by hand.

Rows use the W1 anatomy: the title takes the width, the state sits at the far end, and actions take
its place on hover.

- **A fan-out is one row** — "Fan-out: migrate the API · 12 running · 2 need you" — unfolding to its
  sessions. Twenty sibling rows would bury the space.
- **Sub-agents** stay inside their parent's running-agents chip (Plan 26), not rows.
- **Scheduled runs** wear a clock, as in Codex's Recents.

### Recent

The same sessions by last activity (Today, Yesterday, …), each naming its space, with its state.
Today's activity lens becomes this, and gets its status marks back (they are styled nowhere today).

### What leaves the sidebar

| Today | Goes to |
|---|---|
| Open (per split) and New split | nothing — the window shows what is open |
| GroupBar | nothing — one view, which may be a split |
| Sessions heading listing unopened simulators and machines | the side pane's + (new-tab tools) and the palette |
| Other spaces, the space strip, the header's flat space list | the spaces as sections; the profile in the header |
| Agents, Library, Connections, Scheduled rows | the rail |
| "N need you" pill, Active, Agents pill | Needs you, and Home's count |
| Archived section | the space page (and Settings ▸ Archived) |
| Theme items in the header's ⋯ | Settings ▸ Appearance |

### Identity without rooms

Today a space's colour tints one icon. In this design it marks the space's section icon, the
composer's space chip, and the pane bar's breadcrumb (`Homework › Wants a yes`), so the window always
says which space a session works in. That is more presence than the room gives it now, with no
switching.

## Options considered

- **A — Keep rooms; improve the walk** (Plan 26 W3/W4: other spaces under the room, switch in place).
  Built, and it helps. But it keeps two lists of the same sessions and a room model that 35
  components have to respect. Kept as the first step, not the destination.
- **B — Spaces as sections of one list** (recommended).
- **C — No spaces: one list of sessions with tags.** Simplest to draw. But a tag cannot carry a
  folder, connections, memory or allowlists, which is what a space is for.
- **D — Spaces in the rail** (Slack and Discord workspaces). Glanceable badges, but every look is
  still a walk, and the rail is better spent on destinations.
- **E — Window tabs for open sessions** (Chrome, VS Code). Familiar, but it is a second list of
  sessions beside the sidebar, and a second tab strip above the side pane's. Rejected as the
  default.

## Plan

Each phase ships on its own and is useful alone.

**Phase 1 — The sidebar, on today's model.** No data-model change: a session from another space
still switches rooms underneath, instantly and without the slide (W4).

- The rail (W2, never built) and the header (profile switcher, search, new).
- Needs you, replacing the pill, Active and the Agents pill.
- Spaces as sections (Plan 26 W3's other-space rows promoted, with the current space just another
  section), Pinned, and the Spaces | Recent lens.
- The strip, Open, New split and the GroupBar go.
- The sidebar lists sessions only. Loose tools move into side panes, and the bug where an
  agent-opened terminal makes a row and no pane is fixed.

**Phase 2 — Profiles made real.**

- A browser partition per profile, and sign-ins and passkeys per profile, migrated from the shared
  ones.
- Create, rename, recolour and delete in the app.
- "Open in new window" for a profile, and attention badges in the switcher.

**Phase 3 — Retire the room.**

- Lists hold every space's items; nothing unloads on a switch.
- "The current space" becomes the space of the session in focus. The 27 store actions that bail
  without an active space take a space explicitly.
- Groups migrate to one view per window: the active split is kept, the rest become sessions in their
  spaces.
- The space row's `groups_json` / `layout_json` retire.

## Decisions (answered 2026-10-03)

1. **Spaces stay as sections of one list, not rooms, named *spaces*.** Yes.
2. **Profiles become real isolation, switched from the header, with per-profile windows.** Yes —
   "with a button for each to share it to another session": each thing a profile keeps to itself
   (a saved sign-in, a passkey, a site's browser sign-in) gets a button that copies it into another
   profile.
3. **Splits become one view at a time, with no named splits.** Yes.
4. **Needs you is the one list of what waits on you; the pill and Active go.** Yes.
5. **Build all three phases.** Phase 1 (`feat/sidebar-rail`), Phase 2 (`feat/profiles-real`) and
   Phase 3 (`feat/one-list-no-rooms`) are built in parallel and merged on `integration/plan-26`.

## Status (2026-10-04)

Built as the three branches above, each gated (typecheck, build, full suite) and checked in the built
app, and merged on `integration/plan-26`, which passes the same gates and the live checks below. Not
pushed.

- **Phase 1:** the rail (back and forward; Home with the waiting count, Library, Connections,
  Scheduled tasks, Notifications; you and Settings at its foot) stays when the sidebar collapses. The
  header is the profile switcher, search and new session. Needs you is drawn only when something
  waits. Each space is a section — its tally, five sessions then Show more, a fan-out as one row, a
  schedule's clock, a + and a ⋯ on hover, folded per space — beside Pinned and the Spaces | Recent
  lens. The sidebar lists sessions only; what an agent opens goes into its session's side pane.
- **Phase 2:** a browser partition per profile (the first keeps `persist:browser`, so nothing signed in
  is lost), sign-ins and passkeys per profile, a Share with button on each, create, rename, recolour
  and delete in the app, one window per profile from Open in new window, and what waits in each other
  profile in the switcher's menu.
- **Phase 3:** every space of the profile is loaded at once and the current space is the focused
  session's. A window has one view, saved per profile (`ui.view:<profileId>`) and migrated once from a
  room's groups; `groups_json` and `layout_json` are read for that and never written again (the
  columns stay, since migrations only add).
- **Finished after the merge:** a sign-in started from a session's card opens its terminal and consent
  page in that session's side pane; the composer's space chip moves a session that has not started to
  another space of its profile; browsers an agent opens in quick succession all stay, in order (an
  overtaken items fetch had pruned with the list from before); a restored tab keeps its title while
  its page loads; the swiper's gesture module and invert setting are gone.
- **Live checks:** `one-list`, `sidebar-rail` and `profiles` are new. The Plan 26 checks, and the older
  ones that opened pages from the destination rows, now use the rail, the sections and the one view.
  Retired: `space-swipe`, `sidebar-spaces`, `sidebar-collapsed` (its one live claim — a page up must not
  swallow the click that brings the sidebar back — moved to `sidebar-rail`) and `pane-close`;
  `sidebar-and-splits` kept its two Settings claims as `settings-leading`.
