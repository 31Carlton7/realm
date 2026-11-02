# Plan 31: Teams v2, the memory library, and the next update

Date: 2026-11-02. Base: `integration/v2.6.3` (a00a82e2, v2.6.3). Builds on Plan 30 (always-on
employee: channels + a Lead) and the 2.6.0 memory work.

Research (screenshots + notes): `realm-worktrees/.verify/nov02/teams-research/RESEARCH.md`.

## The ask

The owner, 2026-11-02: improve agent teams "and take a lot out of the Grok Bot and Reason Machines
playbook… I really like how agents can talk to each other… have different teammates for different
things" instead of creating sessions all the time; the current teams "feel pretty vibe-coded… not
usable right now", so strip what exists and overhaul the look and feel; team icons should be like
Grok Bot's: "very simple static single color icons… clean and professional but still cool and cute".
Plus a memory library: one place to view, create, edit, delete and connect every agent's memory files.
Plus the next-update list (status audited below).

## What exists (audit, 2026-11-02)

Teams is ~25k lines in five phases (roles + Review, vault, approve-then-post, handoffs, lab) plus
"dynamic Teams" (record types, deliverables, policies). Underneath it is a creator-campaign product:

- A teammate ("role") is a saved definition; each wake is a hidden `runs` row → a session the sidebar
  hides (`model.ts:179-196`). There is no conversation: the "chat" is assembled from run reports.
- Posting never worked in production (`NotConnectedAdapter`). Lab is phone-farm infrastructure.
- "Teammate" means two things: a team role, and the prompter's "+ → Add teammate…" sub-agent.
- Teammates are listed in three places; waiting reviews in five.
- In the owner's data: Versed has Creator Manager, Content Producer, Viral Video Studier; General has
  Ops. 0 vault grants, 0 lab devices, 1 act ticket, 8 policies per team space (seeded).

## Teams v2 — the model

**A teammate is a permanent agent in a space that you message.** Name, what it does (brief), an icon
(shape × colour), model (+ agent, effort), working folder, permission mode, and a flag for **Lead**
(the chief of staff; Plan 30's Lead). Each teammate owns **one home session** — a real Realm session
whose transcript IS the chat: streamed, with tool calls, questions and permissions, like any session.

**Work happens in task sessions the teammate starts** (by `agent_start`, so they are ordinary
children with the delegation machinery). They are titled `<teammate> - <task>`, run in the
teammate's permission mode (no approval spam: children inherit the teammate's mode), and are listed
under the teammate — never hidden. A task handed to another teammate nests under the session that
asked for it, with a `↳ n` count.

**Teammates talk to each other** with two tools on every session in a space with teammates:

| Tool | What it does |
|---|---|
| `team_list` | Every teammate: handle, what it does, Lead or not, state (idle / working / needs you), its live task's title, model. |
| `team_message {to, message, wait}` | Posts into the teammate's home session as a message from the sender ("From @cto: …"), queued behind a live turn. With `wait: true` it returns the reply (the target's next turn's final text). Both transcripts show the exchange. `to: "lead"` reaches the Lead. |

Asking the person stays Realm's question card (it already says who asks). Needs-you is said on the
teammate's sidebar row and in Needs you, as today for sessions.

**The Lead** (one per space, optional) sits first in the list with a small star, and its brief says
to route work to the right teammate, keep you out of the middle, and come back with finished work.

**Not in v2** (cut, with data left in place): Review batches and approve-to-post, tickets/acts,
pacing/holds, lab, record types and records pages (records are memory files — the memory library
shows them), policies, team vault grants, team budgets UI, starter galleries, the synthesized chat,
Realmites on teammates. Tables stay; no destructive migration. The phone's Review screen gets an
empty list rather than an error.

## Teams v2 — the screens

```
┌ Sidebar ─────────────┐┌ @cto ──────────────────────────────┐┌ cto's computer ──────┐
│ Team               + ││  you: Can we move search to SQLite? ││ This Mac · Ready   ■ │
│ ★ ● Lead             ││  cto: Starting a session for it.    ││ Files                │
│ ● cto            •   ││   ↳ cto - sqlite search   Working  ││ Terminal             │
│ ● design engineer    ││  cto: Done. Search is on SQLite…    ││ Simulator            │
│ ▸ Strat              ││                                     ││ Sessions             │
│   ● research         ││                                     ││ cto - sqlite search 1m│
│ Sessions             ││ [Message cto…]  Claude Opus 5.5 ⌄   ││  ↳ design - icon 14h │
└──────────────────────┘└─────────────────────────────────────┘└──────────────────────┘
```

- **Sidebar:** a "Team" section at the top of each space with teammates (icon, name, the still state
  dot, unread dot). Optional user-made groups fold like folders. A row's disclosure shows its live
  and recent task sessions nested. Task sessions don't also appear loose in the session list.
- **Teammate page** (a pane, like a session): head = icon, name, one-line role, model chip, menu
  (Edit, Make Lead, Archive). Centre = the home session's transcript + composer ("Message cto"),
  reusing the session pane. Right = **its computer**: machine + state + Stop, Files (its folder in
  Documents), Terminal, Simulator (opens the panes for its folder), then **Sessions** it started,
  newest first, age, unread dot, nested hand-offs.
- **New teammate sheet:** name, what it does (with quick starts: Lead, CTO, Design engineer,
  Research, Cleanup, TPM), icon maker (big preview, 8 shapes, 12 colours), model (the prompter's
  own picker, Claude and Codex), folder, permission mode. One button.
- **Icons:** Grok Bot's recipe — one flat colour shape with two short slanted eye strokes; nothing
  else. 8 shapes (circle, flower, rounded square, pill, triangle, hexagon, cloud, drop) × 12
  colours. Drawn at 16 (rows, log lines), 24 (header), 64 (sheet preview). Still: no motion, no
  mood. State is the row's dot, never the face. Replaces the Realmite rule in design.md.
- The prompter's "+ → Add teammate…" becomes "Add sub-agent…" so "teammate" means one thing.

## Memory library

One page — **Memory** in the Library — for every memory an agent reads:

- **Sources**, grouped: Realm (profile repo, each space's folder, team repos, `teammates/<handle>/`),
  Claude (`~/.claude/CLAUDE.md`, `~/.claude/projects/*/memory/*.md`, each space folder's
  `CLAUDE.md`), Codex (`~/.codex/AGENTS.md`, each space folder's `AGENTS.md`), Cursor (`~/.cursor/
  rules`, `.cursor/rules`), Gemini (`~/.gemini/GEMINI.md`). Only sources that exist are drawn.
- **List:** every memory file — title (frontmatter `name`/first heading), description, type, source,
  updated — with one search across all of them (name, description, body).
- **Reader:** rendered Markdown, frontmatter as properties, `[[links]]` that open the linked memory,
  "Read by" (which agents/spaces load it, from `memory.sources`), Show in Finder.
- **Edit / New / Delete:** a plain Markdown editor; new memory from the frontmatter template; Realm
  repo writes commit to the repo (and update `MEMORY.md`'s index line); files outside Realm ask once
  before writing; delete moves to the Trash (repo files are removed by a commit).
- **Connect:** per source, whether Realm points agents at it (Claude's auto-memory redirect, the
  managed `AGENTS.md`), with the switch that exists today.
- Server: `memory.library.sources/list/read/write/create/delete/search`.

## The next-update list — status and work

| # | Item | Status | Work |
|---|---|---|---|
| 1 | Orchestrator benchmark #1 | Partial (PR #1 open, 94 proposed; F=3) | GitHub/issue links in app (Help menu, Settings ▸ About), CONTRIBUTING + issue templates, refreshed 2.6.3 numbers, PR text ready — posting waits on the owner |
| 2 | Chromium > 138 | Done (Electron 45, Chromium 156, v2.5.0) | Remove stale "Chromium 138" comments; check `corner-shape` now works natively |
| 3 | "What it reported" opens/closes | Done in the Agents tab | Find any other "What it reported" surface; iOS toggle |
| 4 | Calm image loader | Done (well + one ring) | Codex's image tool shows nothing while it runs — give it the same loader |
| 5 | New session in Activity view | Partly fixed | Palette and worktree paths don't scroll/focus; new session's space |
| 6 | Show in Finder in Documents | Done | — |
| 7 | Sub-agent brief readable | Done in the viewer | Raw text when a child opens as a session — render the brief there too |
| 8 | Account dropdown (Claude/Codex) | Not built | Accounts per CLI (own config dir each), add/sign in from Settings and from the prompter, per-session account |
| 9 | Switch provider mid-conversation | Blocked today | `sessions.switchAgent`: summarise on the frontier model, save the summary as a Markdown file, inject it as system context on the new engine's first turn, a hand-off line in the transcript |

## Streams

| Stream | Branch | Owns |
|---|---|---|
| T1 Teams server | `feat/teams-v2-server` | contracts, migration, teammate service, home sessions, `team_list`/`team_message`, strip server/main |
| T2 Teams UI | `feat/teams-v2-ui` | strip renderer team UI, icons, sidebar, teammate page, new-teammate sheet, design.md |
| M Memory library | `feat/memory-library` | `memory.library.*`, the Memory page |
| S Switch + accounts | `feat/switch-provider-and-accounts` | items 9 then 8 |
| F Fixes | `fix/next-update-leftovers` | items 2, 3, 4, 5, 7 |
| B Benchmark | `feat/bench-maturity` | item 1 (in-repo parts) |

T2 merges T1's branch once T1's contract commit lands. Integration: `integration/v2.7.0`, `--no-ff`
merges, full gates, every stream's live script on the combined build, one at a time.
Rules: never downgrade a model call; no AI attribution; commit by path; targeted tests only
(`--maxWorkers=2` while memory is short); live checks on a scratch home, never the real one.
