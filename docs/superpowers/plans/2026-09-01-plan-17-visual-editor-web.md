# Realm Plan 17 — The visual editor (browser pane → real source)

> Numbered 17: 16 is search-and-forks. Grounded in Plan 11 (browser pane / `webContents.debugger` CDP) and
> Plan 13 (diff pane, review). Three load-bearing unknowns are resolved by the research below:
> **(1)** React 19 deleted `fiber._debugSource` (PR #28265) and has shipped no replacement — issue #31981 is
> still open with "nothing has changed here" as of Feb 2026, so *any* React source mapping must come from
> our own build transform, not from React. **(2)** CDP `Runtime.addBinding` + `Page.addScriptToEvaluateOnNewDocument`
> with a `worldName` gives us a page-side runtime with a private channel that page JS cannot see, forge, or
> CSP-block — the same debugger we already own, no new transport. **(3)** Because the source-location contract
> is *a DOM attribute*, the framework axis and the styling axis are independent: 5 frameworks × 4 styling
> systems costs 5 + 4 adapters, not 20.
>
> **The governing decision:** live preview is universal, source commit is conditional. A refused edit is a
> feature. A wrong edit in someone's repo is the only unrecoverable failure this plan can produce, and the
> whole design is bent around never producing it.

## Architecture (settled by research)

Realm already owns the browser: one `WebContentsView` per pane on `persist:browser`, driven end-to-end by
`webContents.debugger` in flatten mode from Electron main (`apps/desktop/src/main/browser-pane.ts#attachCdp`).
There is no Playwright, no Puppeteer, no remote debugging port, no preload in the browser view. Plan 11 W4
already injects DOM into pages over `Runtime.evaluate`, with the observation that matters here recorded in
`browser-agent.ts`: *"DOM injection rides the debugger, so CSP that blocks page scripts does not block it."*

That single fact settles the transport, and settles it against the obvious answer.

**The user's one-line add is a build plugin, not a runtime.** `@realm/visual` is a compiler plugin whose only
job is stamping source locations onto emitted markup, plus publishing a project manifest. The *runtime* —
overlay painting, hit testing, tweak application, the protocol — ships with Realm and is injected by Realm
over CDP into an isolated world. This inverts the usual shape (Onlook, Locator, react-dev-inspector all ship
the runtime in your bundle) and it is the right inversion for us, for four reasons:

1. **No transport to build.** A page-hosted runtime that talks to realm-server needs the port injected into the
   user's bundle, an auth token in the user's bundle, `connect-src` room in the user's dev CSP, and CORS on a
   socket that is currently loopback-with-no-auth by deliberate design. Four new attack-surface decisions to
   buy a channel we already have.
2. **Version skew dies.** The runtime is always exactly the Realm build's runtime. No "your `@realm/visual` is
   two minors behind the app" support class.
3. **CSP immunity.** Strict-CSP dev servers are common. Debugger-injected script is not subject to page CSP.
4. **The user's production bundle can never contain it.** The plugin is a dev-only transform that emits
   attributes; there is no Realm code to accidentally ship.

The plugin still carries a runtime *fallback* build for people who want click-to-source in plain Chrome, but
that is not on Realm's path and is not on this plan's critical path.

Ownership follows Plan 11 exactly: views and CDP in Electron main; realm-server owns rows, the source
write-back, and the agent-facing surface; the renderer owns the inspector UI. Three transports, and **which
one carries which message is a latency decision, not a taste decision** — see W2.

---

## W1 — The source-location contract

Everything downstream is a function of one attribute. Get it right and the rest is bookkeeping.

```
data-rl-src="src/components/Card.tsx:42:7-42:63#a91f"
             ^path rel to project root  ^open-tag range   ^4-byte hash of those bytes
```

- **Path is relative to the manifest root**, never absolute. Absolute paths in the DOM leak the user's home
  directory into any page that can read its own DOM.
- **The range is the opening tag**, start-of-`<` to end-of-`>`, not the element. Editing attributes never needs
  the children, and not carrying the end position keeps the range stable under child edits.
- **The hash is the safety interlock.** Realm re-reads those exact bytes before every write and refuses if the
  hash has moved. This is what makes concurrent editing (the user typing in their editor while the inspector
  is open) safe rather than merely unlikely. It is cheap and it is the single highest-value four bytes in the plan.

Why an attribute and not a side-table keyed by an opaque id (Onlook's `data-oid`, Locator's approach): Realm
has filesystem access to the project and needs *zero* coordination with the user's dev server to resolve a
location. A side-table means a fetch, a cache, an invalidation story, and a dev-server route. code-inspector
reached the same conclusion independently — it stamps a full `data-insp-path` — and it is the tool that
supports the most frameworks, which is not a coincidence.

**Why we cannot get this from React.** `fiber._debugSource` was removed in React 19 (facebook/react#28265) to
solve problems unrelated to tooling, with no replacement. The React team's own suggested direction —
component stacks, `_debugStack`, `captureOwnerStack()` — is *line-granular at best*: React 19's own
`ReactJSXElement.js` defines only `_debugInfo`, `_debugStack`, `_debugTask` on a DEV element, and explicitly
filters `__source` out of props. Vaadin's issue #31981 states the disqualifying case perfectly:

```jsx
return <><span>Hello</span><span>Hello</span><span>Hello</span></>;
```

Three elements, one line, no column. A visual editor that cannot tell them apart cannot write to source.
`@babel/plugin-transform-react-jsx-source` still *produces* `__source` (Vite's `@vitejs/plugin-react` uses the
development JSX transform whenever `NODE_ENV=development`; Next's SWC does the equivalent) — React 19 simply
throws it away. So the data exists at compile time and dies at runtime, and the only fix is to stamp it
somewhere React cannot discard: the DOM.

### The plugin (`@realm/visual`)

One line, per bundler:

```ts
// vite.config.ts
plugins: [react(), realmVisual()]
```

It does three things and nothing else:

1. Runs a per-framework AST visitor that adds `data-rl-src` to **host elements only** (lowercase JSX tags, Vue
   template elements, Svelte elements). Components get `data-rl-owner` instead — a *different* attribute,
   because a location on `<Card/>` names where the Card was *used*, not the DOM node that appeared, and
   conflating those is how you write to the wrong file. (Onlook's own AST README shows the trap: `data-oid`
   on `<Child/>` only reaches the DOM if `Child` spreads props.)
2. Serves `/.well-known/appspecific/com.realm.visual.json` from the dev server:
   `{ root: "/abs/path/to/project", uuid, framework, styling: ["tailwind","css-modules"], version }`.
   This is deliberately modelled on Chrome DevTools' Automatic Workspace Folders — same well-known path shape,
   same "the dev server declares its own root" premise. It is how Realm decides an origin is trustworthy
   enough to write files for (W6), and it is why we can support arbitrary user setups without configuration.
3. Refuses to do anything when `NODE_ENV !== "development"`, loudly, at config time.

**Turbopack is the top build-integration risk.** Next 15+ with Turbopack does not accept JS-authored
transforms; Locator's own README routes users to a webpack loader for exactly this reason, and
`experimental.swcPlugins` means shipping a Rust/WASM artifact. v1 ships Vite (Rollup transform hook) and
webpack/Next-with-Babel; Turbopack goes through a module-level loader shim and is verified live before we
claim it.

**Degradation when the plugin is absent.** The runtime probes, in order:

| Framework | Free runtime source data | Quality |
|---|---|---|
| Svelte | `node.__svelte_meta.loc` → `{file,line,column,char}` | **Full.** Svelte gives us everything for free, dev-only. Plugin optional. |
| Vue | `el.__vueParentComponent.type.__file` | File only, no position. Locate-the-component, not locate-the-tag. |
| React | fiber via `__reactFiber$*`, `_debugOwner` chain | **Component names only.** No location. React 19 killed it. |
| Solid | `solid-devtools/locator` conventions | Component-level. |
| Plain HTML | the file *is* the DOM | Full, if served from the project root. |

Without a location we run in **DOM-only mode**: preview works, every commit is refused with the one-click fix
("add `realmVisual()` to your vite config"). That is the honest behaviour and it is also the best possible ad
for the plugin.

---

## W2 — The protocol and its three layers

The mistake to avoid is one uniform pipe. A padding drag emits ~60 tweaks/second; a commit emits one. Routing
both through realm-server is how you get a laggy scrubber.

### Layer B (the interesting one): Electron main ↔ the page

**Identity is `backendNodeId`.** Not a selector, not a runtime-assigned id, not a path. This is already the
house ref convention (`browser_snapshot` emits `[ref=<backendNodeId>]`) and it means the visual editor and the
agent toolset name the same elements — an agent can be handed the thing the user just clicked, for free.

Consequences, all good: hit testing is `DOM.getNodeForLocation` (CDP, no page code); the page runtime never
invents ids; and joining the two is `DOM.resolveNode({backendNodeId})` → `Runtime.callFunctionOn`. **CDP owns
identity; the page runtime owns painting and mutation.**

Injection:

```
Page.addScriptToEvaluateOnNewDocument({ source: RUNTIME_JS, worldName: "realm-visual", runImmediately: true })
Runtime.addBinding({ name: "__rlVisual", executionContextName: "realm-visual" })
```

An isolated world, because page JS then cannot read our state, cannot call `__rlVisual`, and cannot forge
events at Realm. A ~30-line **main-world probe** is injected separately and only when a framework probe is
needed, because expando properties (`__svelte_meta`, `__vueParentComponent`, `__reactFiber$*`) are per-world
and invisible from an isolated world. Everything the main-world probe returns is untrusted page data and is
typed as such all the way up.

Down-calls (main → page) are `Runtime.callFunctionOn` with a fixed op enum. **No payload is ever evaluated as
code**; `functionDeclaration` is a compile-time constant string and everything variable is an argument.

```jsonc
// visual.enable — arms the runtime for a browser
→ { "op": "visualEnable", "browserId": "01J…" }
← { "framework": "react" | "vue" | "svelte" | "solid" | "none",
    "plugin": { "present": true, "version": "0.1.0", "root": "/Users/…/app" } | null,
    "styling": ["tailwind", "css-modules"],
    "manifestOrigin": "http://localhost:5173" }

// visual.inspect — everything the inspector needs for one node
→ { "op": "visualInspect", "browserId": "01J…", "ref": 4821 }
← { "ref": 4821,
    "tag": "div",
    "rect": { "x": 320, "y": 118, "w": 264, "h": 96 },
    "box": { "margin": [0,0,16,0], "border": [1,1,1,1], "padding": [12,16,12,16] },
    "src": { "path": "src/components/Card.tsx", "start": [42,7], "end": [42,63], "hash": "a91f" } | null,
    "owner": [ { "name": "Card", "path": "src/components/Card.tsx", "line": 12 },
               { "name": "Deck", "path": "src/routes/Deck.tsx", "line": 41 } ],
    "computed": { "padding-top": "12px", "color": "oklch(0.72 0.11 250)", … },
    "classes": ["rounded-card", "p-4", "bg-surface"],
    "vars": { "color": { "token": "--ink-2", "declaredIn": "src/theme.css:14" } },
    "instances": 7,                       // how many DOM nodes share this data-rl-src
    "flags": ["in-loop"] }

// visual.tweak — live preview. Fire-and-forget, ~60/s during a drag.
→ { "op": "visualTweak", "browserId": "01J…", "ref": 4821,
    "tweakId": "tw_7f3", "decls": { "padding-top": "14px" }, "scope": "instance" }
← { "ok": true }

// visual.revert — drop one tweak or all of them
→ { "op": "visualRevert", "browserId": "01J…", "tweakId": "tw_7f3" | null }
```

Up-events ride the binding, and **only hover does**, because hover is the one thing that must be driven
in-page at pointer speed:

```jsonc
__rlVisual('{"kind":"hovered","el":<passed back via callFunctionOn objectId>,"rect":{…},"label":"Card > div"}')
__rlVisual('{"kind":"invalidated","reason":"navigation"|"hmr"|"detached"}')
```

`invalidated` is load-bearing: an HMR reload silently reruns the user's component and blows away every live
tweak. The inspector must know, not discover.

**Live tweaks are applied through a Realm-owned stylesheet, never `element.style`.** The runtime sets
`data-rl-tweak="tw_7f3"` on the node and writes `[data-rl-tweak="tw_7f3"]{padding-top:14px}` into a
`CSSStyleSheet` it adopted. Reason: React re-renders reset `style` props; they do not reset our attribute, and
a `MutationObserver` re-stamps it if they do. The attribute is also what makes revert exact — one rule
deleted, no "what was it before" bookkeeping.

The overlay and the tweak stylesheet both carry `data-rl-visual`, and — following the `HIGHLIGHT_ATTR`
precedent in `browser-agent.ts` — `buildSnapshot`'s `collectDoc` must filter them, or every agent snapshot
taken with the inspector open reports a phantom `[new]` element and the agent chases it.

### Layer A: realm-server ↔ Electron main

Six new ops appended to `BROWSER_HOST_OPS` in `apps/server/src/browsers/host-bridge.ts`, dispatched in
`browser-agent-host.ts#handleOp`: `visualEnable`, `visualDisable`, `visualInspect`, `visualTree`,
`visualTweak`, `visualRevert`. Same targeted `browserHost.op` / `browserHost.result` frames, same 60s timeout,
no new socket. Adding an op means touching those two files plus `agent-tools.ts` in lockstep — that is the
existing rule and it does not change.

### Layer C: renderer ↔ the world, and the one place we bypass the server

New RPC (`packages/contracts/src/rpc.ts`, house convention `namespace.verb`, zod `{params, result}`):

```ts
"visual.enable":  { params: z.object({ browserId: IdSchema }), result: VisualSessionSchema },
"visual.disable": { params: z.object({ browserId: IdSchema }), result: z.object({ ok: z.literal(true) }) },
"visual.inspect": { params: z.object({ browserId: IdSchema, ref: z.number().int() }), result: VisualNodeSchema },
/** Plan the source edit for a set of live tweaks WITHOUT writing. Returns per-property verdicts —
 *  the inspector renders these as the green/amber/grey badges, so the user knows what is committable
 *  BEFORE they invest in a tweak. Throws VISUAL_STALE if any data-rl-src hash no longer matches disk. */
"visual.plan":    { params: z.object({ browserId: IdSchema, tweaks: z.array(TweakSchema) }), result: EditPlanSchema },
/** Apply a previously-planned edit to the working tree. Re-verifies every hash under the same lock the
 *  planner used; a plan that has gone stale is refused, never re-planned silently. Writes land as ordinary
 *  unstaged changes — the diff pane is the review surface, there is no separate approval UI. */
"visual.commit":  { params: z.object({ browserId: IdSchema, planId: z.string(), accept: z.array(z.string()) }), result: CommitResultSchema },
```

Events: `visual.selected` (an agent or the runtime changed selection), `visual.invalidated`.

**And one deliberate bypass.** Drag-scrub tweaks go renderer → Electron main over IPC directly:

```
browser:visual-tweak   send   (browserId, ref, tweakId, decls)    // per-frame, fire-and-forget
```

exactly like `browser:set-bounds` already does. Routing a 60Hz scrub through
renderer → ws → server → ws → main → CDP → page adds two socket hops and a JSON validate per frame to buy
nothing; the server has no decision to make about a preview that touches no file. Select, plan, and commit —
everything with a consequence — go through the server, where the permission model, the environment root, and
the agent surface live. **The rule: previews take the short path, decisions take the server path.**

---

## W3 — The framework-agnostic core, and the three adapter axes

The core imports no framework and knows no styling system. It is:

- **Geometry & hit testing** — `DOM.getNodeForLocation`, box model, scroll containers, occlusion. Pure CDP.
- **The overlay** — margin/border/padding bands, a label chip, the sibling/parent rail. In-page (isolated
  world) because Plan 11 W2's invariant forbids painting DOM over a `WebContentsView`; this is the same
  reasoning that produced W4's action highlight and it is not negotiable.
- **The tweak engine** — adopted stylesheet, `data-rl-tweak`, revert, `MutationObserver` re-stamp.
- **The protocol** — the ops above.
- **The write-back planner** — operates on *source ranges and text*, not on JSX or Vue or Svelte.
- **The commit path** — filesystem write inside the environment root, then the diff pane.

Three adapter axes hang off it, and the whole point is that **they are independent**:

**Axis 1 — build adapters** (in `@realm/visual`, one AST visitor each): JSX/TSX (Babel + SWC), Vue SFC
template, Svelte, Astro, plain HTML. ~150 lines each. Output is always the same attribute.

**Axis 2 — probe adapters** (in the injected runtime, ~40 lines each): `identify(el) → { component, owners }`.
React fiber walk, Vue `__vueParentComponent`, Svelte `__svelte_meta`, Solid, none. Used for the breadcrumb and
for "edit the component instead", never for the write itself when the plugin is present.

**Axis 3 — styling adapters** (in the server-side planner, the real work): Tailwind classes, inline `style`,
CSS Modules, CSS-in-JS tagged templates, plain CSS via sourcemap. Each implements
`plan(range, currentSource, decls) → PropertyVerdict[]`.

Because axis 1 hands axis 3 a *byte range in a file* and nothing else, a Vue project with Tailwind reuses the
React project's Tailwind planner verbatim. Five frameworks and four styling systems cost nine adapters, not
twenty. That is the "general architecture so it's simpler to figure out."

---

## W4 — Write-back, and the refusal list

The refusal list matters more than the happy path. Read it first.

### What we will write

**1. Tailwind classes — `className="…"` as a static string literal in the located tag.**
Parse the literal, drop utilities that conflict with the property being set, append the new one. We own the
conflict table (derive it from tailwind-merge's group model — MIT — rather than depending on it at edit time;
we need the *inverse* mapping, CSS property → utility group, which it does not expose). Two disciplines:
prefer a scale token and snap to the nearest by default (`p-4`, not `p-[17px]`); emit an arbitrary value only
on an explicit "exact" modifier, because arbitrary values are exactly where tailwind-merge stops working —
`[padding:1rem]` and `p-8` do not merge, by documented design, so a codebase full of arbitrary values is a
codebase where our own future edits become unreliable.

**2. Inline `style={{…}}` / `:style` / `style="…"` — object or declaration list with static keys.** Add or
replace one property. The most reliable case there is, and the fallback for host elements with no class hook.

**3. CSS Modules.** `class={styles.card}` → resolve `.card` in the sibling `.module.css`, edit the declaration.
Only when exactly one rule matches, with no media query, no pseudo-class, no `:global`, and no second rule of
equal-or-higher specificity also setting the property.

**4. Plain CSS / global stylesheets.** Reached through `CSS.getMatchedStylesForNode`, which hands back
`styleSheetId` + a source `range`; the sheet's sourcemap inverts to an authored file. Only for files inside
the project root that the sourcemap names directly.

**5. styled-components / emotion tagged templates.** Edit the template literal of the located styled
component — only when the declaration being changed is in fully static text with no `${…}` interpolation
anywhere in the same declaration block that could reorder it.

**6. Design tokens.** When the computed value resolves through `var(--x)`, the inspector says so and offers
two doors: *override here* (writes a literal, local blast radius) or *edit the token* (writes the `:root`
declaration, shows the usage count first). Never silently the second one.

### What we will refuse — and refuse *by name*, with the reason on screen

- **The located tag is a component, not a host element.** `<Card className="…">` — we cannot prove `className`
  reaches the node you clicked without following the component's implementation. Offer the owner chain
  ("edit inside Card") instead. This is the single most common refusal and the UI must make it feel like a
  navigation, not an error.
- **`cn()` / `clsx()` / `twMerge()` with anything other than one static string argument.** We can edit a
  static literal argument only when no later argument can set the same property, which in general we cannot
  know. Multi-arg, ternary, template-literal-with-interpolation: refused.
- **`cva` / `tailwind-variants` variant maps.** The class lives in a table keyed by props we cannot observe.
  Refused, with a jump to the variant definition.
- **`{...props}` spread on the located tag**, when it appears after `className`/`style`. Downstream overrides
  are invisible to us. (Spread *before* an explicit `className` is fine and we allow it.)
- **A stale hash.** The bytes at `data-rl-src` no longer match the file. Always refuse; never re-locate by
  guessing. Offer reload.
- **Anything resolving outside the project root**, after `realpath`, or under `node_modules`, or with a
  non-source extension. See W6 — this is a security control, not a convenience check.
- **Generated CSS.** Tailwind's output, minified vendor sheets, any stylesheet whose sourcemap does not invert
  to an authored file in the root.
- **A competing `!important` at higher specificity.** The edit would be legal and invisible. Refuse and say
  which rule wins.
- **`dangerouslySetInnerHTML`, `v-html`, `{@html}`, closed shadow roots, cross-origin iframe content.** No
  source exists to edit.
- **Creating a styling surface on a component.** If a host element has no `className` and no `style`, we will
  add `style` with a one-line confirmation. If a *component* has neither, we refuse — adding a prop that the
  component may not accept is a type error we caused.
- **Properties the source cannot express** because the tweak actually landed on an inherited or parent-driven
  value. Attribute it to the parent or refuse; never write the property onto the child and call it done.

### Not a refusal, but a mandatory warning

- **Loops.** `instances: 7` in the inspect payload is not decoration. One source range, seven rendered nodes;
  the edit changes all of them. The confirm button reads *"Apply to 7 elements"* and the overlay flashes the
  other six before the write. This is the case users get wrong, not the tool.
- **Token edits.** Usage count, always, before the write.

### The write itself

Server-side, inside the environment's git root, holding the same lock the planner used, re-verifying every
hash. Output is an ordinary unstaged working-tree change — Plan 13's diff pane is already the review surface
and there is no reason to build a second one. There is no auto-commit and no auto-format; if the project has
a formatter, we leave the file for it rather than guessing its config. Every write is one contiguous range
replacement per file, which keeps the diff readable and the revert trivial.

---

## W5 — The inspector

**It is a right rail inside the browser pane, not a floating panel, and the `WebContentsView`'s bounds
narrow to make room.** Plan 11 W2's invariant means a floating inspector over a browser view is illegal;
`setBounds` already takes an arbitrary rect, so shrinking the view is a two-line change and produces a Figma
layout for free. `useAnchoredPopover` still governs the color picker and any menu inside the rail.

Property groups, in order:

- **Layout** — display (flex/grid/block segmented control), direction, justify, align, gap
- **Box** — padding and margin as a four-field box widget with a linked/unlinked toggle, width/height, min/max
- **Typography** — size, weight, line-height, letter-spacing, color, align
- **Appearance** — background, border (width/style/color), radius, shadow, opacity
- **Position** — static/relative/absolute/fixed, inset, z-index

Every numeric field is a **drag-scrub**: pointer-lock, 1px per unit, ⇧ ×10, ⌥ ×0.1, arrow keys, type-to-set.
This is the interaction the feature is *for*, and it is why the preview path bypasses the server.

**Degradation is per-property, and it is visible before you touch anything.** `visual.plan` runs on selection,
not on commit, so each row carries a badge:

| Badge | Meaning | Behaviour |
|---|---|---|
| ● green | maps to a static literal in one place | edit freely, commits cleanly |
| ● amber | maps, but with blast radius — loop, token, shared CSS rule | edits, commits behind a count-bearing confirm |
| ○ grey | previewable only | scrubs live, commit disabled, hover gives the reason and a jump to the file |

The grey state is the whole degradation story and it must be *pleasant*: you can still drag it, still see it,
still screenshot it, still hand it to an agent as "make this look like this". The reason text is specific
("`className` here is `cn(base, active && …)` — Realm can only edit a single static string") and always
offers the next action.

**The escape hatch is the agent.** Any refused tweak becomes a one-click "ask the agent" that hands the
session the selected `ref`, the owner chain, the current source range, and the desired declarations. That is
Cursor's entire model — visual change in, agent locates and edits — and it is the correct *fallback*. Our bet
is that the deterministic path covers the common case and the agent covers the tail, rather than the agent
covering everything and being wrong 5% of the time in a file you did not read.

**Primitives we do not have and must build** (`packages/ui` is genuinely thin, and the renderer has zero
`type="number"` and zero `type="range"`): the drag-scrub number field, a slider, a real color picker
(`hexToHsl`/`hslToHex` exist in `@realm/ui`; the HSV surface and eyedropper do not), and a tooltip — the
`--tooltip-*` tokens are defined in `tokens.css` and nothing consumes them, so this is a debt the design
system already booked. Segmented controls and switches exist as `.settings-tabs` / `.switch` idioms and
should be lifted into components while we are here.

---

## W6 — Security

This feature injects Realm code into a page and writes files in the user's repo on the strength of a string
it read out of that page's DOM. State the boundaries plainly.

**The trust boundary is the manifest, not the page.** Visual editing arms for a browser only when all of:
the origin is loopback or in the space's allowlist; `/.well-known/appspecific/com.realm.visual.json` is
served and parses; and its `root` resolves, after `realpath`, to a directory Realm already owns as an
environment. A production site that stamps `data-rl-src` on its own markup gets nothing, because no manifest
Realm trusts names a root. This is Chrome's Automatic Workspace Folders model and it is the right one.

**Every `data-rl-src` is hostile input.** `../../../.ssh/authorized_keys` is the attack, and it is trivially
mountable by any page. Path resolution: join to root, `realpath`, assert still inside root, assert extension
is in the source allowlist, assert not under `node_modules`/`.git`/`dist`. Assert, not sanitize — a path that
fails any check is refused, never repaired. This is the highest-severity control in the plan and it gets
mutation-grade tests.

**Two worlds.** The runtime lives in an isolated world; page JS cannot see it, call `__rlVisual`, or forge an
event. The main-world probe is minimal, read-only, and its output is untrusted page data that reaches an
agent transcript only through `fenceUntrusted` — the existing invariant, unchanged.

**No payload is ever code.** Down-calls are a fixed op enum with a constant `functionDeclaration`; variables
are arguments. Nothing the page produces is ever passed to `Runtime.evaluate`.

**Off by default, per browser, with a visible toggle.** Plan 11 shipped `realm-browser` default-ON on the
reasoning that it is Realm's own code under Realm's own permission flow. This is different: it writes to the
source tree. It is an explicit per-pane "Inspect" toggle, and there is a per-space kill switch alongside the
existing MCP provider switches.

**Agents get read and preview, never commit.** `visual_inspect` and `visual_tweak` are read-only-ish tools an
agent may call; `visual.commit` has no agent-facing tool at all. An agent that wants a source change edits the
file the way it already does, through the normal permission flow, and the user reviews it in the diff pane.
We do not build a second, weaker path into the user's repo.

**No secrets on the wire.** Password fields are already excluded from snapshots; the inspector reads computed
styles and class names, never input values, and never `type=password` anything.

---

## W7 — Work breakdown

Ordered by dependency. Days are one engineer, honest, including tests.

| | Work | Days |
|---|---|---|
| **1** | **Transport spike.** `Page.addScriptToEvaluateOnNewDocument` + `worldName` + `Runtime.addBinding` in a `WebContentsView`; `DOM.getNodeForLocation` → `resolveNode` → `callFunctionOn` round trip; survive navigation and HMR. Six new `BROWSER_HOST_OPS`. **Kill criterion:** if a named isolated world's binding does not survive same-document navigation, fall back to main-world with an obfuscated binding name and re-do the security section. | 3 |
| **2** | **`@realm/visual`, React + Vite only.** Babel/SWC visitor, `data-rl-src`, `data-rl-owner`, hash, manifest route, dev-only guard. | 4 |
| **3** | **Core runtime.** Overlay, hit testing, box model, adopted-stylesheet tweak engine, `MutationObserver` re-stamp, `invalidated` events, `collectDoc` filtering. | 4 |
| **4** | **Write-back planner v1** — Tailwind static literal + inline style only. Everything else refused with a reason. Path-resolution guards. Mutation-grade tests on the refusal list. **This is the plan's centre of gravity; do not compress it.** | 7 |
| **5** | **Inspector UI + missing primitives.** Drag-scrub field, slider, color picker, tooltip; the four property groups; badge rendering; view-bounds narrowing for the rail. | 6 |
| **6** | **Commit path + diff-pane handoff.** `visual.plan` / `visual.commit`, lock, hash re-verify, stale handling. | 2 |
| **7** | **Styling adapters 2** — CSS Modules, plain CSS via sourcemap, CSS-in-JS, tokens. | 5 |
| **8** | **Framework adapters** — Svelte (`__svelte_meta`, nearly free), Vue SFC, plain HTML; probe adapters for each. | 4 |
| **9** | **Build adapters** — webpack/Next-Babel, then the Turbopack loader shim, verified live. | 3 |
| **10** | **Agent seam** — `visual_inspect`/`visual_tweak` on the `realm-browser` provider; "ask the agent" from a grey badge. | 2 |
| **11** | **Security + live verification.** Path-traversal suite, hostile-manifest suite, the no-overlay invariant with the rail open at every layout position, real apps: a Vite+Tailwind SPA, a Next app-router project, a SvelteKit project. | 4 |

**≈44 days to the full thing. The minimum genuinely-working version is items 1–6 plus a stripped item 5
(padding, margin, font-size, color only): ≈18 days**, and it does the whole demo — one line in a Vite React
app, click a div, drag padding, watch it move, accept, see the Tailwind class change in the diff pane. Ship
that, dogfood it on Realm's own renderer, and let what breaks choose the order of 7–11.

**Mutants that must die** (the ones that pass a naive test suite):

- A stale `data-rl-src` hash that writes anyway.
- A path that escapes the root via a symlink inside the root.
- A loop edit that commits without showing the instance count.
- `cn("p-4", cond && "p-8")` edited as if it were a literal.
- A `<Card className>` edit that writes to the *usage* site and silently does nothing.
- Commit succeeding against a plan computed before an HMR reload.
- The overlay leaking into `browser_snapshot` as a `[new]` element.
- A grey-badge property whose commit button is merely hidden rather than refused server-side.
- The inspector rail rendered as a floating panel over the view when the pane is narrow.

---

## Risks and unknowns

**We own a compiler transform forever.** React 19's hole is not closing — issue #31981 has been open 14 months
with the React team not responding and Vaadin still hand-patching. Mitigation: the transform does the most
boring possible thing (stamp an attribute on a JSX opening element), which is the shape most likely to survive
React Compiler, new JSX runtimes, and RSC. Residual risk: the React Compiler's memoization could hoist an
element such that one `data-rl-src` backs more DOM nodes than the source suggests — our `instances` count
already surfaces that, but the warning text will need tuning.

**Turbopack.** The realest schedule risk. If the loader shim does not hold, Next-with-Turbopack users need a
Rust SWC plugin, which is a different project. Sequenced late (item 9) deliberately.

**Preview ≠ committed result, occasionally.** Live preview writes raw CSS; the commit writes a Tailwind class
that Tailwind's JIT may not have generated yet. Between accept and HMR there is a frame where the page shows
the old class. Acceptable, but it must not look like a failure.

**Tailwind arbitrary values are a one-way door.** Once a codebase has `p-[17px]`, tailwind-merge stops merging
it against `p-8` — documented behaviour, not a bug — and our own future edits inherit that unreliability.
Hence snapping to scale by default. If users override constantly, revisit.

**Two-way editing.** The user typing in their editor while the inspector is open is the normal case, not the
edge case. The hash interlock makes it *safe*; making it *pleasant* (re-locate rather than refuse, when the
file changed elsewhere) is unsolved and deliberately deferred.

**The no-overlay invariant and the rail.** Narrowing the view is clean, but at small pane widths the rail and
the page fight for space, and resize is on the do-NOT-animate list. Plan 11's degenerate-case answer
(the layout moves) probably applies; unverified.

**Unknown: does a named isolated world's binding survive Electron's cross-process navigation** under
`--disable-backgrounding-occluded-windows`? Plan 11 found one non-obvious constraint in this exact area
(synthetic input dropped after cross-process navigation until a compositor frame exists). Item 1 exists to
find the next one before anything is built on top of it.

**Unknown: how much of the tail the agent seam actually absorbs.** If grey badges are 40% of real edits, this
is a Cursor clone with extra steps and the deterministic planner was the wrong bet. If they are 5%, the bet
paid. Instrument the badge distribution from day one of dogfooding — it is the single number that should
steer items 7–11.

## Out of scope

Editing production sites. Editing without a manifest-verified project root. Component creation, deletion, or
reparenting (Cursor's drag-across-the-DOM-tree; a different and much larger problem than changing a value).
Multi-element selection and bulk edit. Responsive breakpoint editing (`sm:`/`md:` variants — v2, and it needs
its own conflict model). Animation and transition editing. Figma import/export. Attaching to the user's real
Chrome. Any path by which an agent commits source through this feature rather than through the editing flow
it already has.

---

## References

React source location:
[facebook/react#31981 — reintroduce debugSource](https://github.com/facebook/react/issues/31981) ·
[facebook/react#28351 — DevTools lazily derives source from component stacks](https://github.com/facebook/react/pull/28351) ·
[facebook/react#29092 — fiber missing debug information](https://github.com/facebook/react/issues/29092) ·
[captureOwnerStack (react.dev)](https://react.dev/reference/react/captureOwnerStack) ·
[React 19.1.0 release](https://github.com/facebook/react/releases/tag/v19.1.0) ·
[ArnaudBarre/vite-plugin-react-click-to-component (manual patching, still)](https://github.com/ArnaudBarre/vite-plugin-react-click-to-component)

Build-time transforms:
[@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/README.md) ·
[@react-dev-inspector/babel-plugin](https://www.npmjs.com/package/@react-dev-inspector/babel-plugin) ·
[babel-plugin-transform-react-jsx-location](https://github.com/adrianton3/babel-plugin-transform-react-jsx-location)

Prior art (licenses checked):
[zh-lx/code-inspector — MIT, `data-insp-path`, 8 bundlers × 10 frameworks](https://github.com/zh-lx/code-inspector) ·
[zthxxx/react-dev-inspector — MIT](https://github.com/zthxxx/react-dev-inspector) ·
[onlook-dev/onlook — Apache-2.0, `data-oid` opaque ids](https://github.com/onlook-dev/onlook) ·
[infi-pc/locatorjs — **no LICENSE file in repo; treat as all-rights-reserved, read only**](https://github.com/infi-pc/locatorjs) ·
[Cursor — a visual editor for the Cursor Browser](https://cursor.com/blog/browser-visual-editor) ·
[Cursor Browser docs](https://cursor.com/docs/agent/tools/browser) ·
[Next.js dev overlay `/__nextjs_launch-editor`](https://deepwiki.com/vercel/next.js/5.3-dev-overlay-and-error-ui) ·
[antfu/vite-plugin-vue-tracer (sourcemap-based, no DOM attributes)](https://github.com/antfu/vite-plugin-vue-tracer) ·
[sveltejs/vite-plugin-svelte inspector](https://github.com/sveltejs/vite-plugin-svelte/blob/main/docs/inspector.md) ·
[Svelte `__svelte_meta`](https://www.petermekhaeil.com/til/svelte-components-have-file-location-meta-data/) ·
[sveltejs/svelte#1501 — add location info to nodes](https://github.com/sveltejs/svelte/pull/1501)

Chrome DevTools as the model for trust and write-back:
[Automatic Workspace connection](https://developer.chrome.com/docs/devtools/automatic-workspaces) ·
[Chromium ecosystem guide — automatic workspace folders](https://chromium.googlesource.com/devtools/devtools-frontend/+/main/docs/ecosystem/automatic_workspace_folders.md) ·
[Workspaces — save changes to source](https://developer.chrome.com/docs/devtools/workspaces) ·
[Astro's implementation](https://github.com/withastro/astro/commit/41ed3ac54adf1025a38031757ee0bfaef8504092)

Tailwind write-back hazards:
[tailwind-merge — arbitrary properties are not merged, by design](https://www.skypack.dev/view/tailwind-merge) ·
[tailwind-variants#258 — base/class conflicts survive twMerge](https://github.com/heroui-inc/tailwind-variants/issues/258)
