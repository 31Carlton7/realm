# Realm Plan 13 — Orchestration: Realm becomes the coordinator

> The strategic build: everything plan-scale done for Realm so far (sequential implementers, briefs,
> reviews, merges) happened outside Realm. The embryo exists: `browser_agent_run` is a delegated,
> permission-scoped, watchable sub-session. Generalize it. Prerequisites all merged: gateway providers,
> per-session toolsets, notifications, scoping, environments.

## W1 — `agent_run`: general delegation
The `realm-agent` provider gains `agent_run(goal, constraints?)` beside `browser_agent_run`:
`constraints = { agentKind?, environmentId? | newWorktree?, permissionMode?, maxTurns?, timeoutMs?, skills?: string[] }`.
A real session in the caller's space (visible, watchable), full normal toolset (its space's MCP + skills —
NOT the browser-only restriction), running in the named environment or a fresh worktree (Plan 7's seam).
Safety lines carried over verbatim: **bypassPermissions never inherited** (cap = min(parent, requested));
recursion depth-1 (a child sees neither `agent_run` nor `browser_agent_run`); parent interrupt cancels;
result = fenced final text + child session id/title; settle/cancel ordering per W5-p11's fix.

## W2 — Background dispatch + the task queue
- **⌘⇧↩ "dispatch"** in the composer: create-session(+optional worktree)-and-send in one gesture WITHOUT
  focusing the new pane — the user keeps typing where they are; the notifications feed announces settle
  (already built). Palette: "Dispatch task…".
- A **Tasks view** on the space page (new tab): rows = sessions born by dispatch/agent_run — goal, status
  dot, environment, started/settled, jump. Data = existing sessions + a `dispatched` origin marker
  (contracts enum on the session row; migration). No new runtime — it is a lens, not a scheduler.

## W3 — The reviewer recipe
- **"Request review"** on the diff pane: spawns a reviewer session over the SAME environment (read-only
  permission mode) with a refutation prompt (the house discipline: verify claims against the diff, hunt
  the named mutant classes), streams into its own pane, and its final verdict lands as a notification +
  a `review` block appended to the diff pane (verdict + findings, fenced as agent output).
- `agent_review(environmentId)` on the provider so a parent AGENT can request review too (same depth-1).
- No auto-merge, ever: review informs the human's ship click; the plan bans wiring review→ship.

## W4 — Coordinator live pass
Parent dispatches a real task into a worktree, watches via Tasks, reviewer refutes a planted bug, ship
stays human. Mutants: bypass cap, recursion, dispatch-not-focusing, review read-only, queue lens showing
foreign spaces.
