# What an agent in Realm knows Realm can do

Realm tells each agent session what it can do in three places:

1. **The preamble** (`apps/server/src/mcp/capabilities.ts`). It is composed at every session start in `SessionService.ensureLive`. It has one block per Realm tool group the session really has, a "Finishing without the user" section, and the blocks Realm draws. Claude gets it in the system prompt and Codex as developer instructions. The ACP agents (Cursor, Gemini and the rest) take no per-session context, so they get it as the `realm` gateway's MCP `instructions` on `initialize`. Each agent gets it exactly once.
2. **`realm_capabilities`** (`realm-workspace__realm_capabilities`, in `apps/server/src/workspace/catalog.ts`). This is the live catalog. It lists every tool group with each tool's first sentence. It says which groups are off in this space, which this Mac can't offer, and which have nothing to list here, along with who can change that. It also lists the user's connections and their state, the skills that are on, pane counts, Laya's mode, and what Realm does that no tool reaches. Pass `group` to get one group's tools in full. It is a promptless read.
3. **Each tool's own description**, which says how to call the tool.

## Audit: before this change

The audit was taken on `integration/v2.3` (Realm 2.2.0) by listing every tool through the real gateway. The space was a team with every provider switched on.

| Capability | Tools | What the preamble said before | Now |
|---|---|---|---|
| Sub-agents | agent_start/wait/run/review | covered | covered |
| | agent_status, agent_peers, agent_ask, agent_answer, browser_agent_run | **not named** | named |
| Asking the user | ui_ask | covered | covered |
| Browser | browser_open/snapshot/act/do | covered | covered |
| | browser_list, browser_navigate, browser_read, browser_screenshot, browser_batch | **not named** | named |
| Sign-ins | browser_credentials, browser_fill_credential (saved or **generated** password) | **not named**. Agents asked the user to type passwords that Realm could fill. | named, and in "Finishing" |
| Files | browser_download, browser_upload, browser_dismiss_dialog | **not named** | named |
| Documents | docs_search/list/read/open/state | covered | covered |
| | docs_progress | **not named** | named |
| Schedules | schedule_create, schedule_list | covered | covered |
| Team | team_roles, record_*, review_submit, review_close | covered, but **told to every space**, team or not | only in a team's space (`listsIn`) |
| | record_types, review_status, policy_read, team_handoff, team_mention | **not named** | named |
| Vault | vault_list, vault_http | **no block** | block (team spaces) |
| Terminal | terminal_open/write/read | covered | covered |
| | terminal_wait, terminal_list, terminal_close, **signin_start** | **not named** | named, and signin_start is in "Finishing" |
| Simulator | 14 tools | covered | covered |
| | simulator_apps | **not named** | named |
| Goals | update_goal, goal_status | covered | covered |
| Workspace | workspace_state, pane_show, sessions_*, session_open, space_*, settings_* | covered | covered |
| Memory repo | memory_index/read/search/save/remove/write_file | **no block**. The memory service's own block names save/read only when a repo is attached. | block (only where a repo is attached) |
| Realm UI / Mac apps / machines | app_*, computer_*, vm_* | covered | covered |
| | vm_start, vm_stop | **not named** | named |
| Connections (user MCP servers) | none | **nothing**: an agent could not tell "not connected" from "does not exist" | `realm_capabilities` lists each one with on/off and connected / needs sign-in / failing |
| Skills | none (injected per agent) | nothing | `realm_capabilities` lists the ones that are on, with their paths |
| Switched-off groups | none | nothing: an off group was simply absent | `realm_capabilities` says it is off and where the user turns it on |
| Laya | none | nothing | mode shown in `realm_capabilities` |
| Settings pages, Schedules page, Memory page, Code Review, Library, search, checkpoints | none (user-only) | nothing | named under "In Realm, with no tool", with where the user does each |
| `mac` CLI | none (skill + a binary Realm does not ship) | nothing | named under "In Realm, with no tool" |
| Finishing autonomously | none | nothing told the agent when a step was its own to take | "Finishing without the user": the tool that takes each common step, and the steps that stay the user's (typing a password or code, payments, consent buttons, irreversible outward acts they did not ask for) |
| Cursor, Gemini and the other ACP agents | none | **got nothing**: no context channel | get the preamble as the gateway's MCP instructions |

## Size

These are estimated tokens (characters ÷ 4; no tokenizer is available offline), for the preamble alone:

| Session | Before | After |
|---|---|---|
| Ordinary space, simulator available (before included the team block by mistake) | 10,699 chars ≈ 2,675 | 10,122 chars ≈ 2,531 |
| Ordinary space, no simulator | 9,042 ≈ 2,261 | 8,820 ≈ 2,205 |
| Team space with a memory repo | 10,699 ≈ 2,675 | 11,427 ≈ 2,857 |
| Every provider on | 12,544 ≈ 3,136 | 12,755 ≈ 3,189 |

The preamble now names about 35 more tools and adds the "Finishing" section, yet an ordinary session's preamble is smaller than before. Anything that changes per session, such as connections, switches, skills and panes, lives in `realm_capabilities` and costs nothing until it is called.

## Adding a tool

1. Add the tool to its provider.
2. Name it, backticked, in that provider's block in `capabilities.ts`, saying when to reach for it. `apps/server/src/mcp/capabilities-catalog.test.ts` lists every provider through the real gateway and fails on any tool its block does not name, and on any provider with no block.
3. Class it in `REALM_TOOL_CLASSES` (`packages/contracts/src/risk-class.ts`). `policies-app.test.ts` fails otherwise.
4. Do nothing for `realm_capabilities`: it reads the gateway, so the tool shows up there in its own words.

A new provider also needs a `BLOCKS` entry and a place in `ORDER`. If it lists tools only in some spaces, it should implement `listsIn(spaceId)`, so sessions elsewhere are not told about it. If it depends on something this Mac may lack, it should implement `offered()`.

## Still out of an agent's reach

These are deliberate, and `realm_capabilities` names where the user does each one:

- Adding an MCP connection or signing in to one (OAuth).
- Reading, editing or deleting a saved sign-in.
- Settings beyond the five in `AGENT_SETTINGS`.
- Editing or deleting a schedule.
- Team roles and policies.
- Opening Realm's own pages (Settings, Library, Code Review).
