# Realm Plan 7 — Environment split, git ergonomics, and the capability answer

> Proposal, not yet approved. Written against three research documents produced 2026-08-28:
> `specs/2026-08-28-competitive-audit.md`, `specs/2026-08-28-capability-research.md`, and the browser-control
> technical brief folded into the latter.

## Why this plan is not the plan that was asked for

The request was: real brand icons in a combined model selector (done, `feat/model-selector`), a roadmap audit,
and a set of capabilities — Vercel connect, sandboxing, external gateways, iOS/Android simulators, browser
control, mac-cli.

The audit came back with a different priority, and both research tracks converged on it independently:

- Against the seven capabilities this category has converged on, Realm scores **2 of 7**.
- It has **no worktrees, no diff viewer, and no git write path**. `workspace.gitInfo` returns counts and stops.
- **Claude Code's own desktop app now ships Realm's v1 spec** — worktrees, browser pane, simulator pane, split
  panes, plan mode, MCP — free with the subscription, from the vendor of Realm's primary agent.
- Four of the six requested capabilities are best answered by *not building an integration*: Vercel Sandbox is
  answered by the Seatbelt sandboxes Claude Code and Codex already ship, "Vercel connect" by an MCP row,
  simulator control by an existing MCP server, and mac-cli by a ~100-line skill.

Realm is ahead of all eleven surveyed products on exactly one thing: **workspace-as-place** — swipeable tinted
spaces with identity scoped per space. Anthropic shipped the panes but not the identity boundary around them.
That is the thing to defend, and it is worth nothing if three agents fight over port 3000.

## The root cause worth naming

`Session` conflates three things: **the task**, **the environment it runs in**, and **the provider
conversation**. Every symptom below is downstream of that single conflation:

- There is nowhere to hang a worktree, so every session shares one checkout.
- `sessions.setAgent` must refuse after the first event, which is why the new model picker has to render
  cross-agent rows as unavailable and explain itself.
- Parallel agents collide on ports, build output, and the index.
- There is no unit that a checkpoint could revert.

Splitting Environment out of Session is therefore not one feature. It is the precondition for four.

---

## W1 — Environment as a first-class record

Introduce `Environment`: a checkout (path, branch, worktree-or-primary), a port block, and a lifecycle. A
`Session` references one; several sessions may share one; deleting the last session that references an
environment offers to remove it.

- Migration v5: `environments` table; `sessions.environment_id`.
- Existing sessions adopt a "primary checkout" environment for their space — **no user-visible change on
  upgrade**. The migration runs against a real home with real data; hand-write the v4 fixture rather than
  replaying migrations (a fixture derived from the code under test agrees with any mutation of it — this cost
  a workstream in Plan 6).
- `Session.cwd` becomes derived from the environment rather than stored, or is kept as a cache with the
  environment authoritative. Pick one and state which.

## W2 — Worktrees and port blocks

- `git worktree add` per environment, under a Realm-managed directory; branch named from the session title.
- A **port block per environment** (Conductor's pattern: a base port plus nine), exported into the agent's
  and terminal's env as `REALM_PORT_BASE` and friends, so three agents running `pnpm dev` do not all want
  `:3000`. This is the single highest-value thing in the plan for daily use.
- Removal is the dangerous half: never `git worktree remove --force` a dirty tree without asking, and never
  delete a branch with unpushed commits. Surface both.

## W3 — The diff pane and a git write path

- A diff pane fed by `git diff`, per environment, with per-file staging.
- Commit, push, and open-PR as **one action** with an editable message, not three chores.
- The branch and diff chips already in the prompter become the entry point.

## W4 — Checkpoints

Per-turn checkpoints stored as **hidden git refs**, reverting both the workspace and — where the adapter
supports it — the provider conversation. T3 Code is open source and does exactly this; read it rather than
reinventing. This is what makes an agent safe to let run.

## W5 — mac-cli as a skill (half a day, do it early)

Realm's agents are external CLIs with their own tool systems, so "give Realm a tool" and "give the agent a
tool" are different problems. mac-cli wants to reach the *agents*: a skill describing the binary, its `--json`
output, and its exit codes (0 success, 1 not found/bad input, 2 permission denied), plus ensuring it is on the
PATH of spawned sessions. No pane, no adapter, no RPC.

## W6 — MCP gateway

This is what actually delivers "connect external gateways". A `packages/mcp` that manages MCP servers per
space, with `https://mcp.vercel.com` as one row in a list rather than a bespoke Vercel integration. Also the
delivery vehicle for simulator control (an iOS-simulator MCP already exists on this machine) — which is why
the simulator pane is deferred rather than built.

## W7 — Browser pane

Only after the above. Architecture, per the technical brief:

- `BaseWindow` + two `WebContentsView`s (React UI, agent browser), the browser on a `persist:agent` session so
  it never touches the user's daily-driver profile.
- Driven entirely through `webContents.debugger` in flatten mode. **This opens no debugging port**, which is a
  real security advantage over every external-Chrome approach, and `Input.dispatchMouseEvent` this way does
  **not** require window focus — unlike `sendInputEvent`, which documents that it does.
- Legibility: fused `DOMSnapshot` + `DOM` + `Accessibility`, filtered to interactive elements, with a
  screenshot tool the model may call when the snapshot is ambiguous and one attached automatically on action
  failure. Filtered AX costs roughly 0.3–1× a screenshot in tokens; the win is determinism, not size.
- Permissions: copy Claude Code's split — read-only calls run free, state-changing calls prompt, an otherwise
  read-only call still prompts when it sets a mutating flag, and a batch runs unprompted only if every action
  in it is read-only. OAuth consent screens get a hard block, not a prompt.
- "Use my real Chrome" ships later as an explicit opt-in against Chrome 144's `--autoConnect` consent flow.
  Never the copy-the-default-profile hack.

**Two spikes before committing to W7, each under an hour:** does `Accessibility.getFullAXTree` return a
populated tree via `webContents.debugger` without `app.setAccessibilitySupportEnabled(true)`, and does
`Page.startScreencast` work against a `WebContentsView`. Neither could be confirmed from primary docs.

**The known tax:** `WebContentsView` is a native view with insertion-order stacking and no z-index, so React
overlays — the command palette, menus, sheets, tooltips Plan 6 just built — **cannot paint over it**. Either
design the pane so nothing overlays it, hide-and-swap a `capturePage()` still when a modal opens, or stream
`Page.startScreencast` into a canvas and give up native frame rate. Decide this before writing code.

---

## Explicitly dropped

- **Vercel Sandbox** — Claude Code and Codex ship kernel-enforced Seatbelt sandboxes already. The gap is a
  policy UI, not a sandbox. Adopting it means shipping repos to Virginia to run tests more slowly.
- **Vercel Connect** — an OAuth token broker needing a 12-hour OIDC token and a Vercel project. Non-starter
  for a desktop app with no accounts.
- **Vercel REST API / CLI as an integration** — no user problem it solves that a terminal does not.
- **Simulator pane** — measured on this machine: `simctl` screenshots take 0.5–0.7s (~2fps, not the spec's
  5–10), degrading to 63s under contention; `simctl` has no input verbs at all; `recordVideo` writes zero
  bytes until SIGINT so it cannot be streamed; and Xcode 27 removes Simulator.app in favour of Device Hub,
  killing window capture. Use the existing MCP.
- From the old §12 roadmap: **artifact marketplace**, **Windows/Linux**, **computer use**.

## Reordered

Mobile drops from first to sixth — pairing (`npx t3 pair --tailscale` is the shape) before a native client.
Multi-agent rises to fourth, as an MCP gateway concern rather than a bespoke orchestrator.

## Deferred but not dropped

**AI Gateway / custom provider endpoints.** `ANTHROPIC_BASE_URL` genuinely can front the CLI agents, and the
generic pattern (OpenRouter, LiteLLM, Bedrock, Vertex) is worth four days — later. For a Max subscriber it
means paying per token instead of flat rate, so it is a power-user setting, not a default.

## Execution notes

Sequential implementers only. Gates: `SHELL=/bin/bash pnpm vitest run` (one pty test flakes under zsh),
`pnpm -r typecheck`, `pnpm -r build`. No `lint` script exists. Mutation-grade throughout — the standing
finding on this project is *code right, tests weak*. Commit before mutating: `git checkout --` restores from
HEAD and silently wipes uncommitted work. The user's dev server runs from this repo on 5173/8787; never kill
it, and use different ports for scratch instances.
