# Realm Plan 25 — Watchable machines: a visible cursor, a controlled-screen frame, and machines you can connect

> Numbered 25: 24 (inline UI) is the highest on this branch. Renumber on landing if it collides with
> another session's in-flight plan.

> **Status (2026-09-10): W1–W7 built.** Every spike below was RUN, and the results are recorded in
> "Spikes, resolved" near the bottom rather than left as questions. Two things changed under
> measurement and the plan text above them has been left as written, with the correction beside it:
> `machine-pane-live.mjs` found that the relay forwarded the client's own handshake into the
> machine's message stream (a correctly-sized black canvas, green suite), and noVNC's own
> `scaleViewport` turned out to be required rather than forbidden.

## Context

Realm drives things the user cannot watch. `browser_act` dispatches real CDP mouse events at real
coordinates (`performAct`, `apps/desktop/src/main/browser-agent.ts`), but the only evidence is a status
dot, an inline ticker, and a ring that flashes for 900 ms — you can read that a click happened, you
cannot see it happen. Computer use is worse: `AxHelper.swift` captures a window with ScreenCaptureKit
and posts real `CGEvent`s, and the JPEG goes **only to the model**. No renderer surface shows it; the
only human signal is a `Driving <App>` menu-bar item.

And there is nothing to watch on. Realm has never embedded a streamed display — no VNC, RDP, SPICE,
QEMU, `Virtualization.framework`, `desktopCapturer`. The one precedent is the iOS-simulator skill,
where an *external* daemon serves a page on localhost and a browser pane is pointed at it.
`ItemKindSchema` carries an unused `"simulator"` member that `Icon.tsx` already maps — a reserved slot
nothing fills.

This plan closes both gaps: a `machine` pane that shows and drives a remote screen — a local VM,
another Mac at an address, a container, this Mac — reachable from a button beside the session and from
the agent itself; plus one honest visual language for "something is being controlled" covering the
browser, the simulator, and every machine.

Outcome: click one button beside a session and get a pane with the connect flow ready; connect your
other MacBook by address and watch an agent work on it; boot a guest whose blast radius is a disk
image; and in all three cases see a real cursor moving and a framed screen that says it is being driven.

## Decisions

- **QEMU is the VM engine, detected rather than shipped.** Not UTM automation (hard dependency on
  another app's scripting surface), not `Virtualization.framework` (cannot boot Windows at all), and not
  bundled — QEMU is GPL-2.0 and shipping it inside a signed, notarized proprietary `.app` takes on
  source-offer obligations every release. Verified here: Homebrew `qemu` 10.2.0, `hvf` and `tcg`,
  `virtio-gpu-pci` / `virtio-tablet-pci` / `usb-tablet`, `edk2-aarch64-code.fd` and
  `edk2-x86_64-code.fd` under `/opt/homebrew/share/qemu/`, and QMP carrying `screendump`,
  `input-send-event`, `snapshot-save/load`, `system_powerdown`, `query-status`. Where QEMU is absent the
  source is **not in the picker at all** — design.md: "Where the owner has said nothing, show nothing —
  not a disabled control."
- **The screen is a DOM `<canvas>`, not a native view.** `@novnc/novnc@1.7.0` decodes RFB in the
  renderer: zero runtime dependencies, 635 KB unpacked, single-entry exports map. This is the
  highest-leverage choice here — a `WebContentsView` composites above all DOM unconditionally, which is
  why the browser pane has no dropdowns and why `state/no-overlay.ts` exists. A canvas has none of that
  tax, so menus, sheets and the palette open over a machine screen, and **a CDP screenshot is valid
  evidence** for it — the inverse of design.md's warning about native views.
- **Realm relays the pixels.** The renderer CSP already permits `connect-src ws://127.0.0.1:*`, so no
  CSP change either way. QEMU's `websocket=` is confirmed compiled in (`vnc-ws-server-websock`,
  `Sec-WebSocket-Protocol: binary`), but a server-side TCP↔WS proxy is needed anyway for remote
  endpoints — so it is built first and QEMU's own WebSocket becomes an optimization, not a dependency.
  That moves the plan's biggest unknown off the critical path.
- **The renderer never holds a credential.** The proxy performs the RFB auth handshake server-side and
  hands the renderer a loopback socket gated by a one-time token in the URL — the shape
  `documents/preview.ts` and `index.html` already establish. `machineEndpoint()` returns a `wsUrl` and
  no password.
- **The cursor is the real input, never a re-enactment.** design.md forbids "simulated typing" and
  "theater about AI". On the browser and the simulator it must be injected *into the page*; on a
  machine pane it is a DOM overlay, positioned by the same arithmetic the real input uses.
- **Codex needs no new plumbing.** `McpGateway.realmProvidersFor` filters on session *role*
  (browser-agent child, reviewer child, delegation depth) and per-space enablement — never on agent
  vendor (`apps/server/src/app.ts:465–478`, `mcp/gateway.ts:164`). Codex sessions already receive
  `realm-computer` when a space enables it and will receive `realm-vm` on identical terms.
- **The agent can set a machine up itself**, as asked: `vm_connect` and `vm_create` exist and are gated,
  with the card naming what is actually being spent.
- **A remote Mac over VNC is pixels.** Driving it means coordinates through RFB, not the AX-tree indices
  `computer_act` uses. AX-grade control of another Mac needs Realm's helper on the far side — named in
  Phase 5 rather than implied now.

## Architecture

```
realm-server                       Electron main               renderer
─────────────                      ─────────────               ────────
MachineService  (row + item)                                   MachinePane
MachineManager  (qemu child, QMP)                              MachineHub ── RFB ──┐
MachineWsProxy  (/vnc/<token>/<id>, does the RFB auth) ◄─────── novnc canvas ──────┘
QmpDriver / RfbDriver  ← the AGENT's channel
BridgeDriver ──► browserHost.op ──► computerHost        (mac source only)
```

Supervision lives in realm-server, as the prior in-repo research settled
(`docs/superpowers/specs/2026-08-28-capability-research.md` §4). Main is needed for exactly one source:
this Mac, whose Swift helper and TCC grants belong to `Realm.app`.

**Two pipelines, never conflated** — the rule research states, made physical. The human's fast channel
is RFB over a WebSocket into the canvas. The agent's slow channel is a *different socket*: QMP over a
unix socket for `qemu`, a server-side RFB client for remote endpoints, the existing bridge for this Mac.
Neither can starve or evict the other, which is also why every QEMU gets `-vnc …,share=ignore` — the
default `allow-exclusive` lets a second client evict the first, and the human's view must never be
interruptible by the agent's.

**Secrets.** `apps/desktop/src/main/secret-store.ts` is explicit that one key leaves main — `oauth`, via
`oauthKey` — and that there is deliberately no sibling op for the `credential` key. A VNC password is a
third case: add `machine: 3` to `SECRET_DOMAINS` in `packages/contracts/src/secret-box.ts` (codes are
permanent — add, never renumber), a `machineSecretBox` mirroring `oauthSecretBox`
(`apps/server/src/mcp/oauth.ts:155`), and a `machineKey` op beside `oauthKey`. The server holds this key
because the server is what authenticates, for both the proxy and the agent channel. One deliberate
divergence from oauth: with no key available (no desktop app, a headless test) oauth degrades to
plaintext and `machine` instead **refuses to store the password at all** — an OAuth token is Realm's, a
VNC password is frequently the user's login. Realm-created VMs never touch this: loopback-bound,
`share=ignore`, and a fresh 32-byte per-boot secret at mode 0600, passed as `-object secret,…,file=…`
(never `data=`, because argv is world-readable through `ps`).

## Phase 1 — See the control: the cursor and the frame

Ships alone against the browser, which already has everything but the visuals, and defines the language
the machine pane reuses.

### The cursor

`performAct` already resolves `(x, y)` from `DOM.getContentQuads` immediately before dispatching
`mouseMoved` → `mousePressed` → `mouseReleased`. The visualization is those same coordinates, and
because a `WebContentsView` composites above all DOM, it must be **injected into the page over CDP** —
a third page-side artifact after the action ring and the element picker. Feature A therefore adds no
renderer component; it is main-process work in `browser-agent.ts` plus one accent line in the renderer.

**Appearance, as specified:** a white pointer with a one-pixel border in the primary accent and an inner
gradient in that accent falling to transparent — a mark that reads as lit rather than drawn. Sizing:
14 px, the `control` rung of the ladder documented in `Icon.tsx` ("a button's verb"), with a 2 px stroke
and a 3 px core so it reads at that size against arbitrary page content. Press contracts to **0.82**,
not the 0.96 design.md permits for controls, because 0.96 on a 14 px box is half a pixel — the same
failure the stylesheet already documents about "a 6px circle changing brightness by a third". Ratios are
chosen against the box, not copied.

**How it moves, and why not a path.** The truth is that all three events fire at the same point; the
page receives one instantaneous arrival and no intermediate `mouseMoved`. So a tweened arc is theatre
twice over: it depicts a traversal that never happened, and a hover menu the drawn path crosses does
*not* open, so the drawing and the page visibly disagree. That is the pointer's exact equivalent of the
simulated typing design.md bans. The mark therefore **swaps position** — a straight interpolation on
`--dur-swap` (160 ms, "one thing replacing another") with `--ease-out-strong`, deliberately not
`--dur-move` ("something travelling across the pane"), because naming it travel would put the lie in the
tokens instead of the pixels. Nothing is drawn at any intermediate point: no trail, no afterimage, no
ripple. Both endpoints are coordinates the input actually used.

The mark is placed **before** the dispatch and the host does **not await** the interpolation — the same
ordering already accepted at `browser-agent-host.ts:292` (ring, then act). So there is no added latency
per click, and the **press flash** is what marks the moment rather than the arrival. First placement has
no previous point, so the injected script sets position with `transition:none`, forces one reflow read,
then enables the transition, and the first appearance is a fade at the point on `--dur-enter` (180 ms);
transitioning from `(0,0)` would fabricate a sweep from the corner, and that is a real bug source with a
test. **No idle motion of any kind** — the mark does not breathe, blink or drift when nothing is
happening.

**Per action** — a new pure `cursorTargetFor(action)` beside the existing `highlightTargetRef`:

| action | ring (today) | cursor | press form |
|---|---|---|---|
| `click` | yes | yes, at the quad centre | contract to 0.82 for `--dur-press`, repeated `clickCount` times |
| `type` | yes | **no** | — |
| `key` | yes when `ref` set | **no** | — |
| `scroll` | no | **yes** — ref point, or viewport centre exactly as `performAct` computes it | the contraction plus two ticks on the side matching the **sign** of the delta; magnitude is not depicted |
| `download` | **yes** — it is a click through `performAct` | **yes** | as `click` |
| `fillCredential` | **no**, deliberately | **no**, same reason | — |

`type` and `key` dispatch no mouse event at all, so a pointer at that field would be the one outright
false thing this feature could draw. And note the correction: it is **`fillCredential`** that skips the
ring — "the one op where the page is about to receive a real secret — the moment to do the least in it,
not the most" — while `download` rings, because "a download is a click that happens to produce a file".

**The ring is not redundant, and the split proves it.** The ring says *this element*: quad-shaped,
outlives the click at 900 ms, and is the **only** honest mark for `type` and `key`. The cursor says
*this point*, and carries the press — the only mark for `scroll`, which has none today. On a click both
appear and do not read as two edges, because they differ in scale and only one moves. The ticker
(`.browser-ticker`) stays: it is the *record* — hoverable, timed, with a failure state — where the
cursor is the *live position*. The `driving` dot stays too: it is what tells you an agent is driving a
pane you are not looking at, which is why it is also on sidebar rows.

**Attribute discipline is the delicate part.** Everything today keys off `HIGHLIGHT_ATTR` set to `""`.
Give it a **value**: the ring writes `"ring"`, the cursor `"cursor"`. Then `buildSnapshot`'s element
filter is presence-based (~94–97) and covers the cursor with zero change, while
`REMOVE_HIGHLIGHTS_JS` and the pre-capture sweep (~220–222) **narrow to rings** — otherwise drawing a
ring deletes the cursor on every act, and a `browser_batch` snapshot blinks it mid-burst. While in here,
collapse both into one `markAct(send, action)` that resolves `DOM.getContentQuads` **once** and injects
both in a single `Runtime.evaluate`: fewer CDP round trips than today, and the at-act-time geometry rule
lives in one place so the ring's point and the cursor's can never diverge.

**Disappearance has three owners.** A dwell watchdog **owned by the page** (`CURSOR_IDLE_MS = 2000`,
reset on every placement, fading on `--dur-fast` and removing itself) so a dead IPC or a lost
`driving:false` can never leave a stuck pointer; navigation, which takes the DOM with it; and
`armElementPick`, which removes it explicitly, because two accent overlays chasing one pointer is the
failure. Align 2000 ms with `computer-driving.ts`'s `LINGER_MS = 1500` or write down why they differ —
that indicator already made the same coalesce-a-burst decision for the same reason.

**Reduced motion has one source: the page** (`matchMedia("(prefers-reduced-motion: reduce)")`), because
Chromium derives it from the macOS setting and a renderer flag would be a second way to disagree. Under
reduce the mark jumps — which is literally the event stream, so it is the *more* honest rendering — and
the press becomes a stroke/opacity change rather than a scale, following the precedent `styles.css`
already writes down for the ping: "Only the motion goes; the halo stays painted, because that is what
carries the state with no motion left to carry it."

**The user's own pointer is never tracked.** Reading `mousemove` would mean injecting a listener into
untrusted content for a cosmetic reason, which the picker's doc comment spends four bullets rejecting.
And the honest consequence to leave visible: the agent's `mouseMoved` really does steal `:hover` from
wherever the user was pointing. That is pre-existing in `browser_act`; the cursor makes it legible for
the first time. Do **not** block the user's input while an agent drives — that would be Realm lying
about who holds the wheel.

### The controlled frame

When an agent is driving, the pane's content is framed: an inset ring in the primary accent with a
gradient falling inward to transparent, a slow pulse, and small text at the bottom saying the screen is
being controlled.

**This is state, not decoration, and it has precedent.** design.md rejects "decorative pulsing", but the
app already pulses to say something is in flight — `styles.test.ts` asserts "the three in-flight states
share one ping, and its ring survives prefers-reduced-motion". The frame **joins that rule** rather than
adding a second animation, which is also what makes it survive reduced motion correctly: the ring stays
painted, the pulse goes.

**Where it is drawn differs by surface and cannot be unified away.** Browser and simulator panes are
`WebContentsView`s, so the frame and its label are injected into the page by the same mechanism as the
cursor. (Insetting the view a few pixels and drawing the ring in the gutter is tempting — design.md says
losing a hairline of page content is invisible — but resizing a view mid-drive reflows the page under
the agent's own coordinates. Rejected for that reason.) Machine panes are a canvas, so it is an ordinary
DOM overlay: same tokens, same timing, different transport. **The simulator needs no separate work** —
there is no simulator pane; a simulator is a browser pane pointed at `serve-sim`, so it inherits the
browser's frame for free.

**One shared artifact, and only one.** `apps/desktop/src/main/agent-cursor.ts` exporting
`AGENT_CURSOR = { size: 14, stroke: 2, core: 3, pressScale: 0.82, idleMs: 2000 }` — interpolated into
the injected string on one side, and read by `styles.test.ts` to assert `.machine-cursor` on the other.
The injected CSS is a template string in a `.ts` file, so `styles.test.ts` cannot see it directly; that
is why the numbers are a module and the parity assertion is the test. `showActionHighlight` already
demonstrates the gap by hard-coding `220ms`, `260ms` and `#4c8dff` inline. Anything more shared than
that number table is a false abstraction over two surfaces with different physics.

**Accent, first.** The ring is hard-coded `#4c8dff` while the picker reads live `--rl-accent`
(`BrowserPane.tsx:128`) — a live bug, and one design.md already names ("The blue accent is a
condiment"). Add `host.setAccent(browserId, accent)` through the bridge, read from the store's theme
state rather than a `MutationObserver`, and have main cache it per view for both the ring and the cursor.
This is the first slice to ship because it fixes a real defect and proves the plumbing.

**Mutants that must die.** `cursorTargetFor` returning a ref for `type` (a pointer at a field no mouse
touched) or `null` for `scroll` (the one act with no mark keeps having none). The scroll fallback point
diverging from `performAct`'s. The tick direction ignoring the delta's sign. Restoring the old
whole-attribute `REMOVE_HIGHLIGHTS_JS` (every act deletes the cursor it just placed) or widening the
pre-capture sweep (the cursor blinks on every batch snapshot). Changing the snapshot filter from
presence to `[attr=""]` (the agent starts seeing its own cursor as clickable). Feeding the cursor the
snapshot's cached rect instead of at-act-time quads. Removing the `catch` (decoration fails the act it
decorates). Adding `markAct` to the `fillCredential` branch. A cubic-bezier path or an `infinite`
animation appearing in the injected string. Inverting the `matchMedia` check. Dropping the watchdog
reset (the pointer dies mid-burst) or the timeout itself (a lost broadcast leaves it forever). Deleting
`armElementPick`'s removal. Restoring the hard-coded blue. And, guarding Phase 2:
deleting `{ role: "appMenu" }` from `installMenu`'s template, which is what keeps ⌘Q away from guests.

**Live check** `apps/desktop/scripts/agent-cursor-live.mjs` is not optional here, because design.md is
explicit that "a CDP screenshot renders the DOM only, so a native view over the surface under test is
simply absent from it". Boot the real app on a locally served page, drive `browser_act` over the bridge,
and sample a **real screen capture** to prove the mark is painted inside the view's rect, at the
element's centre within a pixel, and gone after `CURSOR_IDLE_MS`. Model it on `element-picker-live.cjs`,
which already documents that a synthetic click without a preceding move does not test this code.

## Phase 2 — The machine pane, the connect flow, and its entry points

A viewer and a control surface with no VM engine — usable the moment you have an address, which includes
your other MacBook (macOS Screen Sharing is RFB on 5900). Shipping this before QEMU is deliberate: it
settles every geometric and keyboard question before any supervision work exists.

**Contracts and registration.** New `packages/contracts/src/machine.ts`: `MachineSchema`,
`MachineSourceSchema` (`qemu | vnc | mac | container`), `MachineStatusSchema`
(`off | booting | running | suspended | failed`), `MachineStateSchema`, `VmActionSchema`. Add
`"machine"` to `ItemKindSchema` (`entities.ts:57`) immediately after `"browser"` — its sibling, a live
remote surface with a durable row behind it — and **do not reuse `"simulator"`**, which `Icon.tsx`
already maps to a phone and which `device-ax.ts` and the picker's device branch speak about
specifically. A VM is not a phone.

**Icons, and a live bug to fix on the way.** Add `machine: ComputerIcon` (a monitor on a stand; not
`LaptopIcon`, which is taken and means *this* Mac). And note that **`agents-page` has no key at all** —
verified: `schedules-page` is present, `agents-page` is not, and `Icon.tsx:130` falls back to
`icons.folder` silently, so the Agents page wears a folder in the sidebar and pane bar today. Add a new
`packages/ui/src/icon.test.ts` asserting **every** `ItemKindSchema` member has an `icons` key. That is
the highest-value new test in the plan: it converts a whole class of silent visual failure into a red
suite, and it kills the `agents-page` bug as a side effect.

**Migration v26**, appended to `apps/server/src/db/migrations.ts` where the array index *is* the version.
Two choices worth the comment: **no `status` column** — status is a fact about a process, no process
survives a restart, and a column would have to be rewritten to `off` at every boot and would be a lie
the moment a VM was killed while the server was down (this is why `terminals` has none either); and
**`vnc_port` / `ws_port` are per-run**, cleared on stop and by `restoreAll`, each under a
`CREATE UNIQUE INDEX … WHERE … IS NOT NULL` — migration v6's trick, since SQLite treats NULLs as
distinct, so many stopped machines coexist and the no-overlap invariant lives in the schema rather than
the allocator's care. Deliberately the opposite of `environments.port_block_start`, which is permanent
because a dev server left running should keep its port. Per-space config goes in `settings`, no
migration: `machine.allowedMachines:<spaceId>`, `machine.catalog`, `machine.qemuPath`.

**Disk layout** under `<realmHome>/machines/` — `<machineId>/{disk.qcow2, nvram.fd, vnc.secret,
qmp.sock, qemu.log}` and content-addressed images at `images/<sha256>.{qcow2,iso}` with a JSON sidecar.
Not in the space's project folder — the deliberate opposite of `DOWNLOAD_DIRNAME`, because a download is
the user's file and belongs where they see it, while a 20 GB image is Realm's infrastructure and inside
a git checkout is a hazard.

**Server pieces**, each after a template: `store/machines.ts` (`MachinesStore`, raw SQL + a `toMachine`
mapper, after `store/browsers.ts`); `machines/service.ts` (`MachineService` owning row + item + process,
after `terminals/service.ts`, with `create()` synchronous inside `BEGIN`/`COMMIT`/`ROLLBACK` and one
`items.changed` broadcast exactly as `BrowserService.open` does, port and image work in `start()`
outside the transaction — the split `terminals.create` already makes); and `machines/ws-proxy.ts`, a
loopback `WebSocketServer` (`ws` is already a server dep via `rpc/server.ts`) piping each connection to
a TCP socket, performing the RFB auth server-side, with `documents/preview.ts`'s exact security shape —
a per-boot token as a **path segment**, `timingSafeEqual`, bound to `127.0.0.1`, every old URL dead at
the next boot.

**RPC.** `machines.capabilities / create / list / get / update / start / stop / suspend / resume / reset
/ close / endpoint` plus `machines.images.{list,download,cancel,import,remove}` in `Methods`, registered
with `reg(...)` in `rpc/methods.ts` with `machines` added to `Deps`, a `machine` case in the
`items.delete` switch at ~454, and `closeAllInSpace` wired into `spaces.delete` at ~121. Events:
`machine.status` (carrying `wsPort`, so the renderer never re-`get`s after a start), `machine.action`,
`machine.driving`, `machineImage.progress`. **No secret rides any event** — broadcasts reach every
client including main.

**Renderer.** `panes/machine/{MachinePane.tsx, machine-hub.ts, machine-client.ts, fit.ts}`.

- **The hub is not optional.** `PaneHost.tsx:144` does not render panes in inactive pane groups at all,
  so a machine pane *will* be unmounted while its machine runs. Follow `terminal-hub.ts` closely: a
  module-level hub owning one `RFB` per machineId plus its container div (noVNC builds its canvas inside
  a container exactly as xterm builds inside a host, so the move-the-host-element trick works
  unchanged), `attach`/`detach` where **detach does not disconnect** — the RFB stays connected and keeps
  decoding, so a machine you come back to shows the current screen rather than a reconnect — a
  `MachineFactory` seam so no test ever loads `@novnc/novnc`, and `isConnected`/`onConnect` in place of
  `hasData`/`onFirstData`. Copy `scheduleViewRelease`/`cancelViewRelease` from `browser-client.ts` with
  its comment adapted (React double-mounts, a leaf reparent must *adopt* rather than blink); six lines
  twice is cheaper than an abstraction nobody can name. **There is no `MachineBuffer`** — a framebuffer
  is a current state, not a stream to replay, and RFB already holds the latest pixels: the canvas *is*
  the buffer. Write that down as a decision, not an accident.
- **`fit.ts` is pure, and it is where the real bug lives.** noVNC sizes its backing store to the
  framebuffer and CSS-scales it, so the ratio must be computed in **device** pixels and the CSS size set
  in CSS pixels, or Retina users get a soft screen for no reason:
  `scale = min(rect.w*dpr/fb.w, rect.h*dpr/fb.h)`, `style.width = fb.width*scale/dpr`. Plus one rule
  worth having: snap `scale*dpr` to the nearest integer ≥ 1 **when doing so still fills ≥ 92 % of the
  box**, because an integer device ratio is what makes guest text sharp. The inverse
  `toFramebuffer(clientPoint)` lives beside it with a **round-trip property test** across mode × DPR ×
  aspect — the same arithmetic decides where a click lands, and a scale/unscale pair that disagree is a
  pane that clicks in the wrong place. Re-derive on `ResizeObserver`, on DPR change
  (`matchMedia("(resolution: Ndppx)")` — there is no DPR event), and on the guest's own resolution
  change.
- **`view-sync.ts` does not transfer, and saying so is the biggest simplification here.** Every flag in
  `ViewSyncFlags` exists because a native view's bounds trail the DOM. A canvas has no bounds to sync,
  cannot paint outside its box, and moves with the layout because it *is* the layout. So there is no
  `shouldShowView`, no `SETTLE_MS`, and **the machine pane registers no `browserRect`** — as a comment
  and as a test, because adding one would make the palette and every sheet start dodging a pane that
  composites nothing.
- Then: `registerPane("machine", MachinePane)`; `paneMeta.machine` (state word + the guest's live
  resolution in mono, plus the scale as a percentage when it is not 100 %, because a user reading small
  text needs to know whether they are looking at a resampled image) and `paneActions.machine` (**two**
  inline stateful toggles, Power and Grab keyboard, wearing `data-on` like `focusToggle` does);
  `machineState` / `machineError` / `machineImageProgress` in `state/store.ts` with `applyMachineState`
  copying `applyBrowserDriving`'s shape including its no-churn guard; the `Api` seam and `live-api.ts`
  one-liners; `.machine-*` in `styles.css`; `CommandPalette.tsx:251` (memo deps need no change);
  `SpaceHeader.tsx:44`.
- **No second bar.** `.browser-chrome` exists only because a native view forbade dropdowns and forced an
  address bar's controls inline. A machine has no address bar, so `PanelBar` is its only bar and its ⋯
  menu carries Scale, Send key ▸, Clipboard ▸, Snapshot, Reveal disk image, Delete. One bar per pane is
  design.md's "pane bars stay compact and consistent across pane kinds", finally achievable.
- Styling notes that carry reasons: the letterbox ground is `--rl-terminal-bg`, not `--canvas`, because a
  guest desktop is arbitrary and must not fight a near-white surround in light mode (the ruling
  `.terminal-pane` already writes down for itself); the canvas wears `var(--shadow-hairline)`, the
  one-device-pixel inset outline every screenshot in the app wears, which is what stops a pale guest
  bleeding into the letterbox; `image-rendering: pixelated` appears **only** under
  `[data-scale="actual"]`; and no hairline between the bar and the screen — the same argument
  `.browser-chrome` makes about a line along an edge that is already the strongest tonal step.

**`PanelBar.tsx` needs zero edits, and that is the tell.** `machine` joins neither `PAGE_KINDS` (it has
a real row, not a sentinel) nor `DELETES_ON_CLOSE`. design.md puts the `×` "exactly where an object
outlives its pane", and a disk image, an installed OS, a suspended RAM state and a network config
outlive the pane more emphatically than anything currently in that set. So the `×` is a plain
layout-only close, and Delete lives in the ⋯ menu — where `confirmFirst = !PAGE_KINDS.has(kind)` at
`PanelBar.tsx:70` already gives it the two-step **for free** — and **names what it destroys**: "Delete —
removes the machine and its disk image (12.4 GB)". The brief's counter, that a running VM is something a
stray click would cost you, is a rule about the confirm step, not about which control closes: closing
costs nothing because the machine keeps running while unmounted. The one honest risk — a running VM
whose pane is closed is invisible compute — is the sidebar's job, and `browserDriving` set that
precedent: the row wears its dot with no pane open. No banner.

**States get shapes, not five hues** (design.md: "readable without color alone"). Reuse the existing dot
vocabulary where the semantics match (`running` → `running`, `failed` → `error`) and add exactly three
values where they differ: `booting` (accent + fast ping, joining the ping family rather than borrowing
`driving`, whose CSS comment says it means an agent act is in flight); `off` (declared explicitly so a
typo cannot silently render as "off"); and `suspended` as **a ring, not a disc** — the one genuinely new
dot form in the app, and it earns itself, because `off` and `suspended` are the only pair with no hue
available to separate them, so the difference has to be a shape. Words in the accessible name are plain
and in sentence case — "starting up", "suspended", "failed to start" — not QEMU's "powered on"/"halted".

**Pane bodies, one per state.** `off`: the name, one line of exact fact in mono
(`Debian 13 · 4 GB · 40 GB disk`), one accent Start, and — only with an ISO attached — one quiet line
naming what first boot does. Nothing else; a first-run screen is a decision, not an inventory.
`booting`: **the framebuffer itself, the moment there is one** — a VNC server answers before the guest
OS is up, so the canvas shows real firmware output, which beats any indicator because it *is* the
machine; before RFB connects, one "Starting…" line with the app's one `.spinner` and, after ~8 s,
whatever concrete reason the server can name. **No progress bar for booting** — there is no measurable
fraction, and "where a figure genuinely cannot be stated, draw nothing at all rather than an empty
meter, which is itself a claim". `failed`: heading, the server's reason **verbatim**, the exact command
in mono when it was a spawn failure, the last ~8 stderr lines in a collapsed mono well, and Try
again / Open the log — `machineError` exists precisely because the state alone is a dead end.
`downloading`: a **determinate** bar, because here the fraction is real.

### Entry points — the button the user asked for

The cluster is `SessionPanelActions` in `panes/session/SessionPane.tsx:56` — summary, terminal,
documents, browser — rendered in the session pane's bar via `paneActions`. Add `SessionMachineButton`
immediately after `SessionBrowserButton`, on the reasoning that button's own comment gives: a browser
"takes no precondition and is always offered" because it is a place you go, and so is a machine. It
calls `newMachine(null, true)` — beside, not instead — and the pane opens with the connect flow already
focused, which is exactly "clicking it opens up the pane with the connection flow ready to go".

Say plainly what does not exist: **there is no simulator button** to sit next to. `simulator` is a
reserved kind with no registered pane; a simulator today is a browser pane pointed at `serve-sim`. The
cluster gains one button, not two. (`SpaceHeader`'s menu also has no "New browser" today, so adding
"New machine…" makes it inconsistent about browsers — pre-existing, flagged, not silently expanded.)

**The connect flow is the pane's body, not a sheet.** That is what the user asked for, and design.md
agrees for the same reason: "Empty panes should offer the shortest honest path to useful work", and
there is nothing behind a sheet worth preserving. One form component, one home — the palette and
`SpaceHeader` routes create the pane too rather than opening a second copy in a modal. It offers, in
order of how likely each is to work right now:

- **Another Mac** — an address, port defaulted to 5900, optional password, and one line: "Realm connects
  from this Mac; the agent never receives the password." Its own row rather than buried under "VNC",
  because that is how the user thinks about it, while the transport underneath is the ordinary `vnc`
  source.
- **A VNC address** — anything else: a cloud sandbox, a container someone else started.
- **A Linux VM on this Mac** — Phase 3, and **absent entirely** when `QemuLocator` reports nothing.
- **This Mac's screen** — Phase 5, and offered **only when it is honest**: mirroring the only display
  into a pane *on* that display is a hall of mirrors, so it appears only when there is a second display
  or as a single-window capture of an app from the list `computerListApps` already returns.

**The image download does not block the form.** Pressing Create with an image not yet on disk creates
the row and shows the pane immediately, and the pane's body becomes the download state — name,
determinate bar, byte counts in tabular mono, Cancel — advancing to `booting` on its own. The user can
close the pane, switch spaces and come back, because the download is the server's and the pane is a view
of it. That is the same "the pane is a window onto a process that outlives it" property as the terminal
hub, and it is what makes the ×-not-trash decision hang together.

**No `machine-page`.** Full settings (CPUs, disks, shared folders, network, snapshots) are a page's
worth of content and building one for four fields is the inventory failure. Name it as future work so
nobody builds half of one now.

### Keyboard, pointer, clipboard

**⌘Q can never reach the guest, and the guarantee is structural rather than a handler.**
`apps/desktop/src/main/index.ts:101–112` installs `Menu.setApplicationMenu` with `{ role: "appMenu" }`,
and **menu accelerators fire in main before the renderer sees the keydown** — `hotkeys.ts`'s own comment
states this for ⌘W and notes the fix there was to *remove* it from the menu. So there is nothing to
implement, and the pane must be honest that it *cannot* capture ⌘Q. Instead **Send key ▸** in the ⋯ menu
covers the chords the platform eats — ⌘Q, ⌘Tab, ⌘Space, ⌘H, ⌘W, ⌃⌥Del — via `rfb.sendKey` pairs, which
is what every remote-desktop client does. Reuse `parseKeySpec` and `MODIFIER_ALIASES` from
`packages/contracts/src/computer-use.ts:153` rather than inventing a second chord grammar.

**Grab keyboard** is an inline `data-on` toggle, default **off**: Realm's global hotkeys run on `window`
and `preventDefault`, so ⌘T opens a Realm terminal, and a Realm user's muscle memory is Realm's. On, the
pane adds a capture-phase listener that stops propagation of everything main did not already eat.
Because it changes what *every* key does it must be visible without opening a menu, which is why it is a
lit inline toggle. Two existing properties make the pane work with **no `hotkeys.ts` edit**, and both are
one line from breaking so both get tests: the `Escape` binding acts only when
`focusedItem.kind === "session"`, so Esc reaches the guest; and `isEditableTarget` returns false for a
focused canvas, so global bindings fire by default.

**Pointer: absolute, always. No pointer lock.** VNC's `PointerEvent` carries framebuffer coordinates by
protocol, and lock yields *relative deltas* VNC cannot carry — you would integrate them into a virtual
position that drifts against the guest's own pointer, the acceleration-mismatch bug every client that
tried this has. Lock also takes **Escape** hostage, and Esc is a key the guest needs. And design.md's
first priority is truthful system behaviour: a locked pointer silently desynchronised from the guest's
is the pane lying about where you are pointing. What is lost is relative-mode 3D in the guest; say
nothing about it. **One cursor, not two**: enable RFB's cursor pseudo-encoding so noVNC renders the
guest's cursor as a CSS `cursor:` on its canvas, replacing the Mac's arrow over the canvas. Do not
intercept wheel events (noVNC maps them to buttons 4–7 natively) and do not stop pointer events at the
pane boundary — a drag that leaves the canvas must still release the button in the guest.

**Clipboard: two explicit ⋯ actions, no automatic sync.** RFB's clipboard is latin-1 historically and
extended only where both ends speak the pseudo-encoding, so it must not pretend to be transparent. And
automatic Mac→guest sync would silently push whatever is on the user's clipboard into a VM that may be
running anything, which Realm's whole posture argues against. Send-then-⌘V is the two-step every client
uses. The incoming direction routes through main (`window.realm`) rather than `navigator.clipboard`, so
the pane never depends on gesture heuristics.

## Phase 3 — Local VMs on QEMU

`apps/server/src/machines/qemu-argv.ts` is a **pure** `buildQemuArgv(spec)` with no I/O, so every flag is
unit-testable — the split `browser-host.ts` makes against Electron.

arm64 guest, hardware-accelerated:

```
qemu-system-aarch64
  -machine virt,accel=hvf,highmem=on   -cpu host   -smp 4  -m 4096
  -drive if=pflash,format=raw,unit=0,readonly=on,file=<share>/edk2-aarch64-code.fd
  -drive if=pflash,format=raw,unit=1,file=<dir>/nvram.fd      # writable UEFI vars: boot order persists
  -drive if=virtio,format=qcow2,file=<dir>/disk.qcow2,cache=writeback,discard=unmap
  -device virtio-gpu-pci,xres=1280,yres=800
  -device qemu-xhci -device usb-kbd -device virtio-tablet-pci
  -netdev user,id=net0 -device virtio-net-pci,netdev=net0      # SLIRP: out only, nothing reaches in
  -object secret,id=vncpw,format=raw,file=<dir>/vnc.secret
  -vnc 127.0.0.1:<display>,password-secret=vncpw,share=ignore
  -display none
  -qmp unix:<dir>/qmp.sock,server=on,wait=off
  -name "<title>" -rtc base=utc  [ -cdrom <iso> -boot order=d ]
```

Five flags that will be missed and then needed: **`-vnc 127.0.0.1:<display>`, never `:<display>`** (the
bare form binds every interface and puts the guest's screen on the LAN — a security mutant with a test);
**`share=ignore`** (the default lets a second client evict the human's view); **`password-secret` via
`file=`** (argv is world-readable through `ps`); **`virtio-tablet-pci`**, because with only a relative
device QMP absolute coordinates are meaningless and every agent click lands elsewhere — the agent's
whole addressing model depends on it, so the argv builder asserts it rather than leaving it to a defaults
helper; and **`-qmp unix:`, not TCP**, because a unix socket has filesystem permissions while a QMP port
on loopback is an unauthenticated total-control channel with no token.

x86_64 guests use `qemu-system-x86_64 -machine q35,accel=tcg -cpu qemu64 -accel tcg,thread=multi` with
`edk2-x86_64-code.fd`, `-smp 2` (TCG scales badly; more vCPUs mostly add lock contention) and
`virtio-vga`. They run 10–30× slower than native, the row records which accel it got, and the UI says so
rather than letting it read as a bug.

**`MachineManager`** (process only, no DB) after `terminals/manager.ts` with `jsonrpc/stdio.ts`'s
death-reporting discipline; `spawn` and `connectProbe` injected, because `TerminalManager` gets away with
spawning `/bin/sh` and a QEMU cannot be a unit-test dependency. **`running` means four things, in
order**: the child is alive; the QMP socket produces its greeting and `qmp_capabilities` succeeds;
`query-status` returns `running`; and a TCP connect to the port the renderer will use succeeds. The last
is not redundant — the renderer's entire job is to open that socket. Add `probeConnect` beside
`probePort` in `workspace/ports.ts`, noting they are mirror images ("can I bind" vs "can I reach") and
must not be confused. On timeout, kill with `disposed: true` and a reason carrying the stderr tail.

stderr streams to `<dir>/qemu.log` and is kept as a 50-line ring (`STDERR_TAIL_LINES`, from `stdio.ts`)
that the death message reads; never broadcast line by line, because QEMU's stderr is not a terminal and
a log event stream would be a second pipeline with no consumer. **Crash vs deliberate kill branches on
`disposed`**, never on parsing the reason — that flag is the documented reason the adapters carry it. A
crash sets `failed` with the last stderr line, frees ports, and **keeps the row**: the one place this
departs from `TerminalService.onExit`, which deletes it, because a dead pty has no state worth keeping
while a dead VM still owns a disk image and a config the user chose, and "start it again" is the
recovery.

**Lifecycle, stated rather than inherited.** Closing a pane does not stop the machine. Quitting Realm
does — `closeAll()` is QMP `system_powerdown` (a Linux guest flushes its filesystem), then SIGTERM, then
SIGKILL after 2 s, and it must be **awaited** in `app.ts`'s close beside `terminals.closeAll()`, before
`db.close()`; un-awaited it orphans QEMU, which then holds the qcow2's lock and makes the next start fail
with something that reads like corruption. `restoreAll()` starts nothing — respawning a shell is free,
booting five VMs at 4 GB each is a resource decision the user did not make — and it NULLs every recorded
port (a port held by a dead process is a lie, and the UNIQUE index would refuse to reissue it) and clears
stale sockets and secrets. A row whose image has vanished is **not** deleted, unlike a terminal whose cwd
vanished; it degrades to `failed` / `image_missing`, because deleting it would throw away the config.
`suspend`/`resume` are QMP `stop`/`cont` — vCPUs halted, RAM resident, VNC still serving the last frame,
which is an honest frozen screen. Disk snapshots are out of v1 and named as such.

**Images.** The curated list is **pinned in the repo** (`catalog-data.ts`, 4–6 entries), because a
checksum fetched over the same channel as the image verifies nothing and pinning makes the release the
trust anchor; a network refresh may only *extend* it via the `machine.catalog` settings cache
(`models/catalog.ts`'s shape, including its rule that the service may not fail a caller) and loses every
id collision to the in-repo list. Downloads are content-addressed, resumable with `Range`, and verified
**twice**: a streaming hash while writing, which fails a fresh download early, and a from-disk re-hash
before the rename, which is the only pass covering bytes written by a previous attempt. Two named traps:
a server answering **200 to a `Range` request** must truncate and restart, because appending a full body
to a partial file is the classic silent corruption; and an imported file is probed with
`qemu-img info --output=json` and refused unless its format is qcow2 or raw with no backing chain — the
extension is never trusted. Free space is checked with `statfs` first. Every terminal state is a word,
never a spinner that just stops: `offline`, `http_error`, `checksum_mismatch`, `disk_full`, `cancelled`,
`resume_unsupported`, `not_a_disk_image`.

## Phase 4 — `realm-vm`: an agent that drives, connects, and creates

`apps/server/src/machines/agent-tools.ts`, `MACHINE_PROVIDER_NAME = "realm-vm"`, registered in `app.ts`
beside `createComputerAgentProvider` (~579). Three registration obligations: `OPT_IN_PROVIDERS`
(`mcp/service.ts:41–49`) gains it — and that comment ("`realm-computer` is the only one") must be
**rewritten, not appended to**, because the reason differs: computer use reaches every app on the Mac,
while a machine is a computer the user's files can be shared into and whose network is the user's
network. `BLOCKS["realm-vm"]` and `ORDER` in `mcp/capabilities.ts` — `capabilities.test.ts`'s drift
guard already fails without it, so note that rather than writing a new test. And the double enablement
check the other providers use, because an agent can call a tool it was told about before the space was
switched off.

**Tools.** `vm_list`, `vm_status`, `vm_screenshot` read freely. `vm_act`, `vm_start`, `vm_stop`,
**`vm_connect`** and **`vm_create`** are gated through `d.broker.gate(...)`. The last two exist because
the user asked for an agent that sets this up itself, and the card carries what is being spent:
`Connect to the Mac at 10.0.1.14 and let this session drive it`, or `Create a VM "Debian 13" — 4 GB,
4 CPUs, downloading a 1.2 GB image`. There is no `vm_exec`: a shell inside the guest needs a guest agent
and is a different security story from clicking pixels.

**Be honest about what the agent gets: pixels and coordinates.** The browser and computer providers give
a tree with indices, and every good property they have derives from it — acting by `[ref=N]`,
re-resolving at act time, refusing a stale ref, a card that can name the element. A machine has none of
that. So there is no `vm_snapshot` and no refs (OCR-derived indices would silently mean nothing), and
**staleness is undetectable**: a click at `(412,300)` always "succeeds" and may hit the wrong thing.
Three mitigations stand in: every `vm_act` result **carries a fresh screenshot** — the screenshot is the
receipt, not a second call; `vm_screenshot` returns `width`/`height` in framebuffer pixels with the
origin documented, and coordinates are validated against them; and the tool descriptions say to
screenshot after every act, because there is no other way to verify. The card names the machine *and*
the coordinates — coordinates mean little to a human, but they are the only thing distinguishing two
clicks, and a card that cannot distinguish two requests trains the user to approve everything. And
`fenceUntrusted` does not reach inside a JPEG: a screenshot carries a fenced header, but a model reading
it is reading whatever the guest chose to display. Say that in the provider's doc comment.

**One driver seam, four sources.** `MachineDriver { screenshot, act }`:
- **`qemu` → `QmpDriver`.** `screendump {format:"png"}` into the machine dir, downscaled and
  JPEG-encoded; `input-send-event` for act, absolute coordinates scaled to QEMU's `0..0x7FFF` axis
  range. No RFB client needed, and it works with the pane closed — exactly when an agent is most likely
  to be working.
- **`vnc`/`container` → `RfbDriver`.** A minimal server-side RFB client: Raw encoding,
  `FramebufferUpdateRequest incremental=0` for a full frame, `PointerEvent`/`KeyEvent` for act. This is
  the real new protocol work, and it is what makes "connect a MacBook and let an agent control it" true
  rather than view-only.
- **`mac` → `BridgeDriver`.** `d.bridge.call("computerSnapshot" | "computerAct", …)` — a thin adapter
  over `realm-computer`'s executor, inheriting its whole safety model (forbidden bundle ids, secure-field
  refusal against the live role, frontmost and occlusion checks, the menu-bar indicator). The machine's
  bundle id is the same grant key `computer.allowedApps` uses, so the two features cannot disagree about
  what TextEdit is.

**Typing is layout-dependent inside a guest.** `type` expands to key events against QEMU's qcode names,
so non-ASCII text is **refused with a sentence**, never silently dropped — that is the Android
`input text` trap already documented at `capability-research.md:290`, and repeating it knowingly would be
inexcusable.

**Grants.** `MachineAllowlist` (`machine.allowedMachines:<spaceId>`) copied from `computer/allowlist.ts`
including its per-space reasoning, and *excluding* its forbidden-id triple check, because there is no
forbidden set here — say that rather than shipping a dead constant. `promptUnderBypass: true` as the
computer provider does: the reasoning is honestly weaker for a Realm-built sandbox and strongest for a
remote Mac, and one provider cannot hold two bypass policies without making the user reason about which
source a machine is, so it takes the strict one. Every mutating tool is wrapped in the `runTracked` twin
(`browsers/agent-tools.ts:479`): `machine.driving` true → run → false in a `finally` → one
`machine.action` carrying the text the card showed.

**Watching it** is Phase 1's second payoff, and the machine's version is strictly better: on a canvas the
mark is positioned by the *same* `fit.ts` arithmetic the real input uses, so it can be *provably* at the
point the input went to. Do not drag it down to match the browser's injected string; share only
`AGENT_CURSOR`'s numbers. The known future merge, named so nobody builds a second bespoke ticker: fold
`browserActions`/`browserDriving`/`.browser-ticker` into one `agentActions` keyed by item `refId` rather
than overloading `browser.action` with a machine id.

## Phase 5 — This Mac, and containers

**`mac`, and the fast-pipeline problem.** 30 fps of base64 JPEG through the JSON-RPC socket would put
megabytes per second alongside session events, so the first ship deliberately is **not** a stream: the
pane polls `captureApp`'s existing one-shot JPEG at 1–2 fps through a `machineCaptureOnce` bridge op.
That is honest for "watch an agent drive TextEdit", needs **zero Swift work**, and gets the source
shipped. The upgrade, if asked for, is main running its own loopback MJPEG/WebSocket listener with the
bridge op returning only a port and token — the CSP already allows both.

The real cost of continuous capture is not the ScreenCaptureKit code: `captureApp` is
`SCScreenshotManager.captureImage` plus two semaphores, one image, no state, and **the helper exits after
the op**. A stream needs an `SCStream` with a `minimumFrameInterval`, an output delegate on its own
queue, a `stream(_:didStopWithError:)` path for display reconfiguration and mid-stream permission
revocation, filter re-creation whenever the app's window set changes (`SCShareableContent` is a
snapshot), and — the actual expense — a long-lived helper process with its own lifecycle in main's
`computerHost`. Keep capture window-scoped as the existing `SCContentFilter` already is, never
whole-desktop; show it while it is live; and route the Screen Recording grant through the flow that
exists (`main/computer-access.ts`, `ComputerAccessSection`).

**AX-grade control of another Mac** is the honest upgrade path for the remote-Mac source, and it is not
VNC: Realm's own Swift helper on the far side, over the same bridge shape, would give a remote machine
the same tree-and-indices model `computer_act` has locally. Named here so nobody expects `computer_act`
to work over RFB.

**`container`** is `docker run` with a virtual display and a VNC server, after which the machine is a
`vnc` source with a lifecycle — the cheapest source once Phases 2–4 exist. Nothing about Docker has been
verified here; treat it as separate research rather than an estimate.

## Verification

**Spikes, in the order they can invalidate work.** Moving the WS proxy into Phase 2 already demotes the
biggest from architecture risk to schedule risk.

1. **QEMU's own WebSocket VNC, and whether noVNC connects raw.** The code is compiled in
   (`vnc-ws-server-websock`, `Sec-WebSocket-Protocol: binary`). Unestablished: whether QEMU requires the
   `binary` subprotocol noVNC stopped sending years ago, and whether Chromium accepts QEMU's reply when
   the client requested none. Fallback: route through Realm's proxy, which Phase 2 builds anyway.
2. **UEFI vars files.** Homebrew ships `edk2-aarch64-code.fd` but **no `edk2-aarch64-vars.fd`**, and
   `edk2-i386-vars.fd` but no `edk2-x86_64-vars.fd`. Confirm a 64 MiB zero-filled pflash unit 1 boots
   and persists boot entries on aarch64, and which vars file x86_64 wants.
3. **`share=ignore` + `password-secret=` together** — individually documented, jointly untested; a wrong
   combination is a QEMU that exits with a parse error. Cheap now, expensive in Phase 4.
4. **`screendump` against `virtio-gpu-pci` with `-display none`**, and whether the PNG carries the
   guest's real resolution — a firmware screen is 800×600, so the agent must read dimensions from the
   image and never assume.
5. **`input-send-event` before the guest loads the tablet driver.** Absolute input into a UEFI shell may
   do nothing, which decides whether "install an OS" is an agent-capable task at all.
6. **`hvf` + `-cpu host` against free RAM** — does QEMU refuse or does macOS swap? Decides whether
   `memory_mb` needs a server-side cap.
7. **A second `WebSocketServer` in the built server bundle.** `rpc/server.ts` already uses `ws`, but the
   tsup externalization needs checking — both `preview.ts` and hard experience warn that the built ESM
   behaves differently from the source the suite tests.
8. **RFB decode cost in the renderer at 1440×900**, which decides whether a WebCodecs path is ever
   needed; the repo's prior research reached for H.264 once already.

**Unit tests, each with the mutation it exists to kill.** Phase 1's are listed in that phase. Beyond
them — argv: drop `accel=hvf`; `-display none` → `cocoa`; remove `virtio-tablet-pci`;
`-vnc 127.0.0.1:N` → `:N`; secret via `data=`; drop `share=ignore`; aarch64 with `-cpu qemu64`. Ports:
stride collision; skipping a busy candidate; the partial index letting two stopped machines coexist;
`restoreAll` no longer clearing ports. Manager: raise the ready deadline (must reject **and** kill the
child); ready meaning only "process alive"; dropping `qmp_capabilities`; `disposed` forced either way.
Service: `restoreAll` starting a process, or deleting a row whose image is missing (it must survive and
report `image_missing`); `closeFromLayout` disposing anything (closing a pane would kill a running VM);
`deleteItem` not pruning `machineState` (a reused id inherits the old dot). Images: comparing only a hash
prefix; renaming before verifying; treating a 200 as a resume; skipping the from-disk re-hash. `fit.ts`:
dropping the `* dpr`; removing the integer-snap coverage guard; one sign flipped in the inverse, caught
only by the round-trip property test; unclamped panning. Hub: `detach` disconnecting; a remount
reconnecting instead of adopting; `dispose` leaving an RFB decoding forever. Pane: registering a
`browserRect`; `booting` rendering a determinate meter or `downloading` not; Resize-guest offered
disabled rather than absent when `capabilities.resize` is false; Grab-keyboard's capture listener or its
`stopPropagation` removed; widening `hotkeys.ts`'s `kind === "session"` check so Esc interrupts a
session; Delete losing its arm or its size. Sidebar: `suspended` given a fill (two indistinguishable
grey dots); a state's word dropped from the accessible name; the dot gated on the layout. Provider,
asserted on a **driver spy** rather than returned text so a mutant that returns an error while still
clicking fails: `vm_act` without the gate; dropping `promptUnderBypass`; keying the grant on the tool
instead of the machine; allowing non-ASCII `type`. Scaling: dropping the `0..0x7FFF` normalization, and
swapping x/y against an asymmetric fixture. Plus the new `packages/ui/src/icon.test.ts` (every
`ItemKindSchema` member has an icon — which also kills today's `agents-page` folder bug) and
`entities.test.ts` accepting `"machine"`.

**`styles.test.ts`** is the mechanical home per AGENTS.md: `.machine-cursor` matches `AGENT_CURSOR` and
the injected string; no `infinite` animation and no `transition: all`; its reduced-motion block kills the
travel and keeps the mark painted; `.machine-screen canvas` carries `var(--shadow-hairline)`;
`.machine-screen` uses `--rl-terminal-bg`, not `--canvas`; `pixelated` only under `[data-scale="actual"]`;
no `corner-shape: squircle` on any `.machine-*` selector; no hairline between `.panel-bar` and
`.machine-screen`.

**Live checks.** `agent-cursor-live.mjs` (Phase 1, above). `machine-pane-live.mjs`: boot the real app
against a local VNC server serving a known test pattern and assert with real numbers — Fit letterboxes
at the correct aspect at three pane sizes; at 2× DPR an exactly-fitting framebuffer is pixel-identical to
the source; a click at a known canvas point produces a `PointerEvent` at the expected framebuffer
coordinate; and a menu, a sheet and the palette all open **over** the canvas and are visible, which is
the direct proof that the no-overlay tax does not apply. Here a CDP screenshot *is* valid evidence,
unlike the browser pane — worth a comment, since it is the inverse of design.md's warning. Rebuild
first: the live scripts boot the built app and a stale build reads as a live bug. Never point any of this
at the real `~/Realm`; use `REALM_HOME=$(mktemp -d) REALM_DEVTOOLS_PORT=9223 REALM_PORT=8788`.

**Gates before commit**: `SHELL=/bin/bash pnpm vitest run`, `pnpm -r typecheck`, `pnpm build`.

## Order of work

| # | Work | Ships alone as |
|---|---|---|
| W1 | The accent through the bridge; the ring stops being hard-coded blue | every user's action ring is their own accent — and it de-risks W2's plumbing |
| W2 | `agent-cursor.ts`, `cursorTargetFor`, `markAct`, the attribute split, the watchdog, reduced motion, the controlled frame | **watch the agent browse** (and the simulator, free) |
| W3 | Contracts + icon (+ the `agents-page` fix and the icon-completeness test), pane, hub, `fit.ts`, styles, store, sidebar dots, WS proxy, connect flow, session button — **`vnc` source only** | connect your other MacBook and drive it by hand |
| W4 | `RfbDriver` + `realm-vm` on `vnc` | an agent drives that Mac, and can connect one itself |
| W5 | QEMU: locator, argv, manager, images, the download-in-the-pane flow | "New machine → Debian → watch it install" |
| W6 | `QmpDriver` on `qemu` | an agent drives the VM, pane open or not |
| W7 | `mac` at 1–2 fps with the hall-of-mirrors gate; then `container`; then Send key / Clipboard / Scale modes | watch computer use; throwaway Linux desktops |

W3 before W5 is deliberate: the address-based sources are what was asked for most concretely, need no
engine, and settle every geometric and keyboard question before QEMU's unknowns enter the picture.

## Verified on this Mac (2026-09-10)

Recorded so nobody re-derives them. Everything here was checked directly; anything not listed is an
assumption.

- **QEMU 10.2.0**, Homebrew, `/opt/homebrew/bin/qemu-system-aarch64` and `qemu-system-x86_64`.
- **Accelerators**: `hvf` and `tcg` both present. `hvf` only for the host architecture — an aarch64
  guest on Apple Silicon; every x86_64 guest is `tcg`.
- **Devices in the aarch64 binary**: `virtio-gpu-pci`, `virtio-tablet-pci`, `usb-tablet`, `qemu-xhci`,
  `usb-kbd`, `virtio-net-pci`. **`virtio-vga` is not there** — it is x86_64 only, which is consistent
  with Phase 3 using it only for x86_64 guests, but the argv builder must not offer it for aarch64.
- **Firmware**: `/opt/homebrew/share/qemu/edk2-aarch64-code.fd` and `edk2-x86_64-code.fd` exist.
  **Neither `edk2-aarch64-vars.fd` nor `edk2-x86_64-vars.fd` does** — the vars files shipped are
  `edk2-arm-vars.fd` (32-bit arm, a near-miss worth not grabbing by mistake), `edk2-i386-vars.fd`,
  `edk2-loongarch64-vars.fd` and `edk2-riscv-vars.fd`. Spike 2 covers what unit 1 should be.
- **QMP commands available**: `screendump`, `input-send-event`, `snapshot-save`, `snapshot-load`,
  `system_powerdown`, `query-status`.
- **VNC WebSocket support is compiled in**: the binary carries `vnc-ws-server-websock` and
  `Sec-WebSocket-Protocol: binary`. Whether noVNC's handshake matches it is Spike 1.
- **`@novnc/novnc@1.7.0`**: MPL-2.0, zero runtime dependencies, 635 KB unpacked, single-entry
  exports map. Carried over from the research that produced this plan — the package is not installed
  in this checkout, so re-check the version and size at the moment W3 adds the dependency.
- **Renderer CSP already permits `connect-src ws://127.0.0.1:*`** — no CSP change is needed for either
  the proxy or QEMU's own WebSocket.

## Spikes, resolved

Run on QEMU 10.2.0, 2026-09-10. Recorded so nobody re-derives them.

1. **QEMU's own WebSocket VNC — not needed.** The relay was built first, as planned, and it turned
   the question into an optimisation nobody has to answer. Realm reaches every guest over its own
   loopback TCP.
2. **UEFI vars: resolved, and better than hoped.** A 64 MiB zero-filled pflash on unit 1 boots
   `edk2-aarch64-code.fd` with no stderr, and the firmware **writes to it** — so boot entries
   persist with no `edk2-aarch64-vars.fd` to copy. It is created with `wx` so a reboot never wipes
   the boot order the firmware just saved.
3. **`share=ignore` + `password-secret=`: accepted together.** The full argv parses and the listener
   comes up. Also measured, and now a test: `-vnc :72` binds `*:5972` — every interface — while
   `-vnc 127.0.0.1:71` binds loopback only.
4. **`screendump` works, and the resolution is a lie.** Against `virtio-gpu-pci` with `-display
   none` it produced a **640×480** PNG despite `xres=1280,yres=800`, because nothing had initialised
   the display. So `QmpDriver` reads dimensions out of the image and never from the spec.
5. **`input-send-event` refuses a paused VM** — "VM not running". That is exactly the suspended
   case, so it is turned into "this machine is suspended, resume it first" rather than relayed.
6. **RAM cap: not needed yet.** `hvf` + `-cpu host` was not pushed past free memory; the catalog's
   defaults are 1–4 GB and a server-side cap is still unwritten. Named as open.
7. **A second `WebSocketServer` in the bundle: fine.** `pnpm build` produces a working ESM bundle
   with both listeners; `ws` was already externalised for `rpc/server.ts`.
8. **RFB decode cost: not measured.** The pane is smooth against a 1440×900 test pattern in the live
   check, but no timing was taken. WebCodecs remains unneeded and unproven.

Three further things measured that the plan did not ask about, each now a test:

- **`des-ecb` does not exist in this suite's Node.** OpenSSL 3 moved single DES to the legacy
  provider; Electron's BoringSSL still has it. `des-ede3` with the key three times is single DES and
  is in the default provider everywhere.
- **`BrowserWindow.capturePage` composites no child `WebContentsView`** — a window entirely covered
  by a bright green page captures as pure white. The view's own capture is the evidence.
- **`ws` takes subprotocols as its second ARGUMENT.** An `options.protocol` is silently nothing.

## Risks and stated assumptions

- **QEMU is GPL-2.0**, so it is detected, not bundled. A change in emphasis from "bundle QEMU": Realm
  runs QEMU rather than delegating to UTM, but the binary is the user's Homebrew install. If shipping it
  inside the app matters more than the licence burden, that is a decision to take explicitly, with the
  source offer it carries.
- **noVNC is MPL-2.0** — the first dependency here that is neither MIT nor Apache. File-level obligation:
  publish modifications to noVNC's own files, and we make none. Otherwise a clean fit (zero runtime deps,
  635 KB, single entry), so it goes in `devDependencies` like the other renderer libs.
- **A pulsating frame runs against a literal line in design.md** ("Do not add… decorative pulsing"). The
  defence is that it carries state and joins the existing in-flight ping rule rather than adding a second
  animation — but it is a judgment call, and if it reads as decoration in the real window the ring should
  stay and the pulse should go.
- **The cursor is a marker, not a hand.** design.md warns against "human-like agent presence" and generic
  AI imagery, so the white-with-accent-border glow is drawn as a lit *point*, not an arrow — a second
  arrow beside the user's real one would be both ambiguous and the thing design.md is warning about.
- **x86_64 guests run under TCG** on Apple Silicon: 10–30× slower, and the UI must say so.
- **Windows needs an ARM64 ISO the user supplies** plus virtio driver media; the catalog cannot carry it.
- **macOS guests are out of scope** — Apple's licence and QEMU's capabilities both say no.
- **`computer_act` will not work over VNC.** A remote Mac is pixels until Realm's helper runs there.

## Out of scope

SPICE, RDP, USB passthrough, 3D/GPU acceleration in guests, virtiofs shared folders, disk snapshots,
multi-monitor guests, physical iOS/Android devices, a `machine-page` for full settings, the `agentActions`
ticker merge, any generalisation of `axElementAt` into a "device" abstraction, and attaching to a running
UTM VM's own display.
