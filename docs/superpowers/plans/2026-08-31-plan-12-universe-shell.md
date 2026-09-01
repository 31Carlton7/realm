# Realm Plan 12 — The Universe shell: under-strip, plus-menu, scoped tools, pages

> Transcribed from five screenshots of Universe (universe.works) supplied by the user on 2026-08-31.
> Implementers cannot see the images; THIS transcription is the reference. Numbered 12 (9 = Beautiful UI,
> 10 = reserved for the gateway session, 11 = browser pane, in flight).

## What the screenshots show, mapped to Realm

**1 — The prompter's under-strip.** Below Universe's prompter card hangs a second, quieter strip:
`💻 Carlton's M4 MacBook Pro ⌄` and `📁 Workspace ⌄`. Two selectors: the machine the agent runs on, and
the workspace it runs in. Realm mapping: the workspace selector is Plan 7's **environment** (space folder /
checkout / worktree — the concept the control-row rework removed from the row; it returns here, in the
under-strip, as a real selector: pick an existing environment or "New worktree…" for the session being
composed; after the first message it becomes display-only, same rule as the agent). The machine selector is
honest about reality: **Realm runs agents on this Mac only** — the strip shows this machine's name with no
caret today, and the selector exists as the seam for remote execution later (roadmap: pairing). Do not ship
a dropdown with one item pretending otherwise.

**2 — The "+" menu.** Universe's plus opens: `📎 Add files or photos ⌘U · 📁 Add folder · ⧉ Slash
commands · ⊞ Connectors (1 needs reconnection) › · ⚡ Plugins ›`. Realm mapping: "+" stops being a bare
file-picker trigger and becomes a menu — **Add files** (existing attach picker, gains ⌘U), **Add folder**
(link a folder into the space — the existing project-link flow), **Skills** (opens the @-mention picker
primed; Universe calls these slash commands), **Connectors** (submenu: this space's MCP servers with a
health badge — `mcp.test` powers "N need attention" — and a jump to the Connections tab), **Plugins is not
mapped** (Realm has no plugin system; do not invent one for menu parity).

**3 — Sidebar destinations.** Universe's sidebar tops with navigation pages above the spaces list:
Discover, My Agents & Skills, Integrations, Work (Sessions / Library / Calendar), Scheduled tasks,
Notifications, and an account row at the bottom. Realm adopts the *pattern*, not the inventory: above the
space section (below search + New session) — **Library** (all skills + memory docs across scopes),
**Connections** (all MCP servers across scopes), **Notifications**; the account/settings row moves to the
bottom-left where the settings gear lives, opening the new Settings pages (below). Discover, Calendar,
Scheduled tasks, Teams, Billing: out of scope — they are Universe's cloud product, not Realm's local one.

**4 — The space page.** A space in Universe is a page with tabs: Memory ("Every session here reads this
before it starts… Below is what the agent has learned working here"), Skills, Library, History, Sessions,
People — with a "Write a standing instruction" empty-state CTA. Realm mapping: the space-settings SHEET's
tabs (General/Skills/Connections/Memory, from Plan 8 W5) get promoted to a **space page** — a pane, not a
modal — with tabs General · Memory · Skills · Connections · Sessions · History. Memory keeps the standing-
instruction framing; Sessions lists the space's sessions; History = the space's checkpoints + recent ships
(diff pane's commit results). People: out of scope (no multi-user).

**5 — Settings pages.** Universe's account window: Main / Teams / Billing / Shared / MCP / Usage /
Devices / App, where Main shows **model accounts per provider** (Claude "max subscription · 2.1.223",
Codex "plus plan", …) and an **Engines list** ("Claude Code — Installed", "Grok — Install"), and App shows
appearance, notification toggles, a default tool-permission control, and a **macOS permissions panel**
(Screen Recording / Accessibility / Full Disk / Automation / Files & Folders, each with grant state and an
"Ask macOS" button). Realm mapping — a real Settings surface (page, not sheet) with:
- **Account/Engines**: the agent probe rendered as Universe renders it — per-CLI install state, version,
  logged-in identity, with the install-card command flow behind "Install". (All data exists: `agentProbe`,
  `AGENT_CLI_COMMANDS`.)
- **App**: theme (exists), notification preferences (new), default permission mode for new sessions (new,
  honest: per-agent support noted), reduced-motion note.
- **Permissions (macOS)**: TCC grant states for the app — Files & Folders, Automation, Screen Recording,
  Accessibility — with honest "can't be checked until used" rows where macOS provides no probe API, and
  deep links to System Settings. (mac-cli's `doctor` five-state model is prior art; its `writeOnly` lesson
  — grants that half-work — applies.)
- MCP/Usage/Devices/Teams/Billing: MCP lives in Connections; the rest are cloud concepts, out of scope.

**Notifications page** (3 & 5 both show it): a feed, newest first, of things that waited on the user:
permission requests (pending ones actionable inline — same ApprovalCard), sessions that finished while
unfocused, worktree/checkpoint hazards, MCP servers failing `mcp.test`, CLI probe regressions. Backed by a
notifications store (server-side rows so the feed survives restart), with per-category toggles in Settings
and the existing cross-space badge system feeding counts.

## The scoping model (the user asked for "the correct UX pattern")

The hierarchy already exists in Realm's data: **Profile → Space** (profiles group spaces; Work/School/
Personal). Adopt the User-vs-Workspace settings pattern (VS Code / GitHub org-vs-repo), concretely:

1. Every skill, MCP server, and memory doc gains a **scope**: `profile` or `space` (where it's defined).
2. Lists render in two labelled groups: **"This space"** and **"From <profile>"** (inherited). Inherited
   items show a scope badge and are toggleable per space (override), never editable in place — an "Edit in
   profile" affordance jumps to the defining scope. Space-scoped items can be **promoted** ("Move to
   profile") when they prove out.
3. Creation flows ask scope ONCE, at creation, defaulting to the scope you're standing in.
4. Effective set = profile items minus per-space disables, plus space items — computed in ONE place
   (server), consumed by skills injection, MCP configFor, and memory systemContext alike, so the panels
   and the wire can never disagree.
5. Migration: existing per-space rows keep scope `space`; nothing changes behaviour on upgrade.

## Workstreams (sequential unless noted; renderer-heavy ones must not run parallel to Plan 11's)

- **W1 — Under-strip + plus-menu** (Composer only; parallel-safe with Plan 11 W3+): the strip (environment
  selector wired to Plan 7's `environments.*` + `createWorktree`; machine name display), the "+" menu with
  ⌘U, Connectors health badge via cached `mcp.test` results.
- **W2 — Scoping model** (server + contracts): profile scope for skills/MCP/memory, the effective-set
  computation, migration, RPC. Mutation targets: inheritance math, override isolation, promote/demote.
- **W3 — Space page** (promote the sheet; sheet retires for spaces), Sessions + History tabs.
- **W4 — Sidebar destinations + Library page + Connections page** (scoped groups per the pattern).
- **W5 — Notifications**: store, feed page, inline permission actions, Settings toggles, badge unification.
- **W6 — Settings pages**: Engines (probe UI), App, macOS Permissions panel.
- **W7 — Coordinator visual pass** against the transcription; single merge.

## Out of scope, named

Remote machines (seam only), Discover, Calendar, Scheduled tasks, Teams/Billing/Usage/Shared, People,
Plugins-as-a-system, haptics.
