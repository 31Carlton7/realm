# Realm Plan 11 — The browser pane and browser agents

> Numbered 11: 9 is the merged Beautiful UI plan; 10 is reserved for the gateway session's rename of its
> MCP-gateway plan. Grounded in `specs/2026-08-28-capability-research.md` (browser brief + the 2026-08-31
> spike addendum). Both load-bearing unknowns are resolved: `Accessibility.getFullAXTree` populates via
> `webContents.debugger` with NO global a11y switch, and `Page.startScreencast` works on a `WebContentsView`
> (visible-only — a hidden window emits one frame and stops).
>
> **User decision:** the overlay problem is solved by LAYOUT — nothing ever paints over the browser view.

## Architecture (settled by research + spikes)

One `WebContentsView` per browser pane, on a `persist:browser` session partition (never the user's daily
Chrome; they log in once inside Realm). Driven entirely by `webContents.debugger` in flatten mode from
Electron **main** — no debugging port exists, input works without window focus, AX legibility is free.
Screencast-into-canvas is NOT used (visible-only, and the no-overlay layout removes its reason to exist).

Ownership: the view and CDP live in Electron main. realm-server reaches them over the existing main↔server
channel, and exposes the tool surface to agents as a built-in MCP server through Plan 8's per-session
`mcpServers` plumbing — which all three agents already consume (Cursor's MCP verified live). **Coordination
point:** the gateway session's in-server Streamable HTTP gateway is the natural transport for this once it
lands; W3 should ride it rather than invent a parallel endpoint.

## W1 — The pane

- A `browser` item kind: DOM placeholder in the pane grid, bounds synced to the native view
  (ResizeObserver + rAF; `setVisible(false)` during animated layout transitions, restore on settle —
  the research's mitigation for bounds lag).
- DOM chrome ABOVE the view (address bar, back/forward, reload, spinner, origin display) — the view's
  bounds start below it. All chrome controls are **inline buttons, no dropdowns** (see W2).
- Navigation guards: `setWindowOpenHandler` deny, `will-navigate` allowlist check, `Fetch.enable` +
  `failRequest` for subresources — as guardrails against agent mistakes, explicitly NOT a security
  boundary (DNS rebinding/redirects bypass it; documented stance).
- Per-space origin allowlist stored like MCP servers; default posture decided in W2 of settings (Connections
  tab gains a Browser section).

## W2 — The no-overlay layout (the user's chosen design)

The invariant: **no floating surface may intersect a browser view's rectangle.** Enforced by one shared
positioning primitive, not per-callsite discipline:

1. A layout-store selector exposes `browserRects[]` (live bounds of every browser leaf).
2. The anchored-popover primitive (menus, pickers) and the centered-surface primitive (palette, sheets)
   position within the **complement**: palette and sheets center over the widest non-browser column
   (sidebar + non-browser panes); anchored menus flip/slide along their anchor edge until clear.
3. Browser-pane chrome has no dropdowns at all — its controls are inline toolbar buttons, so nothing ever
   needs to open "over" the view from its own header. The pane ⋯ menu is replaced by toolbar buttons.
4. **The degenerate case** (browser pane near-fullscreen, complement too narrow for a sheet): the layout
   MOVES instead of overlaying — opening a sheet snaps the browser leaf to ≤50% split for the sheet's
   lifetime and restores on close. Instant, not animated (resize is on the do-NOT-animate list).
5. Mutants that must die: a sheet centered over a browser rect; a menu flipping INTO the view; the snap
   not restoring; the invariant silently skipped when two browser panes are open.

## W3 — The agent tool surface (an MCP server every agent gets)

> **Built (2026-08-31), one transport amendment:** the Plan 9 gateway merged first, so `realm-browser`
> ships as an **in-process provider on the MCP gateway** (`RealmToolProvider`, mounted in
> `apps/server/src/mcp/gateway.ts`) rather than its own MCP server entry — agents reach it through the
> one `realm` endpoint they already connect to, as `realm-browser__browser_*` tools. The mount point is
> the gateway, not the hub, because the permission model needs the CALLING session's identity and the
> hub is deliberately session-blind. Per-space off switch: `mcp.setProviderEnabled` (default ON —
> Realm's own code under Realm's own permission flow). CDP executes in Electron main
> (`browser-agent*.ts`), reached over targeted `browserHost.op`/`browserHost.result` frames on the
> existing RPC socket. Live-check-found constraint: an occluded window's `WebContentsView` drops all
> synthetic input after any cross-process navigation until a compositor frame exists, so main carries
> `--disable-backgrounding-occluded-windows`.

Realm-owned toolset `realm-browser`, auto-present in every session's tool surface (per-space
disableable). Tools, designed from the browser brief's evidence:

- **`browser_snapshot`** — the legibility core: one fused pass (`DOMSnapshot.captureSnapshot` +
  `DOM.getDocument({pierce:true})` + `Accessibility.getFullAXTree` + `Page.getLayoutMetrics`, fired in
  parallel), filtered to interactive + visible elements with paint-order occlusion (the check naive
  implementations miss), `getEventListeners` sweep for div-soup sites, refs = **backendNodeId** (stable;
  never frontend nodeIds), `*[new]` markers on elements changed since the last snapshot, values capped,
  passwords never included. Filtered AX costs ~0.3–1× a screenshot in tokens; the win is determinism.
- **`browser_read`** — page text (article-first), console, network summaries.
- **`browser_act`** — click/type/key/scroll by ref: three-event clicks (move→press→release), full key
  events for React inputs, `insertText` only where key events are not needed. Coordinates accepted only
  from the vision fallback.
- **`browser_navigate`**, **`browser_screenshot`** (on demand; attached AUTOMATICALLY on any failed act —
  where vision pays for itself), **`browser_batch`** (unprompted only if every action inside is read-only).
- **Permission model = Realm's existing one.** Read-only tools run free; mutating tools raise
  `permission_request` through the normal session flow (the ApprovalCard the user already knows). Hard
  blocks, not prompts: OAuth consent screens, downloads, and typing into `type=password` fields — those
  pause and hand to the user. High-risk categories refused outright.
- Injection stance: page content is data; snapshots are delimited as untrusted; the action, not just the
  input, is what gets screened. Navigation/post targets may never come from page content.

## W4 — Watching the agent

The user watches natively at full frame rate for free (that is the point of the architecture). Add:
in-page action highlights injected via `Runtime.evaluate` (a ring around the element about to be clicked —
inside the page, so no overlay violation), an action ticker in the DOM chrome ("clicked *Submit*"), and
the pane's status dot riding the existing session-status plumbing.

## W5 — Browser agents (see the companion explanation in the plan's PR/report)

A dedicated **browser-agent session kind** composed from existing Plan 8 pieces: a Realm-spawned agent
session whose skills injection carries a browsing playbook skill, whose `systemContext` (memory seam)
carries the browsing policy, whose `mcpServers` contains ONLY `realm-browser` (+ the task's allowlist),
and whose permission mode maps mutating browser tools onto ApprovalCard. Exposed to a parent session as
one MCP tool: `browser_agent_run(goal, constraints)` → the parent's transcript shows one tool call; the
browser agent's full trace is its own session pane the user can open. Per-origin site playbooks accumulate
as skills (`~/Realm/skills/site-*`), which the mention/skills system already loads.

## W6 — Live verification

Real sites, including a JS-heavy SPA and a div-soup page; the permission flow driven end to end; the
allowlist proven to block; the no-overlay invariant driven through every floating surface with a browser
pane at every layout position. Mutation-grade on guards (password block, OAuth block, allowlist,
read-only gating of batch).

## Out of scope

Attaching to the user's real Chrome (later, as an explicit opt-in via Chrome 144 `--autoConnect` only),
extensions inside Realm (`chrome.debugger` unsupported in Electron), video recording, multi-profile
browser contexts.
