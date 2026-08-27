# Realm Glass Shell — UI Overhaul Design

**Date:** 2026-08-24 · **Status:** approved in brainstorming; supersedes the visual/layout portions of Plan 2's shell. The spaces model, gesture stack, agent sessions, and all of Plan 3 are untouched.

**Decisions this records** (made interactively, with mockups): depth was diagnosed as the core visual problem; material = **vibrant glass** (Arc/Claude Desktop direction) over layered-dark and inset-panel alternatives; navigation = **Arc-true** (sidebar is the open set, TabBar retired) over differentiated-tabs and command-centric alternatives; themes = **dark-first, competent light**. Mockups: `Realm Material Study` and `Realm Shell Layouts` artifacts (2026-08-24).

---

## 1. The material system

Three planes. Every component sits on exactly one.

### Plane 0 — the ground
The window itself, using real macOS vibrancy (`under-window` material on the BrowserWindow — already enabled in `apps/desktop/src/main/index.ts`) tinted by the active space colour. Replaces today's painted gradient as the primary treatment. The tint is **strongly saturated** — the space colour is the ground's identity, and the two-finger swipe visibly changes the whole world, interpolating the tint with the drag.

`packages/ui/src/theme.ts` is rewritten: `paletteFromColor(hex, mode)` now derives —
- `groundTint` / `groundTint2` (saturated space-hued radial pair painted behind vibrancy, and the whole fallback when vibrancy is off),
- `accent` (the space colour, contrast-adjusted per mode),
- alpha-step ladders for chrome and stage (below),
- three text tiers: `textBright`, `textDim`, `textFaint`.

### Plane 1 — chrome glass
Sidebar and popovers/menus. `rgba(255,255,255,.05–.08)` fills over `backdrop-filter: blur(34px) saturate(150%)`, inset 1px right-edge hairline `rgba(255,255,255,.07)`. **No opaque fills in chrome** — rows, search, tiles, strip squares are all alpha-white steps:
- resting `transparent`, hover `.09`, active/selected `.16` with an inset top edge-light `.18`.

### Plane 2 — the stage
The content card. Smoked glass: `rgba(16,14,26,.62)` + `blur(28px) saturate(140%)`, border `1px rgba(255,255,255,.09)`, **bright top edge** `inset 0 1px 0 rgba(255,255,255,.14)` (the signature "lit from above" detail), drop shadow `0 18px 44px rgba(0,0,0,.5)`. Radius 12px. Terminal and (future) browser panes keep opaque interiors for legibility but take the same border/edge/shadow so they sit on the same plane. Popovers/sheets are Plane 2 at higher alpha (`.82`) with a stronger edge-light.

### Tokens
The `--rl-*` custom-property set is rebuilt (~20 tokens): plane fills, alpha steps, edge-lights, borders, text tiers, accent, ground tints, shadows, radius, easing. `applyTheme` and `data-mode` stay as the delivery mechanism. Exact values are decided in the plan; the mockup values above are the starting point.

### Fallback
If vibrancy is unavailable (platform, or a future GPU toggle): Plane 0 paints `groundTint`→`groundTint2` as an opaque gradient (today's mechanism). Planes 1–2 are pure CSS and unchanged. Blur values are the only per-platform variable.

## 2. Shell structure (Arc-true)

### TabBar retires
- Delete `apps/desktop/src/renderer/src/components/TabBar.tsx` and its CSS.
- Contracts: a layout **leaf holds exactly one item** — `tabs: string[]`/`activeTab` becomes `itemId: string | null`. `packages/contracts/src/layout.ts` reshapes accordingly: `setActiveTab` is deleted; `addTab` becomes `openItem(l, leafId, itemId)` (replace-in-leaf); `removeTab` becomes `closeItem(l, itemId)` (keeping its collapse-the-split semantics); `allTabs`/`findLeafOfTab` become `allItems`/`findLeafOfItem`; `splitLeaf`, `gridPreset`, `updateSizes`, `firstLeaf` keep their shapes. The uniqueness invariant simplifies to "an item appears in at most one leaf". Persisted layouts migrate: each existing leaf collapses to its `activeTab` (or its first tab); displaced tabs return to the space list (a pure `migrateLayout` in contracts, applied on read).
- `PaneHost` renders leaves without a tab strip; store drops tab-tracking state.

### Sidebar composition (top → bottom)
1. **Search field** — unchanged position; placeholder gains the ⌘K affordance.
2. **Space header** — icon + name at 16px/650, ⋯ menu unchanged.
3. **`OPEN` group** — items currently in the layout, in layout order. Active item: `.16` fill + edge-light. Hover reveals ×; closing removes from layout only. When a split is active, each open row shows a 2px position glyph (left/right/top/bottom quadrant mark), not text.
4. **`SPACE` group** — every other item in the space. Click opens into the focused leaf (replacing its item; the replaced item returns to this group). The pinned grid renders as a compact tile row at the top of this group. An item appears in exactly one group.
5. **New…** footer button — unchanged behaviour.
6. **Space strip** — unchanged (icons, drag-reorder, two-finger swipe via the existing gesture stack).

Group labels: 11px/500 uppercase, letter-spaced, `textFaint`.

### Splits
- `⌘\` splits the focused leaf; the next item opened from the sidebar fills the new leaf. `LayoutMenu` grid presets unchanged.
- **New interaction:** dragging a sidebar row onto a stage edge creates a split on that edge (drop zones: 4 edges + centre-replace). This is the only new interaction in the design.
- Closing a split leaf's item collapses the split (`closeItem` inherits `removeTab`'s collapse semantics).

### Untouched
SpaceSwiper/gesture stack, drag-reorder, item context menus, sheets (restyled only), CommandPalette (restyled only), NewSessionSheet (restyled only — logic just passed Plan 3 review).

## 3. Stage contents

Structure and behaviour of transcript components are preserved; they change material and type only — except the two follow-up closures noted.

- **User messages:** right-aligned bubbles, alpha-white fill one step above stage.
- **Assistant prose:** no container — set directly on the stage glass, max measure ~72ch.
- **Thinking:** collapsed to one dim line with a left rule; click to expand.
- **Tool cards:** 12px mono command line; status glyph coloured running/ok/error; output in a **recessed well** inside the card (the one inset-material element in the app). Extends `toolSummary`/`toolIcon` to Codex (`exec_command`, `apply_patch`) and ACP titles — closes that Plan 3 follow-up.
- **Permission card:** amber-tinted glass + amber border on Plane 2; buttons as alpha steps, Allow filled with accent. Behaviour untouched.
- **Composer:** glass field; options row as 10.5px chips. Cost renders blank when `costUsd` is 0 — closes that follow-up.
- **Type scale:** base 13px; space name 16/650; pane title 13.5/600; group labels 11/500 caps; sidebar rows 12px; tool mono 12px. Face: system stack; a bundled mono face is a plan-time decision weighed against bundle size.

## 4. Motion

Exactly three moments; all disabled under `prefers-reduced-motion`:
1. Space swipe re-tints the ground continuously with the drag (extends the existing gesture pipeline's transform writes to also interpolate tint tokens).
2. Stage settle: 150ms opacity + 4px translate when a leaf's item changes.
3. Permission card enter: 120ms scale from 98%.

Everything else is instant.

## 5. Light mode (dark-first)

Same token structure, frosted-white derivation: higher-alpha white glass fills, dark text tiers, borders carry more separation than edge-lights, space tint desaturated ~20%. One derivation pass in `paletteFromColor`; no bespoke redesign. `data-mode` switching unchanged.

## 6. Verification

- Contracts: layout-op removal + migration covered by updated unit tests (migration round-trips every persisted-layout shape from Plan 2 fixtures).
- Renderer: component tests updated for the removed TabBar; sidebar open/space grouping, close-returns-to-space, and drag-to-split get new tests.
- Visual: CDP screenshot pass on both modes × 3 space colours; text-contrast spot checks (WCAG AA on `textDim` against both stage and chrome).
- Live: `pnpm dev` manual pass — swipe re-tint, open/close/split flows, permission card, terminal pane legibility.

## 7. Out of scope (unchanged from prior roadmap)

Browser pane, realm-mcp, ACP mode mapping, model pickers, Windows/Linux styling beyond the fallback path, sidebar width preference, any server/adapter change.
